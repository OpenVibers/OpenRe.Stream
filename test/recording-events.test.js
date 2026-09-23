'use strict';
// Recording requests (Media contract as Live's recorder uses it) and the event relay (outbox →
// OpenVibe.Events with OpenRe's service token), with stub Media / Network / Events servers.
const assert = require('assert');
const http = require('http');
const { runtime, manualClock, suite, OWNER, silent, outboxTypes } = require('./helpers');
const { createCoordinator } = require('../server/coordinator');
const { createMediaClient } = require('../server/media-client');

const t = suite('recording-events');

function stub(handler) {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => { let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; } handler(req, res, parsed, body); });
        });
        s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(r => { s.closeAllConnections(); s.close(r); }) }));
    });
}
const reply = (res, status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj || {})); };

async function setup({ media: mediaHandler, recording_mode = 'vod' }) {
    const calls = [];
    const media = await stub((req, res, body) => { calls.push({ method: req.method, url: req.url, body, auth: req.headers.authorization }); mediaHandler(req, res, body, calls); });
    const clock = manualClock();
    const rt = runtime({ clock, env: { MEDIA_URL: media.url, MEDIA_API_KEY: 'k-live', OPENRE_RECORDING_START_DELAY_MS: '0' } });
    const client = createMediaClient({ config: rt.config });
    const coordinator = createCoordinator({ rt, media: client, log: silent });
    const { definition, key } = rt.store.definitions.create({ owner_subject: OWNER, title: 'Rec', recording_mode, external_refs: [{ service: 'live', type: 'user', id: '8' }] });
    const w = rt.store.workers.register({ kind: 'rtmp-ingest', endpoints: { rtmpPlayPort: 19390, flvPort: 19391 } });
    rt.store.workers.ready(w.id);
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: rt.store.workers.get(w.id) });
    rt.store.sessions.transition(a.session.id, 'live');
    return { rt, clock, coordinator, session: a.session, calls, media };
}

t('a live session gets one recording request; finalize when it ends (Media finalises)', async () => {
    const { rt, coordinator, session, calls, media } = await setup({
        media: (req, res) => {
            if (req.url === '/api/v1/live/vods') return reply(res, 201, { id: 501 });
            if (req.url === '/api/v1/live/vods/501/ingest/rtmp') return reply(res, 202, { status: 'recording' });
            if (req.url === '/api/v1/live/vods/501/finalize') return reply(res, 200, {});
            return reply(res, 404);
        },
    });
    await coordinator.tick();
    await coordinator.tick();
    assert.deepStrictEqual(calls.map(c => `${c.method} ${c.url}`), ['POST /api/v1/live/vods', 'POST /api/v1/live/vods/501/ingest/rtmp']);
    assert.strictEqual(calls[0].auth, 'Bearer k-live');
    assert.strictEqual(calls[0].body.user_id, 8);
    assert.strictEqual(calls[0].body.visibility, 'public');
    assert.strictEqual(calls[1].body.rtmp_url, `rtmp://127.0.0.1:19390/live/${session.id}`);
    assert.strictEqual(rt.store.recordings.bySession(session.id).state, 'recording');
    assert.deepStrictEqual(outboxTypes(rt.db).filter(x => x.startsWith('openre.recording')), ['openre.recording.requested']);
    rt.store.sessions.finish(session.id, { reason: 'publisher_disconnected' });
    await coordinator.tick();
    assert.strictEqual(calls.pop().url, '/api/v1/live/vods/501/finalize');
    assert.strictEqual(rt.store.recordings.bySession(session.id).state, 'finalized');
    await media.close();
});

t('Media refusing for disk space: the empty VOD shell is deleted and the request retried later', async () => {
    let refuse = true;
    const { rt, clock, coordinator, session, calls, media } = await setup({
        media: (req, res) => {
            if (req.method === 'POST' && req.url === '/api/v1/live/vods') return reply(res, 201, { id: 600 + calls.length });
            if (req.url.endsWith('/ingest/rtmp')) return refuse ? reply(res, 409, { error: 'Disk critically low — recording refused' }) : reply(res, 202, {});
            if (req.method === 'DELETE') return reply(res, 200, {});
            return reply(res, 404);
        },
    });
    await coordinator.tick();
    assert.deepStrictEqual(calls.map(c => c.method), ['POST', 'POST', 'DELETE'], 'create, ingest refused, shell deleted');
    const rec = rt.store.recordings.bySession(session.id);
    assert.strictEqual(rec.state, 'pending');
    assert.match(rec.last_error, /Disk/);
    assert.ok(rec.next_attempt_at >= clock.now() + 5 * 60 * 1000, 'disk refusals wait five minutes');
    refuse = false;
    clock.advance(5 * 60 * 1000 + 1);
    rt.store.workers.heartbeat(session.worker_id); // the ingest worker is alive throughout
    await coordinator.tick();
    assert.strictEqual(rt.store.recordings.bySession(session.id).state, 'recording');
    await media.close();
});

t('clips-only recordings are deleted after finalising; a session that ends first is never requested', async () => {
    const { rt, coordinator, session, calls, media } = await setup({
        recording_mode: 'clips',
        media: (req, res) => {
            if (req.url === '/api/v1/live/vods') return reply(res, 201, { id: 700 });
            if (req.method === 'DELETE') return reply(res, 200, {});
            return reply(res, req.url.endsWith('/finalize') ? 200 : 202, {});
        },
    });
    await coordinator.tick();
    assert.strictEqual(calls[0].body.clips_only, true);
    rt.store.sessions.finish(session.id, { reason: 'x' });
    await coordinator.tick();
    assert.deepStrictEqual(calls.slice(-2).map(c => `${c.method} ${c.url}`), ['POST /api/v1/live/vods/700/finalize', 'DELETE /api/v1/live/vods/700']);
    await media.close();

    const s2 = await setup({ media: (req, res) => reply(res, 500) });
    s2.rt.store.sessions.finish(s2.session.id, { reason: 'gone' });
    s2.rt.db.prepare("INSERT INTO recordings (id, session_id, mode, state, created_at, updated_at) VALUES ('rec_01J0000000000000000000000A', ?, 'vod', 'pending', 0, 0)").run(s2.session.id);
    await s2.coordinator.tick();
    assert.strictEqual(s2.rt.store.recordings.bySession(s2.session.id).state, 'cancelled');
    assert.strictEqual(s2.calls.length, 0);
    await s2.media.close();
});

t('the relay publishes outbox rows with a Network service token; Events down means rows wait', async () => {
    let down = true;
    const got = [];
    const events = await stub((req, res, body) => {
        if (down) return reply(res, 503, { code: 'events.unavailable' });
        assert.strictEqual(req.headers.authorization, 'Bearer svc-token');
        const list = body.events || [body];
        list.forEach(e => got.push(e));
        return reply(res, 200, body.events ? { results: list.map((e, i) => ({ event_id: e.event_id, seq: i + 1 })) } : { event_id: list[0].event_id, seq: 1 });
    });
    const network = await stub((req, res, body, raw) => {
        const p = new URLSearchParams(raw);
        assert.strictEqual(p.get('grant_type'), 'client_credentials');
        assert.strictEqual(p.get('client_id'), 'openre');
        assert.strictEqual(p.get('audience'), 'openvibe.events');
        reply(res, 200, { access_token: 'svc-token', token_type: 'Bearer', expires_in: 300 });
    });
    const rt = runtime({ env: { EVENTS_URL: events.url, OV_NETWORK_INTERNAL_URL: network.url, OV_OAUTH_CLIENT_SECRET: 's3cret' } });
    assert.strictEqual(rt.events.configured, true);
    const { definition } = rt.store.definitions.create({ owner_subject: OWNER });
    rt.store.definitions.rotateKey(definition.id, { rotated_by: OWNER });
    await rt.events.outbox.flush();
    assert.strictEqual(rt.events.outbox.pending(), 1, 'kept while Events is down');
    down = false;
    rt.db.prepare('UPDATE event_outbox SET next_attempt_at = 0').run();
    await rt.events.outbox.flush();
    assert.strictEqual(rt.events.outbox.pending(), 0);
    assert.strictEqual(got[0].event_type, 'openre.key.rotated');
    assert.strictEqual(got[0].source, 'openre');
    await events.close();
    await network.close();
});

t('without EVENTS_URL the relay is off but every row is still written with its change', () => {
    const rt = runtime();
    assert.strictEqual(rt.events.configured, false);
    assert.strictEqual(rt.events.start(), false);
    const { definition } = rt.store.definitions.create({ owner_subject: OWNER });
    rt.store.definitions.rotateKey(definition.id);
    assert.strictEqual(rt.events.status().pending, 1);
});

t.run();
