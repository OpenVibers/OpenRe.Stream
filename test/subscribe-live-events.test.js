'use strict';
// scripts/subscribe-live-events.js against a stub Network and Events (fetch is injected): Live's
// token, the subscription created once with Live's secret, reported when it exists, --dry-run,
// --disable/--enable for rollback, and no secret in anything it prints.
const assert = require('assert');
const { run, parseArgs, TOPIC, DEFAULT_ENDPOINT } = require('../scripts/subscribe-live-events');
const { suite } = require('./helpers');

const t = suite('subscribe-live-events');
const SECRET = 's'.repeat(64);
const CLIENT_SECRET = 'c'.repeat(48);
const ENV = { OV_OAUTH_CLIENT_ID: 'live', OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET, OV_NETWORK_INTERNAL_URL: 'http://network.test', EVENTS_URL: 'http://events.test/', OPENRE_EVENTS_SECRET: SECRET };

function stub({ subscriptions = [], tokenStatus = 200, createStatus = 201 } = {}) {
    const calls = [];
    const subs = subscriptions.map((s) => ({ ...s }));
    const reply = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body) });
    const fetchImpl = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ method, url, headers: opts.headers || {}, body: opts.body || null });
        if (url === 'http://network.test/oauth/token') {
            const p = new URLSearchParams(opts.body);
            assert.strictEqual(p.get('grant_type'), 'client_credentials');
            assert.strictEqual(p.get('client_id'), 'live');
            assert.strictEqual(p.get('audience'), 'openvibe.events');
            return tokenStatus === 200 ? reply(200, { access_token: 'tok-live', token_type: 'Bearer', expires_in: 300 }) : reply(tokenStatus, { error: 'invalid_client' });
        }
        assert.strictEqual(opts.headers.Authorization, 'Bearer tok-live');
        if (url === 'http://events.test/api/v1/subscriptions' && method === 'GET') return reply(200, { subscriptions: subs });
        if (url === 'http://events.test/api/v1/subscriptions' && method === 'POST') {
            const b = JSON.parse(opts.body);
            if (createStatus === 409) return reply(409, { code: 'events.subscription_exists', subscription_id: 'sub_existing' });
            const row = { id: 'sub_new', consumer: 'live', topic_pattern: b.topic_pattern, endpoint: b.endpoint, enabled: true };
            subs.push(row);
            return reply(201, { ...row, secret: b.secret });
        }
        const m = /^http:\/\/events\.test\/api\/v1\/subscriptions\/([^/]+)\/(enable|disable)$/.exec(url);
        if (m && method === 'POST') {
            const s = subs.find((x) => x.id === m[1]);
            s.enabled = m[2] === 'enable';
            return reply(200, s);
        }
        return reply(404, { code: 'not_found' });
    };
    return { fetchImpl, calls, subs };
}

const logs = () => { const lines = []; const log = (s) => lines.push(String(s)); log.lines = lines; return log; };
const noSecret = (lines) => {
    for (const l of lines) for (const s of [SECRET, CLIENT_SECRET, 'tok-live']) assert.ok(!l.includes(s), `printed a secret: ${l}`);
};

t('creates openre.session.* → Live\'s /internal/openre-events with Live\'s secret, as Live', async () => {
    const s = stub({ subscriptions: [{ id: 'sub_other', topic_pattern: 'media.vod.*', endpoint: 'http://127.0.0.1:3000/internal/events', enabled: true }] });
    const log = logs();
    const r = await run({ env: ENV, fetchImpl: s.fetchImpl, log });
    assert.deepStrictEqual(r, { action: 'create', subscription_id: 'sub_new', existed: false, created: true });
    const post = s.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/v1/subscriptions'));
    assert.deepStrictEqual(JSON.parse(post.body), { topic_pattern: TOPIC, endpoint: DEFAULT_ENDPOINT, secret: SECRET });
    assert.strictEqual(TOPIC, 'openre.session.*');
    assert.strictEqual(DEFAULT_ENDPOINT, 'http://127.0.0.1:3000/internal/openre-events');
    assert.match(log.lines.join('\n'), /subscribed: sub_new \(openre\.session\.\* → http:\/\/127\.0\.0\.1:3000\/internal\/openre-events\)/);
    noSecret(log.lines);
});

t('an existing subscription is reported, not duplicated (and a 409 race is handled)', async () => {
    let s = stub({ subscriptions: [{ id: 'sub_1', topic_pattern: TOPIC, endpoint: DEFAULT_ENDPOINT, enabled: true }] });
    let log = logs();
    let r = await run({ env: ENV, fetchImpl: s.fetchImpl, log });
    assert.deepStrictEqual(r, { action: 'create', subscription_id: 'sub_1', existed: true, created: false });
    assert.ok(!s.calls.some((c) => c.method === 'POST' && c.url.endsWith('/subscriptions')), 'no second subscription');
    assert.match(log.lines.join('\n'), /cutover-preflight\.js --only events/);
    s = stub({ createStatus: 409 });
    log = logs();
    r = await run({ env: ENV, fetchImpl: s.fetchImpl, log });
    assert.strictEqual(r.subscription_id, 'sub_existing');
});

t('--dry-run lists and changes nothing', async () => {
    const s = stub();
    const log = logs();
    const r = await run({ action: 'list', env: ENV, fetchImpl: s.fetchImpl, log });
    assert.strictEqual(r.existed, false);
    assert.deepStrictEqual(s.calls.map((c) => c.method), ['POST', 'GET'], 'only the token and the list');
    assert.match(log.lines.join('\n'), /would create one/);
});

t('--disable and --enable (rollback and its undo)', async () => {
    const s = stub({ subscriptions: [{ id: 'sub_1', topic_pattern: TOPIC, endpoint: DEFAULT_ENDPOINT, enabled: true }] });
    const log = logs();
    let r = await run({ action: 'disable', env: ENV, fetchImpl: s.fetchImpl, log });
    assert.deepStrictEqual(r, { action: 'disable', subscription_id: 'sub_1', enabled: false });
    assert.strictEqual(s.subs[0].enabled, false);
    r = await run({ action: 'enable', env: ENV, fetchImpl: s.fetchImpl, log });
    assert.strictEqual(s.subs[0].enabled, true);
    await assert.rejects(run({ action: 'disable', env: ENV, fetchImpl: stub().fetchImpl, log }), /no subscription openre\.session\.\* .* to disable/);
    noSecret(log.lines);
});

t('refuses without a usable secret before calling anything; a refused token is an error', async () => {
    const s = stub();
    await assert.rejects(run({ env: { ...ENV, OPENRE_EVENTS_SECRET: 'short' }, fetchImpl: s.fetchImpl, log: () => {} }), /OPENRE_EVENTS_SECRET must be set/);
    await assert.rejects(run({ env: { ...ENV, OV_OAUTH_CLIENT_SECRET: '' }, fetchImpl: s.fetchImpl, log: () => {} }), /OV_OAUTH_CLIENT_SECRET is not set/);
    assert.strictEqual(s.calls.length, 0);
    await assert.rejects(run({ env: ENV, fetchImpl: stub({ tokenStatus: 401 }).fetchImpl, log: () => {} }), /Network refused a token for live \(401 invalid_client\)/);
});

t('arguments', () => {
    assert.strictEqual(parseArgs([]).action, 'create');
    assert.strictEqual(parseArgs(['--dry-run']).action, 'list');
    assert.strictEqual(parseArgs(['--disable']).action, 'disable');
    assert.strictEqual(parseArgs(['--live-env', '/tmp/x.env']).liveEnv, '/tmp/x.env');
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

t.run();
