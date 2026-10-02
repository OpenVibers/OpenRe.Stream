'use strict';
/**
 * openre-webrtc — the WebRTC transport worker (unit openre-webrtc@<release>.service).
 *
 * One worker owns everything WebRTC (T4 decision 1: mediasoup is single-process, so WHIP ingest,
 * the SFU and viewer signaling cannot be split):
 *
 *   public   0.0.0.0:OPENRE_WEBRTC_PORT (9936 until the WebRTC cutover; Live's WHIP/SFU live on its
 *            app port 3000), SO_REUSEPORT so two generations listen during a drain:
 *              POST/OPTIONS   /whip/<key>          WHIP ingest (RFC 9725): offer → answer
 *              PATCH/DELETE   /whip/session/<id>   trickle ICE or ICE restart / end (ETag/If-Match,
 *                                                  the POST's Bearer, if any, is required again)
 *              WS upgrade     /b/<key>             browser broadcaster signaling (mediasoup-client)
 *              WS upgrade     /w/<session id>      viewer signaling, by playback id (never the key)
 *   internal 127.0.0.1:<egressPort>  the RTP egress API the restream worker, Media's RTP recorder and
 *            the thumbnail grabber use: GET /rtp/<session id>?vport&aport returns the SDP a pulling
 *            ffmpeg reads (a PlainRTP consumer per producer sends RTP to those ports); DELETE
 *            /rtp/<session id>/<transport id> closes one. Port from OPENRE_WEBRTC_INTERNAL_PORT_*.
 *
 * Admission is exactly the other workers': resolveIngestKey with protocol 'webrtc' (one open session
 * per definition), maxPublishersPerWorker, never while draining. A session goes live when media
 * flows — ICE connects for WHIP (Live's whip-handler rule), the first video producer for a browser
 * broadcaster — and ends on DELETE, ICE failure past its grace, broadcast WS close, when its last
 * producer closes, or on the coordinator's end/drain/lost signals.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { createWorkerRuntime } = require('./runtime');
const { createSfu } = require('./webrtc/sfu');
const sdpTool = require('./webrtc/sdp');
const { createSignaling } = require('./webrtc/signaling');
const { createThumbnailer } = require('./thumbnails');
const { rtpInputArgs } = require('./restream/ffmpeg-args');
const { createMediaClient } = require('../server/media-client');

const WHIP_KEY_RE = /^\/whip\/([^/]+)\/?$/;
const WHIP_SESSION_RE = /^\/whip\/session\/([0-9a-f]{16,})\/?$/;
const MAX_BODY = 1 * 1024 * 1024;
const ICE_GRACE_MS = 15000;
const PRODUCER_GONE_GRACE_MS = 2000;

const WHIP_CORS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, If-Match',
    'Access-Control-Expose-Headers': 'Location, X-WHIP-ERROR, ETag',
    'Access-Control-Max-Age': '86400',
    'Cross-Origin-Resource-Policy': 'cross-origin',
});

/** Bind the first free loopback port in [min, max] (skipping `skip`). */
function listenInRange(server, min, max, skip = new Set()) {
    return new Promise((resolve, reject) => {
        let port = min;
        const tryNext = () => {
            while (skip.has(port)) port++;
            if (port > max) { reject(new Error(`no free loopback port in ${min}-${max}`)); return; }
            const onError = (err) => {
                server.removeListener('listening', onListening);
                if (err.code === 'EADDRINUSE' || err.code === 'EACCES') { port++; tryNext(); } else reject(err);
            };
            const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, '127.0.0.1');
        };
        tryNext();
    });
}

/** A free UDP port (best effort: bound then released, so ffmpeg can take it and its +1 for RTCP). */
function freeUdpPort() {
    return new Promise((resolve, reject) => {
        const s = dgram.createSocket('udp4');
        s.once('error', reject);
        s.bind(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}
async function allocateUdpPortPair() {
    const p = await freeUdpPort();
    return p % 2 === 0 ? p : await freeUdpPort();
}

function readBody(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function createWebrtc({ rt, log = console, exit = (code) => process.exit(code), spawnImpl, fetchImpl = globalThis.fetch }) {
    const { store, config } = rt;
    const w = config.webrtc;

    const sfu = createSfu({ config, log });
    const media = createMediaClient({ config, fetchImpl });
    const thumbnails = createThumbnailer({ config, log, ...(spawnImpl ? { spawnImpl } : {}), media });

    /** sessionId → session record */
    const sessions = new Map();
    let pendingEnds = 0;
    let publicServer = null;
    let egressServer = null;
    let endpoints = null;
    let signaling = null;

    const actor = () => `worker:${runtime.me && runtime.me.id}`;
    function safe(promise, what) {
        return Promise.resolve(promise).catch((err) => log.error(`[webrtc] ${what}: ${err && (err.stack || err.message) || err}`));
    }

    // ── Admission ───────────────────────────────────────────────
    async function admit(key, mode) {
        if (runtime.draining || !runtime.me || runtime.me.state !== 'ready') return { error: 'generation not taking sessions' };
        if (sessions.size >= w.maxPublishersPerWorker) return { error: 'worker full' };
        const r = await store.definitions.resolveIngestKey(key, 'webrtc');
        if (r.error) return { error: r.error };
        const a = await store.sessions.admit({ definition: r.definition, key: r.key, protocol: 'webrtc', worker: runtime.me });
        if (a.error) return { error: a.error };
        const sess = {
            sessionId: a.session.id, definitionId: r.definition.id, hint: r.key.hint, mode,
            ended: false, endReason: null, live: false, createdAt: Date.now(),
            whip: new Map(), producers: new Set(), egress: new Map(),
            thumbTimer: null, timers: new Set(),
        };
        sessions.set(sess.sessionId, sess);
        return { sessionId: sess.sessionId, definitionId: sess.definitionId, hint: r.key.hint, peerId: `bc-${sess.sessionId}` };
    }

    function timer(sess, fn, ms) {
        const t = setTimeout(() => { sess.timers.delete(t); fn(); }, ms);
        t.unref?.();
        sess.timers.add(t);
        return t;
    }

    async function goLive(sess) {
        if (sess.live || sess.ended) return;
        sess.live = true;
        const t = await store.sessions.transition(sess.sessionId, 'live', { reason: 'media_flowing', actor: actor() });
        if (!t.ok) {
            log.warn(`[webrtc] session ${sess.sessionId} could not go live (${t.code}); closing`);
            sess.endReason = 'coordinator_failed';
            await endSession(sess.sessionId, 'coordinator_failed');
        }
    }

    async function endSession(sessionId, reason) {
        const sess = sessions.get(sessionId);
        if (sess) { sess.endReason = reason; await endSessionRecord(sess, reason); return true; }
        pendingEnds++;
        try { await store.sessions.finish(sessionId, { reason, actor: actor() }); } finally { pendingEnds--; }
        if (runtime.draining) runtime.exitWhenIdle();
        return false;
    }

    async function endSessionRecord(sess, reason) {
        if (sess.ended) return;
        sess.ended = true;
        sessions.delete(sess.sessionId);
        pendingEnds++;
        try {
            for (const t of sess.timers) clearTimeout(t);
            sess.timers.clear();
            if (sess.thumbTimer) clearInterval(sess.thumbTimer);
            for (const e of sess.egress.values()) { for (const tid of e.transportIds) { try { sfu.closePlainConsumer(sess.sessionId, tid); } catch { /* gone */ } } }
            sess.egress.clear();
            sfu.closeSession(sess.sessionId);
            await store.sessions.finish(sess.sessionId, { reason, actor: actor() });
            log.log(`[webrtc] session ${sess.sessionId} ended (${reason})`);
        } finally {
            pendingEnds--;
        }
        if (runtime.draining) runtime.exitWhenIdle();
    }

    // ── WHIP ────────────────────────────────────────────────────
    function whipHeaders(req, resourceId, etag) {
        const host = req.headers.host || `${w.publicHost}:${w.publicPort}`;
        return {
            ...WHIP_CORS,
            Location: `https://${host}/whip/session/${resourceId}`,
            ETag: etag,
        };
    }

    /** A new entity-tag per ICE session (RFC 9725 §4.3: it changes on every ICE restart). */
    const newIceEtag = () => `"${crypto.randomBytes(8).toString('hex')}"`;
    const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
    const bearerOf = (req) => {
        const auth = req.headers.authorization;
        return auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    };

    function sendWhipError(res, status, code, message) {
        res.writeHead(status, { ...WHIP_CORS, 'content-type': 'application/json', 'X-WHIP-ERROR': code });
        res.end(JSON.stringify({ error: message, error_code: code }));
    }

    async function handleWhipPost(req, res, key) {
        const bearer = bearerOf(req);
        if (bearer && bearer !== key) return sendWhipError(res, 401, 'bearer_mismatch', 'Bearer token does not match stream key');
        let offerText;
        try { offerText = await readBody(req); } catch { return sendWhipError(res, 413, 'body_too_large', 'Offer too large'); }
        if (req.headers['content-type'] && /json/.test(req.headers['content-type'])) {
            try { offerText = JSON.parse(offerText).sdp; } catch { return sendWhipError(res, 400, 'invalid_sdp', 'Invalid JSON body'); }
        }
        if (!offerText || typeof offerText !== 'string') return sendWhipError(res, 400, 'missing_sdp', 'Missing SDP offer in request body');

        let offerSdp;
        try { offerSdp = sdpTool.parse(offerText); } catch { return sendWhipError(res, 400, 'invalid_sdp', 'Invalid SDP offer'); }

        const adm = await admit(key, 'whip');
        if (adm.error) return sendWhipError(res, adm.error === 'worker full' ? 503 : 409, adm.error, `Publish refused: ${adm.error}`);
        const sess = sessions.get(adm.sessionId);
        const resourceId = crypto.randomBytes(16).toString('hex');
        const peerId = `whip-${resourceId}`;

        let transportInfo;
        try {
            transportInfo = await sfu.createTransport(sess.sessionId, peerId, { iceConsentTimeout: 0 });
        } catch (err) {
            log.warn(`[webrtc] WHIP transport failed for ${sess.sessionId}: ${err.message}`);
            await endSessionRecord(sess, 'transport_creation_failed');
            return sendWhipError(res, 502, 'transport_creation_failed', 'WHIP transport creation failed');
        }
        const transport = transportInfo.transport;

        try {
            await sfu.connectTransport(sess.sessionId, peerId, transportInfo.id, sdpTool.extractDtlsParameters(offerSdp));
        } catch (err) {
            log.warn(`[webrtc] WHIP DTLS failed for ${sess.sessionId}: ${err.message}`);
            await endSessionRecord(sess, 'dtls_negotiation_failed');
            return sendWhipError(res, 502, 'dtls_negotiation_failed', 'DTLS negotiation failed');
        }

        const routerCaps = await sfu.getRouterCapabilities(sess.sessionId);
        const producersByKind = {};
        for (const [mediaIndex, m] of (offerSdp.media || []).entries()) {
            if (m.port === 0) continue;
            let rtpParams;
            try { rtpParams = sdpTool.extractRtpParameters(m, routerCaps, mediaIndex); } catch (err) {
                if (err.code === 'invalid_rtp_encoding') { await endSessionRecord(sess, 'invalid_rtp_encoding'); return sendWhipError(res, 400, 'invalid_rtp_encoding', `Invalid RTP encoding for ${m.type}`); }
                throw err;
            }
            if (!rtpParams || rtpParams.codecs.length === 0) continue;
            let produced;
            try { produced = await sfu.produce(sess.sessionId, peerId, transportInfo.id, m.type, rtpParams); } catch (err) {
                log.warn(`[webrtc] WHIP producer failed for ${sess.sessionId}: ${err.message}`);
                await endSessionRecord(sess, 'producer_creation_failed');
                return sendWhipError(res, 502, 'producer_creation_failed', 'Failed to create media producer');
            }
            producersByKind[m.type] = produced.producer;
            sess.producers.add(produced.id);
        }
        if (Object.keys(producersByKind).length === 0) {
            await endSessionRecord(sess, 'no_compatible_codecs');
            return sendWhipError(res, 406, 'no_compatible_codecs', 'No compatible codecs — router supports VP8, H264, Opus.');
        }

        let answer;
        try { answer = sdpTool.buildSdpAnswer(transportInfo, offerSdp, producersByKind, { fallbackAddress: w.media.announcedIp || '127.0.0.1' }); } catch (err) {
            log.error(`[webrtc] SDP answer failed for ${sess.sessionId}: ${err.message}`);
            await endSessionRecord(sess, 'answer_generation_failed');
            return sendWhipError(res, 500, 'answer_generation_failed', 'Failed to generate SDP answer');
        }

        const remoteUfrag = offerSdp.iceUfrag || ((offerSdp.media || []).find((m) => m.iceUfrag) || {}).iceUfrag || null;
        sess.whip.set(resourceId, {
            peerId, transportId: transportInfo.id, iceReady: false, iceGraceTimer: null, iceFailTimer: null,
            // The resource's own state: the ICE session's entity-tag, the client's current ICE
            // username fragment, and the key's hash — a client that authenticated with a Bearer
            // must send it again on PATCH/DELETE; any Bearer sent must be the key.
            etag: newIceEtag(), remoteUfrag, keyHash: sha256(key), bearerRequired: Boolean(bearer),
        });

        // The session goes live when media flows: ICE connected (Live's whip-handler rule).
        transport.on('icestatechange', (state) => {
            const entry = sess.whip.get(resourceId);
            if (!entry) return;
            if (state === 'failed') { clearTimeout(entry.iceFailTimer); safe(endSession(sess.sessionId, 'ice_failed'), 'ice failed end'); return; }
            if (state === 'disconnected') {
                clearTimeout(entry.iceGraceTimer);
                entry.iceGraceTimer = setTimeout(() => { if (sess.whip.has(resourceId) && !sess.live) safe(endSession(sess.sessionId, 'ice_disconnected'), 'ice grace end'); }, ICE_GRACE_MS);
                entry.iceGraceTimer.unref?.();
                return;
            }
            if (state === 'connected' || state === 'completed') {
                clearTimeout(entry.iceGraceTimer);
                if (!entry.iceReady) { entry.iceReady = true; safe(goLive(sess), 'go live'); }
            }
        });
        transport.on('dtlsstatechange', (state) => {
            if ((state === 'closed' || state === 'failed') && sess.whip.has(resourceId)) safe(endSession(sess.sessionId, 'dtls_closed'), 'dtls end');
        });

        log.log(`[webrtc] WHIP session ${sess.sessionId} accepted for ${sess.definitionId} (key …${sess.hint}), ${Object.keys(producersByKind).length} producer(s)`);
        res.writeHead(201, { 'content-type': 'application/sdp', ...whipHeaders(req, resourceId, sess.whip.get(resourceId).etag) });
        res.end(answer);
    }

    function findWhip(resourceId) {
        for (const sess of sessions.values()) {
            const entry = sess.whip.get(resourceId);
            if (entry) return { sess, entry };
        }
        return null;
    }

    /** RFC 9725 §4.5: the resource accepts the Bearer the endpoint did, and only that. */
    function whipResourceAuthorized(req, entry) {
        const bearer = bearerOf(req);
        if (!bearer) return !entry.bearerRequired;
        return crypto.timingSafeEqual(sha256(bearer), entry.keyHash);
    }

    /**
     * Trickle ICE / ICE restart (RFC 9725 §4.3, RFC 8840 fragments). The transport is ICE-lite, so
     * trickled candidates are acknowledged and discarded: the client's connectivity checks reach
     * the transport's own candidates (sent in the answer) and mediasoup learns the client's address
     * from them. New ICE credentials in the fragment are an ICE restart: the transport gets new
     * credentials, answered 200 with them and a new ETag; the session stays up either way.
     */
    async function handleWhipPatch(req, res, resourceId) {
        const found = findWhip(resourceId);
        if (!found) return sendWhipError(res, 404, 'session_not_found', 'Session not found');
        const { sess, entry } = found;
        if (!whipResourceAuthorized(req, entry)) return sendWhipError(res, 401, 'unauthorized', 'Bearer token required for this resource');
        if (!/^application\/trickle-ice-sdpfrag\s*(;|$)/i.test(req.headers['content-type'] || '')) {
            return sendWhipError(res, 415, 'unsupported_media_type', 'PATCH body must be application/trickle-ice-sdpfrag');
        }
        const ifMatch = (req.headers['if-match'] || '').trim();
        if (ifMatch && ifMatch !== '*' && ifMatch !== entry.etag) return sendWhipError(res, 412, 'etag_mismatch', 'If-Match does not name the current ICE session');
        let body;
        try { body = await readBody(req); } catch { return sendWhipError(res, 413, 'body_too_large', 'Fragment too large'); }
        let frag;
        try { frag = sdpTool.parseIceFragment(body); } catch { return sendWhipError(res, 400, 'invalid_sdpfrag', 'Invalid trickle-ice-sdpfrag'); }

        if (frag.ufrag && frag.pwd && frag.ufrag !== entry.remoteUfrag) {
            let iceParameters;
            try { iceParameters = await sfu.restartIce(sess.sessionId, entry.peerId, entry.transportId); } catch (err) {
                log.warn(`[webrtc] WHIP ICE restart failed for ${sess.sessionId}: ${err.message}`);
                return sendWhipError(res, 500, 'ice_restart_failed', 'ICE restart failed');
            }
            if (!sess.whip.has(resourceId)) return sendWhipError(res, 404, 'session_not_found', 'Session not found');
            entry.remoteUfrag = frag.ufrag;
            entry.etag = newIceEtag();
            log.log(`[webrtc] WHIP ICE restart for ${sess.sessionId}`);
            res.writeHead(200, { ...WHIP_CORS, 'content-type': 'application/trickle-ice-sdpfrag', ETag: entry.etag });
            return res.end(sdpTool.buildIceFragment(iceParameters));
        }
        res.writeHead(204, WHIP_CORS);
        res.end();
    }

    async function handleWhipDelete(req, res, resourceId) {
        const found = findWhip(resourceId);
        if (!found) return sendWhipError(res, 404, 'session_not_found', 'Session not found');
        if (!whipResourceAuthorized(req, found.entry)) return sendWhipError(res, 401, 'unauthorized', 'Bearer token required for this resource');
        await endSession(found.sess.sessionId, 'whip_delete');
        res.writeHead(200, WHIP_CORS);
        res.end();
    }

    // ── RTP egress (loopback) ───────────────────────────────────
    async function describeEgress(sess) {
        const caps = await sfu.getRouterCapabilities(sess.sessionId);
        const out = { video: null, audio: null };
        for (const kind of ['video', 'audio']) {
            const p = sfu.findProducerByKind(sess.sessionId, kind);
            if (!p) continue;
            const prod = sfu.getProducers(sess.sessionId).find(x => x.id === p.id);
            if (prod && prod.paused) continue;
            const routerCodec = caps.codecs.find(c => c.kind === kind && (kind !== 'video' || c.mimeType === 'video/VP8')) || caps.codecs.find(c => c.kind === kind);
            out[kind] = routerCodec ? {
                payloadType: routerCodec.preferredPayloadType,
                codec: (routerCodec.mimeType || `${kind}/unknown`).split('/')[1],
                clockRate: routerCodec.clockRate,
                ...(kind === 'audio' && routerCodec.channels ? { channels: routerCodec.channels } : {}),
            } : null;
        }
        return out;
    }

    async function openEgress(sess, { vport, aport }) {
        const videoProducer = sfu.findProducerByKind(sess.sessionId, 'video');
        if (!videoProducer) return { error: 'no video producer yet' };
        const video = await sfu.createPlainConsumer(sess.sessionId, videoProducer.id, { remoteIp: '127.0.0.1', remotePort: vport, remoteRtcpPort: vport + 1 });
        const audioProducer = sfu.findProducerByKind(sess.sessionId, 'audio');
        let audio = null;
        if (audioProducer && aport) audio = await sfu.createPlainConsumer(sess.sessionId, audioProducer.id, { remoteIp: '127.0.0.1', remotePort: aport, remoteRtcpPort: aport + 1 });
        const transportIds = [video.transportId, ...(audio ? [audio.transportId] : [])];
        const sdp = sdpTool.buildEgressSdp({ video: { ...video, port: vport }, audio: audio ? { ...audio, port: aport } : null });
        return { sdp, transports: transportIds, video, audio };
    }

    function handleEgressHttp(req, res) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        const get = /^\/rtp\/(ses_[0-9A-HJKMNP-TV-Z]{26})\/?$/.exec(url.pathname);
        const describe = /^\/rtp\/(ses_[0-9A-HJKMNP-TV-Z]{26})\/describe$/.exec(url.pathname);
        const del = /^\/rtp\/(ses_[0-9A-HJKMNP-TV-Z]{26})\/([a-f0-9]+)\/?$/.exec(url.pathname);
        safe((async () => {
            if (req.method === 'GET' && describe) {
                const sess = sessions.get(describe[1]);
                if (!sess) return json(404, { error: 'session_not_found' });
                return json(200, await describeEgress(sess));
            }
            if (req.method === 'GET' && get) {
                const sess = sessions.get(get[1]);
                if (!sess) return json(404, { error: 'session_not_found' });
                const vport = Number(url.searchParams.get('vport'));
                const aport = Number(url.searchParams.get('aport')) || 0;
                if (!Number.isInteger(vport) || vport <= 0) return json(400, { error: 'vport required' });
                try {
                    const r = await openEgress(sess, { vport, aport });
                    if (r.error) return json(404, { error: r.error });
                    const handle = crypto.randomBytes(8).toString('hex');
                    sess.egress.set(handle, { transportIds: r.transports, at: Date.now() });
                    return json(200, { handle, sdp: r.sdp, transports: r.transports });
                } catch (err) { return json(502, { error: err.message }); }
            }
            if (req.method === 'DELETE' && del) {
                const sess = sessions.get(del[1]);
                if (!sess) return json(404, { error: 'session_not_found' });
                const handle = del[2];
                const e = sess.egress.get(handle);
                if (e) { for (const tid of e.transportIds) { try { sfu.closePlainConsumer(sess.sessionId, tid); } catch { /* gone */ } } sess.egress.delete(handle); }
                return json(200, { ok: true });
            }
            return json(404, { error: 'not_found' });
        })(), 'egress request');
    }

    // ── Thumbnails ──────────────────────────────────────────────
    function startThumbnails(sess) {
        if (!thumbnails.enabled || sess.thumbTimer) return;
        const grab = async () => {
            if (sess.ended) return;
            try {
                const producer = sfu.findProducerByKind(sess.sessionId, 'video');
                if (!producer) return;
                const port = await allocateUdpPortPair();
                const video = await sfu.createPlainConsumer(sess.sessionId, producer.id, { remoteIp: '127.0.0.1', remotePort: port, remoteRtcpPort: port + 1 });
                const sdpPath = path.join(os.tmpdir(), `openre-thumb-${sess.sessionId}-${video.transportId}.sdp`);
                fs.writeFileSync(sdpPath, sdpTool.buildEgressSdp({ video: { ...video, port } }), 'utf8');
                let buffer = null;
                try { buffer = await thumbnails.capture(rtpInputArgs(sdpPath)); } finally {
                    try { sfu.closePlainConsumer(sess.sessionId, video.transportId); } catch { /* gone */ }
                    try { fs.unlinkSync(sdpPath); } catch { /* gone */ }
                }
                if (buffer) await thumbnails.publish(store, sess.sessionId, buffer, { protocol: 'webrtc' });
            } catch (err) { log.warn(`[webrtc] thumbnail ${sess.sessionId}: ${err.message}`); }
        };
        sess.thumbTimer = setInterval(() => safe(grab(), 'thumbnail'), w.thumbnails.intervalMs);
        sess.thumbTimer.unref?.();
        safe(grab(), 'thumbnail');
    }

    // ── HTTP servers ────────────────────────────────────────────
    function handleRequest(req, res) {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/whip' || url.pathname.startsWith('/whip/')) {
            if (req.method === 'OPTIONS') { res.writeHead(204, WHIP_CORS); return res.end(); }
            const kMatch = WHIP_KEY_RE.exec(url.pathname);
            const sMatch = WHIP_SESSION_RE.exec(url.pathname);
            if (req.method === 'POST' && kMatch) return safe(handleWhipPost(req, res, decodeURIComponent(kMatch[1])), 'whip post');
            if (req.method === 'PATCH' && sMatch) return safe(handleWhipPatch(req, res, sMatch[1]), 'whip patch');
            if (req.method === 'DELETE' && sMatch) return safe(handleWhipDelete(req, res, sMatch[1]), 'whip delete');
            if (sMatch || kMatch) { res.writeHead(405, { ...WHIP_CORS, Allow: sMatch ? 'PATCH, DELETE, OPTIONS' : 'POST, OPTIONS' }); return res.end(); }
            res.writeHead(404, WHIP_CORS);
            return res.end();
        }
        res.writeHead(404);
        return res.end();
    }

    async function closePublic() {
        if (!publicServer) return;
        publicServer.close();
        log.log('[webrtc] public listener closed; running sessions stay until they leave');
    }

    function closeAll() {
        for (const sess of [...sessions.values()]) { try { sfu.closeSession(sess.sessionId); } catch { /* gone */ } }
        closePublic();
        if (egressServer) { egressServer.closeAllConnections?.(); egressServer.close(); egressServer = null; }
        if (signaling) signaling.closeAll();
        sfu.closeAll();
        const closing = [];
        if (publicServer) { publicServer.closeAllConnections?.(); closing.push(new Promise(r => publicServer.close(() => r()))); publicServer = null; }
        return Promise.all(closing);
    }

    const runtime = createWorkerRuntime({
        rt, kind: 'webrtc', log, exit,
        hooks: {
            onDrain: () => closePublic(),
            onDrainDeadline: async () => { for (const s of [...sessions.values()]) await endSessionRecord(s, 'drain_deadline'); },
            onEndRequested: async (s) => await endSession(s.id, 'end_requested'),
            onLost: async () => { for (const s of [...sessions.values()]) await endSessionRecord(s, 'worker_lost'); return closeAll(); },
            onHeartbeat: async () => { for (const sess of sessions.values()) await store.sessions.setViewers(sess.sessionId, sfu.getViewerCount(sess.sessionId)); },
            activeCount: () => sessions.size + pendingEnds,
            onExit: () => closeAll(),
        },
    });

    // A session with no producers left after having been live is over (its encoder disconnected).
    sfu.on('producer-removed', ({ sessionId }) => {
        const sess = sessions.get(sessionId);
        if (!sess || sess.ended) return;
        if (sfu.hasProducers(sessionId)) return;
        timer(sess, () => { if (!sess.ended && !sfu.hasProducers(sessionId) && sess.live) safe(endSession(sessionId, 'producer_closed'), 'producer gone end'); }, PRODUCER_GONE_GRACE_MS);
    });
    // A *browser* broadcaster goes live when its first video producer appears (Live's
    // broadcast-server rule). A WHIP publisher is different: media can be produced before ICE/DTLS
    // completes, so it only goes live when ICE connects (Live's whip-handler rule, below).
    sfu.on('producer-added', ({ sessionId, kind }) => {
        const sess = sessions.get(sessionId);
        if (sess && sess.mode === 'browser' && kind === 'video') safe(goLive(sess), 'go live');
    });

    signaling = createSignaling({
        sfu,
        iceServers: w.stunUrls,
        log,
        admit: async (key) => {
            const r = await admit(key, 'browser');
            if (r.error) return { error: r.error };
            const sess = sessions.get(r.sessionId);
            startThumbnails(sess);
            return { sessionId: r.sessionId, peerId: r.peerId };
        },
        endSession: async (sessionId, reason) => await endSession(sessionId, reason),
    });

    async function start() {
        if (!sfu.available) throw new Error('mediasoup is not installed (add mediasoup to package.json and npm install)');
        if (!sdpTool.available()) throw new Error('sdp-transform is not installed (add sdp-transform to package.json and npm install)');
        if (config.isProduction && !w.media.announcedIp) throw new Error('MEDIASOUP_ANNOUNCED_IP is required in production (the public address candidates are advertised with)');
        await sfu.init();
        sfu.setAnnouncedIp(w.media.announcedIp);

        // Internal egress API first: it is how this generation is reached.
        egressServer = http.createServer((req, res) => handleEgressHttp(req, res));
        const egressPort = await listenInRange(egressServer, w.internalPortMin, w.internalPortMax);
        endpoints = { publicPort: w.port, publicPorts: [w.port], egressPort, announcedIp: w.media.announcedIp || null };
        await runtime.register(endpoints);

        publicServer = http.createServer((req, res) => handleRequest(req, res));
        publicServer.on('upgrade', (req, socket, head) => { safe((async () => { if (await signaling.handleUpgrade(req, socket, head)) return; socket.destroy(); })(), 'upgrade'); });
        await new Promise((resolve, reject) => {
            publicServer.once('error', reject);
            publicServer.listen({ port: w.port, host: w.bindHost, reusePort: true }, () => resolve());
        });
        publicServer.on('error', (err) => log.error(`[webrtc] public listener ${w.port}: ${err.message}`));
        await runtime.ready();
        log.log(`[webrtc] generation ${runtime.me.generation} ready: whip+signaling ${w.bindHost}:${w.port}, egress 127.0.0.1:${egressPort}`);
        return endpoints;
    }

    return {
        start, runtime, sfu, endpoints: () => endpoints,
        sessions: () => [...sessions.values()],
        drain: async (reason) => await runtime.drainNow(reason),
        close: closeAll,
    };
}

module.exports = { createWebrtc, listenInRange };

if (require.main === module) {
    (async () => {
        require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
        const { load, exitIfDrill } = require('../server/config');
        const { openRuntime } = require('../server/store');
        const config = load();
        exitIfDrill(config, 'openre-webrtc');
        const rt = await openRuntime({ config });
        const worker = createWebrtc({ rt });
        await worker.start();
        for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => worker.drain(sig).catch((err) => console.error(`[webrtc] drain failed on ${sig}: ${err && (err.stack || err.message) || err}`)));
    })().catch((err) => { console.error(`[webrtc] failed to start: ${err && err.stack || err}`); process.exit(1); });
}
