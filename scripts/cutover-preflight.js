#!/usr/bin/env node
'use strict';
/**
 * Read-only pre-flight for the RTMP cutover (docs/cutover.md). Run on the host as root:
 *
 *   sudo node /opt/openre.stream/current/scripts/cutover-preflight.js [--only a,b] [--slot <id>] [--json]
 *
 * Checks (in this order; --only / --skip pick some):
 *   release   `current` points at the expected release (--expect-release, else origin/main of
 *             /opt/openre.stream/repo as last fetched) and that release contains --require-commit
 *             (default 6dc78a5, the nginx realip fix)
 *   service   openre-api /api/ready: ready, not a drill, one ready rtmp-ingest and restream worker
 *             on the current release, a valid coordinator lease, the event relay configured
 *   env       /etc/openvibe/openre.env: OPENRE_DRILL unset, the RTMP port and public host
 *   bind      OPENRE_RTMP_BIND is public and the RTMP port really listens on a public address
 *   dns       the ingest host resolves (A/AAAA) only to this host's addresses
 *   port      the ingest port answers an RTMP handshake from outside (see "port" below)
 *   db        PRAGMA integrity_check and foreign_key_check of openre.db (opened read-only)
 *   live-env  /etc/openvibe/live.env has OPENRE_URL, OPENRE_EVENTS_SECRET (32+ chars) and
 *             OV_OAUTH_CLIENT_SECRET, and the running Live process was started with them
 *   events    Events has Live's openre.session.* subscription to /internal/openre-events, enabled,
 *             with the secret Live holds (compared by hash, never printed), and no dead deliveries
 *   slot      only with --slot <id>: the Live slot and its OpenRe definition, for the per-slot step
 *
 * "port": from the host itself a connection to its own public address never crosses the provider
 * edge, so the result is MANUAL there. Prove it from outside: run `--only port` on any machine
 * that is not the host (a checkout with `npm ci` is enough), or pass --probe-url with a probe you
 * trust (GET, `{host}` and `{port}` replaced, JSON answer with a boolean `open` or `reachable`).
 *
 * Nothing is written anywhere: files and databases are opened read-only, no secret value is
 * printed, the only network traffic is DNS, one GET to /api/ready and one TCP connection with an
 * RTMP handshake (no publish). Exit 0 when no check FAILs (--strict: also no WARN/MANUAL).
 */
const crypto = require('crypto');
const dnsPromises = require('dns').promises;
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULTS = Object.freeze({
    root: '/opt/openre.stream',
    openreEnv: '/etc/openvibe/openre.env',
    liveEnv: '/etc/openvibe/live.env',
    openreDb: '/var/lib/openre/openre.db',
    eventsDb: '/var/lib/openvibe-events/events.db',
    liveDb: '/opt/openvibe.live/data/live.db',
    api: 'http://127.0.0.1:4500',
    openreUrl: 'http://127.0.0.1:4500',
    liveUnit: 'openvibe-live.service',
    endpoint: 'http://127.0.0.1:3000/internal/openre-events',
    topic: 'openre.session.*',
    requireCommit: '6dc78a5',
    ingestHost: 'ingest.openre.stream',
    port: 1936,
    timeoutMs: 5000,
});
const CHECKS = Object.freeze(['release', 'service', 'env', 'bind', 'dns', 'port', 'db', 'live-env', 'events', 'slot']);
const WORKER_KINDS = Object.freeze(['rtmp-ingest', 'restream']);

// ── helpers ─────────────────────────────────────────────────────────────────

/** KEY=VALUE lines (systemd EnvironmentFile / dotenv); null when the file cannot be read. */
function parseEnvFile(text) {
    if (text == null) return null;
    return require('dotenv').parse(String(text));
}

const isLoopback = (a) => /^127\./.test(a) || a === '::1' || a === 'localhost' || /^::ffff:127\./.test(a);
const isWildcard = (a) => a === '0.0.0.0' || a === '::' || a === '*' || a === '[::]';
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => Boolean(a && b) && crypto.timingSafeEqual(sha256(a), sha256(b));

/** Local addresses of the listeners on a TCP port, from `ss -Hltn`. */
function parseSsListeners(stdout, port) {
    const out = [];
    for (const line of String(stdout || '').split('\n')) {
        const cols = line.trim().split(/\s+/);
        const local = cols.find((c) => new RegExp(`:${port}$`).test(c));
        if (!local) continue;
        const addr = local.slice(0, local.lastIndexOf(':')).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
        out.push(addr);
    }
    return out;
}

/** Non-internal addresses of this machine (the host's public addresses on openvibe-ovh). */
function localAddresses(interfaces = os.networkInterfaces()) {
    const out = [];
    for (const list of Object.values(interfaces || {})) for (const i of list || []) if (!i.internal) out.push(i.address);
    return out;
}

/** TCP connect + RTMP C0/C1; resolves { ok, rtmp, code, error, ms }. Sends no publish. */
function rtmpProbe(host, port, timeoutMs = DEFAULTS.timeoutMs) {
    return new Promise((resolve) => {
        const started = Date.now();
        let connected = false;
        const socket = net.connect({ host, port });
        const done = (r) => { socket.destroy(); resolve({ ms: Date.now() - started, ...r }); };
        socket.setTimeout(timeoutMs, () => done(connected
            ? { ok: true, rtmp: false, error: 'connected, but no RTMP handshake answer' }
            : { ok: false, code: 'ETIMEDOUT', error: `no answer within ${timeoutMs / 1000}s` }));
        socket.once('connect', () => {
            connected = true;
            const c1 = Buffer.alloc(1536);
            crypto.randomFillSync(c1, 8);
            socket.write(Buffer.concat([Buffer.from([0x03]), c1]));
        });
        socket.once('data', (d) => done({ ok: true, rtmp: d[0] === 0x03 }));
        socket.once('error', (err) => done({ ok: false, code: err.code, error: err.message }));
    });
}

function runCmd(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

function realDeps() {
    return {
        readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
        readBinary: (p) => { try { return fs.readFileSync(p); } catch { return null; } },
        readlink: (p) => { try { return fs.readlinkSync(p); } catch { return null; } },
        exists: (p) => fs.existsSync(p),
        run: runCmd,
        resolve4: (h) => dnsPromises.resolve4(h).catch((e) => (e.code === 'ENODATA' || e.code === 'ENOTFOUND' ? [] : Promise.reject(e))),
        resolve6: (h) => dnsPromises.resolve6(h).catch((e) => (e.code === 'ENODATA' || e.code === 'ENOTFOUND' ? [] : Promise.reject(e))),
        interfaces: () => os.networkInterfaces(),
        probe: rtmpProbe,
        fetch: (url, opts) => fetch(url, opts),
        openDb: (p) => {
            const Database = require('better-sqlite3');
            return new Database(p, { readonly: true, fileMustExist: true });
        },
    };
}

function withDb(deps, file, fn) {
    let db;
    try { db = deps.openDb(file); } catch (err) { return { error: `cannot open ${file} read-only: ${err.message}` }; }
    try { return fn(db); } finally { try { db.close(); } catch { /* read-only */ } }
}

// ── checks ──────────────────────────────────────────────────────────────────

async function checkRelease(ctx) {
    const { deps, opts } = ctx;
    const target = deps.readlink(path.join(opts.root, 'current'));
    if (!target) return ['FAIL', `${opts.root}/current is not a symlink`];
    const current = path.basename(target);
    ctx.release = current;
    const repo = path.join(opts.root, 'repo');
    let expected = opts.expectRelease;
    let source = '--expect-release';
    if (!expected) {
        const r = await deps.run('git', ['-C', repo, 'rev-parse', '--short=12', 'origin/main']);
        if (r.code !== 0) return ['FAIL', `current = ${current}; cannot read origin/main in ${repo}: ${(r.stderr || '').trim().split('\n')[0]} (run as root, or pass --expect-release)`];
        expected = r.stdout.trim();
        source = 'origin/main as last fetched';
    }
    const problems = [];
    if (!current.startsWith(expected) && !expected.startsWith(current)) problems.push(`current = ${current}, expected ${expected} (${source}): deploy it (docs/cutover.md A2)`);
    if (opts.requireCommit) {
        const r = await deps.run('git', ['-C', repo, 'merge-base', '--is-ancestor', opts.requireCommit, current]);
        if (r.code === 1) problems.push(`release ${current} does not contain ${opts.requireCommit}`);
        else if (/not a valid (object|commit)/i.test(r.stderr || '')) problems.push(`${opts.requireCommit} is not in ${repo} yet (deploy.sh release fetches it), so ${current} cannot contain it`);
        else if (r.code !== 0) problems.push(`cannot tell whether ${current} contains ${opts.requireCommit}: ${(r.stderr || '').trim().split('\n')[0]}`);
    }
    if (problems.length) return ['FAIL', problems.join('; ')];
    return ['PASS', `current = ${current} (${source})${opts.requireCommit ? `, contains ${opts.requireCommit}` : ''}`];
}

async function checkService(ctx) {
    const { deps, opts } = ctx;
    let res;
    try {
        res = await deps.fetch(`${opts.api}/api/ready`, { signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (err) {
        return ['FAIL', `${opts.api}/api/ready unreachable: ${err.message}`];
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!body) return ['FAIL', `/api/ready answered ${res.status} without JSON`];
    const problems = [];
    if (res.status !== 200 || body.status !== 'ready') problems.push(`status ${res.status} ${body.status} (${JSON.stringify(body.checks || {})})`);
    if (body.mode === 'drill') problems.push('the API runs in drill mode (OPENRE_DRILL)');
    const workers = Array.isArray(body.workers) ? body.workers : [];
    const rows = ctx.workerRows || workerRowsFromDb(ctx);
    for (const kind of WORKER_KINDS) {
        const ready = workers.filter((w) => w.kind === kind && w.state === 'ready');
        if (ready.length !== 1) { problems.push(`${ready.length} ready ${kind} workers (want 1)`); continue; }
        const row = rows && rows.find((w) => w.kind === kind && w.generation === ready[0].generation);
        if (ctx.release && row && row.release && row.release !== ctx.release) problems.push(`${kind}#${ready[0].generation} runs release ${row.release}, current is ${ctx.release}: deploy.sh workers`);
    }
    const draining = workers.filter((w) => w.state === 'draining').map((w) => `${w.kind}#${w.generation}`);
    if (!body.coordinator || !body.coordinator.lease_valid) problems.push('no valid coordinator lease');
    if (!body.events || !body.events.configured) problems.push('event relay not configured (EVENTS_URL, OV_OAUTH_CLIENT_SECRET)');
    if (problems.length) return ['FAIL', problems.join('; ')];
    const summary = WORKER_KINDS.map((k) => { const w = workers.find((x) => x.kind === k && x.state === 'ready'); return `${k}#${w.generation}`; }).join(', ');
    const pending = body.events && body.events.pending ? `, ${body.events.pending} events waiting in the outbox` : '';
    if (draining.length) return ['WARN', `ready: ${summary}; still draining: ${draining.join(', ')}${pending}`];
    return ['PASS', `ready: ${summary}, coordinator lease valid, event relay on${pending}`];
}

function workerRowsFromDb(ctx) {
    const r = withDb(ctx.deps, ctx.opts.openreDb, (db) => db.prepare("SELECT kind, generation, release, state FROM workers WHERE state IN ('starting', 'ready', 'draining')").all());
    ctx.workerRows = Array.isArray(r) ? r : null;
    return ctx.workerRows;
}

function openreEnv(ctx) {
    if (ctx.openreEnvValues === undefined) ctx.openreEnvValues = parseEnvFile(ctx.deps.readFile(ctx.opts.openreEnv));
    return ctx.openreEnvValues;
}

function liveEnv(ctx) {
    if (ctx.liveEnvValues === undefined) ctx.liveEnvValues = parseEnvFile(ctx.deps.readFile(ctx.opts.liveEnv));
    return ctx.liveEnvValues;
}

async function checkEnv(ctx) {
    const env = openreEnv(ctx);
    if (!env) return ['FAIL', `cannot read ${ctx.opts.openreEnv} (run as root)`];
    const problems = [];
    if (truthy(env.OPENRE_DRILL)) problems.push('OPENRE_DRILL is set: the coordinator and every worker refuse to start');
    const port = Number(env.OPENRE_RTMP_PORT || 1936);
    if (port !== ctx.opts.port) problems.push(`OPENRE_RTMP_PORT = ${port}, expected ${ctx.opts.port}`);
    const host = env.OPENRE_RTMP_PUBLIC_HOST || 'ingest.openre.stream';
    if (host !== ctx.opts.ingestHost) problems.push(`OPENRE_RTMP_PUBLIC_HOST = ${host}, expected ${ctx.opts.ingestHost}`);
    const missing = ['OV_OAUTH_CLIENT_SECRET', 'OPENRE_SECRETS_KEY', 'EVENTS_URL'].filter((n) => !env[n]);
    if (missing.length) problems.push(`not set: ${missing.join(', ')}`);
    if (problems.length) return ['FAIL', problems.join('; ')];
    return ['PASS', `OPENRE_DRILL unset, RTMP port ${port}, public host ${host}, secrets and EVENTS_URL set`];
}

async function checkBind(ctx) {
    const { deps, opts } = ctx;
    const env = openreEnv(ctx);
    if (!env) return ['FAIL', `cannot read ${opts.openreEnv} (run as root)`];
    const bind = env.OPENRE_RTMP_BIND || '0.0.0.0';
    const ss = await deps.run('ss', ['-Hltn', `sport = :${opts.port}`]);
    if (ss.code !== 0) return ['FAIL', `ss failed: ${ss.stderr.trim()}`];
    const listening = parseSsListeners(ss.stdout, opts.port);
    const publicListeners = listening.filter((a) => !isLoopback(a));
    const envPublic = !isLoopback(bind);
    const detail = `OPENRE_RTMP_BIND=${bind}; listening on ${listening.length ? listening.map((a) => `${a}:${opts.port}`).join(', ') : 'nothing'}`;
    if (!envPublic) return ['FAIL', `${detail}: set OPENRE_RTMP_BIND=0.0.0.0 and start a worker generation (docs/cutover.md A3)`];
    if (!publicListeners.length) return ['FAIL', `${detail}: the running generation still has the old bind; start a new one with deploy.sh workers (docs/cutover.md A3)`];
    if (!isWildcard(bind) && !publicListeners.includes(bind)) return ['WARN', `${detail}: the bind is a specific address`];
    return ['PASS', detail];
}

async function checkDns(ctx) {
    const { deps, opts } = ctx;
    let a4 = [];
    let a6 = [];
    try { [a4, a6] = await Promise.all([deps.resolve4(opts.ingestHost), deps.resolve6(opts.ingestHost)]); } catch (err) {
        return ['FAIL', `cannot resolve ${opts.ingestHost}: ${err.code || err.message}`];
    }
    const all = [...a4, ...a6];
    if (!all.length) return ['FAIL', `${opts.ingestHost} has no A or AAAA record`];
    const mine = opts.hostIps.length ? opts.hostIps : localAddresses(deps.interfaces());
    ctx.onHost = all.some((a) => localAddresses(deps.interfaces()).includes(a));
    const foreign = all.filter((a) => !mine.includes(a));
    const detail = `${opts.ingestHost} → ${all.join(', ')}`;
    if (foreign.length) {
        const hint = opts.hostIps.length ? `the host is ${opts.hostIps.join(', ')}` : 'not an address of this machine (run on the host, or pass --host-ip <the host\'s address>)';
        return ['FAIL', `${detail}; ${foreign.join(', ')}: ${hint}. A Cloudflare-proxied (orange) record cannot carry RTMP`];
    }
    const bind = (openreEnv(ctx) || {}).OPENRE_RTMP_BIND || '0.0.0.0';
    if (a6.length && bind === '0.0.0.0') return ['WARN', `${detail}: AAAA records exist but OPENRE_RTMP_BIND=0.0.0.0 listens on IPv4 only`];
    return ['PASS', `${detail} (this host)`];
}

async function checkPort(ctx) {
    const { deps, opts } = ctx;
    if (opts.probeUrl) {
        const url = opts.probeUrl.replace(/\{host\}/g, encodeURIComponent(opts.ingestHost)).replace(/\{port\}/g, String(opts.port));
        let body;
        try {
            const res = await deps.fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs * 3) });
            body = await res.json();
            if (!res.ok) return ['MANUAL', `probe answered ${res.status}; check by hand (docs/cutover.md A4)`];
        } catch (err) {
            return ['MANUAL', `probe ${new URL(url).host} failed (${err.message}); check by hand (docs/cutover.md A4)`];
        }
        const open = body && typeof body.open === 'boolean' ? body.open : body && typeof body.reachable === 'boolean' ? body.reachable : null;
        if (open === true) return ['PASS', `external probe ${new URL(url).host}: ${opts.ingestHost}:${opts.port} open`];
        if (open === false) return ['FAIL', `external probe ${new URL(url).host}: ${opts.ingestHost}:${opts.port} not reachable — open ${opts.port}/tcp at the provider edge (owner)`];
        return ['MANUAL', 'the probe answer has no boolean open/reachable; check by hand (docs/cutover.md A4)'];
    }
    let addrs = [];
    try { addrs = await deps.resolve4(opts.ingestHost); } catch { addrs = []; }
    const target = addrs[0] || opts.ingestHost;
    const onHost = addrs.some((a) => localAddresses(deps.interfaces()).includes(a));
    const r = await deps.probe(target, opts.port, opts.timeoutMs);
    const what = `${opts.ingestHost}:${opts.port}${addrs[0] ? ` (${addrs[0]})` : ''}`;
    const answer = r.ok ? (r.rtmp ? 'answers the RTMP handshake' : `accepts TCP (${r.error || 'no RTMP answer'})`) : r.code === 'ECONNREFUSED' ? 'refused (nothing listens there)' : `${r.code || 'error'}: ${r.error}`;
    if (onHost) {
        return ['MANUAL', `${what} ${answer} from this host, which never crosses the provider edge. From a machine outside: \`node scripts/cutover-preflight.js --only port\` or \`nc -vz -w 5 ${opts.ingestHost} ${opts.port}\``];
    }
    if (r.ok && r.rtmp) return ['PASS', `${what} ${answer} from outside the host (${Math.round(r.ms)} ms)`];
    if (r.ok) return ['WARN', `${what} ${answer}: something accepts TCP but is not an RTMP server`];
    if (r.code === 'ECONNREFUSED') return ['FAIL', `${what} ${answer}: the edge lets it through, but no public listener (check "bind" on the host)`];
    return ['FAIL', `${what} ${answer}: filtered — open ${opts.port}/tcp at the provider edge (owner, docs/cutover.md A4) and in the host firewall if one is active`];
}

async function checkDb(ctx) {
    const r = withDb(ctx.deps, ctx.opts.openreDb, (db) => {
        const integrity = db.prepare('PRAGMA integrity_check').all().map((x) => Object.values(x)[0]).join('; ');
        const fk = db.prepare('PRAGMA foreign_key_check').all();
        const counts = {};
        for (const t of ['stream_definitions', 'ingest_keys', 'ingest_sessions', 'destinations', 'migration_map']) {
            try { counts[t] = db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n; } catch { counts[t] = null; }
        }
        return { integrity, fk: fk.length, counts };
    });
    if (r.error) return ['FAIL', r.error];
    const counts = Object.entries(r.counts).map(([k, v]) => `${k} ${v == null ? '?' : v}`).join(', ');
    if (r.integrity !== 'ok') return ['FAIL', `integrity_check = ${r.integrity.slice(0, 300)}`];
    if (r.fk) return ['FAIL', `integrity_check ok, but ${r.fk} foreign key violation(s)`];
    return ['PASS', `integrity_check ok, no foreign key violations (${counts})`];
}

async function checkLiveEnv(ctx) {
    const { deps, opts } = ctx;
    const env = liveEnv(ctx);
    if (!env) return ['FAIL', `cannot read ${opts.liveEnv} (run as root)`];
    const problems = [];
    if (!env.OPENRE_URL) problems.push('OPENRE_URL not set (the integration is off)');
    else if (env.OPENRE_URL.replace(/\/+$/, '') !== opts.openreUrl) problems.push(`OPENRE_URL = ${env.OPENRE_URL}, expected ${opts.openreUrl}`);
    if (!env.OPENRE_EVENTS_SECRET) problems.push('OPENRE_EVENTS_SECRET not set');
    else if (env.OPENRE_EVENTS_SECRET.length < 32) problems.push('OPENRE_EVENTS_SECRET shorter than 32 characters (Events refuses it)');
    if (!env.OV_OAUTH_CLIENT_SECRET) problems.push('OV_OAUTH_CLIENT_SECRET not set (Live cannot get OpenRe tokens)');
    const notes = [];
    if (!env.OPENRE_PUBLIC_URL) notes.push('OPENRE_PUBLIC_URL unset (default https://openre.stream)');
    // The running process: systemd loaded the env file when Live started. Names only.
    const show = await deps.run('systemctl', ['show', opts.liveUnit, '--property=MainPID']);
    const pid = Number((/MainPID=(\d+)/.exec(show.stdout) || [])[1] || 0);
    if (!pid) problems.push(`${opts.liveUnit} is not running`);
    else {
        const raw = deps.readBinary(`/proc/${pid}/environ`);
        if (!raw) problems.push(`cannot read /proc/${pid}/environ (run as root)`);
        else {
            const running = new Map(String(raw).split('\0').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
            const stale = ['OPENRE_URL', 'OPENRE_EVENTS_SECRET', 'OPENRE_PUBLIC_URL'].filter((n) => (env[n] || '') !== (running.get(n) || ''));
            if (stale.length) problems.push(`Live (pid ${pid}) was started before ${stale.join(', ')} changed in ${opts.liveEnv}: restart Live (deploy.sh --restart --wait-idle)`);
        }
    }
    if (problems.length) return ['FAIL', problems.join('; ')];
    return ['PASS', `OPENRE_URL=${env.OPENRE_URL}, OPENRE_EVENTS_SECRET set, running Live (pid ${pid}) has them${notes.length ? `; ${notes.join('; ')}` : ''}`];
}

async function checkEvents(ctx) {
    const { opts } = ctx;
    const env = liveEnv(ctx) || {};
    const r = withDb(ctx.deps, opts.eventsDb, (db) => {
        const subs = db.prepare("SELECT id, enabled, secret FROM subscriptions WHERE consumer = 'live' AND topic_pattern = ? AND endpoint = ?").all(opts.topic, opts.endpoint);
        const dead = subs.length ? db.prepare("SELECT count(*) AS n FROM deliveries WHERE subscription_id = ? AND status = 'dead'").get(subs[0].id).n : 0;
        const pending = subs.length ? db.prepare("SELECT count(*) AS n FROM deliveries WHERE subscription_id = ? AND status IN ('pending', 'failed')").get(subs[0].id).n : 0;
        return { subs, dead, pending };
    });
    if (r.error) return ['FAIL', r.error];
    if (!r.subs.length) return ['FAIL', `no subscription live ${opts.topic} → ${opts.endpoint}: create it (scripts/subscribe-live-events.js, docs/cutover.md A5)`];
    if (r.subs.length > 1) return ['FAIL', `${r.subs.length} identical subscriptions (${r.subs.map((s) => s.id).join(', ')}): disable all but one`];
    const s = r.subs[0];
    const problems = [];
    if (!s.enabled) problems.push('disabled');
    if (!env.OPENRE_EVENTS_SECRET) problems.push(`cannot compare the secret: OPENRE_EVENTS_SECRET not readable in ${opts.liveEnv}`);
    else if (!sameSecret(s.secret, env.OPENRE_EVENTS_SECRET)) problems.push("its secret is not Live's OPENRE_EVENTS_SECRET (Live answers 401 to every delivery)");
    if (r.dead) problems.push(`${r.dead} dead deliveries (replay them after fixing: POST /api/v1/deliveries/replay)`);
    if (problems.length) return ['FAIL', `${s.id}: ${problems.join('; ')}`];
    return [r.pending ? 'WARN' : 'PASS', `${s.id} enabled, secret matches Live's${r.pending ? `, ${r.pending} deliveries waiting or retrying` : ', nothing waiting'}`];
}

async function checkSlot(ctx) {
    const { opts } = ctx;
    const id = Number(opts.slot);
    const live = withDb(ctx.deps, opts.liveDb, (db) => {
        const slot = db.prepare('SELECT id, user_id, slug, title, protocol, streaming_method, ingest_authority, openre_stream_id FROM managed_streams WHERE id = ?').get(id);
        if (!slot) return { slot: null };
        const liveNow = db.prepare('SELECT id FROM streams WHERE managed_stream_id = ? AND is_live = 1 LIMIT 1').get(id);
        const subject = db.prepare("SELECT subject_id FROM linked_accounts WHERE service = 'network' AND user_id = ?").get(slot.user_id);
        const user = db.prepare('SELECT username, is_banned FROM users WHERE id = ?').get(slot.user_id);
        return { slot, liveNow, subject: subject && subject.subject_id, user };
    });
    if (live.error) return ['FAIL', live.error];
    if (!live.slot) return ['FAIL', `Live has no managed stream ${id}`];
    const s = live.slot;
    const openre = withDb(ctx.deps, opts.openreDb, (db) => {
        const defs = db.prepare("SELECT d.id, d.state, d.mirror_to_live FROM external_refs r JOIN stream_definitions d ON d.id = r.definition_id WHERE r.service = 'live' AND r.type = 'managed_stream' AND r.ref_id = ?").all(String(id));
        const map = db.prepare("SELECT source_type, status, reason FROM migration_map WHERE source_system = 'live' AND ((source_type = 'managed_stream' AND source_id = ?) OR source_type = 'restream_destination')").all(String(id));
        const dests = defs.length ? db.prepare('SELECT enabled, hold_reason FROM destinations WHERE definition_id = ?').all(defs[0].id) : [];
        const openSessions = defs.length ? db.prepare("SELECT count(*) AS n FROM ingest_sessions WHERE definition_id = ? AND state IN ('starting', 'live', 'ending')").get(defs[0].id).n : 0;
        return { defs, slotMap: map.find((m) => m.source_type === 'managed_stream') || null, dests, openSessions };
    });
    if (openre.error) return ['FAIL', openre.error];
    const facts = [`slot ${id} (@${live.user ? live.user.username : '?'}, ${s.protocol}${s.streaming_method ? `/${s.streaming_method}` : ''}) authority ${s.ingest_authority || 'live'}`];
    const problems = [];
    if (live.user && live.user.is_banned) problems.push('owner is banned');
    if (!live.subject) problems.push('owner has no canonical subject (they sign in to Live once)');
    if (live.liveNow) problems.push(`live on Live right now (stream ${live.liveNow.id}): wait for the window`);
    if (s.protocol !== 'rtmp' && !['rtmp', 'obs'].includes(String(s.streaming_method || '').toLowerCase())) problems.push('not an RTMP slot (OpenRe carries RTMP only)');
    if (openre.defs.length > 1) problems.push(`${openre.defs.length} OpenRe definitions reference it`);
    const def = openre.defs[0];
    if (def) {
        facts.push(`OpenRe ${def.id} (${def.state}${def.mirror_to_live ? ', mirrored' : ', NOT mirrored to Live'})`);
        const held = openre.dests.filter((d) => d.hold_reason).length;
        facts.push(`${openre.dests.length} destination(s)${held ? `, ${held} held` : ''}`);
        if (s.openre_stream_id && s.openre_stream_id !== def.id) problems.push(`Live points at ${s.openre_stream_id}, OpenRe has ${def.id}`);
        if (openre.openSessions) facts.push(`${openre.openSessions} open OpenRe session(s)`);
    } else facts.push(openre.slotMap ? `migration_map: ${openre.slotMap.status}${openre.slotMap.reason ? ` (${openre.slotMap.reason})` : ''}` : 'not migrated yet');
    if (problems.length) return ['FAIL', `${facts.join('; ')}: ${problems.join('; ')}`];
    return ['PASS', facts.join('; ')];
}

const RUNNERS = { release: checkRelease, service: checkService, env: checkEnv, bind: checkBind, dns: checkDns, port: checkPort, db: checkDb, 'live-env': checkLiveEnv, events: checkEvents, slot: checkSlot };

// ── entry ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = { ...DEFAULTS, only: null, skip: [], hostIps: [], json: false, strict: false, expectRelease: null, probeUrl: null, slot: null };
    const take = (i) => { if (argv[i + 1] == null) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
    const names = { '--root': 'root', '--openre-env': 'openreEnv', '--live-env': 'liveEnv', '--openre-db': 'openreDb', '--events-db': 'eventsDb', '--live-db': 'liveDb', '--api': 'api', '--openre-url': 'openreUrl', '--live-unit': 'liveUnit', '--expect-release': 'expectRelease', '--require-commit': 'requireCommit', '--ingest-host': 'ingestHost', '--probe-url': 'probeUrl', '--slot': 'slot' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--strict') opts.strict = true;
        else if (a === '--only') { opts.only = take(i).split(',').map((s) => s.trim()).filter(Boolean); i++; }
        else if (a === '--skip') { opts.skip = take(i).split(',').map((s) => s.trim()).filter(Boolean); i++; }
        else if (a === '--host-ip') { opts.hostIps.push(...take(i).split(',').map((s) => s.trim()).filter(Boolean)); i++; }
        else if (a === '--port') { opts.port = Number(take(i)); i++; }
        else if (a === '--timeout-ms') { opts.timeoutMs = Number(take(i)); i++; }
        else if (names[a]) { opts[names[a]] = take(i); i++; }
        else if (a === '-h' || a === '--help') opts.help = true;
        else throw new Error(`unknown argument ${a}`);
    }
    if (opts.requireCommit === '' || opts.requireCommit === 'none') opts.requireCommit = null;
    opts.openreUrl = String(opts.openreUrl).replace(/\/+$/, '');
    opts.api = String(opts.api).replace(/\/+$/, '');
    for (const c of [...(opts.only || []), ...opts.skip]) if (!CHECKS.includes(c)) throw new Error(`unknown check ${c} (${CHECKS.join(', ')})`);
    if (opts.slot != null && !/^\d+$/.test(String(opts.slot))) throw new Error('--slot takes a Live managed stream id');
    if (!Number.isInteger(opts.port) || opts.port <= 0) throw new Error('--port must be a TCP port');
    return opts;
}

async function preflight(opts, deps = realDeps()) {
    const ctx = { opts, deps };
    const wanted = (opts.only || CHECKS.filter((c) => c !== 'slot' || opts.slot != null)).filter((c) => !opts.skip.includes(c));
    const results = [];
    for (const id of wanted) {
        if (id === 'slot' && opts.slot == null) { results.push({ id, status: 'SKIP', detail: 'pass --slot <id>' }); continue; }
        let status;
        let detail;
        try { [status, detail] = await RUNNERS[id](ctx); } catch (err) { status = 'FAIL'; detail = `check crashed: ${err.message}`; }
        results.push({ id, status, detail });
    }
    const bad = results.filter((r) => r.status === 'FAIL' || (opts.strict && ['WARN', 'MANUAL'].includes(r.status)));
    return { ok: bad.length === 0, results };
}

function format(report) {
    const lines = report.results.map((r) => `${r.status.padEnd(6)} ${r.id.padEnd(9)} ${r.detail}`);
    lines.push('', report.ok ? 'preflight: no blocking failure' : `preflight: ${report.results.filter((r) => r.status === 'FAIL').length} failed`);
    return lines.join('\n');
}

if (require.main === module) {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(`cutover-preflight: ${err.message}`); process.exit(2); }
    if (opts.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 37).join('\n')); process.exit(0); }
    preflight(opts).then((report) => {
        console.log(opts.json ? JSON.stringify(report, null, 2) : format(report));
        process.exit(report.ok ? 0 : 1);
    }, (err) => { console.error(`cutover-preflight: ${err.stack || err}`); process.exit(2); });
}

module.exports = { preflight, parseArgs, format, parseEnvFile, parseSsListeners, localAddresses, rtmpProbe, sameSecret, CHECKS, DEFAULTS };
