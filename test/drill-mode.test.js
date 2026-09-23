'use strict';
// OPENRE_DRILL (ovhost restore drills): openre-api serves reads from a restored copy and nothing
// else; the coordinator and every transport worker refuse to start (before opening the database);
// no event relay and no Media calls, whatever else the production env file sets.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { load } = require('../server/config');
const { createEvents } = require('../server/events');
const { createMediaClient } = require('../server/media-client');
const { createCoordinator } = require('../server/coordinator');
const { createRtmpIngest } = require('../workers/rtmp-ingest');
const { createRestreamWorker } = require('../workers/restream-worker');
const { createUnportedTransport } = require('../workers/unported-transport');
const { openDb } = require('../server/db');
const { runtime, bootApi, request, serviceToken, tmpDir, testEnv, child, suite, silent } = require('./helpers');

const t = suite('drill-mode');
// What the production env file sets: with these, a non-drill process would publish and record.
const PROD_LIKE = { EVENTS_URL: 'http://127.0.0.1:9', OV_OAUTH_CLIENT_SECRET: 'x'.repeat(40), MEDIA_URL: 'http://127.0.0.1:9', MEDIA_API_KEY: 'k'.repeat(40) };
const reader = serviceToken('live', ['openre.stream.read', 'openre.stream.write', 'openre.session.read']);

t('OPENRE_DRILL parses like the other switches and is off by default', () => {
    assert.strictEqual(load({}).drill, false);
    for (const v of ['1', 'true', 'on', 'yes']) assert.strictEqual(load({ OPENRE_DRILL: v }).drill, true, v);
    for (const v of ['', '0', 'false', 'off']) assert.strictEqual(load({ OPENRE_DRILL: v }).drill, false, v);
});

t('no event relay and no Media client in a drill, even with production credentials', () => {
    const on = load(testEnv(tmpDir(), PROD_LIKE));
    const off = load(testEnv(tmpDir(), { ...PROD_LIKE, OPENRE_DRILL: '1' }));
    const db = openDb(':memory:');
    assert.strictEqual(createEvents({ config: on, db, log: silent }).configured, true, 'control: the same env publishes outside a drill');
    const ev = createEvents({ config: off, db, log: silent });
    assert.strictEqual(ev.configured, false);
    assert.strictEqual(ev.start(), false, 'the relay does not start');
    assert.strictEqual(createMediaClient({ config: on }).configured, true, 'control');
    assert.strictEqual(createMediaClient({ config: off }).configured, false);
    db.close();
});

t('the coordinator and every transport worker refuse to be created in a drill', () => {
    const rt = runtime({ env: { OPENRE_DRILL: '1' } });
    const drill = (fn) => assert.throws(fn, (err) => err.code === 'OPENRE_DRILL' && /restore drill/.test(err.message));
    drill(() => createCoordinator({ rt, media: null, log: silent }));
    drill(() => createRtmpIngest({ rt, log: silent, exit: () => {} }));
    drill(() => createRestreamWorker({ rt, log: silent, exit: () => {} }));
    for (const kind of ['webrtc-ingest', 'sfu', 'jsmpeg']) drill(() => createUnportedTransport({ rt, kind, log: silent, exit: () => {} }));
    assert.strictEqual(rt.db.prepare('SELECT count(*) AS n FROM workers').get().n, 0, 'no generation registered');
    assert.strictEqual(rt.db.prepare('SELECT count(*) AS n FROM leases').get().n, 0, 'no coordinator lease taken');
});

t('the entry points exit before opening the database', async () => {
    for (const script of ['workers/coordinator.js', 'workers/rtmp-ingest.js', 'workers/restream-worker.js', 'workers/sfu.js']) {
        const dir = tmpDir();
        const p = child(script, testEnv(dir, { ...PROD_LIKE, OPENRE_DRILL: '1' }));
        const r = await p.exited;
        assert.strictEqual(r.code, 1, `${script} exit code`);
        assert.match(p.output, /does not run in a restore drill/, script);
        assert.ok(!fs.existsSync(path.join(dir, 'openre.db')), `${script} must not create or touch the database`);
    }
});

t('openre-api in a drill: reads work and match a normal instance; writes, /play/ and sign-in are refused', async () => {
    const dir = tmpDir();
    const normal = await bootApi({ dir });
    const created = await request(normal.base, 'POST', '/api/v1/streams', { token: reader, headers: { 'X-OV-Subject': 'usr_01J0000000000000000000000A' }, body: { title: 'Restored' } });
    assert.strictEqual(created.status, 201);
    const health = await request(normal.base, 'GET', '/api/health');
    const list = await request(normal.base, 'GET', '/api/v1/streams', { token: reader });
    const outboxBefore = normal.rt.db.prepare('SELECT count(*) AS n FROM event_outbox').get().n;
    await normal.close();

    const drill = await bootApi({ dir, env: { ...PROD_LIKE, OPENRE_DRILL: '1' } });
    try {
        const ready = await request(drill.base, 'GET', '/api/ready');
        assert.strictEqual(ready.status, 200);
        assert.strictEqual(ready.body.mode, 'drill');
        assert.strictEqual(ready.body.events.configured, false);
        const h = await request(drill.base, 'GET', '/api/health');
        assert.strictEqual(h.text, health.text, '/api/health is byte-identical (ovhost compares it)');
        const l = await request(drill.base, 'GET', '/api/v1/streams', { token: reader });
        assert.strictEqual(l.status, 200);
        assert.deepStrictEqual(l.body, list.body, 'reads come from the restored copy');
        const robots = await request(drill.base, 'GET', '/robots.txt');
        assert.strictEqual(robots.status, 200);

        const write = await request(drill.base, 'POST', '/api/v1/streams', { token: reader, headers: { 'X-OV-Subject': 'usr_01J0000000000000000000000A' }, body: { title: 'x' } });
        assert.strictEqual(write.status, 503);
        assert.strictEqual(write.body.code, 'openre.drill_read_only');
        const patch = await request(drill.base, 'PATCH', `/api/v1/streams/${created.body.stream.id}`, { token: reader, body: { title: 'y' } });
        assert.strictEqual(patch.status, 503);
        const play = await request(drill.base, 'GET', '/play/ses_01J00000000000000000000000.flv');
        assert.strictEqual(play.status, 503);
        const login = await request(drill.base, 'GET', '/auth/login');
        assert.strictEqual(login.status, 503);
        const count = drill.rt.db.prepare('SELECT count(*) AS n FROM stream_definitions').get().n;
        assert.strictEqual(count, 1, 'nothing was written');
        assert.strictEqual(drill.rt.db.prepare('SELECT count(*) AS n FROM event_outbox').get().n, outboxBefore, 'no event enqueued');
    } finally {
        await drill.close();
    }
});

t.run();
