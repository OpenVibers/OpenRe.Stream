'use strict';
// scripts/set-definition-state.js (per-slot rollback) against a real openre-api: a stub Network
// hands out Live's service token, the script finds the slot's definition by its live:managed_stream
// reference and disables it; the key the broadcaster got is then refused at the RTMP handshake.
// Re-enabling restores it. Also: unknown slot, no-op, and nothing secret printed.
const assert = require('assert');
const { run, parseArgs } = require('../scripts/set-definition-state');
const { bootApi, request, serviceToken, suite, OWNER } = require('./helpers');

const t = suite('set-definition-state');
const CLIENT_SECRET = 'c'.repeat(48);
const LIVE_CAPS = ['openre.stream.read', 'openre.stream.write', 'openre.key.rotate', 'openre.session.read'];
let api;
let env;
let key;
let streamId;
const tokenRequests = [];

/** fetch: Network's token endpoint is stubbed (Live's real grants), everything else is the real API. */
async function fetchImpl(url, opts = {}) {
    if (url === 'http://network.test/oauth/token') {
        const p = new URLSearchParams(opts.body);
        tokenRequests.push(Object.fromEntries(p));
        const token = serviceToken(p.get('client_id'), LIVE_CAPS, { aud: p.get('audience') });
        return new Response(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 300 }), { status: 200 });
    }
    return fetch(url, opts);
}

const logs = () => { const lines = []; const log = (s) => lines.push(String(s)); log.lines = lines; return log; };

t('setup: a definition made for Live slot 12, as Live does at the switch', async () => {
    api = await bootApi();
    env = { OV_OAUTH_CLIENT_ID: 'live', OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET, OV_NETWORK_INTERNAL_URL: 'http://network.test', OPENRE_URL: api.base };
    const created = await request(api.base, 'POST', '/api/v1/streams', {
        token: serviceToken('live', LIVE_CAPS),
        headers: { 'X-OV-Subject': OWNER },
        body: { title: 'Slot 12', mirror_to_live: true, external_refs: [{ service: 'live', type: 'managed_stream', id: '12' }] },
    });
    assert.strictEqual(created.status, 201);
    streamId = created.body.stream.id;
    key = created.body.key.key;
    assert.ok(api.rt.store.definitions.resolveIngestKey(key, 'rtmp').definition);
});

t('--state disabled: the definition is disabled and its key refused at the handshake', async () => {
    const log = logs();
    const r = await run({ slot: '12', state: 'disabled', env, fetchImpl, log });
    assert.deepStrictEqual(r, { id: streamId, state: 'disabled', changed: true, open_session: null });
    assert.deepStrictEqual(tokenRequests.at(-1), { grant_type: 'client_credentials', client_id: 'live', client_secret: CLIENT_SECRET, audience: 'openvibe.openre' });
    assert.deepStrictEqual(api.rt.store.definitions.resolveIngestKey(key, 'rtmp'), { error: 'stream_disabled' });
    assert.match(log.lines.join('\n'), new RegExp(`${streamId} \\(live:managed_stream:12\\): active → disabled`));
    for (const l of log.lines) { assert.ok(!l.includes(key)); assert.ok(!l.includes(CLIENT_SECRET)); }
    const again = await run({ slot: '12', state: 'disabled', env, fetchImpl, log });
    assert.strictEqual(again.changed, false);
});

t('--state active: the same key works again (re-switching the slot later)', async () => {
    const r = await run({ slot: '12', state: 'active', env, fetchImpl, log: () => {} });
    assert.strictEqual(r.state, 'active');
    assert.ok(api.rt.store.definitions.resolveIngestKey(key, 'rtmp').definition);
});

t('a slot without a definition is an error; arguments are checked', async () => {
    await assert.rejects(run({ slot: '99', state: 'disabled', env, fetchImpl, log: () => {} }), /no stream definition for live:managed_stream:99/);
    assert.throws(() => parseArgs(['--slot', 'x', '--state', 'disabled']), /--slot/);
    assert.throws(() => parseArgs(['--slot', '12', '--state', 'archived']), /--state must be active or disabled/);
    assert.deepStrictEqual(parseArgs(['--slot', '12', '--state', 'disabled']), { liveEnv: '/etc/openvibe/live.env', slot: '12', state: 'disabled' });
    await api.close();
});

t.run();
