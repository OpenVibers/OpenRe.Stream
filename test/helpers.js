'use strict';
/**
 * Shared test fixtures: a generated Network signing key and token minting, temp databases, a
 * manual clock, runtime/API boot helpers, child-process helpers and a tiny sequential runner.
 */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { serviceAuth } = require('openvibe-contracts');
const { load } = require('../server/config');
const { openRuntime } = require('../server/store');

const ROOT = path.join(__dirname, '..');
const ISSUER = 'https://openvibe.network';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SECRETS_KEY = crypto.randomBytes(32).toString('hex');
const OWNER = 'usr_01J0000000000000000000000A';
const OTHER = 'usr_01J0000000000000000000000B';

const silent = { log() {}, warn() {}, error(...a) { if (process.env.DEBUG) console.error(...a); } };

function serviceToken(slug, cap, { aud = 'openvibe.openre', exp = Math.floor(Date.now() / 1000) + 300 } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return serviceAuth.signServiceToken({
        iss: ISSUER, sub: `svc:${slug}`, actor_type: 'service', aud: [aud], cap, ns: [], iat: now, exp,
        jti: `tok_${crypto.randomBytes(8).toString('hex')}`,
    }, privateKey);
}

function userToken({ subjectId = OWNER, role = 'user', aud = ['openvibe.network'], exp = Math.floor(Date.now() / 1000) + 3600 } = {}) {
    return serviceAuth.signServiceToken({
        sub: 57, id: 57, subject_id: subjectId, username: 'streamer', display_name: 'Streamer', role, iss: ISSUER, aud,
        iat: Math.floor(Date.now() / 1000), exp,
    }, privateKey);
}

function manualClock(t = Date.now()) {
    return { t, now() { return this.t; }, advance(ms) { this.t += ms; return this.t; } };
}

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function tmpDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'openre-test-'));
    made.push(d);
    return d;
}

function testEnv(dir, extra = {}) {
    return {
        NODE_ENV: 'test',
        PORT: '0',
        OPENRE_DB_PATH: path.join(dir, 'openre.db'),
        OPENRE_SECRETS_KEY: SECRETS_KEY,
        OV_NETWORK_PUBLIC_KEY: publicKey,
        OPENRE_DEST_ALLOW_PRIVATE: '1',
        OPENRE_RTMP_PUBLIC_HOST: '127.0.0.1',
        ...extra,
    };
}

/** A runtime on a temp database (no network). */
function runtime({ env = {}, clock, dir = tmpDir(), fetchImpl } = {}) {
    const config = load(testEnv(dir, env));
    return { ...openRuntime({ config, clock, log: silent, fetchImpl }), dir };
}

async function bootApi({ env = {}, dir = tmpDir(), clock, fetchImpl } = {}) {
    const { start } = require('../server/index');
    const config = load(testEnv(dir, env));
    const h = await start({ config, clock, log: silent, fetchImpl });
    const base = `http://127.0.0.1:${h.server.address().port}`;
    return { ...h, base, dir };
}

async function request(base, method, p, { token, body, headers = {}, cookie, form } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (cookie) h.Cookie = cookie;
    let payload;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
}

/** A child process running one of the service's entry points with a test env. */
function child(script, env, { onLine } = {}) {
    const proc = spawn(process.execPath, [path.join(ROOT, script)], {
        cwd: ROOT,
        env: { ...process.env, ...env, OPENRE_ENV_FILE: '/nonexistent' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.output = '';
    const onData = (c) => {
        const s = c.toString();
        proc.output += s;
        if (process.env.DEBUG) process.stderr.write(`[${path.basename(script)}] ${s}`);
        if (onLine) for (const line of s.split('\n')) if (line) onLine(line);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.exited = new Promise(r => proc.on('exit', (code, signal) => r({ code, signal })));
    return proc;
}

async function waitFor(pred, { timeoutMs = 10000, intervalMs = 50, what = 'condition' } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const v = await pred();
        if (v) return v;
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
        await sleep(intervalMs);
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function hasFfmpeg() {
    try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

/** Publish a lavfi test pattern over RTMP with the system ffmpeg. */
function publish(url, { seconds } = {}) {
    const args = ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15', '-c:a', 'aac', '-b:a', '64k'];
    if (seconds) args.push('-t', String(seconds));
    args.push('-f', 'flv', url);
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.err = '';
    p.stderr.on('data', (c) => { p.err += c; });
    p.exited = new Promise(r => p.on('exit', (code, signal) => r({ code, signal })));
    return p;
}

/** An RTMP sink (ffmpeg -listen 1) that counts as a working restream destination. */
function rtmpSink(port, key = 'sinkkey') {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/app/${key}`, '-f', 'null', '-'], { stdio: 'ignore' });
    p.exited = new Promise(r => p.on('exit', (code, signal) => r({ code, signal })));
    return p;
}

function suite(name) {
    const tests = [];
    const t = (n, fn) => tests.push([n, fn]);
    t.run = async () => {
        let failed = 0;
        for (const [n, fn] of tests) {
            try { await fn(); console.log(`  ok   ${n}`); } catch (err) { failed++; console.log(`  FAIL ${n}\n${err.stack}`); }
        }
        console.log(`${name}: ${tests.length - failed}/${tests.length} passed`);
        process.exit(failed ? 1 : 0);
    };
    return t;
}

/** The event types in the outbox, in order. */
function outboxTypes(db) {
    return db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map(r => JSON.parse(r.envelope).event_type);
}
function outboxEnvelopes(db) {
    return db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map(r => JSON.parse(r.envelope));
}

module.exports = {
    ROOT, ISSUER, privateKey, publicKey, SECRETS_KEY, OWNER, OTHER, silent, serviceToken, userToken, manualClock, tmpDir, testEnv,
    runtime, bootApi, request, freePort, child, waitFor, sleep, hasFfmpeg, publish, rtmpSink, suite, outboxTypes, outboxEnvelopes,
};
