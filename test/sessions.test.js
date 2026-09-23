'use strict';
// Session state machine: allowed transitions, events emitted exactly per the lifecycle rules,
// admission (one open session per stream), and outputs following their session down.
const assert = require('assert');
const { contracts } = { contracts: require('openvibe-contracts') };
const { runtime, manualClock, suite, OWNER, outboxTypes, outboxEnvelopes } = require('./helpers');
const { NEXT, canTransition } = require('../server/state-machine');

const t = suite('sessions');

function setup(clock = manualClock()) {
    const rt = runtime({ clock });
    const { definition, key } = rt.store.definitions.create({ owner_subject: OWNER, title: 'Show', external_refs: [{ service: 'live', type: 'managed_stream', id: '12' }] });
    const w = rt.store.workers.register({ kind: 'rtmp-ingest', endpoints: { publicPort: 1936, rtmpPlayPort: 19360, flvPort: 19361 } });
    rt.store.workers.ready(w.id);
    return { rt, clock, definition, key, worker: rt.store.workers.get(w.id) };
}

t('the transition table is exactly starting→live→ending→ended with failed from any open state', () => {
    assert.deepStrictEqual(NEXT, { starting: ['live', 'ending', 'failed'], live: ['ending', 'failed'], ending: ['ended', 'failed'], ended: [], failed: [] });
    assert.ok(!canTransition('ended', 'live'));
    assert.ok(!canTransition('live', 'starting'));
    assert.ok(!canTransition('failed', 'ended'));
});

t('a clean session emits started then ended; envelopes are valid events.event-envelope@1', () => {
    const { rt, clock, definition, key, worker } = setup();
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker });
    assert.strictEqual(a.session.state, 'starting');
    assert.deepStrictEqual(outboxTypes(rt.db), [], 'starting is internal');
    assert.ok(rt.store.sessions.transition(a.session.id, 'live', { reason: 'media_flowing' }).ok);
    clock.advance(90 * 1000);
    const f = rt.store.sessions.finish(a.session.id, { reason: 'publisher_disconnected' });
    assert.ok(f.ok);
    assert.strictEqual(f.session.state, 'ended');
    assert.deepStrictEqual(outboxTypes(rt.db), ['openre.session.started', 'openre.session.ended']);
    const [started, ended] = outboxEnvelopes(rt.db);
    for (const ev of [started, ended]) {
        const v = contracts.validate('events.event-envelope@1', ev);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.strictEqual(ev.source, 'openre');
        assert.strictEqual(ev.subject.type, 'ingest_session');
        assert.ok(!JSON.stringify(ev).includes(key.key), 'no ingest key in events');
    }
    assert.strictEqual(started.subject.revision, 2);
    assert.strictEqual(ended.subject.revision, 4);
    assert.deepStrictEqual(started.payload.external_refs, [{ service: 'live', type: 'managed_stream', id: '12', label: null }]);
    assert.strictEqual(started.payload.playback.flv.internal_url, `http://127.0.0.1:19361/live/${a.session.id}.flv`);
    assert.strictEqual(ended.payload.duration_seconds, 90);
    assert.deepStrictEqual(rt.store.sessions.transitions(a.session.id).map(x => x.to_state), ['starting', 'live', 'ending', 'ended']);
});

t('a publisher that leaves during the handshake ends without events; failures always emit', () => {
    const { rt, definition, key, worker } = setup();
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker });
    rt.store.sessions.finish(a.session.id, { reason: 'publisher_disconnected' });
    assert.deepStrictEqual(outboxTypes(rt.db), []);
    const b = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker });
    rt.store.sessions.transition(b.session.id, 'failed', { reason: 'worker_lost' });
    const ev = outboxEnvelopes(rt.db).pop();
    assert.strictEqual(ev.event_type, 'openre.session.failed');
    assert.strictEqual(ev.payload.was_live, false);
    assert.strictEqual(ev.payload.failure_reason, 'worker_lost');
});

t('invalid transitions change nothing (a worker and the coordinator racing)', () => {
    const { rt, definition, key, worker } = setup();
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker });
    rt.store.sessions.transition(a.session.id, 'live');
    rt.store.sessions.transition(a.session.id, 'failed', { reason: 'lease_expired' });
    const before = outboxTypes(rt.db).length;
    const r = rt.store.sessions.finish(a.session.id, { reason: 'publisher_disconnected' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'invalid_transition');
    assert.strictEqual(rt.store.sessions.get(a.session.id).state, 'failed');
    assert.strictEqual(outboxTypes(rt.db).length, before);
});

t('one open session per stream: a second publisher is refused while the first holds its lease', () => {
    const { rt, clock, definition, key, worker } = setup();
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker });
    assert.strictEqual(rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker }).error, 'duplicate_publisher');
    // Lease expired (worker died): the stale session fails and the new publish is admitted.
    clock.advance(rt.config.workers.leaseMs + 1);
    const b = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker });
    assert.ok(b.session);
    assert.strictEqual(rt.store.sessions.get(a.session.id).state, 'failed');
    assert.strictEqual(rt.store.sessions.get(a.session.id).failure_reason, 'lease_expired');
});

t('heartbeats renew the lease of every session the worker owns', () => {
    const { rt, clock, definition, key, worker } = setup();
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker });
    const lease1 = rt.store.sessions.get(a.session.id).lease_expires_at;
    clock.advance(5000);
    rt.store.workers.heartbeat(worker.id);
    assert.strictEqual(rt.store.sessions.get(a.session.id).lease_expires_at, lease1 + 5000);
});

t('ending a session asks its outputs to stop; an output never moves the session', () => {
    const { rt, definition, key, worker } = setup();
    const dest = rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:1/app', stream_key: 'k1234' });
    rt.store.outputs.createDestination(definition.id, { platform: 'custom', server_url: 'rtmp://127.0.0.1:2/app', stream_key: 'k5678' });
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker });
    rt.store.sessions.transition(a.session.id, 'live');
    assert.strictEqual(rt.store.outputs.ensureAutoOutputs(), 2);
    const [out, other] = rt.store.outputs.outputsOfSession(a.session.id);
    rt.store.outputs.report(other.id, { state: 'live' });
    rt.store.outputs.report(out.id, { state: 'failed', last_error: 'boom' });
    assert.strictEqual(rt.store.sessions.get(a.session.id).state, 'live', 'a failed output leaves the session live');
    assert.ok(outboxTypes(rt.db).includes('openre.output.failed'));
    rt.store.sessions.finish(a.session.id, { reason: 'publisher_disconnected' });
    assert.strictEqual(rt.db.prepare('SELECT desired FROM outputs WHERE id = ?').get(other.id).desired, 'stop', 'the running output is told to stop');
    assert.ok(dest.id);
});

t('an end request is recorded for the owning worker to act on', () => {
    const { rt, definition, key, worker } = setup();
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker });
    assert.ok(rt.store.sessions.requestEnd(a.session.id, OWNER));
    assert.deepStrictEqual(rt.store.sessions.endRequestsFor(worker.id).map(s => s.id), [a.session.id]);
});

t.run();
