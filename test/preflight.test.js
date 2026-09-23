'use strict';
// scripts/cutover-preflight.js against a mocked host: files, commands, DNS, interfaces, the port
// probe and /api/ready are fakes; the three databases are real SQLite files opened read-only.
// Covers the host as it is today (2026-09-23: everything the cutover still needs fails), a host
// ready for the first slot, each failure on its own, the off-host port check, the probe URL, the
// per-slot check, and that no secret value ever reaches the output.
const assert = require('assert');
const net = require('net');
const path = require('path');
const Database = require('better-sqlite3');
const { openDb } = require('../server/db');
const { preflight, parseArgs, format, parseSsListeners, rtmpProbe, sameSecret, CHECKS } = require('../scripts/cutover-preflight');
const { tmpDir, freePort, suite } = require('./helpers');

const t = suite('preflight');

const HOST_IP = '15.204.79.215';
const RELEASE = 'aaaaaaaaaaaa';
const EVENTS_SECRET = 'e'.repeat(64);
const CLIENT_SECRET = 'c'.repeat(48);
const SECRETS_KEY = 'f'.repeat(64);
const LIVE_PID = 4242;

// ── fixtures: three databases ──────────────────────────────────────────────

function makeDbs() {
    const dir = tmpDir();
    const openrePath = path.join(dir, 'openre.db');
    const o = openDb(openrePath);
    const now = Date.now();
    const worker = o.prepare(`INSERT INTO workers (id, kind, generation, release, state, endpoints, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`);
    worker.run('wrk_1', 'rtmp-ingest', 2, RELEASE, 'ready', now, now);
    worker.run('wrk_2', 'restream', 2, RELEASE, 'ready', now, now);
    o.prepare(`INSERT INTO stream_definitions (id, owner_subject, mirror_to_live, created_at, updated_at) VALUES ('str_1', 'usr_1', 1, ?, ?)`).run(now, now);
    o.prepare(`INSERT INTO external_refs (definition_id, service, type, ref_id, created_at) VALUES ('str_1', 'live', 'managed_stream', '12', ?)`).run(now);
    o.prepare(`INSERT INTO migration_map (source_system, source_type, source_id, target_type, target_id, status, imported_at) VALUES ('live', 'managed_stream', '12', 'stream', 'str_1', 'imported', ?)`).run(now);
    o.close();

    const eventsPath = path.join(dir, 'events.db');
    const e = new Database(eventsPath);
    e.exec(`CREATE TABLE subscriptions (id TEXT PRIMARY KEY, consumer TEXT NOT NULL, topic_pattern TEXT NOT NULL, endpoint TEXT NOT NULL, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, retry_policy TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, project_id TEXT, env TEXT NOT NULL DEFAULT 'production');
        CREATE TABLE deliveries (event_id TEXT NOT NULL, subscription_id TEXT NOT NULL, seq INTEGER NOT NULL, priority INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, next_attempt_at INTEGER, last_error TEXT, last_status INTEGER, delivered_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (event_id, subscription_id));`);
    e.close();

    const livePath = path.join(dir, 'live.db');
    const l = new Database(livePath);
    l.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, is_banned INTEGER DEFAULT 0);
        CREATE TABLE managed_streams (id INTEGER PRIMARY KEY, user_id INTEGER, slug TEXT, title TEXT, protocol TEXT, streaming_method TEXT, ingest_authority TEXT DEFAULT 'live', openre_stream_id TEXT);
        CREATE TABLE streams (id INTEGER PRIMARY KEY, managed_stream_id INTEGER, is_live INTEGER);
        CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY, user_id INTEGER, service TEXT, service_user_id TEXT, subject_id TEXT);
        INSERT INTO users (id, username) VALUES (5, 'rehearsal');
        INSERT INTO managed_streams (id, user_id, slug, title, protocol, streaming_method) VALUES (12, 5, 'test', 'Test', 'rtmp', 'obs');
        INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (5, 'network', '77', 'usr_01J0000000000000000000000A');`);
    l.close();
    return { dir, openrePath, eventsPath, livePath };
}

function addSubscription(dbs, { secret = EVENTS_SECRET, enabled = 1, id = 'sub_1' } = {}) {
    const e = new Database(dbs.eventsPath);
    e.prepare(`INSERT INTO subscriptions (id, consumer, topic_pattern, endpoint, secret, enabled, created_at, updated_at) VALUES (?, 'live', 'openre.session.*', 'http://127.0.0.1:3000/internal/openre-events', ?, ?, 0, 0)`).run(id, secret, enabled);
    e.close();
}

function addDelivery(dbs, status, n = 1) {
    const e = new Database(dbs.eventsPath);
    for (let i = 0; i < n; i++) e.prepare("INSERT INTO deliveries (event_id, subscription_id, seq, priority, status, created_at, updated_at) VALUES (?, 'sub_1', ?, 1, ?, 0, 0)").run(`evt_${status}_${i}`, i, status);
    e.close();
}

// ── fixtures: the host ─────────────────────────────────────────────────────

const envText = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

/** A host that is ready for the first slot. Every field can be overridden per test. */
function host(dbs, over = {}) {
    const h = {
        release: RELEASE,
        originMain: RELEASE,
        containsCommit: true,
        openreEnv: { OV_OAUTH_CLIENT_ID: 'openre', OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET, OPENRE_SECRETS_KEY: SECRETS_KEY, OPENRE_RTMP_PORT: '1936', OPENRE_RTMP_BIND: '0.0.0.0', OPENRE_RTMP_PUBLIC_HOST: 'ingest.openre.stream', EVENTS_URL: 'http://127.0.0.1:4300', MEDIA_API_KEY: 'm'.repeat(40) },
        liveEnv: { OV_OAUTH_CLIENT_ID: 'live', OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET, OPENRE_URL: 'http://127.0.0.1:4500', OPENRE_PUBLIC_URL: 'https://openre.stream', OPENRE_EVENTS_SECRET: EVENTS_SECRET },
        runningLiveEnv: null, // default: same as liveEnv
        ss: 'LISTEN 0      511          0.0.0.0:1936       0.0.0.0:*\nLISTEN 0 511 127.0.0.1:19360 0.0.0.0:*\n',
        a4: [HOST_IP],
        a6: [],
        interfaces: { lo: [{ address: '127.0.0.1', internal: true }], ens3: [{ address: HOST_IP, internal: false }, { address: '2604:2dc0:202:200::7c', internal: false }] },
        probe: { ok: true, rtmp: true, ms: 12 },
        ready: { status: 200, body: { status: 'ready', checks: { db: true, key: true }, workers: [{ kind: 'restream', generation: 2, state: 'ready' }, { kind: 'rtmp-ingest', generation: 2, state: 'ready' }], coordinator: { holder: 'coordinator:1', lease_valid: true }, events: { configured: true, pending: 0, rejected: 0 } } },
        probeUrl: null,
        ...over,
    };
    const calls = [];
    const files = {
        '/etc/openvibe/openre.env': h.openreEnv ? envText(h.openreEnv) : null,
        '/etc/openvibe/live.env': h.liveEnv ? envText(h.liveEnv) : null,
    };
    const running = h.runningLiveEnv || h.liveEnv || {};
    const deps = {
        calls,
        readFile: (p) => (p in files ? files[p] : null),
        readBinary: (p) => (p === `/proc/${LIVE_PID}/environ` ? Buffer.from(`PATH=/usr/bin\0${Object.entries(running).map(([k, v]) => `${k}=${v}`).join('\0')}\0`) : null),
        readlink: (p) => (p === '/opt/openre.stream/current' && h.release ? `/opt/openre.stream/releases/${h.release}` : null),
        run: async (cmd, args) => {
            calls.push([cmd, ...args]);
            if (cmd === 'git' && args.includes('rev-parse')) return { code: 0, stdout: `${h.originMain}\n`, stderr: '' };
            if (cmd === 'git' && args.includes('merge-base')) {
                if (h.containsCommit === 'unknown') return { code: 128, stdout: '', stderr: `fatal: Not a valid object name ${args[args.length - 2]}\n` };
                return { code: h.containsCommit ? 0 : 1, stdout: '', stderr: '' };
            }
            if (cmd === 'ss') return { code: 0, stdout: h.ss, stderr: '' };
            if (cmd === 'systemctl') return { code: 0, stdout: `MainPID=${h.livePid === undefined ? LIVE_PID : h.livePid}\n`, stderr: '' };
            return { code: 127, stdout: '', stderr: `no ${cmd}` };
        },
        resolve4: async () => h.a4,
        resolve6: async () => h.a6,
        interfaces: () => h.interfaces,
        probe: async (hostName, port) => { calls.push(['probe', hostName, port]); return h.probe; },
        fetch: async (url) => {
            calls.push(['fetch', url]);
            if (url.endsWith('/api/ready')) {
                if (h.ready instanceof Error) throw h.ready;
                return { status: h.ready.status, ok: h.ready.status < 300, json: async () => h.ready.body };
            }
            if (h.probeUrl) return { status: h.probeUrl.status || 200, ok: (h.probeUrl.status || 200) < 300, json: async () => h.probeUrl.body };
            throw new Error(`unexpected fetch ${url}`);
        },
        openDb: h.openDb || ((p) => new Database(p, { readonly: true, fileMustExist: true })),
    };
    deps.h = h;
    return deps;
}

function opts(dbs, argv = []) {
    return parseArgs(['--openre-db', dbs.openrePath, '--events-db', dbs.eventsPath, '--live-db', dbs.livePath, ...argv]);
}

const byId = (report) => Object.fromEntries(report.results.map((r) => [r.id, r]));

function assertNoSecret(report) {
    const text = JSON.stringify(report) + format(report);
    for (const s of [EVENTS_SECRET, CLIENT_SECRET, SECRETS_KEY, 'm'.repeat(40), 'x'.repeat(64)]) assert.ok(!text.includes(s), 'a secret value reached the output');
}

// ── tests ──────────────────────────────────────────────────────────────────

t('a host ready for the first slot: every check passes; on the host the port check is MANUAL', async () => {
    const dbs = makeDbs();
    addSubscription(dbs);
    const deps = host(dbs);
    const report = await preflight(opts(dbs), deps);
    const r = byId(report);
    assert.deepStrictEqual(Object.keys(r), CHECKS.filter((c) => c !== 'slot'), 'slot runs only with --slot');
    for (const id of ['release', 'service', 'env', 'bind', 'dns', 'db', 'live-env', 'events']) assert.strictEqual(r[id].status, 'PASS', `${id}: ${r[id].detail}`);
    assert.strictEqual(r.port.status, 'MANUAL');
    assert.match(r.port.detail, /never crosses the provider edge/);
    assert.match(r.port.detail, /--only port/);
    assert.strictEqual(report.ok, true);
    assert.strictEqual((await preflight(opts(dbs, ['--strict']), host(dbs))).ok, false, '--strict counts MANUAL as blocking');
    assertNoSecret(report);
    // read-only: the only commands are git reads, ss and systemctl show
    for (const c of deps.calls.filter((x) => !['probe', 'fetch'].includes(x[0]))) {
        assert.ok(['git rev-parse', 'git merge-base', 'ss -Hltn', 'systemctl show'].some((p) => c.join(' ').replace(/-C \S+ /, '').startsWith(p)), `unexpected command ${c.join(' ')}`);
    }
});

t('the host as it is on 2026-09-23: old release, loopback bind, Live env and subscription missing', async () => {
    const dbs = makeDbs();
    const deps = host(dbs, {
        release: '655b98a10aaa',
        originMain: '450f87c3b2a1',
        containsCommit: false,
        openreEnv: { ...host(dbs).h.openreEnv, OPENRE_RTMP_BIND: '127.0.0.1' },
        liveEnv: { OV_OAUTH_CLIENT_ID: 'live', OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
        ss: 'LISTEN 0 511 127.0.0.1:1936 0.0.0.0:*\n',
    });
    const report = await preflight(opts(dbs), deps);
    const r = byId(report);
    assert.strictEqual(report.ok, false);
    assert.strictEqual(r.release.status, 'FAIL');
    assert.match(r.release.detail, /current = 655b98a10aaa, expected 450f87c3b2a1/);
    assert.match(r.release.detail, /does not contain 6dc78a5/);
    assert.strictEqual(r.bind.status, 'FAIL');
    assert.match(r.bind.detail, /OPENRE_RTMP_BIND=127\.0\.0\.1; listening on 127\.0\.0\.1:1936: set OPENRE_RTMP_BIND=0\.0\.0\.0/);
    assert.strictEqual(r['live-env'].status, 'FAIL');
    assert.match(r['live-env'].detail, /OPENRE_URL not set/);
    assert.match(r['live-env'].detail, /OPENRE_EVENTS_SECRET not set/);
    assert.strictEqual(r.events.status, 'FAIL');
    assert.match(r.events.detail, /no subscription live openre\.session\.\* → http:\/\/127\.0\.0\.1:3000\/internal\/openre-events/);
    assert.strictEqual(r.dns.status, 'PASS', 'DNS is already done');
    assert.strictEqual(r.db.status, 'PASS');
    assertNoSecret(report);
});

t('release: --expect-release wins over origin/main; --require-commit none skips the ancestry check', async () => {
    const dbs = makeDbs();
    const deps = host(dbs, { originMain: 'bbbbbbbbbbbb', containsCommit: false });
    let r = byId(await preflight(opts(dbs, ['--only', 'release', '--expect-release', RELEASE, '--require-commit', 'none']), deps));
    assert.strictEqual(r.release.status, 'PASS');
    assert.ok(!deps.calls.some((c) => c.includes('rev-parse')), 'origin/main is not read when a release is given');
    r = byId(await preflight(opts(dbs, ['--only', 'release']), host(dbs, { containsCommit: 'unknown' })));
    assert.match(r.release.detail, /6dc78a5 is not in \/opt\/openre\.stream\/repo yet \(deploy\.sh release fetches it\)/, 'production on 2026-09-23: the repo never fetched 6dc78a5');
    r = byId(await preflight(opts(dbs, ['--only', 'release']), host(dbs, { release: null })));
    assert.match(r.release.detail, /not a symlink/);
});

t('bind: public in the env but the running generation still listens on loopback → deploy.sh workers', async () => {
    const dbs = makeDbs();
    const r = byId(await preflight(opts(dbs, ['--only', 'bind']), host(dbs, { ss: 'LISTEN 0 511 127.0.0.1:1936 0.0.0.0:*\n' })));
    assert.strictEqual(r.bind.status, 'FAIL');
    assert.match(r.bind.detail, /deploy\.sh workers/);
    const r6 = byId(await preflight(opts(dbs, ['--only', 'bind']), host(dbs, { ss: 'LISTEN 0 511 [::]:1936 [::]:*\nLISTEN 0 511 0.0.0.0:19360 0.0.0.0:*\n', openreEnv: { ...host(dbs).h.openreEnv, OPENRE_RTMP_BIND: '::' } })));
    assert.strictEqual(r6.bind.status, 'PASS', r6.bind.detail);
});

t('env: OPENRE_DRILL in the production env file fails; so do a wrong port or host', async () => {
    const dbs = makeDbs();
    const base = host(dbs).h.openreEnv;
    let r = byId(await preflight(opts(dbs, ['--only', 'env']), host(dbs, { openreEnv: { ...base, OPENRE_DRILL: '1' } })));
    assert.strictEqual(r.env.status, 'FAIL');
    assert.match(r.env.detail, /OPENRE_DRILL is set/);
    r = byId(await preflight(opts(dbs, ['--only', 'env']), host(dbs, { openreEnv: { ...base, OPENRE_RTMP_PORT: '1935', OPENRE_RTMP_PUBLIC_HOST: 'openre.stream' } })));
    assert.match(r.env.detail, /OPENRE_RTMP_PORT = 1935/);
    assert.match(r.env.detail, /OPENRE_RTMP_PUBLIC_HOST = openre\.stream/);
    r = byId(await preflight(opts(dbs, ['--only', 'env,bind']), host(dbs, { openreEnv: null })));
    assert.match(r.env.detail, /cannot read \/etc\/openvibe\/openre\.env \(run as root\)/);
    assert.strictEqual(r.bind.status, 'FAIL');
});

t('dns: a proxied (foreign) address fails; AAAA with an IPv4-only bind warns; off the host --host-ip decides', async () => {
    const dbs = makeDbs();
    let r = byId(await preflight(opts(dbs, ['--only', 'dns']), host(dbs, { a4: ['104.21.3.4'] })));
    assert.strictEqual(r.dns.status, 'FAIL');
    assert.match(r.dns.detail, /Cloudflare-proxied/);
    r = byId(await preflight(opts(dbs, ['--only', 'dns']), host(dbs, { a6: ['2604:2dc0:202:200::7c'] })));
    assert.strictEqual(r.dns.status, 'WARN');
    assert.match(r.dns.detail, /IPv4 only/);
    r = byId(await preflight(opts(dbs, ['--only', 'dns']), host(dbs, { a4: [] })));
    assert.match(r.dns.detail, /no A or AAAA record/);
    const laptop = { lo: [{ address: '127.0.0.1', internal: true }], wlan0: [{ address: '10.0.0.9', internal: false }] };
    r = byId(await preflight(opts(dbs, ['--only', 'dns']), host(dbs, { interfaces: laptop })));
    assert.strictEqual(r.dns.status, 'FAIL');
    assert.match(r.dns.detail, /--host-ip/);
    r = byId(await preflight(opts(dbs, ['--only', 'dns', '--host-ip', HOST_IP]), host(dbs, { interfaces: laptop })));
    assert.strictEqual(r.dns.status, 'PASS');
});

t('port from outside the host: handshake = PASS, refused = no public listener, timeout = provider edge', async () => {
    const dbs = makeDbs();
    const laptop = { wlan0: [{ address: '10.0.0.9', internal: false }] };
    const run = (probe) => preflight(opts(dbs, ['--only', 'port']), host(dbs, { interfaces: laptop, probe })).then(byId);
    let r = await run({ ok: true, rtmp: true, ms: 40 });
    assert.strictEqual(r.port.status, 'PASS');
    assert.match(r.port.detail, /ingest\.openre\.stream:1936 \(15\.204\.79\.215\) answers the RTMP handshake from outside/);
    r = await run({ ok: false, code: 'ECONNREFUSED', error: 'connect ECONNREFUSED' });
    assert.strictEqual(r.port.status, 'FAIL');
    assert.match(r.port.detail, /no public listener/);
    r = await run({ ok: false, code: 'ETIMEDOUT', error: 'no answer within 5s' });
    assert.strictEqual(r.port.status, 'FAIL');
    assert.match(r.port.detail, /open 1936\/tcp at the provider edge \(owner, docs\/cutover\.md A4\)/);
    r = await run({ ok: true, rtmp: false, error: 'connected, but no RTMP handshake answer' });
    assert.strictEqual(r.port.status, 'WARN');
});

t('port with --probe-url: open/closed from the probe, anything else MANUAL', async () => {
    const dbs = makeDbs();
    const url = 'https://probe.example/check?host={host}&port={port}';
    const run = (probeUrl) => {
        const deps = host(dbs, { probeUrl });
        return preflight(opts(dbs, ['--only', 'port', '--probe-url', url]), deps).then((rep) => ({ r: byId(rep), deps }));
    };
    let { r, deps } = await run({ body: { open: true } });
    assert.strictEqual(r.port.status, 'PASS');
    assert.ok(deps.calls.some((c) => c[0] === 'fetch' && c[1] === 'https://probe.example/check?host=ingest.openre.stream&port=1936'));
    assert.ok(!deps.calls.some((c) => c[0] === 'probe'), 'no direct connection when a probe URL is given');
    ({ r } = await run({ body: { reachable: false } }));
    assert.strictEqual(r.port.status, 'FAIL');
    ({ r } = await run({ body: { hello: 'world' } }));
    assert.strictEqual(r.port.status, 'MANUAL');
    ({ r } = await run({ status: 500, body: {} }));
    assert.strictEqual(r.port.status, 'MANUAL');
});

t('service: not ready, drill mode, a worker on an old release, no lease, relay off, draining', async () => {
    const dbs = makeDbs();
    const ready = host(dbs).h.ready;
    const run = (body, status = 200, argv = []) => preflight(opts(dbs, ['--only', 'release,service', ...argv]), host(dbs, { ready: { status, body } })).then(byId);
    let r = await run({ ...ready.body, status: 'not_ready', checks: { db: true, key: false } }, 503);
    assert.strictEqual(r.service.status, 'FAIL');
    assert.match(r.service.detail, /status 503 not_ready/);
    r = await run({ ...ready.body, mode: 'drill' });
    assert.match(r.service.detail, /drill mode/);
    r = await run({ ...ready.body, coordinator: { lease_valid: false }, events: { configured: false } });
    assert.match(r.service.detail, /no valid coordinator lease/);
    assert.match(r.service.detail, /event relay not configured/);
    r = await run({ ...ready.body, workers: [...ready.body.workers, { kind: 'rtmp-ingest', generation: 1, state: 'draining' }] });
    assert.strictEqual(r.service.status, 'WARN');
    assert.match(r.service.detail, /still draining: rtmp-ingest#1/);
    r = await run({ ...ready.body, workers: [{ kind: 'restream', generation: 2, state: 'ready' }] });
    assert.match(r.service.detail, /0 ready rtmp-ingest workers/);
    // the ready generation runs another release than `current`
    const db = new Database(dbs.openrePath);
    db.prepare("UPDATE workers SET release = '655b98a10aaa' WHERE kind = 'rtmp-ingest'").run();
    db.close();
    r = await run(ready.body);
    assert.strictEqual(r.service.status, 'FAIL');
    assert.match(r.service.detail, /rtmp-ingest#2 runs release 655b98a10aaa, current is aaaaaaaaaaaa: deploy\.sh workers/);
    const down = byId(await preflight(opts(dbs, ['--only', 'service']), host(dbs, { ready: new Error('connect ECONNREFUSED 127.0.0.1:4500') })));
    assert.match(down.service.detail, /unreachable/);
});

t('live-env: Live running without the new settings must be restarted; a short secret is refused', async () => {
    const dbs = makeDbs();
    const env = host(dbs).h.liveEnv;
    let r = byId(await preflight(opts(dbs, ['--only', 'live-env']), host(dbs, { runningLiveEnv: { OV_OAUTH_CLIENT_SECRET: CLIENT_SECRET } })));
    assert.strictEqual(r['live-env'].status, 'FAIL');
    assert.match(r['live-env'].detail, /started before OPENRE_URL, OPENRE_EVENTS_SECRET, OPENRE_PUBLIC_URL changed/);
    assert.match(r['live-env'].detail, /deploy\.sh --restart --wait-idle/);
    r = byId(await preflight(opts(dbs, ['--only', 'live-env']), host(dbs, { liveEnv: { ...env, OPENRE_EVENTS_SECRET: 'short', OPENRE_URL: 'http://127.0.0.1:4501' } })));
    assert.match(r['live-env'].detail, /shorter than 32/);
    assert.match(r['live-env'].detail, /OPENRE_URL = http:\/\/127\.0\.0\.1:4501, expected http:\/\/127\.0\.0\.1:4500/);
    r = byId(await preflight(opts(dbs, ['--only', 'live-env']), host(dbs, { livePid: 0 })));
    assert.match(r['live-env'].detail, /openvibe-live\.service is not running/);
    assertNoSecret({ results: Object.values(r) });
});

t('events: wrong secret, disabled, duplicates, dead deliveries fail; waiting deliveries warn; secrets never printed', async () => {
    let dbs = makeDbs();
    addSubscription(dbs, { secret: 'x'.repeat(64) });
    let r = byId(await preflight(opts(dbs, ['--only', 'events']), host(dbs)));
    assert.strictEqual(r.events.status, 'FAIL');
    assert.match(r.events.detail, /secret is not Live's OPENRE_EVENTS_SECRET/);
    assertNoSecret({ results: Object.values(r) });

    dbs = makeDbs();
    addSubscription(dbs, { enabled: 0 });
    addDelivery(dbs, 'dead', 2);
    r = byId(await preflight(opts(dbs, ['--only', 'events']), host(dbs)));
    assert.match(r.events.detail, /disabled/);
    assert.match(r.events.detail, /2 dead deliveries/);

    dbs = makeDbs();
    addSubscription(dbs);
    addSubscription(dbs, { id: 'sub_2' });
    r = byId(await preflight(opts(dbs, ['--only', 'events']), host(dbs)));
    assert.match(r.events.detail, /2 identical subscriptions/);

    dbs = makeDbs();
    addSubscription(dbs);
    addDelivery(dbs, 'failed', 3);
    r = byId(await preflight(opts(dbs, ['--only', 'events']), host(dbs)));
    assert.strictEqual(r.events.status, 'WARN');
    assert.match(r.events.detail, /3 deliveries waiting or retrying/);

    r = byId(await preflight(opts(dbs, ['--only', 'events', '--events-db', '/nonexistent/events.db']), host(dbs)));
    assert.match(r.events.detail, /cannot open \/nonexistent\/events\.db read-only/);
});

t('db: integrity_check and foreign keys from a read-only handle', async () => {
    const dbs = makeDbs();
    let r = byId(await preflight(opts(dbs, ['--only', 'db']), host(dbs)));
    assert.strictEqual(r.db.status, 'PASS');
    assert.match(r.db.detail, /stream_definitions 1, ingest_keys 0, ingest_sessions 0, destinations 0, migration_map 1/);
    const corrupt = () => ({
        prepare: (sql) => ({ all: () => (/integrity_check/.test(sql) ? [{ integrity_check: '*** in database main *** Page 7 is never used' }] : []), get: () => ({ n: 0 }) }),
        close() {},
    });
    r = byId(await preflight(opts(dbs, ['--only', 'db']), host(dbs, { openDb: corrupt })));
    assert.strictEqual(r.db.status, 'FAIL');
    assert.match(r.db.detail, /Page 7 is never used/);
    // the real handle really is read-only
    const ro = new Database(dbs.openrePath, { readonly: true, fileMustExist: true });
    assert.throws(() => ro.prepare("DELETE FROM migration_map").run(), /readonly/);
    ro.close();
});

t('slot: offline RTMP slot with a subject and a migrated definition passes; live now / no subject fail', async () => {
    const dbs = makeDbs();
    let r = byId(await preflight(opts(dbs, ['--only', 'slot', '--slot', '12']), host(dbs)));
    assert.strictEqual(r.slot.status, 'PASS', r.slot.detail);
    assert.match(r.slot.detail, /slot 12 \(@rehearsal, rtmp\/obs\) authority live; OpenRe str_1 \(active, mirrored\); 0 destination\(s\)/);
    const l = new Database(dbs.livePath);
    l.prepare('INSERT INTO streams (managed_stream_id, is_live) VALUES (12, 1)').run();
    l.prepare('DELETE FROM linked_accounts').run();
    l.close();
    r = byId(await preflight(opts(dbs, ['--only', 'slot', '--slot', '12']), host(dbs)));
    assert.strictEqual(r.slot.status, 'FAIL');
    assert.match(r.slot.detail, /live on Live right now/);
    assert.match(r.slot.detail, /no canonical subject/);
    r = byId(await preflight(opts(dbs, ['--only', 'slot', '--slot', '99']), host(dbs)));
    assert.match(r.slot.detail, /no managed stream 99/);
    r = byId(await preflight(opts(dbs, ['--only', 'slot']), host(dbs)));
    assert.strictEqual(r.slot.status, 'SKIP');
});

t('arguments, ss parsing and the secret comparison', () => {
    assert.throws(() => parseArgs(['--only', 'nope']), /unknown check nope/);
    assert.throws(() => parseArgs(['--slot', 'abc']), /--slot/);
    assert.throws(() => parseArgs(['--frobnicate']), /unknown argument/);
    assert.deepStrictEqual(parseArgs(['--host-ip', '1.2.3.4,5.6.7.8', '--host-ip', '9.9.9.9']).hostIps, ['1.2.3.4', '5.6.7.8', '9.9.9.9']);
    assert.deepStrictEqual(parseSsListeners('LISTEN 0 511 127.0.0.1:1936 0.0.0.0:*\nLISTEN 0 511 [::]:1936 [::]:*\nLISTEN 0 511 *:1936 *:*\nLISTEN 0 511 127.0.0.1:19360 0.0.0.0:*\n', 1936), ['127.0.0.1', '::', '*']);
    assert.strictEqual(sameSecret('a'.repeat(40), 'a'.repeat(40)), true);
    assert.strictEqual(sameSecret('a'.repeat(40), 'a'.repeat(39)), false);
    assert.strictEqual(sameSecret('', ''), false);
});

t('rtmpProbe: a real socket — RTMP answer, a non-RTMP server, and a refused port', async () => {
    const rtmp = net.createServer((s) => s.once('data', () => s.write(Buffer.concat([Buffer.from([0x03]), Buffer.alloc(1536)]))));
    const other = net.createServer((s) => s.once('data', () => s.write('HTTP/1.1 400 Bad Request\r\n\r\n')));
    await new Promise((r) => rtmp.listen(0, '127.0.0.1', r));
    await new Promise((r) => other.listen(0, '127.0.0.1', r));
    const a = await rtmpProbe('127.0.0.1', rtmp.address().port, 2000);
    assert.deepStrictEqual([a.ok, a.rtmp], [true, true]);
    const b = await rtmpProbe('127.0.0.1', other.address().port, 2000);
    assert.deepStrictEqual([b.ok, b.rtmp], [true, false]);
    const closed = await freePort();
    const c = await rtmpProbe('127.0.0.1', closed, 2000);
    assert.deepStrictEqual([c.ok, c.code], [false, 'ECONNREFUSED']);
    rtmp.close();
    other.close();
});

t.run();
