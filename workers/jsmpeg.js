'use strict';
/**
 * openre-jsmpeg — the JSMPEG transport worker (unit openre-jsmpeg@<release>.service).
 *
 * The relay Live runs in-process (OpenVibe.Live server/streaming/jsmpeg-relay.js), with the
 * lifecycle and ownership moved here:
 *
 *   public   0.0.0.0:OPENRE_JSMPEG_PORT (9736 until the JSMPEG cutover), SO_REUSEPORT so two
 *            generations can listen during a drain. The broadcaster's ffmpeg POSTs MPEG-TS to
 *            http://<host>:<port>/<key>/<w>/<h>/, and viewers connect over WebSocket to
 *            ws://<host>:<port>/<session playback id> (never the key).
 *   internal 127.0.0.1:<tapPort>  GET /tap/<session>.ts streams the raw MPEG-TS for restream.
 *            The port is this generation's own (from OPENRE_JSMPEG_INTERNAL_PORT_MIN..MAX) and is
 *            published in its worker row, so consumers always reach the process that holds the
 *            publisher.
 *
 * Admission is key-in-path exactly like RTMP: resolveIngestKey with protocol 'jsmpeg', one open
 * session per definition. The session goes live on the first bytes and ends when the POST closes.
 *
 * Viewers only ever receive, so the WebSocket server is the ~30 lines that takes the upgrade and
 * writes unmasked binary frames; no ws dependency is needed.
 *
 * Drain: when the coordinator marks this generation draining (a newer one is ready) the public
 * listener closes — new encoders and viewers reach the new generation through the shared port — and
 * running sessions stay until they leave or the drain deadline passes. Then the process exits by
 * itself. SIGTERM starts the same drain; it never drops a live session.
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { createWorkerRuntime } = require('./runtime');
const { createThumbnailer } = require('./thumbnails');
const { createMediaClient } = require('../server/media-client');

const SESSION_ID_RE = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;
const INGEST_PATH_RE = /^\/([^/]+)\/(\d{1,5})\/(\d{1,5})\/?$/;
const TAP_PATH_RE = /^\/tap\/(ses_[0-9A-HJKMNP-TV-Z]{26})\.ts$/;
const MAX_WS_BACKPRESSURE = 512 * 1024;
const MAX_ADMISSION_BUFFER = 4 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;

/** One unmasked WebSocket frame (the server never masks). */
function wsFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.allocUnsafe(2); header[0] = 0x80 | opcode; header[1] = len; }
    else if (len < 65536) { header = Buffer.allocUnsafe(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.allocUnsafe(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([header, payload]);
}

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

function createJsmpeg({ rt, log = console, exit = (code) => process.exit(code), fetchImpl, spawnImpl }) {
    const { store, config } = rt;
    const j = config.jsmpeg;
    const thumbnails = createThumbnailer({ config, log, media: createMediaClient({ config, ...(fetchImpl ? { fetchImpl } : {}) }), ...(spawnImpl ? { spawnImpl } : {}) });
    /** session id → { sessionId, definitionId, width, height, req, ended, live, endReason, viewers:Set, taps:Set } */
    const channels = new Map();
    // Ends in flight. The heartbeat calls exitWhenIdle() every beat; without this an ended session
    // whose `finish` write has not committed yet would let the drained process exit before it lands,
    // leaving the session live until the coordinator fails it lease_expired.
    let pendingEnds = 0;
    let ingestServer = null;
    let tapServer = null;
    let endpoints = null;

    const runtime = createWorkerRuntime({
        rt, kind: 'jsmpeg', log, exit,
        hooks: {
            onDrain: () => closePublic(),
            onDrainDeadline: async () => await endAll('drain_deadline'),
            onEndRequested: async (s) => await endSession(s.id, 'end_requested'),
            onLost: async () => { for (const ch of [...channels.values()]) await endChannel(ch, 'worker_lost'); return closeAll(); },
            onHeartbeat: async () => { for (const ch of channels.values()) await store.sessions.setViewers(ch.sessionId, ch.viewers.size); },
            activeCount: () => channels.size + pendingEnds,
            onExit: () => closeAll(),
        },
    });

    const actor = () => `worker:${runtime.me && runtime.me.id}`;
    /** Never let a rejected handler — Node 22 ends the worker on an unhandled rejection — drop every session on it. */
    function safe(promise, what) {
        return Promise.resolve(promise).catch((err) => log.error(`[jsmpeg] ${what}: ${err && (err.stack || err.message) || err}`));
    }

    async function admit(key, width, height) {
        if (runtime.draining || !runtime.me || runtime.me.state !== 'ready') return { error: 'generation not taking sessions' };
        if (channels.size >= j.maxPublishersPerWorker) return { error: 'worker full' };
        const r = await store.definitions.resolveIngestKey(key, 'jsmpeg');
        if (r.error) return { error: r.error };
        const a = await store.sessions.admit({ definition: r.definition, key: r.key, protocol: 'jsmpeg', worker: runtime.me });
        if (a.error) return { error: a.error };
        return { sessionId: a.session.id, definitionId: r.definition.id, hint: r.key.hint, width, height };
    }

    function handleIngest(req, res, key, width, height) {
        const buffered = [];
        let bufferedBytes = 0;
        let ch = null;
        let done = false;

        req.on('data', (chunk) => {
            if (ch) { feed(ch, chunk); return; }
            if (bufferedBytes + chunk.length > MAX_ADMISSION_BUFFER) return;
            buffered.push(chunk);
            bufferedBytes += chunk.length;
        });
        req.on('error', () => { if (ch) safe(endChannel(ch, 'publisher_disconnected'), 'error end'); });

        safe((async () => {
            const adm = await admit(key, width, height);
            if (done) return;
            if (adm.error) {
                log.log(`[jsmpeg] publish refused (${adm.error}) from ${req.socket.remoteAddress || '?'}`);
                res.statusCode = 404;
                res.setHeader('content-type', 'text/plain');
                res.end(`refused: ${adm.error}\n`);
                req.destroy();
                return;
            }
            ch = { sessionId: adm.sessionId, definitionId: adm.definitionId, req, width, height, live: false, ended: false, endReason: null, viewers: new Set(), taps: new Set(), thumbTimer: null };
            channels.set(ch.sessionId, ch);
            log.log(`[jsmpeg] session ${ch.sessionId} accepted for ${ch.definitionId} (key …${adm.hint}) at ${width}x${height}`);
            res.writeHead(200, { 'content-type': 'video/mp2t' });
            for (const c of buffered.splice(0)) feed(ch, c);
            bufferedBytes = 0;
        })(), 'admission failed');

        req.on('end', () => {
            done = true;
            try { res.end(); } catch { /* already closed */ }
            if (ch) safe(endChannel(ch, ch.endReason || 'publisher_disconnected'), 'end');
        });
        req.on('close', () => {
            done = true;
            if (ch && !ch.ended) safe(endChannel(ch, ch.endReason || 'publisher_disconnected'), 'close');
        });
    }

    async function ensureLive(ch) {
        if (ch.live || ch.ended) return;
        ch.live = true;
        await store.sessions.setMediaInfo(ch.sessionId, { width: ch.width, height: ch.height });
        const t = await store.sessions.transition(ch.sessionId, 'live', { reason: 'media_flowing', actor: actor() });
        if (!t.ok) {
            // The coordinator failed it meanwhile (lease) — the transport must not outlive its record.
            log.warn(`[jsmpeg] session ${ch.sessionId} could not go live (${t.code}); closing`);
            ch.endReason = 'coordinator_failed';
            try { if (ch.req && !ch.req.destroyed) ch.req.destroy(); } catch { /* gone */ }
            return;
        }
        startThumbnails(ch);
    }

    /** Live thumbnails from this worker's loopback MPEG-TS tap (decision 4). Best effort. */
    function startThumbnails(ch) {
        if (!thumbnails.enabled || ch.thumbTimer || !tapServer) return;
        const tapUrl = `http://127.0.0.1:${tapServer.address().port}/tap/${ch.sessionId}.ts`;
        const grab = async () => {
            try { const buf = await thumbnails.capture(['-f', 'mpegts', '-i', tapUrl]); if (buf) await thumbnails.publish(store, ch.sessionId, buf, { protocol: 'jsmpeg', width: ch.width, height: ch.height }); }
            catch (err) { log.warn(`[jsmpeg] thumbnail ${ch.sessionId}: ${err.message}`); }
        };
        ch.thumbTimer = setInterval(() => grab().catch(() => {}), config.webrtc.thumbnails.intervalMs);
        ch.thumbTimer.unref?.();
        grab().catch(() => {});
    }

    function feed(ch, chunk) {
        if (ch.ended) return;
        if (!ch.live) safe(ensureLive(ch), 'go live');
        for (const v of ch.viewers) {
            if (v.socket.destroyed || v.socket.writableLength > MAX_WS_BACKPRESSURE) continue;
            try { v.socket.write(wsFrame(OP_BINARY, chunk)); } catch { /* socket raced with close */ }
        }
        for (const tap of ch.taps) { try { tap(chunk); } catch { /* tap closed */ } }
    }

    async function endChannel(ch, reason) {
        if (ch.ended) return;
        ch.ended = true;
        channels.delete(ch.sessionId);
        if (ch.thumbTimer) { clearInterval(ch.thumbTimer); ch.thumbTimer = null; }
        pendingEnds++;
        try {
            for (const v of ch.viewers) { try { v.socket.end(wsFrame(OP_CLOSE, Buffer.alloc(0))); } catch { /* gone */ } }
            ch.viewers.clear();
            for (const end of ch.taps) { try { end(); } catch { /* gone */ } }
            ch.taps.clear();
            try { if (ch.req && !ch.req.destroyed) ch.req.destroy(); } catch { /* gone */ }
            await store.sessions.finish(ch.sessionId, { reason, actor: actor() });
            log.log(`[jsmpeg] session ${ch.sessionId} ended (${reason})`);
        } finally {
            pendingEnds--;
        }
        if (runtime.draining) runtime.exitWhenIdle();
    }

    async function endSession(sessionId, reason) {
        const ch = channels.get(sessionId);
        if (ch) { ch.endReason = reason; await endChannel(ch, reason); return true; }
        // Not ours any more (publisher already gone): make sure the record is closed. Counted so a
        // drained generation does not exit before the write lands.
        pendingEnds++;
        try { await store.sessions.finish(sessionId, { reason, actor: actor() }); } finally { pendingEnds--; }
        if (runtime.draining) runtime.exitWhenIdle();
        return false;
    }

    async function endAll(reason) {
        for (const ch of [...channels.values()]) { ch.endReason = reason; await endChannel(ch, reason); }
    }

    function handleUpgrade(req, socket) {
        let pathname;
        try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { socket.destroy(); return; }
        const id = pathname.replace(/^\//, '');
        const ch = SESSION_ID_RE.test(id) ? channels.get(id) : null;
        const key = req.headers['sec-websocket-key'];
        if (!ch || typeof key !== 'string') { socket.destroy(); return; }
        const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.setNoDelay(true);
        const viewer = { socket };
        ch.viewers.add(viewer);
        log.log(`[jsmpeg] viewer connected to ${ch.sessionId} (${ch.viewers.size} total)`);
        const drop = () => { ch.viewers.delete(viewer); };
        socket.on('close', drop);
        socket.on('error', drop);
        // Viewers never send: consume and ignore anything inbound (ping/close frames).
        socket.on('data', () => {});
    }

    function handleTap(req, res) {
        const m = TAP_PATH_RE.exec(new URL(req.url, 'http://127.0.0.1').pathname);
        const ch = m && req.method === 'GET' ? channels.get(m[1]) : null;
        if (!ch) { res.statusCode = 404; return res.end(); }
        res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' });
        const tap = (chunk) => { try { if (!res.writableEnded) res.write(chunk); } catch { /* client gone */ } };
        const end = () => { ch.taps.delete(tap); try { if (!res.writableEnded) res.end(); } catch { /* gone */ } };
        ch.taps.add(tap);
        req.on('close', end);
        return undefined;
    }

    function closePublic() {
        if (!ingestServer) return;
        ingestServer.close();
        log.log('[jsmpeg] public listener closed; running sessions stay until they leave');
    }

    function closeAll() {
        closePublic();
        const closing = [];
        for (const srv of [ingestServer, tapServer]) {
            if (!srv) continue;
            srv.closeAllConnections?.();
            closing.push(new Promise(r => srv.close(() => r())));
        }
        ingestServer = null;
        tapServer = null;
        return Promise.all(closing);
    }

    async function start() {
        // Internal endpoint first: it is how this generation is reached, so it goes in the worker
        // row before it can take a session.
        tapServer = http.createServer((req, res) => { handleTap(req, res); });
        const tapPort = await listenInRange(tapServer, j.internalPortMin, j.internalPortMax);
        endpoints = { publicPort: j.port, publicPorts: [j.port], tapPort };
        await runtime.register(endpoints);

        ingestServer = http.createServer((req, res) => {
            if (req.method !== 'POST') { res.statusCode = 404; return res.end(); }
            const m = INGEST_PATH_RE.exec(new URL(req.url, 'http://127.0.0.1').pathname);
            if (!m) { res.statusCode = 404; return res.end(); }
            handleIngest(req, res, m[1], Number(m[2]), Number(m[3]));
            return undefined;
        });
        ingestServer.on('upgrade', handleUpgrade);
        await new Promise((resolve, reject) => {
            ingestServer.once('error', reject);
            ingestServer.listen({ port: j.port, host: j.bindHost, reusePort: true }, () => resolve());
        });
        ingestServer.on('error', (err) => log.error(`[jsmpeg] public listener ${j.port}: ${err.message}`));
        await runtime.ready();
        log.log(`[jsmpeg] generation ${runtime.me.generation} ready: ingest+ws ${j.bindHost}:${j.port}, tap 127.0.0.1:${tapPort}`);
        return endpoints;
    }

    return {
        start,
        runtime,
        endpoints: () => endpoints,
        channels: () => [...channels.values()],
        drain: async (reason) => await runtime.drainNow(reason),
        close: closeAll,
    };
}

if (require.main === module) {
    (async () => {
        require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
        const { load, exitIfDrill } = require('../server/config');
        const { openRuntime } = require('../server/store');
        const config = load();
        exitIfDrill(config, 'openre-jsmpeg');
        const rt = await openRuntime({ config });
        const worker = createJsmpeg({ rt });
        await worker.start();
        for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => worker.drain(sig).catch((err) => console.error(`[jsmpeg] drain failed on ${sig}: ${err && (err.stack || err.message) || err}`)));
    })().catch((err) => { console.error(`[jsmpeg] failed to start: ${err && err.stack || err}`); process.exit(1); });
}

module.exports = { createJsmpeg, listenInRange };
