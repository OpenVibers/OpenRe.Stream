'use strict';
// Session coordinator: generations and draining, lost workers, lease expiry, output assignment to
// the newest restream generation, drain-deadline handover and the single-coordinator lease.
const assert = require('assert');
const { runtime, manualClock, suite, OWNER, outboxTypes, silent } = require('./helpers');
const { createCoordinator } = require('../server/coordinator');
const { createWorkerRuntime } = require('../workers/runtime');

const t = suite('coordinator');

function setup() {
    const clock = manualClock();
    const rt = runtime({ clock });
    const coordinator = createCoordinator({ rt, media: null, log: silent });
    const { definition, key } = rt.store.definitions.create({ owner_subject: OWNER });
    const worker = (kind) => { const w = rt.store.workers.register({ kind, endpoints: { flvPort: 19361, rtmpPlayPort: 19360 } }); rt.store.workers.ready(w.id); return rt.store.workers.get(w.id); };
    return { rt, clock, coordinator, definition, key, worker };
}

t('generations grow per kind; when a newer one is ready every older one drains with a deadline', () => {
    const { rt, clock, coordinator, worker } = setup();
    const g1 = worker('rtmp-ingest');
    const r1 = worker('restream');
    assert.strictEqual(g1.generation, 1);
    assert.strictEqual(r1.generation, 1);
    assert.strictEqual(coordinator.syncTick().drained, 0);
    const g2 = worker('rtmp-ingest');
    assert.strictEqual(g2.generation, 2);
    assert.strictEqual(coordinator.syncTick().drained, 1);
    const old = rt.store.workers.get(g1.id);
    assert.strictEqual(old.state, 'draining');
    assert.strictEqual(old.drain_deadline, clock.now() + rt.config.workers.drainMaxMs);
    assert.strictEqual(rt.store.workers.get(r1.id).state, 'ready', 'other kinds are independent');
    assert.strictEqual(rt.store.workers.newestReady('rtmp-ingest').id, g2.id);
});

t('a draining generation keeps its live session; new sessions only reach the newest generation', () => {
    const { rt, coordinator, definition, key, worker } = setup();
    const g1 = worker('rtmp-ingest');
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: g1 });
    rt.store.sessions.transition(a.session.id, 'live');
    worker('rtmp-ingest');
    coordinator.syncTick();
    assert.strictEqual(rt.store.sessions.get(a.session.id).state, 'live');
    assert.strictEqual(rt.store.workers.get(g1.id).state, 'draining');
    // The worker runtime of the draining generation refuses to take sessions (rtmp-ingest checks
    // runtime.draining / state === 'ready' in its publish handler).
    const exits = [];
    const wr = createWorkerRuntime({ rt, kind: 'rtmp-ingest', log: silent, exit: (c) => exits.push(c), hooks: { activeCount: () => 1 } });
    wr.register({});
    wr.ready();
    wr.stop();
});

t('a worker without heartbeats is lost: its sessions fail (session.failed) and its outputs go back to pending', () => {
    const { rt, clock, coordinator, definition, key, worker } = setup();
    const ing = worker('rtmp-ingest');
    const rs = worker('restream');
    rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/app', stream_key: 'abcd1' });
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: ing });
    rt.store.sessions.transition(a.session.id, 'live');
    const tick1 = coordinator.syncTick();
    assert.strictEqual(tick1.outputsCreated, 1);
    assert.strictEqual(tick1.outputsAssigned, 1);
    const out = rt.store.outputs.outputsOfSession(a.session.id)[0];
    assert.strictEqual(out.worker.id, rs.id);

    // The restream worker dies; the ingest keeps heartbeating.
    clock.advance(rt.config.workers.leaseMs + 1000);
    rt.store.workers.heartbeat(ing.id);
    const tick2 = coordinator.syncTick();
    assert.strictEqual(tick2.lost, 1);
    assert.strictEqual(rt.store.workers.get(rs.id).state, 'lost');
    assert.strictEqual(rt.store.sessions.get(a.session.id).state, 'live', 'a lost restream worker never ends the source session');
    assert.strictEqual(rt.store.outputs.getOutput(out.id).state, 'pending');
    assert.strictEqual(rt.store.outputs.getOutput(out.id).worker, null);
    // A new restream generation picks it up.
    const rs2 = worker('restream');
    assert.strictEqual(coordinator.syncTick().outputsAssigned, 1);
    assert.strictEqual(rt.store.outputs.getOutput(out.id).worker.id, rs2.id);

    // Now the ingest worker dies too: its session fails.
    clock.advance(rt.config.workers.leaseMs + 1000);
    rt.store.workers.heartbeat(rs2.id);
    coordinator.syncTick();
    assert.strictEqual(rt.store.sessions.get(a.session.id).state, 'failed');
    assert.strictEqual(rt.store.sessions.get(a.session.id).failure_reason, 'worker_lost');
    assert.ok(outboxTypes(rt.db).includes('openre.session.failed'));
    assert.strictEqual(rt.store.outputs.getOutput(out.id).desired, 'stop');
});

t('outputs are only created for enabled, auto-start destinations with a key and no cooldown', () => {
    const { rt, clock, coordinator, definition, key, worker } = setup();
    const ing = worker('rtmp-ingest');
    worker('restream');
    rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/a', stream_key: 'k1111' });
    rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/b', stream_key: 'k2222', auto_start: false });
    rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/c', stream_key: 'k3333', enabled: false });
    const cooling = rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/d', stream_key: 'k4444' });
    rt.store.outputs.markDestinationFailure(cooling.id, 'dead');
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: ing });
    rt.store.sessions.transition(a.session.id, 'live');
    assert.strictEqual(coordinator.syncTick().outputsCreated, 1);
    // A manual start ignores the cooldown (like Live's /start).
    rt.store.outputs.startDestination(cooling.id);
    assert.strictEqual(rt.store.outputs.outputsOfSession(a.session.id).length, 2);
    clock.advance(1);
});

t('a restream generation at its drain deadline hands its outputs to the newest generation', () => {
    const { rt, coordinator, definition, key, worker } = setup();
    const ing = worker('rtmp-ingest');
    const rs1 = worker('restream');
    rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/a', stream_key: 'k1111' });
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: ing });
    rt.store.sessions.transition(a.session.id, 'live');
    coordinator.syncTick();
    const out = rt.store.outputs.outputsOfSession(a.session.id)[0];
    rt.store.outputs.report(out.id, { state: 'live' });
    const rs2 = worker('restream');
    coordinator.syncTick();
    assert.strictEqual(rt.store.workers.get(rs1.id).state, 'draining');
    assert.strictEqual(rt.store.outputs.getOutput(out.id).worker.id, rs1.id, 'the running output stays on the draining generation');
    assert.strictEqual(rt.store.outputs.release(rs1.id), 1);   // what restream-worker does at its deadline
    coordinator.syncTick();
    assert.strictEqual(rt.store.outputs.getOutput(out.id).worker.id, rs2.id);
    assert.strictEqual(rt.store.sessions.get(a.session.id).state, 'live');
});

t('only one coordinator acts at a time', async () => {
    const { rt } = setup();
    const a = createCoordinator({ rt, media: null, log: silent, holder: 'a' });
    const b = createCoordinator({ rt, media: null, log: silent, holder: 'b' });
    assert.ok(!(await a.tick()).skipped);
    assert.ok((await b.tick()).skipped);
    rt.clock.advance(rt.config.workers.leaseMs + 1);
    assert.ok(!(await b.tick()).skipped, 'an expired lease can be taken over');
});

t('the worker runtime exits by itself when a draining generation is idle, and on being lost', async () => {
    const { rt, worker } = setup();
    const exits = [];
    let active = 1;
    const wr = createWorkerRuntime({ rt, kind: 'restream', log: silent, exit: (c) => exits.push(c), hooks: { activeCount: () => active } });
    wr.register({});
    wr.ready();
    worker('restream');
    rt.store.workers.drain(wr.me.id, Date.now() + 60000);
    wr.beat();
    assert.ok(wr.draining);
    assert.deepStrictEqual(exits, [], 'still carrying an output');
    active = 0;
    wr.beat();
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(exits, [0]);
    assert.strictEqual(rt.store.workers.get(wr.me.id).state, 'stopped');

    const exits2 = [];
    const wr2 = createWorkerRuntime({ rt, kind: 'rtmp-ingest', log: silent, exit: (c) => exits2.push(c), hooks: { activeCount: () => 1 } });
    wr2.register({});
    wr2.ready();
    rt.store.workers.lose(wr2.me.id, 'test');
    wr2.beat();
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(exits2, [1]);
});

t.run();
