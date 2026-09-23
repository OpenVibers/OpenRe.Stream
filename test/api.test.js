'use strict';
// openre-api: capability guards, owner scoping, keys shown once, destination secrets never
// returned, problem+json, rotation and end requests over HTTP, the playback descriptor.
const assert = require('assert');
const { bootApi, request, serviceToken, userToken, suite, OWNER, OTHER } = require('./helpers');

const t = suite('api');
let api;
const owner = userToken({ subjectId: OWNER });
const other = userToken({ subjectId: OTHER });
const admin = userToken({ subjectId: 'usr_01J0000000000000000000000C', role: 'admin' });
const live = serviceToken('live', ['openre.stream.read', 'openre.stream.write', 'openre.key.rotate', 'openre.session.read', 'openre.session.end', 'openre.output.read', 'openre.output.write']);

t('boot', async () => {
    api = await bootApi();
    const ready = await request(api.base, 'GET', '/api/ready');
    assert.strictEqual(ready.status, 200);
    assert.strictEqual(ready.body.checks.db, true);
    assert.strictEqual(ready.body.checks.key, true);
});

t('anonymous and ungranted callers are refused with problem+json', async () => {
    const r = await request(api.base, 'GET', '/api/v1/streams');
    assert.strictEqual(r.status, 401);
    assert.match(r.headers.get('content-type'), /application\/problem\+json/);
    assert.strictEqual(r.body.code, 'token.missing');
    const noCap = await request(api.base, 'GET', '/api/v1/streams', { token: serviceToken('tools', ['openre.session.read']) });
    assert.strictEqual(noCap.status, 403);
    assert.strictEqual(noCap.body.code, 'capability.denied');
    const wrongAud = await request(api.base, 'GET', '/api/v1/streams', { token: serviceToken('live', ['openre.stream.read'], { aud: 'openvibe.media' }) });
    assert.strictEqual(wrongAud.status, 401);
    const badSubject = await request(api.base, 'GET', '/api/v1/streams', { token: live, headers: { 'X-OV-Subject': 'not-a-subject' } });
    assert.strictEqual(badSubject.status, 400);
});

let streamId;
let firstKey;

t('an owner creates a stream: the key comes back once and never again', async () => {
    const r = await request(api.base, 'POST', '/api/v1/streams', { token: owner, body: { title: 'Evening show', recording_mode: 'vod' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.match(r.body.key.key, /^ork_[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(r.body.stream.owner.id, OWNER);
    assert.strictEqual(r.body.stream.ingest.rtmp.url, `rtmp://127.0.0.1:1936/live`);
    assert.strictEqual(r.body.stream.ingest.rtmp.key_hint, r.body.key.key.slice(-4));
    streamId = r.body.stream.id;
    firstKey = r.body.key.key;
    for (const p of [`/api/v1/streams/${streamId}`, '/api/v1/streams', `/api/v1/streams/${streamId}/keys`]) {
        const g = await request(api.base, 'GET', p, { token: owner });
        assert.strictEqual(g.status, 200, p);
        assert.ok(!g.text.includes(firstKey), `${p} must not return the key`);
        assert.ok(!g.text.includes('key_hash'), `${p} must not return the hash`);
    }
});

t('other owners cannot see or touch the stream; admin staff can read it', async () => {
    assert.strictEqual((await request(api.base, 'GET', `/api/v1/streams/${streamId}`, { token: other })).status, 404);
    assert.strictEqual((await request(api.base, 'POST', `/api/v1/streams/${streamId}/keys/rotate`, { token: other, body: {} })).status, 404);
    assert.deepStrictEqual((await request(api.base, 'GET', '/api/v1/streams', { token: other })).body.streams, []);
    assert.strictEqual((await request(api.base, 'GET', `/api/v1/streams/${streamId}`, { token: admin })).status, 200);
});

t('a service acting for a subject is limited to that owner; external refs resolve', async () => {
    const created = await request(api.base, 'POST', '/api/v1/streams', {
        token: live, headers: { 'X-OV-Subject': OTHER },
        body: { title: 'Slot 44', external_refs: [{ service: 'live', type: 'managed_stream', id: '44' }, { service: 'live', type: 'user', id: '9' }], mirror_to_live: true },
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.stream.owner.id, OTHER);
    const byRef = await request(api.base, 'GET', '/api/v1/streams?external_ref=live:managed_stream:44', { token: live });
    assert.strictEqual(byRef.body.streams[0].id, created.body.stream.id);
    const asOwner = await request(api.base, 'GET', `/api/v1/streams/${streamId}`, { token: live, headers: { 'X-OV-Subject': OTHER } });
    assert.strictEqual(asOwner.status, 404, 'acting for OTHER, the service cannot read OWNER\'s stream');
    const unscoped = await request(api.base, 'GET', `/api/v1/streams/${streamId}`, { token: live });
    assert.strictEqual(unscoped.status, 200, 'without a subject the grant covers every stream');
});

t('rotation over HTTP returns the new key once and the old one stops authenticating', async () => {
    const r = await request(api.base, 'POST', `/api/v1/streams/${streamId}/keys/rotate`, { token: live, body: { grace_seconds: 0 } });
    assert.strictEqual(r.status, 200);
    assert.notStrictEqual(r.body.key.key, firstKey);
    assert.strictEqual(r.body.retired[0].status, 'revoked');
    assert.strictEqual(api.rt.store.definitions.resolveIngestKey(firstKey, 'rtmp').error, 'revoked_key');
    assert.ok(api.rt.store.definitions.resolveIngestKey(r.body.key.key, 'rtmp').definition);
});

t('destinations: validated, masked, never returned in full; SSRF rules apply', async () => {
    const bad = await request(api.base, 'POST', `/api/v1/streams/${streamId}/destinations`, { token: owner, body: { platform: 'custom', server_url: 'file:///etc/passwd', stream_key: 'x' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.code, 'openre.invalid_destination_url');
    const r = await request(api.base, 'POST', `/api/v1/streams/${streamId}/destinations`, { token: owner, body: { platform: 'youtube', name: 'YT', server_url: 'rtmp://a.rtmp.youtube.com/live2', stream_key: 'abcd-efgh-ijkl-mnop' } });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.destination.stream_key_hint, '****mnop');
    const id = r.body.destination.id;
    const list = await request(api.base, 'GET', `/api/v1/streams/${streamId}/destinations`, { token: owner });
    assert.ok(!list.text.includes('abcd-efgh-ijkl-mnop'));
    assert.ok(!list.text.includes('stream_key_enc'));
    const patched = await request(api.base, 'PATCH', `/api/v1/destinations/${id}`, { token: owner, body: { name: 'YouTube main', auto_start: false } });
    assert.strictEqual(patched.body.destination.name, 'YouTube main');
    assert.strictEqual(patched.body.destination.stream_key_hint, '****mnop', 'omitted key is kept');
    const notLive = await request(api.base, 'POST', `/api/v1/destinations/${id}/start`, { token: owner });
    assert.strictEqual(notLive.status, 409);
    assert.strictEqual(notLive.body.code, 'openre.not_live');
    const del = await request(api.base, 'DELETE', `/api/v1/destinations/${id}`, { token: owner });
    assert.strictEqual(del.status, 204);
});

t('the destination test reports URL, DNS and TCP checks without pushing media', async () => {
    const net = require('net');
    const srv = net.createServer((s) => s.destroy());
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const r = await request(api.base, 'POST', `/api/v1/streams/${streamId}/destinations`, { token: owner, body: { platform: 'custom', server_url: `rtmp://127.0.0.1:${srv.address().port}/app`, stream_key: 'k12345' } });
    const test = await request(api.base, 'POST', `/api/v1/destinations/${r.body.destination.id}/test`, { token: owner });
    assert.strictEqual(test.status, 200);
    assert.strictEqual(test.body.ok, true);
    assert.deepStrictEqual(test.body.checks.map(c => c.check), ['url', 'dns', 'stream_key', 'connect']);
    const logs = await request(api.base, 'GET', `/api/v1/destinations/${r.body.destination.id}/logs`, { token: owner });
    assert.match(logs.body.logs[0].message, /^test passed/);
    srv.close();
});

t('sessions: list, detail with playback descriptor, end request', async () => {
    const rt = api.rt;
    const w = rt.store.workers.register({ kind: 'rtmp-ingest', endpoints: { publicPort: 1936, rtmpPlayPort: 19370, flvPort: 19371 } });
    rt.store.workers.ready(w.id);
    const def = rt.store.definitions.get(streamId);
    const a = rt.store.sessions.admit({ definition: def, key: null, protocol: 'rtmp', worker: rt.store.workers.get(w.id) });
    rt.store.sessions.transition(a.session.id, 'live');
    const list = await request(api.base, 'GET', '/api/v1/sessions?state=live', { token: owner });
    assert.deepStrictEqual(list.body.sessions.map(s => s.id), [a.session.id]);
    const detail = await request(api.base, 'GET', `/api/v1/sessions/${a.session.id}`, { token: owner });
    assert.strictEqual(detail.body.session.playback.flv.internal_url, `http://127.0.0.1:19371/live/${a.session.id}.flv`);
    assert.strictEqual(detail.body.session.playback.flv.public_url, `${api.config.baseUrl}/play/${a.session.id}.flv`);
    assert.deepStrictEqual(detail.body.session.transitions.map(x => x.to_state), ['starting', 'live']);
    assert.strictEqual((await request(api.base, 'GET', `/api/v1/sessions/${a.session.id}`, { token: other })).status, 404);
    const noEndCap = await request(api.base, 'POST', `/api/v1/sessions/${a.session.id}/end`, { token: serviceToken('live', ['openre.session.read']) });
    assert.strictEqual(noEndCap.status, 403);
    const end = await request(api.base, 'POST', `/api/v1/sessions/${a.session.id}/end`, { token: owner });
    assert.strictEqual(end.status, 202);
    assert.strictEqual(rt.store.sessions.get(a.session.id).desired_state, 'end');
    // Archiving is refused while it is open.
    const del = await request(api.base, 'DELETE', `/api/v1/streams/${streamId}`, { token: owner });
    assert.strictEqual(del.status, 409);
    rt.store.sessions.finish(a.session.id, { reason: 'test' });
    assert.strictEqual((await request(api.base, 'GET', `/play/${a.session.id}.flv`)).status, 404, 'no playback for an ended session');
});

t('workers are visible to staff and services only', async () => {
    assert.strictEqual((await request(api.base, 'GET', '/api/v1/workers', { token: owner })).status, 403);
    const w = await request(api.base, 'GET', '/api/v1/workers', { token: admin });
    assert.strictEqual(w.status, 200);
    assert.ok(w.body.workers.length >= 1);
});

t('close', async () => { await api.close(); });

t.run();
