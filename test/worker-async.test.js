'use strict';
// Async hardening in the workers (the PostgreSQL sweep): a promise the worker runtime or the RTMP
// admission path used to drop now has a handler. Node 22 ends the process on an unhandled rejection,
// and on an RTMP worker that would drop every publisher it carries, so each of these is a regression
// test for one dropped promise — remove the `.catch` and the test sees the rejection.
const assert = require('assert');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { runtime, testEnv, tmpDir, child, suite, ROOT } = require('./helpers');
const { createWorkerRuntime } = require('../workers/runtime');
const { admissionChain } = require('../workers/rtmp-ingest');
const { pruneOutbox } = require('../workers/coordinator');
const { createSignaling } = require('../workers/webrtc/signaling');

const t = suite('worker-async');

/** Run fn while collecting the process's unhandled rejections (adding a listener suppresses Node's exit). */
async function withUnhandled(fn) {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try { await fn(); await new Promise((r) => setTimeout(r, 30)); } finally { process.removeListener('unhandledRejection', onUnhandled); }
    return unhandled;
}

t('the worker runtime handles a failing stop(): it is logged, not an unhandled rejection', async () => {
    const rt = await runtime();
    const errors = [];
    const wr = createWorkerRuntime({
        rt, kind: 'restream', exit: () => {},
        log: { log() {}, warn() {}, error: (m) => errors.push(String(m)) },
        hooks: { activeCount: () => 1 },
    });
    await wr.register({});
    rt.store.workers.stop = async () => { throw new Error('stop boom'); };
    const unhandled = await withUnhandled(() => { wr.stop(); });
    assert.deepStrictEqual(unhandled, [], 'store.workers.stop returns a promise; dropping it surfaces here');
    assert.ok(errors.some((m) => /stop boom/.test(m)), 'the failure is logged');
});

t('an RTMP admission whose async success handler rejects is logged, not unhandled', async () => {
    // The production call discards the chain's promise; so must this test, or the await would hide the bug.
    const errors = [];
    const log = { log() {}, warn() {}, error: (m) => errors.push(String(m)) };
    const unhandled = await withUnhandled(() => {
        admissionChain(
            Promise.resolve({ sessionId: 'ses_000000000000000000000000' }),
            async () => { throw new Error('finish boom'); },
            () => errors.push('onFailed'),
            log,
        );
    });
    assert.deepStrictEqual(unhandled, [], 'a rejection inside the async success handler must be caught');
    assert.ok(errors.some((m) => /\[rtmp\] admission failed: Error: finish boom/.test(m)), 'it is logged');
    assert.ok(!errors.includes('onFailed'), 'onFailed handles only a rejection of admission itself');
});

t('the coordinator handles a failing outbox prune: logged, not an unhandled rejection', async () => {
    // The 6-hour timer discards the promise, so a rejection would end the coordinator unhandled.
    const errors = [];
    const unhandled = await withUnhandled(() => {
        pruneOutbox({ prune: async () => { throw new Error('prune boom'); } }, { error: (m) => errors.push(String(m)) });
    });
    assert.deepStrictEqual(unhandled, []);
    assert.ok(errors.some((m) => /prune boom/.test(m)), 'the failure is logged');
    // A synchronous throw (an absent outbox) takes the same path, as the old try/catch did.
    const syncErrors = [];
    const syncUnhandled = await withUnhandled(() => {
        pruneOutbox({ prune: () => { throw new Error('sync boom'); } }, { error: (m) => syncErrors.push(String(m)) });
    });
    assert.deepStrictEqual(syncUnhandled, []);
    assert.ok(syncErrors.some((m) => /sync boom/.test(m)));
});

t('the restream worker boot awaits start(): a register failure is reported, not left unhandled', async () => {
    const dir = tmpDir();
    const preload = path.join(ROOT, 'test', 'fixtures', 'fail-worker-register.js');
    const p = child('workers/restream-worker.js', { ...await testEnv(dir), NODE_OPTIONS: `--require ${preload}` });
    const r = await p.exited;
    assert.strictEqual(r.code, 1, p.output);
    // Without the await, the boot IIFE resolves and the rejection is unhandled: Node prints its own
    // stack and this process-owned line never appears.
    assert.match(p.output, /\[restream-worker\] failed to start: Error: register boom/);
});

t('the signaling broadcaster close handles a failing endSession(): logged, not unhandled', async () => {
    // A browser broadcaster's ws 'close' ends its session through an async call the handler never
    // awaits: without a handler a rejected endSession ends the whole WebRTC worker (Node 22) and
    // drops every other session on it.
    const errors = [];
    const log = { log() {}, warn() {}, error: (m) => errors.push(String(m)) };
    const closed = [];
    const signaling = createSignaling({
        sfu: { closePeer: () => {}, hasRouter: () => true },
        iceServers: [],
        log,
        admit: async () => ({ sessionId: 'ses_000000000000000000000000', peerId: 'bc-1' }),
        endSession: async (sessionId, reason) => { closed.push([sessionId, reason]); throw new Error('end boom'); },
    });
    const server = http.createServer((_req, res) => res.end());
    server.on('upgrade', (req, socket, head) => { signaling.handleUpgrade(req, socket, head).catch(() => {}); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/b/ork_somekey`);
    const unhandled = await withUnhandled(async () => {
        await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
        await new Promise((resolve) => { ws.on('close', resolve); ws.close(); });
        await new Promise((r) => setTimeout(r, 30));
    });
    await new Promise((r) => server.close(r));
    signaling.closeAll();
    assert.deepStrictEqual(unhandled, [], 'a rejection of endSession() must be caught');
    assert.ok(closed.some(([, reason]) => reason === 'broadcaster_disconnected'), `the session end was attempted: ${JSON.stringify(closed)}`);
    assert.ok(errors.some((m) => /broadcaster close could not end ses_.*: Error: end boom/.test(m)), `the failure is logged: ${JSON.stringify(errors)}`);
});

t.run();
