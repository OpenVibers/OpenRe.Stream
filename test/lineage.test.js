'use strict';
// Live lineage (D20): the coordinator asks OpenVibe.Live's canonical resolver which channel a Live-linked
// definition belongs to, with OpenRe's service token; session events carry the answer.
const assert = require('assert');
const { runtime, manualClock, suite, OWNER, outboxEnvelopes, silent } = require('./helpers');
const { createCoordinator } = require('../server/coordinator');
const { createLineage } = require('../server/lineage');

const t = suite('lineage');

function setup(answer) {
    const clock = manualClock();
    const rt = runtime({ clock });
    const asked = [];
    const fetchImpl = async (url, opts = {}) => {
        const u = new URL(url);
        const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
        if (u.pathname === '/oauth/token') return reply(200, { access_token: 'svc-openre', expires_in: 300 });
        assert.strictEqual(u.pathname, '/internal/lineage/resolve');
        assert.strictEqual(opts.headers.Authorization, 'Bearer svc-openre');
        asked.push(Object.fromEntries(u.searchParams));
        return typeof answer === 'function' ? answer(u) : reply(200, answer);
    };
    const config = { ...rt.config, oauth: { ...rt.config.oauth, clientSecret: 'openre-secret-for-tests' } };
    const lineage = createLineage({ db: rt.db, config, env: { OV_LIVE_INTERNAL_URL: 'http://live.test' }, fetchImpl, now: () => clock.now(), log: silent });
    const coordinator = createCoordinator({ rt, media: null, lineage, log: silent });
    return { rt, clock, lineage, coordinator, asked };
}
const RESOLVED = { status: 'resolved', channel: { id: '17', slug: 'goosely', owner_subject: OWNER }, rule: 'slot', confidence: 'exact' };

t('a Live-linked definition is resolved with its owner and slot; an unlinked one is never asked about', async () => {
    const { rt, lineage, asked } = setup(RESOLVED);
    const linked = rt.store.definitions.create({ owner_subject: OWNER, mirror_to_live: true, external_refs: [{ service: 'live', type: 'managed_stream', id: '12' }] }).definition;
    rt.store.definitions.create({ owner_subject: OWNER, title: 'OpenRe only' });
    const out = await lineage.refresh();
    assert.deepStrictEqual(out, { checked: 1, resolved: 1 });
    assert.deepStrictEqual(asked, [{ owner_subject: OWNER, slot_id: '12' }], 'owner subject and slot id, never a display name');
    const row = rt.db.prepare('SELECT resolution FROM definition_lineage WHERE definition_id = ?').get(linked.id);
    assert.strictEqual(JSON.parse(row.resolution).channel.slug, 'goosely');
    assert.deepStrictEqual(await lineage.refresh(), { checked: 0, resolved: 0 }, 'fresh answers are not asked again');
});

t('session events carry the resolved channel', async () => {
    const { rt, coordinator } = setup(RESOLVED);
    const { definition, key } = rt.store.definitions.create({ owner_subject: OWNER, mirror_to_live: true, external_refs: [{ service: 'live', type: 'managed_stream', id: '12' }] });
    await coordinator.tick();
    const w = rt.store.workers.register({ kind: 'rtmp-ingest', endpoints: { flvPort: 19361, rtmpPlayPort: 19360 } }); rt.store.workers.ready(w.id);
    const a = rt.store.sessions.admit({ definition, key, protocol: 'rtmp', worker: rt.store.workers.get(w.id) });
    rt.store.sessions.transition(a.session.id, 'live');
    const started = outboxEnvelopes(rt.db).find((e) => e.event_type === 'openre.session.started');
    assert.deepStrictEqual(started.payload.lineage, { channel: { service: 'live', id: '17', slug: 'goosely', owner_subject: OWNER }, rule: 'slot' });
});

t('unresolved answers are kept but not carried; a stale answer is asked again; Live down waits for the next tick', async () => {
    let mode = 'unresolved';
    const { rt, clock, lineage } = setup((u) => (mode === 'down' ? { status: 503, ok: false, json: async () => ({}) } : { status: 200, ok: true, json: async () => (mode === 'unresolved' ? { status: 'unresolved', reason: 'no_match' } : RESOLVED) }));
    const { definition } = rt.store.definitions.create({ owner_subject: OWNER, mirror_to_live: true });
    assert.deepStrictEqual(await lineage.refresh(), { checked: 1, resolved: 0 });
    assert.strictEqual(rt.store.sessions.liveLineage(definition.id), null, 'an unresolved answer is not carried');
    mode = 'down';
    clock.advance(16 * 60 * 1000);
    assert.deepStrictEqual(await lineage.refresh(), { checked: 0, resolved: 0 });
    assert.strictEqual(lineage.stats().failed, 1);
    mode = 'resolved';
    assert.deepStrictEqual(await lineage.refresh(), { checked: 1, resolved: 1 });
});

t('off without a service secret', async () => {
    const clock = manualClock();
    const rt = runtime({ clock });
    const off = createLineage({ db: rt.db, config: { ...rt.config, oauth: { ...rt.config.oauth, clientSecret: '' } }, env: {}, fetchImpl: () => { throw new Error('no calls'); }, log: silent });
    assert.strictEqual(off.enabled, false);
    assert.deepStrictEqual(await off.refresh(), { skipped: 'off' });
});

t.run();
