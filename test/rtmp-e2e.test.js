'use strict';
// End to end with real processes and real RTMP (system ffmpeg): openre-api, openre-rtmp-ingest,
// openre-restream-worker and openre-session-coordinator as separate child processes, a stub
// OpenVibe.Network (token endpoint), a stub OpenVibe.Events and a stub OpenVibe.Media.
//
// Proves: ingest with OpenRe's own keys (wrong and duplicate publishers refused), restream to a
// working destination while a dead destination fails without touching the session, recording
// requested from Media with a key-free loopback URL that Media can actually pull, an API restart
// during the broadcast that ends nothing, HTTP-FLV playback through the new API, a worker
// generation rollover (new sessions on the new generation, the old one drains and exits on its
// own), and the events published to OpenVibe.Events.
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const {
    tmpDir, testEnv, child, waitFor, request, userToken, freePort, sleep, suite, hasFfmpeg, publish, rtmpSink, OWNER,
} = require('./helpers');

if (!hasFfmpeg()) {
    console.log('rtmp-e2e: SKIPPED (no ffmpeg on PATH)');
    process.exit(0);
}

const t = suite('rtmp-e2e');
const token = userToken({ subjectId: OWNER });
const procs = [];
const published = [];
const mediaCalls = [];
let env;
let api;
let coordinator;
let base;
let rtmpPort;
let ingest1;
let stubs = [];

function stubServer(handler) {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => handler(req, res, body));
        });
        s.listen(0, '127.0.0.1', () => { stubs.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
    });
}

const json = (res, status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };

function startChild(script, extra = {}) {
    const p = child(script, { ...env, ...extra });
    procs.push(p);
    return p;
}

async function startApi() {
    const p = startChild('server/index.js');
    await waitFor(async () => { try { return (await request(base, 'GET', '/api/ready')).status === 200; } catch { return false; } }, { what: 'api ready' });
    return p;
}

async function session(streamId, state = 'live') {
    const r = await request(base, 'GET', `/api/v1/sessions?stream_id=${streamId}`, { token });
    return (r.body.sessions || []).find(s => s.state === state) || null;
}

let streamA;
let keyA;
let pubA;
let sessionA;
let sink;

t('setup: stubs and the four OpenRe processes', async () => {
    const network = await stubServer((req, res, body) => {
        if (req.url === '/oauth/token') {
            const p = new URLSearchParams(body);
            return json(res, 200, { access_token: `tok-${p.get('audience')}`, token_type: 'Bearer', expires_in: 300 });
        }
        return json(res, 404, {});
    });
    const events = await stubServer((req, res, body) => {
        if (req.url === '/api/v1/events' && req.method === 'POST') {
            assert.strictEqual(req.headers.authorization, 'Bearer tok-openvibe.events');
            const parsed = JSON.parse(body);
            const list = parsed.events || [parsed];
            const results = list.map((e) => { published.push(e); return { event_id: e.event_id, seq: published.length, duplicate: false }; });
            return json(res, parsed.events ? 200 : 201, parsed.events ? { results } : results[0]);
        }
        return json(res, 404, {});
    });
    const media = await stubServer((req, res, body) => {
        const call = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
        mediaCalls.push(call);
        if (req.method === 'POST' && req.url === '/api/v1/live/vods') return json(res, 201, { id: 77 });
        if (req.method === 'POST' && req.url === '/api/v1/live/vods/77/ingest/rtmp') {
            // Behave like Media: pull the URL with ffmpeg (here for 2 s) and remember the result.
            const pull = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '5000000', '-i', call.body.rtmp_url, '-t', '2', '-f', 'null', '-'], { stdio: 'ignore' });
            procs.push(pull);
            pull.on('exit', (code) => { call.pullExit = code; });
            return json(res, 202, { id: 77, status: 'recording' });
        }
        if (req.method === 'POST' && req.url === '/api/v1/live/vods/77/finalize') return json(res, 200, { ok: true });
        return json(res, 404, { error: 'no' });
    });
    rtmpPort = await freePort();
    const dir = tmpDir();
    env = testEnv(dir, {
        PORT: String(await freePort()),
        OPENRE_RTMP_PORT: String(rtmpPort),
        OPENRE_RTMP_INTERNAL_PORT_MIN: String(20000 + Math.floor(Math.random() * 20000)),
        OV_NETWORK_INTERNAL_URL: network,
        OV_OAUTH_CLIENT_SECRET: 'test-secret',
        EVENTS_URL: events,
        EVENTS_RELAY_INTERVAL_MS: '200',
        MEDIA_URL: media,
        MEDIA_API_KEY: 'media-app-key',
        OPENRE_RECORDING_START_DELAY_MS: '300',
        OPENRE_WORKER_HEARTBEAT_MS: '250',
        OPENRE_WORKER_LEASE_MS: '4000',
        OPENRE_COORDINATOR_INTERVAL_MS: '250',
        OPENRE_RESTREAM_POLL_MS: '250',
        OPENRE_OUTPUT_START_DELAY_MS: '500',
        OPENRE_RESTART_BASE_MS: '200',
        OPENRE_MAX_RESTARTS: '3',
        OPENRE_RAPID_CRASH_GIVEUP: '2',
    });
    env.OPENRE_RTMP_INTERNAL_PORT_MAX = String(Number(env.OPENRE_RTMP_INTERNAL_PORT_MIN) + 20);
    base = `http://127.0.0.1:${env.PORT}`;
    coordinator = startChild('workers/coordinator.js');
    ingest1 = startChild('workers/rtmp-ingest.js');
    startChild('workers/restream-worker.js');
    api = await startApi();
    await waitFor(() => /generation 1 ready/.test(ingest1.output), { what: 'rtmp worker ready' });
});

t('a stream with a working and a dead destination', async () => {
    const r = await request(base, 'POST', '/api/v1/streams', { token, body: { title: 'E2E', recording_mode: 'vod', external_refs: [{ service: 'live', type: 'managed_stream', id: '5' }, { service: 'live', type: 'user', id: '42' }] } });
    assert.strictEqual(r.status, 201);
    streamA = r.body.stream.id;
    keyA = r.body.key.key;
    const sinkPort = await freePort();
    sink = rtmpSink(sinkPort);
    procs.push(sink);
    const deadPort = await freePort();
    assert.strictEqual((await request(base, 'POST', `/api/v1/streams/${streamA}/destinations`, { token, body: { platform: 'custom', name: 'sink', server_url: `rtmp://127.0.0.1:${sinkPort}/app`, stream_key: 'sinkkey' } })).status, 201);
    assert.strictEqual((await request(base, 'POST', `/api/v1/streams/${streamA}/destinations`, { token, body: { platform: 'custom', name: 'dead', server_url: `rtmp://127.0.0.1:${deadPort}/app`, stream_key: 'deadkey' } })).status, 201);
});

t('a wrong key is refused; the right key goes live on generation 1', async () => {
    const wrong = publish(`rtmp://127.0.0.1:${rtmpPort}/live/ork_${'x'.repeat(43)}`, { seconds: 3 });
    procs.push(wrong);
    const w = await wrong.exited;
    assert.notStrictEqual(w.code, 0, 'ffmpeg with a wrong key fails');
    pubA = publish(`rtmp://127.0.0.1:${rtmpPort}/live/${keyA}`);
    procs.push(pubA);
    sessionA = await waitFor(() => session(streamA), { what: 'session A live', timeoutMs: 15000 });
    assert.strictEqual(sessionA.worker.generation, 1);
});

t('a second publisher with the same key is refused while the first is live', async () => {
    const dup = publish(`rtmp://127.0.0.1:${rtmpPort}/live/${keyA}`, { seconds: 3 });
    procs.push(dup);
    const d = await dup.exited;
    assert.notStrictEqual(d.code, 0);
    assert.ok((await session(streamA)).id === sessionA.id);
});

t('the working destination goes live, the dead one fails, the session stays live', async () => {
    const outputs = await waitFor(async () => {
        const r = await request(base, 'GET', `/api/v1/sessions/${sessionA.id}/outputs`, { token });
        const o = r.body.outputs || [];
        return o.length === 2 && o.some(x => x.state === 'live') && o.some(x => x.state === 'failed') ? o : null;
    }, { what: 'outputs live + failed', timeoutMs: 40000 });
    const failed = outputs.find(o => o.state === 'failed');
    assert.match(failed.last_error, /connect|closed|refused|rapid/i);
    assert.strictEqual((await session(streamA)).id, sessionA.id, 'the source session is still live');
    assert.strictEqual(pubA.exitCode, null, 'the encoder is still connected');
});

t('recording is requested from Media with a loopback URL that carries no key, and Media can pull it', async () => {
    const ingestCall = await waitFor(() => mediaCalls.find(c => c.url.endsWith('/ingest/rtmp')), { what: 'media ingest call', timeoutMs: 10000 });
    const create = mediaCalls.find(c => c.url === '/api/v1/live/vods');
    assert.strictEqual(create.auth, 'Bearer media-app-key');
    assert.strictEqual(create.body.user_id, 42);
    assert.strictEqual(create.body.managed_stream_id, 5);
    assert.strictEqual(create.body.meta.openre_session_id, sessionA.id);
    assert.match(ingestCall.body.rtmp_url, new RegExp(`^rtmp://127\\.0\\.0\\.1:\\d+/live/${sessionA.id}$`));
    assert.ok(!ingestCall.body.rtmp_url.includes(keyA));
    await waitFor(() => ingestCall.pullExit !== undefined, { what: 'media pull', timeoutMs: 15000 });
    assert.strictEqual(ingestCall.pullExit, 0, 'Media-side ffmpeg read 2 s from the loopback play URL');
    const detail = await request(base, 'GET', `/api/v1/sessions/${sessionA.id}`, { token });
    assert.strictEqual(detail.body.session.recording.state, 'recording');
});

t('restarting the API during the broadcast ends nothing; playback works through the new API', async () => {
    api.kill('SIGTERM');
    assert.strictEqual((await api.exited).code, 0);
    await sleep(1500);
    api = await startApi();
    const s = await session(streamA);
    assert.strictEqual(s && s.id, sessionA.id);
    assert.strictEqual(pubA.exitCode, null);
    const outputs = (await request(base, 'GET', `/api/v1/sessions/${sessionA.id}/outputs`, { token })).body.outputs;
    assert.ok(outputs.some(o => o.state === 'live'), 'the restream kept running');
    const head = await new Promise((resolve, reject) => {
        http.get(`${base}/play/${sessionA.id}.flv`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.headers['content-type'], 'video/x-flv');
            res.once('data', (c) => { resolve(c.subarray(0, 3).toString()); res.destroy(); });
        }).on('error', reject);
    });
    assert.strictEqual(head, 'FLV');
});

let streamB;
let pubB;
let ingest2;

t('a new rtmp-ingest generation takes new sessions; generation 1 drains but keeps session A', async () => {
    ingest2 = startChild('workers/rtmp-ingest.js');
    await waitFor(() => /generation 2 ready/.test(ingest2.output), { what: 'generation 2 ready' });
    await waitFor(() => /draining/.test(ingest1.output) && /public listener closed/.test(ingest1.output), { what: 'generation 1 draining', timeoutMs: 10000 });
    const r = await request(base, 'POST', '/api/v1/streams', { token, body: { title: 'B', recording_mode: 'none' } });
    streamB = r.body.stream.id;
    pubB = publish(`rtmp://127.0.0.1:${rtmpPort}/live/${r.body.key.key}`);
    procs.push(pubB);
    const sB = await waitFor(() => session(streamB), { what: 'session B live', timeoutMs: 15000 });
    assert.strictEqual(sB.worker.generation, 2, 'new sessions reach the newest generation');
    const sA = await session(streamA);
    assert.strictEqual(sA.id, sessionA.id);
    assert.strictEqual(sA.worker.generation, 1, 'the running session stays on its generation');
    assert.strictEqual(ingest1.exitCode, null);
});

t('when session A ends, generation 1 exits by itself; Media is asked to finalise', async () => {
    pubA.kill('SIGINT');
    await waitFor(async () => {
        const r = await request(base, 'GET', `/api/v1/sessions/${sessionA.id}`, { token });
        return r.body.session.state === 'ended' ? r.body.session : null;
    }, { what: 'session A ended', timeoutMs: 15000 });
    const exit = await Promise.race([ingest1.exited, sleep(10000).then(() => ({ code: 'timeout' }))]);
    assert.strictEqual(exit.code, 0, 'the drained generation exited cleanly');
    await waitFor(() => mediaCalls.some(c => c.url.endsWith('/finalize')), { what: 'media finalize', timeoutMs: 10000 });
    const sB = await session(streamB);
    assert.ok(sB, 'session B on generation 2 is unaffected');
});

t('events reached OpenVibe.Events through the outbox relay, without keys', async () => {
    const types = await waitFor(() => {
        const ts = published.map(e => e.event_type);
        return ['openre.session.started', 'openre.output.healthy', 'openre.output.failed', 'openre.recording.requested', 'openre.session.ended'].every(x => ts.includes(x)) ? ts : null;
    }, { what: 'published events', timeoutMs: 10000 });
    assert.strictEqual(types.filter(x => x === 'openre.session.started').length, 2);
    assert.ok(!types.includes('openre.session.failed'));
    const all = JSON.stringify(published);
    assert.ok(!all.includes(keyA), 'no ingest key in any event');
    assert.ok(!all.includes('sinkkey') && !all.includes('deadkey'), 'no destination key in any event');
    const started = published.find(e => e.event_type === 'openre.session.started' && e.subject.id === sessionA.id);
    assert.deepStrictEqual(started.payload.external_refs.map(r => `${r.service}:${r.type}:${r.id}`), ['live:managed_stream:5', 'live:user:42']);
});

t('no OpenRe process crashed along the way', () => {
    assert.strictEqual(coordinator.exitCode, null, `coordinator exited:\n${coordinator.output}`);
    assert.strictEqual(api.exitCode, null, `api exited:\n${api.output}`);
    assert.strictEqual(ingest2.exitCode, null, `generation 2 exited:\n${ingest2.output}`);
});

t('teardown', async () => {
    if (process.exitCode || process.env.DEBUG) for (const p of procs) if (p.output) console.log(p.output);
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } }
    for (const s of stubs) { s.closeAllConnections?.(); s.close(); }
    stubs = [];
});

t.run();
