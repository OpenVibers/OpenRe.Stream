'use strict';
// ADR-009 acceptance: "Deploying the OpenRe API does not end worker-owned transports."
// The API runs as its own process; a fake worker process owns a live session. The API is stopped
// (SIGTERM, as systemd does on a deploy), the session stays live and its lease keeps being renewed
// by the worker; a new API process starts and serves the same live session.
const assert = require('assert');
const path = require('path');
const { tmpDir, testEnv, child, waitFor, request, userToken, freePort, sleep, suite, OWNER } = require('./helpers');
const { load } = require('../server/config');
const { openRuntime } = require('../server/store');

const t = suite('api-restart');
const dir = tmpDir();
let env;
let api;
let fake;
let sessionId;
let workerId;
const token = userToken({ subjectId: OWNER });

async function startApi() {
    const p = child('server/index.js', env);
    const base = `http://127.0.0.1:${env.PORT}`;
    await waitFor(async () => { try { return (await request(base, 'GET', '/api/ready')).status === 200; } catch { return false; } }, { what: 'openre-api ready' });
    return { proc: p, base };
}

t('setup: API process + fake worker process holding a live session', async () => {
    env = testEnv(dir, { PORT: String(await freePort()), OPENRE_WORKER_HEARTBEAT_MS: '200', OPENRE_WORKER_LEASE_MS: '1500' });
    const rt = openRuntime({ config: load(env), log: { log() {}, warn() {}, error() {} } });
    const { definition } = rt.store.definitions.create({ owner_subject: OWNER, title: 'Restart test' });
    rt.db.close();
    api = await startApi();
    fake = child(path.join('test', 'fixtures', 'fake-worker.js'), { ...env, FAKE_STREAM_ID: definition.id });
    await waitFor(() => /SESSION (ses_\S+) WORKER (wrk_\S+)/.test(fake.output), { what: 'fake worker session' });
    [, sessionId, workerId] = /SESSION (ses_\S+) WORKER (wrk_\S+)/.exec(fake.output);
    const r = await request(api.base, 'GET', `/api/v1/sessions/${sessionId}`, { token });
    assert.strictEqual(r.body.session.state, 'live');
});

t('stopping the API (SIGTERM) leaves the worker process and its session alone', async () => {
    const rt = openRuntime({ config: load(env), log: { log() {}, warn() {}, error() {} } });
    const leaseBefore = rt.store.sessions.get(sessionId).lease_expires_at;
    api.proc.kill('SIGTERM');
    const exit = await api.proc.exited;
    assert.strictEqual(exit.code, 0, 'the API exits cleanly');
    // Longer than a lease: if anything depended on the API, the session would now be failing.
    await sleep(2500);
    assert.strictEqual(fake.exitCode, null, 'fake worker still running');
    const s = rt.store.sessions.get(sessionId);
    assert.strictEqual(s.state, 'live');
    assert.ok(s.lease_expires_at > leaseBefore, 'the worker kept renewing its lease while the API was down');
    assert.strictEqual(rt.store.workers.get(workerId).state, 'ready');
    rt.db.close();
});

t('a new API process serves the same live session', async () => {
    api = await startApi();
    const r = await request(api.base, 'GET', `/api/v1/sessions/${sessionId}`, { token });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.session.state, 'live');
    assert.strictEqual(r.body.session.worker.id, workerId);
    assert.deepStrictEqual(r.body.session.transitions.map(x => x.to_state), ['starting', 'live'], 'no transition happened across the restart');
});

t('teardown', async () => {
    api.proc.kill('SIGTERM');
    fake.kill('SIGKILL');
    await Promise.all([api.proc.exited, fake.exited]);
});

t.run();
