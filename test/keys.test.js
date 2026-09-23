'use strict';
// Ingest keys: stored hashed, shown once, rotation (immediate and with a grace period), revocation
// by the coordinator, archive, and destination secrets sealed at rest.
const assert = require('assert');
const { runtime, manualClock, suite, OWNER, outboxEnvelopes } = require('./helpers');
const { hashIngestKey, isIngestKeyShape, createBox } = require('../server/secrets');
const { createCoordinator } = require('../server/coordinator');

const t = suite('keys');

t('a new definition issues one key; only its SHA-256 is stored', () => {
    const rt = runtime();
    const { definition, key } = rt.store.definitions.create({ owner_subject: OWNER, title: 'Main' });
    assert.ok(isIngestKeyShape(key.key), 'ork_ + 43 base64url chars');
    const rows = rt.db.prepare('SELECT * FROM ingest_keys').all();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].key_hash, hashIngestKey(key.key));
    assert.strictEqual(rows[0].hint, key.key.slice(-4));
    // The plain key is nowhere in the database file's tables.
    const dump = JSON.stringify(rt.db.prepare("SELECT * FROM ingest_keys").all()) + JSON.stringify(rt.db.prepare('SELECT * FROM stream_definitions').all());
    assert.ok(!dump.includes(key.key));
    const r = rt.store.definitions.resolveIngestKey(key.key, 'rtmp');
    assert.strictEqual(r.definition.id, definition.id);
    assert.ok(rt.db.prepare('SELECT last_used_at FROM ingest_keys').get().last_used_at > 0);
});

t('unknown, malformed and wrong-protocol keys are refused', () => {
    const rt = runtime();
    const { key } = rt.store.definitions.create({ owner_subject: OWNER });
    assert.strictEqual(rt.store.definitions.resolveIngestKey('ork_' + 'A'.repeat(43), 'rtmp').error, 'unknown_key');
    assert.strictEqual(rt.store.definitions.resolveIngestKey('a3f9c2', 'rtmp').error, 'malformed_key');
    assert.strictEqual(rt.store.definitions.resolveIngestKey(key.key, 'whip').error, 'protocol_not_allowed');
});

t('rotate revokes the old key immediately and emits openre.key.rotated without any key', () => {
    const rt = runtime();
    const { definition, key: first } = rt.store.definitions.create({ owner_subject: OWNER, external_refs: [{ service: 'live', type: 'managed_stream', id: '7' }] });
    const r = rt.store.definitions.rotateKey(definition.id, { rotated_by: OWNER });
    assert.notStrictEqual(r.key.key, first.key);
    assert.strictEqual(rt.store.definitions.resolveIngestKey(first.key, 'rtmp').error, 'revoked_key');
    assert.strictEqual(rt.store.definitions.resolveIngestKey(r.key.key, 'rtmp').definition.id, definition.id);
    const ev = outboxEnvelopes(rt.db).find(e => e.event_type === 'openre.key.rotated');
    assert.ok(ev);
    assert.deepStrictEqual(ev.subject, { type: 'stream', id: definition.id, revision: 1 });
    assert.deepStrictEqual(ev.actor, { type: 'user', id: OWNER });
    const text = JSON.stringify(ev);
    assert.ok(!text.includes(first.key) && !text.includes(r.key.key), 'no key in the event');
    assert.strictEqual(ev.payload.retired_key_ids.length, 1);
});

t('rotate with a grace period keeps the old key for new publishes until the coordinator revokes it', async () => {
    const clock = manualClock();
    const rt = runtime({ clock });
    const { definition, key: first } = rt.store.definitions.create({ owner_subject: OWNER });
    const r = rt.store.definitions.rotateKey(definition.id, { grace_seconds: 600 });
    assert.strictEqual(rt.store.definitions.resolveIngestKey(first.key, 'rtmp').key.status, 'grace');
    assert.ok(rt.store.definitions.resolveIngestKey(r.key.key, 'rtmp').definition);
    clock.advance(601 * 1000);
    // Past the grace period the key no longer authenticates, even before the coordinator runs...
    assert.strictEqual(rt.store.definitions.resolveIngestKey(first.key, 'rtmp').error, 'revoked_key');
    // ...and the coordinator records the revocation.
    const out = createCoordinator({ rt, media: null, log: { log() {}, warn() {}, error() {} } }).syncTick();
    assert.strictEqual(out.keysRevoked, 1);
    assert.strictEqual(rt.db.prepare("SELECT status FROM ingest_keys WHERE key_hash = ?").get(hashIngestKey(first.key)).status, 'revoked');
});

t('archiving revokes every key and is refused while a session is open', () => {
    const rt = runtime();
    const { definition, key } = rt.store.definitions.create({ owner_subject: OWNER });
    const w = rt.store.workers.register({ kind: 'rtmp-ingest' });
    rt.store.workers.ready(w.id);
    const a = rt.store.sessions.admit({ definition, key: { id: 'k' }, protocol: 'rtmp', worker: rt.store.workers.get(w.id) });
    assert.throws(() => rt.store.definitions.archive(definition.id), /end the live session/);
    rt.store.sessions.finish(a.session.id, { reason: 'test' });
    rt.store.definitions.archive(definition.id);
    assert.strictEqual(rt.store.definitions.resolveIngestKey(key.key, 'rtmp').error, 'revoked_key');
});

t('external refs are unique across definitions', () => {
    const rt = runtime();
    rt.store.definitions.create({ owner_subject: OWNER, external_refs: [{ service: 'live', type: 'managed_stream', id: '9' }] });
    assert.throws(() => rt.store.definitions.create({ owner_subject: OWNER, external_refs: [{ service: 'live', type: 'managed_stream', id: '9' }] }), /already belongs/);
    assert.ok(rt.store.definitions.findByRef('live', 'managed_stream', '9'));
});

t('destination keys are sealed with AES-256-GCM and only the last four characters come back', () => {
    const rt = runtime();
    const { definition } = rt.store.definitions.create({ owner_subject: OWNER });
    const d = rt.store.outputs.createDestination(definition.id, { platform: 'twitch', server_url: 'rtmps://live.twitch.tv/app', stream_key: 'live_1234567890_secret' });
    assert.strictEqual(d.stream_key_hint, '****cret');
    assert.ok(!JSON.stringify(d).includes('live_1234567890_secret'));
    const row = rt.db.prepare('SELECT stream_key_enc FROM destinations').get();
    assert.ok(row.stream_key_enc.startsWith('v1.') && !row.stream_key_enc.includes('secret'));
    assert.strictEqual(rt.store.outputs.destinationForWorker(d.id).stream_key, 'live_1234567890_secret');
    // A second key can take over: the previous one still opens old rows.
    const box2 = createBox({ key: require('crypto').randomBytes(32).toString('hex'), previous: rt.config.secretsKey });
    assert.strictEqual(box2.open(row.stream_key_enc), 'live_1234567890_secret');
    // Without a key nothing is stored in the clear.
    assert.throws(() => createBox({}).seal('x'), /OPENRE_SECRETS_KEY/);
});

t.run();
