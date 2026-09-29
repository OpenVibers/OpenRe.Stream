'use strict';
// T4 naming + the JSMPEG worker's store-level behaviour, without ffmpeg or PostgreSQL: 'whip' is
// an input alias for 'webrtc'; the worker kinds are one per transport; a jsmpeg session's playback
// descriptor is { jsmpeg: { ws_url, width, height } } (plus the loopback tap) and its viewers are
// reported; recording for jsmpeg is refused with a clear reason and an event.
const assert = require('assert');
const { runtime, tmpDir, suite, OWNER, outboxEnvelopes } = require('./helpers');

const t = suite('jsmpeg');

t('naming: whip is an input alias, and the worker kinds are one per transport', async () => {
    const rt = await runtime({ dir: tmpDir() });
    assert.deepStrictEqual(rt.store.workers.KINDS, ['rtmp-ingest', 'restream', 'webrtc', 'jsmpeg']);

    const a = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['whip'] });
    assert.deepStrictEqual(a.definition.protocols, ['webrtc'], 'whip is stored as webrtc');
    const b = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['whip', 'webrtc', 'jsmpeg'] });
    assert.deepStrictEqual(b.definition.protocols, ['webrtc', 'jsmpeg'], 'deduplicated after aliasing');
    await assert.rejects(() => rt.store.definitions.create({ owner_subject: OWNER, protocols: ['sfu'] }), /protocols must be/);

    await assert.rejects(() => rt.store.workers.register({ kind: 'webrtc-ingest' }), /unknown worker kind/);
    await assert.rejects(() => rt.store.workers.register({ kind: 'sfu' }), /unknown worker kind/);
    const w = await rt.store.workers.register({ kind: 'webrtc', endpoints: {} });
    assert.strictEqual(w.kind, 'webrtc');
    rt.db.close();
});

t('a jsmpeg session playback descriptor: ws_url by playback id, width/height, the tap, viewers', async () => {
    const rt = await runtime({ dir: tmpDir() });
    const { definition, key } = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['jsmpeg'] });
    const w = await rt.store.workers.register({ kind: 'jsmpeg', endpoints: { publicPort: 9736, publicPorts: [9736], tapPort: 19710 } });
    await rt.store.workers.ready(w.id);

    const a = await rt.store.sessions.admit({ definition, key, protocol: 'jsmpeg', worker: await rt.store.workers.get(w.id) });
    await rt.store.sessions.setMediaInfo(a.session.id, { width: 640, height: 360 });
    await rt.store.sessions.transition(a.session.id, 'live', { reason: 'media_flowing', actor: 'worker:w' });
    await rt.store.sessions.setViewers(a.session.id, 3);

    const s = await rt.store.sessions.get(a.session.id);
    assert.strictEqual(s.viewers, 3, 'the heartbeat viewer count is on the session');
    const pb = await rt.store.sessions.playback(s);
    assert.deepStrictEqual(Object.keys(pb.jsmpeg).sort(), ['height', 'tap_internal_url', 'width', 'ws_url']);
    assert.strictEqual(pb.jsmpeg.ws_url, `ws://127.0.0.1:9736/${a.session.id}`);
    assert.ok(!pb.jsmpeg.ws_url.includes(key.key), 'the key is never in the viewer URL');
    assert.strictEqual(pb.jsmpeg.width, 640);
    assert.strictEqual(pb.jsmpeg.height, 360);
    assert.strictEqual(pb.jsmpeg.tap_internal_url, `http://127.0.0.1:19710/tap/${a.session.id}.ts`);
    rt.db.close();
});

t('a jsmpeg session with recording on is refused with a clear reason and an event', async () => {
    const rt = await runtime({ dir: tmpDir(), env: { OPENRE_RECORDING_START_DELAY_MS: '0' } });
    const { definition } = await rt.store.definitions.create({ owner_subject: OWNER, protocols: ['jsmpeg'], recording_mode: 'vod' });
    const w = await rt.store.workers.register({ kind: 'jsmpeg', endpoints: { publicPort: 9736, tapPort: 19710 } });
    await rt.store.workers.ready(w.id);
    const a = await rt.store.sessions.admit({ definition, key: null, protocol: 'jsmpeg', worker: await rt.store.workers.get(w.id) });
    await rt.store.sessions.transition(a.session.id, 'live', { reason: 'media_flowing', actor: 'worker:w' });

    const never = () => { throw new Error('Media must not be called for a jsmpeg recording'); };
    const media = { configured: true, createVod: never, ingestRtmp: never, finalizeVod: never, deleteVod: never };
    assert.strictEqual(await rt.store.recordings.ensureRequests(), 1);
    await rt.store.recordings.process(media);

    const rec = await rt.store.recordings.bySession(a.session.id);
    assert.strictEqual(rec.state, 'failed');
    assert.strictEqual(rec.last_error, 'recording is not available for jsmpeg');
    const ev = (await outboxEnvelopes(rt.db)).find(e => e.event_type === 'openre.recording.failed');
    assert.ok(ev, 'a recording.failed event is emitted');
    assert.strictEqual(ev.payload.reason, 'recording is not available for jsmpeg');
    assert.strictEqual(ev.payload.protocol, 'jsmpeg');
    rt.db.close();
});

t.run();
