'use strict';
// End to end for the WebRTC worker with real mediasoup and a real headless WebRTC client (werift, the
// Node peer Live also uses): a WHIP publisher's offer is answered and goes live when ICE connects, a
// PlainRTP egress carries its RTP, a WS viewer consumes by playback id and is counted in the
// heartbeat, a browser broadcaster produces over /b/<key>, admission refuses a bad key / a wrong
// protocol / a duplicate slot, the coordinator records the session through Media's RTP ingest, a
// lost lease ends the sessions and a drain closes the listener and exits.
//
// It needs mediasoup and werift, which are NOT installed in this repo (installs are not available
// here): run it through the checkout that has them,
//   NODE_PATH=<OpenVibe.Live>/node_modules npm test -- webrtc-e2e
// and it prints a skip line (not a failure) everywhere else.
const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const http = require('http');
const WebSocket = require('ws');
const { createWebrtc } = require('../workers/webrtc');
const { runtime, freePort, waitFor, sleep, suite, silent, OWNER } = require('./helpers');

let werift;
try {
    werift = require('werift');
    require.resolve('mediasoup');
} catch (err) {
    console.log('webrtc-e2e: skipped (mediasoup/werift not installed; run with NODE_PATH=<OpenVibe.Live>/node_modules)');
    process.exit(0);
}

const t = suite('webrtc-e2e');

function httpReq(port, method, path, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function wsOpen(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.inbox = [];
        ws.on('message', (d) => { try { ws.inbox.push(JSON.parse(d)); } catch { /* ignore */ } });
        ws.on('error', () => {});
        ws.once('open', () => resolve(ws));
        ws.once('unexpected-response', (req, res) => reject(new Error(`http ${res.statusCode}`)));
        ws.once('error', (err) => reject(err));
    });
}
const wsSend = (ws, obj) => ws.send(JSON.stringify(obj));
const wsWait = (ws, type, timeoutMs = 8000) => waitFor(() => ws.inbox.find((m) => m.type === type), { what: `ws ${type}`, timeoutMs });

/** A fingerprinted DTLS fragment a client sends (format-valid; mediasoup does not handshake here). */
const fakeFingerprint = () => ({ fingerprints: [{ algorithm: 'sha-256', value: crypto.randomBytes(32).toString('hex').match(/.{2}/g).join(':').toUpperCase() }] });

/** Feed a track with VP8 RTP at a steady rate, the way a browser/encoder would. */
function startDummyVideo(track, { fps = 30 } = {}) {
    const KEYFRAME = Buffer.from([0x10, 0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x02, 0x00, 0x02, 0x00]);
    const DELTA = Buffer.from([0x10, 0x11, 0x00, 0x00]);
    let seq = 0x4000;
    let timestamp = 0;
    let n = 0;
    const timer = setInterval(() => {
        const header = new werift.RtpHeader({ version: 2, payloadType: 96, sequenceNumber: seq++, timestamp, ssrc: 0x1a2b3c00, marker: true });
        track.writeRtp(new werift.RtpPacket(header, n % fps === 0 ? KEYFRAME : DELTA));
        timestamp += 3000;
        n++;
    }, 1000 / fps);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
}

let rt;
let worker;
let exits;
let port;
let defA;
let keyA;
let sessionA;
let pub;
let udp;
let mediaPort;
const mediaCalls = [];

t('setup: a real worker generation with mediasoup', async () => {
    port = await freePort();
    const rtcMin = 20000 + Math.floor(Math.random() * 20000);
    const egressMin = await freePort();
    rt = await runtime({
        env: {
            OPENRE_WEBRTC_PORT: String(port),
            OPENRE_WEBRTC_BIND: '127.0.0.1',
            OPENRE_WEBRTC_INTERNAL_PORT_MIN: String(egressMin),
            OPENRE_WEBRTC_INTERNAL_PORT_MAX: String(egressMin + 20),
            OPENRE_MEDIASOUP_MIN_PORT: String(rtcMin),
            OPENRE_MEDIASOUP_MAX_PORT: String(rtcMin + 60),
            MEDIASOUP_ANNOUNCED_IP: '127.0.0.1',
            OPENRE_WORKER_HEARTBEAT_MS: '300',
            OPENRE_DRAIN_MAX_MS: '900',
            OPENRE_RECORDING_START_DELAY_MS: '0',
            OPENRE_THUMBNAILS: 'off',
        },
    });
    exits = [];
    worker = createWebrtc({ rt, log: silent, exit: (code) => exits.push(code) });
    await worker.start();
    assert.strictEqual(worker.runtime.me.state, 'ready');
    assert.ok(worker.runtime.me.generation >= 1);
    assert.ok(worker.endpoints().egressPort > 0, 'the loopback egress endpoint is published');
});

t('a WHIP offer is answered, goes live on ICE, and a PlainRTP egress receives its RTP', async () => {
    const created = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['webrtc'], recording_mode: 'vod', title: 'WebRTC A' });
    defA = created.definition;
    keyA = created.key.key;

    const pc = new werift.RTCPeerConnection({});
    const track = new werift.MediaStreamTrack({ kind: 'video' });
    pc.addTransceiver(track, { direction: 'sendonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const res = await httpReq(port, 'POST', `/whip/${keyA}`, { headers: { 'content-type': 'application/sdp' }, body: pc.localDescription.sdp });
    assert.strictEqual(res.status, 201, `WHIP answer (${res.status}): ${res.body.slice(0, 200)}`);
    assert.match(res.body, /a=recvonly/, 'the answer is a recvonly SDP');
    assert.match(res.body, /a=ice-lite/);
    assert.match(res.headers.location, /\/whip\/session\/[0-9a-f]{16,}$/, 'Location points at the session resource');
    assert.match(String(res.headers.etag), /^"/, 'an ETag is returned');

    await pc.setRemoteDescription({ type: 'answer', sdp: res.body });
    pub = { pc, track, feed: startDummyVideo(track), resourceId: res.headers.location.split('/').pop() };
    await waitFor(() => ['connected', 'completed'].includes(pc.connectionState), { what: 'WHIP publisher ICE connected', timeoutMs: 20000 });

    const sess = await waitFor(async () => { const s = (await rt.store.sessions.ofWorker(worker.runtime.me.id)).find((x) => x.definition_id === defA.id); return s && s.state === 'live' ? s : null; }, { what: 'session live after ICE', timeoutMs: 15000 });
    sessionA = sess.id;
    const pb = await rt.store.sessions.playback(sess);
    assert.ok(pb.webrtc.signaling_url.endsWith(`/w/${sessionA}`));
    assert.ok(!pb.webrtc.signaling_url.includes(keyA), 'the key is never in the viewer URL');

    // A PlainRTP consumer (what restream / Media's RTP recorder / thumbnails use) must receive media.
    udp = dgram.createSocket('udp4');
    await new Promise((r) => udp.bind(0, '127.0.0.1', r));
    udp.packets = 0;
    udp.on('message', () => { udp.packets++; });
    const vport = udp.address().port;
    const egress = await httpReq(worker.endpoints().egressPort, 'GET', `/rtp/${sessionA}?vport=${vport}`);
    assert.strictEqual(egress.status, 200, `egress descriptor (${egress.status}): ${egress.body}`);
    const desc = JSON.parse(egress.body);
    assert.match(desc.sdp, /m=video \d+ RTP\/AVP/);
    assert.ok(desc.handle);
    udp.handle = desc.handle;
    await waitFor(() => udp.packets > 0, { what: 'RTP on the PlainRTP egress', timeoutMs: 20000 });

    const patch = await httpReq(port, 'PATCH', `/whip/session/${pub.resourceId}`, { headers: { 'content-type': 'application/trickle-ice-sdpfrag' }, body: 'a=ice-ufrag:x\r\na=candidate:1 1 udp 1 127.0.0.1 9999 typ host\r\n' });
    assert.strictEqual(patch.status, 204, 'trickle ICE is acknowledged');
});

t('a WS viewer consumes by playback id and is counted in the heartbeat', async () => {
    const playback = await rt.store.sessions.playback(await rt.store.sessions.get(sessionA));
    const ws = await wsOpen(playback.webrtc.signaling_url);
    const welcome = await wsWait(ws, 'welcome');
    assert.strictEqual(welcome.role, 'viewer');
    wsSend(ws, { type: 'watch' });
    const ready = await wsWait(ws, 'sfu-viewer-ready');
    assert.ok(ready.rtpCapabilities.codecs.length > 0);
    const video = ready.producers.find((p) => p.kind === 'video');
    assert.ok(video, 'the WHIP video producer is advertised to the viewer');

    wsSend(ws, { type: 'sfu-viewer-create-transport' });
    const transport = await wsWait(ws, 'sfu-viewer-transport-created');
    assert.ok(transport.iceCandidates.length > 0);
    wsSend(ws, { type: 'sfu-viewer-connect-transport', transportId: transport.id, dtlsParameters: { role: 'client', ...fakeFingerprint() } });
    await wsWait(ws, 'sfu-viewer-transport-connected');
    wsSend(ws, { type: 'sfu-viewer-consume', transportId: transport.id, producerId: video.id, rtpCapabilities: ready.rtpCapabilities });
    const consumed = await wsWait(ws, 'sfu-viewer-consumed');
    assert.strictEqual(consumed.kind, 'video');

    await worker.runtime.beat();
    const s = await waitFor(async () => { const x = await rt.store.sessions.get(sessionA); return x.viewers >= 1 ? x : null; }, { what: 'viewer count in the heartbeat', timeoutMs: 8000 });
    assert.ok(s.viewers >= 1, 'the consumer peer is counted');
    ws.close();
});

t('the coordinator records the session through Media\'s RTP ingest over the real egress', async () => {
    mediaPort = await freePort();
    const media = {
        configured: true,
        appId: 'live',
        createVod: async () => { mediaCalls.push('createVod'); return { id: 'vod-e2e' }; },
        ingestRtpStart: async (vodId, codecs) => { mediaCalls.push(`ingestRtpStart:${codecs.video.codec}`); return { videoPort: mediaPort, audioPort: null }; },
        ingestRtpStop: async () => { mediaCalls.push('ingestRtpStop'); },
        finalizeVod: async () => { mediaCalls.push('finalizeVod'); },
        deleteVod: async () => { mediaCalls.push('deleteVod'); },
    };
    assert.strictEqual(await rt.store.recordings.ensureRequests(), 1);
    await rt.store.recordings.process(media);
    let rec = await rt.store.recordings.bySession(sessionA);
    assert.strictEqual(rec.state, 'recording');
    assert.ok(rec.rtp_handle, 'the worker egress handle is remembered');
    assert.strictEqual(rec.rtp_video_port, mediaPort);
    assert.ok(mediaCalls.includes('ingestRtpStart:VP8'), 'Media was asked for RTP ports with the codec');
});

t('a browser broadcaster produces over /b/<key> and goes live', async () => {
    const created = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['webrtc'], title: 'WebRTC B' });
    const ws = await wsOpen(`ws://127.0.0.1:${port}/b/${created.key.key}`);
    const welcome = await wsWait(ws, 'welcome');
    assert.strictEqual(welcome.role, 'broadcaster');
    wsSend(ws, { type: 'sfu-get-capabilities' });
    const caps = await wsWait(ws, 'sfu-capabilities');
    assert.ok(caps.rtpCapabilities.codecs.length > 0);
    wsSend(ws, { type: 'sfu-create-transport' });
    const transport = await wsWait(ws, 'sfu-transport-created');
    wsSend(ws, { type: 'sfu-connect-transport', transportId: transport.id, dtlsParameters: { role: 'client', ...fakeFingerprint() } });
    await wsWait(ws, 'sfu-transport-connected');
    wsSend(ws, {
        type: 'sfu-produce', transportId: transport.id, kind: 'video',
        rtpParameters: { mid: '0', codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, parameters: {}, rtcpFeedback: [] }], headerExtensions: [], encodings: [{ ssrc: 24681012 }] },
    });
    const produced = await wsWait(ws, 'sfu-produced');
    assert.strictEqual(produced.kind, 'video');
    const live = await waitFor(async () => {
        const s = (await rt.store.sessions.ofWorker(worker.runtime.me.id)).find((x) => x.definition_id === created.definition.id);
        return s && s.state === 'live' ? s : null;
    }, { what: 'browser session live', timeoutMs: 8000 });
    assert.strictEqual(live.protocol, 'webrtc');

    // Admission while this slot is already open is refused.
    await assert.rejects(() => wsOpen(`ws://127.0.0.1:${port}/b/${created.key.key}`), /http 403/, 'a duplicate broadcaster is refused');
    ws.close();
});

t('admission refuses a bad key and a wrong-protocol key', async () => {
    await assert.rejects(() => wsOpen(`ws://127.0.0.1:${port}/b/ork_${'x'.repeat(43)}`), /http 403/, 'bad key refused');
    const wrong = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['rtmp'] });
    await assert.rejects(() => wsOpen(`ws://127.0.0.1:${port}/b/${wrong.key.key}`), /http 403/, 'rtmp-only slot refused on the WebRTC listener');
});

t('DELETE ends the WHIP session', async () => {
    const res = await httpReq(port, 'DELETE', `/whip/session/${pub.resourceId}`);
    assert.strictEqual(res.status, 200);
    const s = await waitFor(async () => { const x = await rt.store.sessions.get(sessionA); return ['ended', 'failed'].includes(x.state) ? x : null; }, { what: 'WHIP session ended', timeoutMs: 8000 });
    assert.strictEqual(s.state, 'ended');
    pub.feed.stop();
    pub.pc.close();
});

t('a lost lease ends the worker\'s sessions and exits', async () => {
    const port2 = await freePort();
    const rtcMin = 20000 + Math.floor(Math.random() * 20000);
    const egressMin = await freePort();
    const rt2 = await runtime({ env: {
        OPENRE_WEBRTC_PORT: String(port2), OPENRE_WEBRTC_BIND: '127.0.0.1',
        OPENRE_WEBRTC_INTERNAL_PORT_MIN: String(egressMin), OPENRE_WEBRTC_INTERNAL_PORT_MAX: String(egressMin + 20),
        OPENRE_MEDIASOUP_MIN_PORT: String(rtcMin), OPENRE_MEDIASOUP_MAX_PORT: String(rtcMin + 60),
        MEDIASOUP_ANNOUNCED_IP: '127.0.0.1', OPENRE_WORKER_HEARTBEAT_MS: '300', OPENRE_THUMBNAILS: 'off',
    } });
    const exits2 = [];
    const w2 = createWebrtc({ rt: rt2, log: silent, exit: (code) => exits2.push(code) });
    await w2.start();
    const created = await rt2.store.definitions.create({ owner_subject: OWNER, protocols: ['webrtc'] });
    // Admit through the real signaling path so the session lives in the worker's own map.
    const ws = await wsOpen(`ws://127.0.0.1:${port2}/b/${created.key.key}`);
    await wsWait(ws, 'welcome');
    const sess = await waitFor(async () => (await rt2.store.sessions.ofWorker(w2.runtime.me.id))[0], { what: 'admitted session' });
    await rt2.store.workers.lose(w2.runtime.me.id, 'test');
    await w2.runtime.beat();
    await waitFor(() => exits2.length > 0, { what: 'lost worker exit', timeoutMs: 8000 });
    assert.strictEqual(exits2[0], 1, 'a lost worker exits non-zero');
    const s = await waitFor(async () => { const x = await rt2.store.sessions.get(sess.id); return ['ended', 'failed'].includes(x.state) ? x : null; }, { what: 'session ended after lease loss', timeoutMs: 8000 });
    assert.ok(s, 'the session is not left live');
    ws.close();
    await w2.close();
});

t('a drain closes the listener, ends what is left and exits cleanly', async () => {
    await worker.drain('test');
    const refused = await waitFor(async () => {
        try { await httpReq(port, 'POST', `/whip/${keyA}`, { body: 'v=0' }); return false; } catch (err) { return /ECONNREFUSED/.test(err.message); }
    }, { what: 'the public listener closed to new sessions', timeoutMs: 5000 });
    assert.ok(refused, 'the public listener is closed to new sessions');
    await waitFor(() => exits.length > 0, { what: 'drained worker exit', timeoutMs: 10000 });
    assert.strictEqual(exits[0], 0, 'a drained generation exits 0');
    if (udp) { try { udp.close(); } catch { /* gone */ } }
});

t('teardown', async () => {
    await sleep(50);
    if (worker) await worker.close().catch(() => {});
});

t.run();
