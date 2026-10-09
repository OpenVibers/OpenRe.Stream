'use strict';
// The WebRTC worker's store-level and pure behaviour, without mediasoup or PostgreSQL: config
// defaults, the WHIP SDP bridge, the { webrtc } playback descriptor, thumbnails (grab + Media
// object upload + openre.session.updated) and the coordinator's WebRTC RTP recording path, all
// against stubs. The real mediasoup end-to-end lives in webrtc-e2e.test.js (needs PostgreSQL).
const assert = require('assert');
const crypto = require('crypto');
const { load } = require('../server/config');
const sdp = require('../workers/webrtc/sdp');
const { webrtcArgs } = require('../workers/restream/ffmpeg-args');
const { createThumbnailer } = require('../workers/thumbnails');
const { createMediaClient } = require('../server/media-client');
const { runtime, tmpDir, suite, OWNER, outboxEnvelopes } = require('./helpers');

const t = suite('webrtc');

/** A minimal but real WHIP offer (VP8 + a DTLS fingerprint built at runtime, as a browser sends). */
function fixtureOffer() {
    const fp = crypto.randomBytes(32).toString('hex').match(/.{2}/g).join(':').toUpperCase();
    return [
        'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0',
        'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
        'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 0.0.0.0',
        'a=ice-ufrag:abcd', 'a=ice-pwd:abcdefghijklmnopqrstuvwx', 'a=ice-options:trickle',
        `a=fingerprint:sha-256 ${fp}`, 'a=setup:actpass', 'a=mid:0', 'a=sendonly', 'a=rtcp-mux',
        'a=rtpmap:96 VP8/90000', 'a=rtcp-fb:96 nack', 'a=rtcp-fb:96 nack pli', 'a=rtcp-fb:96 goog-remb',
        'a=ssrc:11111111 cname:test', 'a=ssrc:11111111 msid:stream track', '',
    ].join('\r\n');
}

t('config: the WebRTC ports never collide with Live and the RTC range is OpenRestream\'s own', () => {
    const c = load({});
    assert.strictEqual(c.webrtc.port, 9936);
    assert.strictEqual(c.webrtc.media.minPort, 10200);
    assert.strictEqual(c.webrtc.media.maxPort, 10300);
    assert.notStrictEqual(c.webrtc.media.minPort, 10000, 'never Live\'s range');
    assert.strictEqual(c.webrtc.media.workers, 1);
    assert.deepStrictEqual(c.webrtc.media.mediaCodecs.map(x => x.mimeType), ['audio/opus', 'video/VP8', 'video/H264']);
    assert.strictEqual(load({ MEDIASOUP_ANNOUNCED_IP: '203.0.113.7' }).webrtc.media.announcedIp, '203.0.113.7');
    assert.strictEqual(load({ OPENRE_WEBRTC_STUN: 'stun:a:1,stun:b:2' }).webrtc.stunUrls.length, 2);
});

t('WHIP SDP: parse, DTLS role, RTP parameters and the answer', () => {
    if (!sdp.available()) { console.log('  skip  sdp-transform not installed'); return; }
    const offer = sdp.parse(fixtureOffer());
    assert.strictEqual(sdp.getDtlsSetupAttribute(offer), 'actpass');
    const dtls = sdp.extractDtlsParameters(offer);
    assert.strictEqual(dtls.role, 'client', 'actpass → the remote is the DTLS client');
    assert.strictEqual(dtls.fingerprints[0].algorithm, 'sha-256');

    const caps = {
        codecs: [{ mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 96 }],
        headerExtensions: [],
    };
    const rtp = sdp.extractRtpParameters(offer.media[0], caps, 0);
    assert.strictEqual(rtp.codecs[0].mimeType, 'video/VP8');
    assert.deepStrictEqual(rtp.encodings[0], { ssrc: 11111111 });
    assert.strictEqual(rtp.mid, '0');

    const transport = { iceParameters: { usernameFragment: 'uf', password: 'pw' }, iceCandidates: [{ foundation: '1', protocol: 'udp', priority: 1, ip: '203.0.113.7', port: 10200, type: 'host' }], dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }] } };
    const answer = sdp.buildSdpAnswer(transport, offer, { video: { rtpParameters: rtp } }, { serverName: 'OpenRestream' });
    const parsedAnswer = sdp.parse(answer);
    assert.strictEqual(parsedAnswer.media[0].direction, 'recvonly');
    assert.strictEqual(parsedAnswer.media[0].setup, 'passive');
    assert.strictEqual(parsedAnswer.icelite, 'ice-lite');
    assert.match(answer, /a=rtpmap:96 VP8\/90000/);
});

t('WHIP PATCH sdpfrag: credentials, candidates, end-of-candidates; malformed bodies throw', () => {
    const trickle = sdp.parseIceFragment('a=ice-ufrag:EsAw\r\na=ice-pwd:P2uYro0UCOQ4zxjKXaWCBui1\r\na=ice-options:trickle\r\na=ice-pacing:50\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n'
        + 'a=candidate:1387637174 1 udp 2122260223 192.0.2.1 61764 typ host generation 0 ufrag EsAw network-id 1\r\n'
        + 'a=candidate:3471623853 1 udp 2122194687 198.51.100.2 61765 typ host\r\na=end-of-candidates\r\n');
    assert.deepStrictEqual(trickle, {
        ufrag: 'EsAw', pwd: 'P2uYro0UCOQ4zxjKXaWCBui1', candidates: 2, endOfCandidates: true,
        iceOptions: 'trickle', icePacing: '50', iceLite: false,
    });
    // Media-level credentials count too; a bare candidate list has none.
    assert.strictEqual(sdp.parseIceFragment('m=video 9 UDP/TLS/RTP/SAVPF 96\na=ice-ufrag:abc\n').ufrag, 'abc');
    assert.deepStrictEqual(sdp.parseIceFragment('a=candidate:1 1 tcp 5 192.0.2.1 9 typ host tcptype active\n'), {
        ufrag: null, pwd: null, candidates: 1, endOfCandidates: false, iceOptions: null, icePacing: null, iceLite: false,
    });
    assert.strictEqual(sdp.parseIceFragment('').candidates, 0);
    assert.strictEqual(sdp.parseIceFragment('a=ice-lite\r\n').iceLite, true);
    for (const bad of ['hello', '{"candidate":"x"}', 'a=candidate:garbage', undefined]) {
        assert.throws(() => sdp.parseIceFragment(bad), (err) => err.code === 'invalid_sdpfrag', `rejects ${bad}`);
    }

    // The restart answer is the server's new credentials plus exactly the attributes the request
    // fragment carried (RFC 9725 §4.3.3): nothing is assumed, ice-lite is not hard-coded.
    const frag = sdp.buildIceFragment({ usernameFragment: 'u1', password: 'p1' });
    assert.deepStrictEqual(sdp.parseIceFragment(frag), {
        ufrag: 'u1', pwd: 'p1', candidates: 0, endOfCandidates: false, iceOptions: null, icePacing: null, iceLite: false,
    });
    assert.ok(!/ice-lite/.test(frag), 'the server does not claim ice-lite the client never sent');

    const mirrored = sdp.parseIceFragment(sdp.buildIceFragment({ usernameFragment: 'u2', password: 'p2' }, trickle));
    assert.deepStrictEqual(mirrored, { ...trickle, ufrag: 'u2', pwd: 'p2', candidates: 0 });
    assert.deepStrictEqual(
        sdp.parseIceFragment(sdp.buildIceFragment({ usernameFragment: 'u3', password: 'p3' }, sdp.parseIceFragment('a=ice-lite\r\na=ice-options:trickle\r\n'))),
        { ufrag: 'u3', pwd: 'p3', candidates: 0, endOfCandidates: false, iceOptions: 'trickle', icePacing: null, iceLite: true },
    );
});

t('behind the TLS vhost (OPENRE_WEBRTC_PUBLIC_PORT=443) the viewer signaling URL is wss:// with no port', async () => {
    const rt = await runtime({ dir: tmpDir(), env: { MEDIASOUP_ANNOUNCED_IP: '203.0.113.7', OPENRE_WEBRTC_PUBLIC_PORT: '443', OPENRE_WEBRTC_PUBLIC_HOST: 'ingest.openre.stream' } });
    const { definition, key } = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['webrtc'] });
    const w = await rt.store.workers.register({ kind: 'webrtc', endpoints: { publicPort: 9936, egressPort: 19810 } });
    await rt.store.workers.ready(w.id);
    const a = await rt.store.sessions.admit({ definition, key, protocol: 'webrtc', worker: await rt.store.workers.get(w.id) });
    await rt.store.sessions.transition(a.session.id, 'live', { reason: 'media_flowing', actor: 'worker:w' });
    const pb = await rt.store.sessions.playback(await rt.store.sessions.get(a.session.id));
    // The worker listens on loopback 9936; nginx serves it on 443, which is what a browser must use.
    assert.strictEqual(pb.webrtc.signaling_url, `wss://ingest.openre.stream/w/${a.session.id}`);
});

t('a webrtc session playback descriptor is { signaling_url, announced_ip } and carries thumbnail_url', async () => {
    const rt = await runtime({ dir: tmpDir(), env: { MEDIASOUP_ANNOUNCED_IP: '203.0.113.7' } });
    const { definition, key } = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['webrtc'] });
    const w = await rt.store.workers.register({ kind: 'webrtc', endpoints: { publicPort: 9936, egressPort: 19810 } });
    await rt.store.workers.ready(w.id);
    const a = await rt.store.sessions.admit({ definition, key, protocol: 'webrtc', worker: await rt.store.workers.get(w.id) });
    await rt.store.sessions.transition(a.session.id, 'live', { reason: 'media_flowing', actor: 'worker:w' });

    const pb = await rt.store.sessions.playback(await rt.store.sessions.get(a.session.id));
    assert.deepStrictEqual(Object.keys(pb.webrtc).sort(), ['announced_ip', 'signaling_url']);
    assert.strictEqual(pb.webrtc.signaling_url, `ws://127.0.0.1:9936/w/${a.session.id}`);
    assert.ok(!pb.webrtc.signaling_url.includes(key.key), 'the key is never in the viewer URL');
    assert.strictEqual(pb.webrtc.announced_ip, '203.0.113.7');
    assert.strictEqual(pb.thumbnail_url, null);

    // The ingest endpoints an encoder/UI needs.
    const ep = await rt.store.definitions.ingestEndpoints(await rt.store.definitions.get(definition.id));
    assert.strictEqual(ep.webrtc.whip_url, 'http://127.0.0.1:9936/whip');
    assert.strictEqual(ep.webrtc.signaling_url, 'ws://127.0.0.1:9936/b');
    rt.db.close();
});

t('a thumbnail is recorded on the session and emits openre.session.updated once', async () => {
    const rt = await runtime({ dir: tmpDir() });
    const { definition } = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['webrtc'] });
    const w = await rt.store.workers.register({ kind: 'webrtc', endpoints: { publicPort: 9936, egressPort: 19810 } });
    await rt.store.workers.ready(w.id);
    const a = await rt.store.sessions.admit({ definition, key: null, protocol: 'webrtc', worker: await rt.store.workers.get(w.id) });
    await rt.store.sessions.transition(a.session.id, 'live', { reason: 'media_flowing', actor: 'worker:w' });

    assert.strictEqual(await rt.store.sessions.setThumbnail(a.session.id, 'https://media.test/o/t1'), true);
    assert.strictEqual(await rt.store.sessions.setThumbnail(a.session.id, 'https://media.test/o/t1'), false, 'unchanged → no second event');
    const s = await rt.store.sessions.get(a.session.id);
    assert.strictEqual(s.thumbnail_url, 'https://media.test/o/t1');
    const ev = (await outboxEnvelopes(rt.db)).filter(e => e.event_type === 'openre.session.updated');
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].payload.thumbnail_url, 'https://media.test/o/t1');
    rt.db.close();
});

t('a grabber captures a frame (ffmpeg stdout) and uploads it to Media as an object', async () => {
    const rt = await runtime({ dir: tmpDir() });
    const { definition } = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['rtmp'] });
    const w = await rt.store.workers.register({ kind: 'rtmp-ingest', endpoints: {} });
    await rt.store.workers.ready(w.id);
    const a = await rt.store.sessions.admit({ definition, key: null, protocol: 'rtmp', worker: await rt.store.workers.get(w.id) });
    await rt.store.sessions.transition(a.session.id, 'live', { reason: 'media_flowing', actor: 'worker:w' });

    const uploads = [];
    const media = { configured: true, uploadObject: async (o) => { uploads.push(o); return { id: 'o1', url: 'https://media.test/o/o1' }; } };
    // A fake ffmpeg: emits a JPEG-ish buffer on stdout and exits 0.
    const fakeSpawn = () => {
        const { EventEmitter } = require('events');
        const p = new EventEmitter();
        p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
        p.kill = () => {};
        setImmediate(() => { p.stdout.emit('data', Buffer.alloc(4000, 1)); p.emit('close', 0); });
        return p;
    };
    const th = createThumbnailer({ config: rt.config, media, spawnImpl: fakeSpawn });
    assert.strictEqual(th.enabled, true);
    const buf = await th.capture(['-i', 'http://127.0.0.1/x.flv']);
    assert.ok(buf && buf.length === 4000);
    const url = await th.publish(rt.store, a.session.id, buf, { protocol: 'rtmp' });
    assert.strictEqual(url, 'https://media.test/o/o1');
    assert.strictEqual(uploads[0].namespace, 'live');
    assert.strictEqual(uploads[0].mimeType, 'image/jpeg');
    assert.strictEqual((await rt.store.sessions.get(a.session.id)).thumbnail_url, url);
    rt.db.close();
});

t('media-client.uploadObject does init → PUT → complete', async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method || 'GET' });
        if (String(url).endsWith('/objects')) return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'o1', upload: { url: 'https://m/o1/content', complete_url: 'https://m/o1/complete', method: 'PUT' } }) };
        if (String(url).endsWith('/o1/content')) return { ok: true, status: 200, text: async () => '' };
        if (String(url).endsWith('/o1/complete')) return { ok: true, status: 200, text: async () => JSON.stringify({ object: { id: 'o1', public_url: 'https://media.test/o/o1' } }) };
        return { ok: false, status: 404, text: async () => '{}' };
    };
    const config = load({ MEDIA_URL: 'http://127.0.0.1:4100', MEDIA_API_KEY: 'k'.repeat(40), MEDIA_APP_ID: 'live' });
    const media = createMediaClient({ config, fetchImpl });
    const r = await media.uploadObject({ namespace: 'live', mimeType: 'image/jpeg', filename: 'x.jpg', bytes: Buffer.alloc(10, 1) });
    assert.strictEqual(r.url, 'https://media.test/o/o1');
    assert.deepStrictEqual(calls.map(c => c.method), ['POST', 'PUT', 'POST']);
    assert.ok(calls[0].url.includes('/api/v2/live/objects'));
});

t('restream args: webrtcArgs reads the worker\'s SDP file and re-encodes', () => {
    const args = webrtcArgs('/tmp/x.sdp', 'rtmp://example/app/key', { videoBitrate: '3000k', maxrate: '3500k', bufsize: '3000k', audioBitrate: '128k', preset: 'veryfast', scale: '1280:720', fps: 30, gop: 60 }, { hasAudio: true });
    assert.strictEqual(args[args.indexOf('-i') + 1], '/tmp/x.sdp');
    assert.ok(args.includes('-protocol_whitelist'));
    assert.strictEqual(args[args.indexOf('-protocol_whitelist') + 1], 'file,rtp,udp');
    assert.ok(args.includes('libx264'));
    assert.strictEqual(args[args.length - 1], 'rtmp://example/app/key');
});

t('the coordinator records a webrtc session through Media\'s RTP ingest and closes the egress', async () => {
    const egress = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = String(url);
        egress.push(`${opts.method || 'GET'} ${u}`);
        if (u.endsWith('/describe')) return { ok: true, status: 200, text: async () => JSON.stringify({ video: { payloadType: 96, codec: 'VP8', clockRate: 90000 }, audio: null }) };
        if (u.includes('/rtp/') && (opts.method || 'GET') === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ handle: 'h1', sdp: 'v=0\r\n', transports: ['t1'] }) };
        if (u.includes('/rtp/') && opts.method === 'DELETE') return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
        return { ok: false, status: 404, text: async () => '{}' };
    };
    const rt = await runtime({ dir: tmpDir(), env: { OPENRE_RECORDING_START_DELAY_MS: '0' }, fetchImpl });
    const { definition } = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['webrtc'], recording_mode: 'vod' });
    const w = await rt.store.workers.register({ kind: 'webrtc', endpoints: { publicPort: 9936, egressPort: 19810 } });
    await rt.store.workers.ready(w.id);
    const a = await rt.store.sessions.admit({ definition, key: null, protocol: 'webrtc', worker: await rt.store.workers.get(w.id) });
    await rt.store.sessions.transition(a.session.id, 'live', { reason: 'media_flowing', actor: 'worker:w' });

    const calls = [];
    const media = {
        configured: true, appId: 'live',
        createVod: async () => { calls.push('createVod'); return { id: 'vod1' }; },
        ingestRtpStart: async (vodId, codecs) => { calls.push(`ingestRtpStart:${codecs.video.codec}`); return { videoPort: 12000, audioPort: 12002 }; },
        ingestRtpStop: async () => { calls.push('ingestRtpStop'); },
        finalizeVod: async () => { calls.push('finalizeVod'); },
        deleteVod: async () => {},
    };
    assert.strictEqual(await rt.store.recordings.ensureRequests(), 1);
    await rt.store.recordings.process(media);
    let rec = await rt.store.recordings.bySession(a.session.id);
    assert.strictEqual(rec.state, 'recording');
    assert.strictEqual(rec.rtp_handle, 'h1');
    assert.ok(egress.some(e => e.includes('/describe')));
    assert.ok(calls.includes('ingestRtpStart:VP8'), 'Media was asked for RTP ports with the codec');

    await rt.store.sessions.finish(a.session.id, { reason: 'test', actor: 'w' });
    await rt.store.recordings.process(media);
    rec = await rt.store.recordings.bySession(a.session.id);
    assert.strictEqual(rec.state, 'finalized');
    assert.ok(calls.includes('ingestRtpStop'));
    assert.ok(calls.includes('finalizeVod'));
    assert.ok(egress.some(e => e.startsWith('DELETE')), 'the egress consumer was closed');
    rt.db.close();
});

t.run();
