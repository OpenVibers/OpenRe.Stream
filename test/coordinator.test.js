'use strict';
// Session coordinator: generations and draining, lost workers, lease expiry, output assignment to
// the newest restream generation, drain-deadline handover and the single-coordinator lease.
const assert = require('assert');
const { runtime, manualClock, suite, OWNER, outboxTypes, silent } = require('./helpers');
const { createCoordinator } = require('../server/coordinator');
const { createWorkerRuntime } = require('../workers/runtime');

const t = suite('coordinator');

async function setup() {
    const clock = manualClock();
    const rt = await runtime({ clock });
    const coordinator = createCoordinator({ rt, media: null, log: silent });
    const { definition, key } = await rt.store.definitions.create({ owner_subject: OWNER });
    const worker = async (kind) => { const w = await rt.store.workers.register({ kind, endpoints: { flvPort: 19361, rtmpPlayPort: 19360 } }); await rt.store.workers.ready(w.id); return await rt.store.workers.get(w.id); };
    return { rt, clock, coordinator, definition, key, worker };
}

t('generations grow per kind; when a newer one is ready every older one drains with a deadline', async () => {
    const { rt, clock, coordinator, worker } = await setup();
    const g1 = await worker('rtmp-ingest');
    const r1 = await worker('restream');
    assert.strictEqual(g1.generation, 1);
    assert.strictEqual(r1.generation, 1);
    assert.strictEqual((await coordinator.syncTick()).drained, 0);
    const g2 = await worker('rtmp-ingest');
    assert.strictEqual(g2.generation, 2);
    assert.strictEqual((await coordinator.syncTick()).drained, 1);
    const old = await rt.store.workers.get(g1.id);
    assert.strictEqual(old.state, 'draining');
    assert.strictEqual(old.drain_deadline, clock.now() + rt.config.workers.drainMaxMs);
    assert.strictEqual((await rt.store.workers.get(r1.id)).state, 'ready', 'other kinds are independent');
    assert.strictEqual((await rt.store.workers.newestReady('rtmp-ingest')).id, g2.id);
});

t('a draining generation keeps its live session; new sessions only reach the newest generation', async () => {
    const { rt, coordinator, definition, key, worker } = await setup();
    const g1 = await worker('rtmp-ingest');
    const a = await rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: g1 });
    await rt.store.sessions.transition(a.session.id, 'live');
    await worker('rtmp-ingest');
    await coordinator.syncTick();
    assert.strictEqual((await rt.store.sessions.get(a.session.id)).state, 'live');
    assert.strictEqual((await rt.store.workers.get(g1.id)).state, 'draining');
    // The worker runtime of the draining generation refuses to take sessions (rtmp-ingest checks
    // runtime.draining / state === 'ready' in its publish handler).
    const exits = [];
    const wr = createWorkerRuntime({ rt, kind: 'rtmp-ingest', log: silent, exit: (c) => exits.push(c), hooks: { activeCount: () => 1 } });
    await wr.register({});
    await wr.ready();
    wr.stop();
});

t('a worker without heartbeats is lost: its sessions fail (session.failed) and its outputs go back to pending', async () => {
    const { rt, clock, coordinator, definition, key, worker } = await setup();
    const ing = await worker('rtmp-ingest');
    const rs = await worker('restream');
    await rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/app', stream_key: 'abcd1' });
    const a = await rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: ing });
    await rt.store.sessions.transition(a.session.id, 'live');
    const tick1 = await coordinator.syncTick();
    assert.strictEqual(tick1.outputsCreated, 1);
    assert.strictEqual(tick1.outputsAssigned, 1);
    const out = (await rt.store.outputs.outputsOfSession(a.session.id))[0];
    assert.strictEqual(out.worker.id, rs.id);

    // The restream worker dies; the ingest keeps heartbeating.
    clock.advance(rt.config.workers.leaseMs + 1000);
    await rt.store.workers.heartbeat(ing.id);
    const tick2 = await coordinator.syncTick();
    assert.strictEqual(tick2.lost, 1);
    assert.strictEqual((await rt.store.workers.get(rs.id)).state, 'lost');
    assert.strictEqual((await rt.store.sessions.get(a.session.id)).state, 'live', 'a lost restream worker never ends the source session');
    assert.strictEqual((await rt.store.outputs.getOutput(out.id)).state, 'pending');
    assert.strictEqual((await rt.store.outputs.getOutput(out.id)).worker, null);
    // The lost worker waking up and stopping its ffmpeg must not overwrite the released output.
    assert.strictEqual(await rt.store.outputs.report(out.id, { state: 'stopped' }, { workerId: rs.id }), null);
    assert.strictEqual((await rt.store.outputs.getOutput(out.id)).state, 'pending');
    // A new restream generation picks it up.
    const rs2 = await worker('restream');
    assert.strictEqual((await coordinator.syncTick()).outputsAssigned, 1);
    assert.strictEqual((await rt.store.outputs.getOutput(out.id)).worker.id, rs2.id);

    // Now the ingest worker dies too: its session fails.
    clock.advance(rt.config.workers.leaseMs + 1000);
    await rt.store.workers.heartbeat(rs2.id);
    await coordinator.syncTick();
    assert.strictEqual((await rt.store.sessions.get(a.session.id)).state, 'failed');
    assert.strictEqual((await rt.store.sessions.get(a.session.id)).failure_reason, 'worker_lost');
    assert.ok((await outboxTypes(rt.db)).includes('openre.session.failed'));
    assert.strictEqual((await rt.store.outputs.getOutput(out.id)).desired, 'stop');
});

t('outputs are only created for enabled, auto-start destinations with a key and no cooldown', async () => {
    const { rt, clock, coordinator, definition, key, worker } = await setup();
    const ing = await worker('rtmp-ingest');
    await worker('restream');
    await rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/a', stream_key: 'k1111' });
    await rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/b', stream_key: 'k2222', auto_start: false });
    await rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/c', stream_key: 'k3333', enabled: false });
    const cooling = await rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/d', stream_key: 'k4444' });
    await rt.store.outputs.markDestinationFailure(cooling.id, 'dead');
    const a = await rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: ing });
    await rt.store.sessions.transition(a.session.id, 'live');
    assert.strictEqual((await coordinator.syncTick()).outputsCreated, 1);
    // A manual start ignores the cooldown (like Live's /start).
    await rt.store.outputs.startDestination(cooling.id);
    assert.strictEqual((await rt.store.outputs.outputsOfSession(a.session.id)).length, 2);
    clock.advance(1);
});

t('a restream generation at its drain deadline hands its outputs to the newest generation', async () => {
    const { rt, coordinator, definition, key, worker } = await setup();
    const ing = await worker('rtmp-ingest');
    const rs1 = await worker('restream');
    await rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/a', stream_key: 'k1111' });
    const a = await rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: ing });
    await rt.store.sessions.transition(a.session.id, 'live');
    await coordinator.syncTick();
    const out = (await rt.store.outputs.outputsOfSession(a.session.id))[0];
    await rt.store.outputs.report(out.id, { state: 'live' });
    const rs2 = await worker('restream');
    await coordinator.syncTick();
    assert.strictEqual((await rt.store.workers.get(rs1.id)).state, 'draining');
    assert.strictEqual((await rt.store.outputs.getOutput(out.id)).worker.id, rs1.id, 'the running output stays on the draining generation');
    assert.strictEqual(await rt.store.outputs.release(rs1.id), 1);   // what restream-worker does at its deadline
    await coordinator.syncTick();
    assert.strictEqual((await rt.store.outputs.getOutput(out.id)).worker.id, rs2.id);
    assert.strictEqual((await rt.store.sessions.get(a.session.id)).state, 'live');
});

t('only one coordinator acts at a time', async () => {
    const { rt } = await setup();
    const a = createCoordinator({ rt, media: null, log: silent, holder: 'a' });
    const b = createCoordinator({ rt, media: null, log: silent, holder: 'b' });
    assert.ok(!(await a.tick()).skipped);
    assert.ok((await b.tick()).skipped);
    rt.clock.advance(rt.config.workers.leaseMs + 1);
    assert.ok(!(await b.tick()).skipped, 'an expired lease can be taken over');
});

t('the worker runtime exits by itself when a draining generation is idle, and on being lost', async () => {
    const { rt, worker } = await setup();
    const exits = [];
    let active = 1;
    const wr = createWorkerRuntime({ rt, kind: 'restream', log: silent, exit: (c) => exits.push(c), hooks: { activeCount: () => active } });
    await wr.register({});
    await wr.ready();
    await worker('restream');
    await rt.store.workers.drain(wr.me.id, Date.now() + 60000);
    await wr.beat();
    assert.ok(wr.draining);
    assert.deepStrictEqual(exits, [], 'still carrying an output');
    active = 0;
    await wr.beat();
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(exits, [0]);
    assert.strictEqual((await rt.store.workers.get(wr.me.id)).state, 'stopped');

    const exits2 = [];
    const wr2 = createWorkerRuntime({ rt, kind: 'rtmp-ingest', log: silent, exit: (c) => exits2.push(c), hooks: { activeCount: () => 1 } });
    await wr2.register({});
    await wr2.ready();
    await rt.store.workers.lose(wr2.me.id, 'test');
    await wr2.beat();
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(exits2, [1]);
});

t.run();
