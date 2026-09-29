'use strict';
// End to end with real processes and real ffmpeg: openre-api, openre-jsmpeg, openre-restream-worker
// and openre-session-coordinator as separate child processes, plus a stub OpenVibe.Network, a stub
// OpenVibe.Events and a stub OpenVibe.Media.
//
// Proves: the broadcaster's ffmpeg POSTs MPEG-TS to /<key>/<w>/<h>/ and the session goes live on the
// newest generation (wrong key and wrong protocol refused), a WebSocket viewer receives the bytes and
// is counted in the session heartbeat, the loopback data tap restreams to a working destination,
// recording is refused with a clear reason, a duplicate publisher is refused, and a second generation
// takes new sessions while the first drains, keeps its session and exits when it ends; a killed worker
// fails its session after the lease expires.
const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const {
    tmpDir, testEnv, multiProcess, child, waitFor, request, userToken, freePort, sleep, suite, hasFfmpeg, rtmpSink, OWNER,
} = require('./helpers');

if (!hasFfmpeg()) {
    console.log('jsmpeg-e2e: skipped (no ffmpeg on PATH)');
    process.exit(0);
}
if (!multiProcess()) {
    console.log('jsmpeg-e2e: skipped (the OpenRe processes share one database: PostgreSQL only, npm run test:pg)');
    process.exit(0);
}
const t = suite('jsmpeg-e2e');
const token = userToken({ subjectId: OWNER });
const procs = [];
const mediaCalls = [];
let env;
let api;
let coordinator;
let base;
let jsmpegPort;
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

/** ffmpeg POSTs MPEG-TS to http://127.0.0.1:<port>/<key>/<w>/<h>/ — Live's JSMPEG broadcaster command. */
function publishJsmpeg(port, key, w, h, { seconds } = {}) {
    const url = `http://127.0.0.1:${port}/${key}/${w}/${h}/`;
    const args = ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30',
        '-c:v', 'mpeg1video', '-b:v', '600k', '-r', '30', '-f', 'mpegts'];
    if (seconds) args.push('-t', String(seconds));
    args.push(url);
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    p.err = '';
    p.stderr.on('data', (c) => { p.err += c; });
    p.exited = new Promise(r => p.on('exit', (code, signal) => r({ code, signal })));
    return p;
}

async function openSession(streamId, state = 'live') {
    const r = await request(base, 'GET', `/api/v1/sessions?stream_id=${streamId}`, { token });
    return (r.body.sessions || []).find(s => s.state === state) || null;
}
async function detail(id) {
    const r = await request(base, 'GET', `/api/v1/sessions/${id}`, { token });
    return r.body.session;
}

let streamA;
let keyA;
let sessionA;
let pubA;
let sink;
let viewer;

t('setup: stubs and the four OpenRe processes', async () => {
    const network = await stubServer((req, res, body) => {
        if (req.url === '/oauth/token') {
            const p = new URLSearchParams(body);
            return json(res, 200, { access_token: `tok-${p.get('audience')}`, token_type: 'Bearer', expires_in: 300 });
        }
        return json(res, 404, {});
    });
    const events = await stubServer((req, res, body) => {
        if (req.url === '/api/v1/events' && req.method === 'POST') return json(res, 201, { event_id: 'e', seq: 1, duplicate: false });
        return json(res, 404, {});
    });
    const media = await stubServer((req, res, body) => {
        mediaCalls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
        return json(res, 404, { error: 'Media must not be called for a jsmpeg recording' });
    });
    jsmpegPort = await freePort();
    const dir = tmpDir();
    env = await testEnv(dir, {
        PORT: String(await freePort()),
        OPENRE_JSMPEG_PORT: String(jsmpegPort),
        OPENRE_JSMPEG_BIND: '127.0.0.1',
        OPENRE_JSMPEG_INTERNAL_PORT_MIN: String(22000 + Math.floor(Math.random() * 20000)),
        OV_NETWORK_INTERNAL_URL: network,
        OV_OAUTH_CLIENT_SECRET: 'test-secret',
        EVENTS_URL: events,
        EVENTS_RELAY_INTERVAL_MS: '200',
        MEDIA_URL: media,
        MEDIA_API_KEY: 'media-app-key',
        OPENRE_RECORDING_START_DELAY_MS: '200',
        OPENRE_WORKER_HEARTBEAT_MS: '250',
        OPENRE_WORKER_LEASE_MS: '4000',
        OPENRE_COORDINATOR_INTERVAL_MS: '250',
        OPENRE_RESTREAM_POLL_MS: '250',
        OPENRE_OUTPUT_START_DELAY_MS: '500',
        OPENRE_RESTART_BASE_MS: '200',
        OPENRE_MAX_RESTARTS: '3',
    });
    env.OPENRE_JSMPEG_INTERNAL_PORT_MAX = String(Number(env.OPENRE_JSMPEG_INTERNAL_PORT_MIN) + 20);
    base = `http://127.0.0.1:${env.PORT}`;
    coordinator = startChild('workers/coordinator.js');
    ingest1 = startChild('workers/jsmpeg.js');
    startChild('workers/restream-worker.js');
    api = await startApi();
    await waitFor(() => /generation 1 ready: ingest\+ws/.test(ingest1.output), { what: 'jsmpeg worker ready' });
});

t('a bad key and a wrong-protocol key are refused', async () => {
    const bad = publishJsmpeg(jsmpegPort, `ork_${'x'.repeat(43)}`, 320, 240, { seconds: 2 });
    procs.push(bad);
    assert.notStrictEqual((await bad.exited).code, 0, 'ffmpeg with a wrong key fails');

    // A definition that does not list jsmpeg: resolveIngestKey answers protocol_not_allowed.
    const r = await request(base, 'POST', '/api/v1/streams', { token, body: { title: 'RTMP only', protocols: ['rtmp'] } });
    assert.strictEqual(r.status, 201);
    const wrong = publishJsmpeg(jsmpegPort, r.body.key.key, 320, 240, { seconds: 2 });
    procs.push(wrong);
    assert.notStrictEqual((await wrong.exited).code, 0, 'an rtmp-only definition is refused on the jsmpeg listener');
});

t('the ffmpeg MPEG-TS POST goes live, a WS viewer receives bytes and is counted', async () => {
    const r = await request(base, 'POST', '/api/v1/streams', {
        token,
        body: { title: 'JSMPEG', protocols: ['jsmpeg'], recording_mode: 'vod', external_refs: [{ service: 'live', type: 'managed_stream', id: '9' }, { service: 'live', type: 'user', id: '42' }] },
    });
    assert.strictEqual(r.status, 201);
    streamA = r.body.stream.id;
    keyA = r.body.key.key;
    const sinkPort = await freePort();
    sink = rtmpSink(sinkPort);
    procs.push(sink);
    assert.strictEqual((await request(base, 'POST', `/api/v1/streams/${streamA}/destinations`, { token, body: { platform: 'custom', name: 'sink', server_url: `rtmp://127.0.0.1:${sinkPort}/app`, stream_key: 'sinkkey' } })).status, 201);

    pubA = publishJsmpeg(jsmpegPort, keyA, 320, 240);
    procs.push(pubA);
    sessionA = await waitFor(async () => await openSession(streamA), { what: 'session A live', timeoutMs: 20000 });
    assert.strictEqual(sessionA.worker.generation, 1);

    const d = await detail(sessionA.id);
    assert.deepStrictEqual({ w: d.playback.jsmpeg.width, h: d.playback.jsmpeg.height }, { w: 320, h: 240 });
    assert.ok(!d.playback.jsmpeg.ws_url.includes(keyA), 'the key is never in the viewer URL');

    viewer = new WebSocket(d.playback.jsmpeg.ws_url);
    viewer.frames = [];
    viewer.on('message', (m) => viewer.frames.push(m));
    await new Promise((res, rej) => { viewer.once('open', res); viewer.once('error', rej); });
    await waitFor(() => viewer.frames.length > 0, { what: 'viewer bytes', timeoutMs: 10000 });
    assert.ok(viewer.frames[0].length > 0);

    const v = await waitFor(async () => { const s = await detail(sessionA.id); return s.viewers >= 1 ? s : null; }, { what: 'viewer counted', timeoutMs: 10000 });
    assert.ok(v.viewers >= 1);
});

t('the JSMPEG data tap restreams to a destination', async () => {
    const outputs = await waitFor(async () => {
        const r = await request(base, 'GET', `/api/v1/sessions/${sessionA.id}/outputs`, { token });
        const o = r.body.outputs || [];
        return o.some(x => x.state === 'live') ? o : null;
    }, { what: 'restream live', timeoutMs: 45000 });
    assert.ok(outputs.some(o => o.state === 'live'));
});

t('recording is refused with a clear reason, without calling Media', async () => {
    const s = await waitFor(async () => { const d = await detail(sessionA.id); return d.recording && d.recording.state === 'failed' ? d : null; }, { what: 'recording failed', timeoutMs: 10000 });
    assert.strictEqual(s.recording.last_error, 'recording is not available for jsmpeg');
    // The worker does upload live-thumbnail objects (decision 4: `POST /api/v2/<app>/objects`), so
    // only the recording endpoints must be untouched.
    assert.strictEqual(mediaCalls.filter((c) => !/\/objects$/.test(c.url)).length, 0, 'Media was never asked to record a jsmpeg session');
});

t('a second publisher with the same key is refused while the first is live', async () => {
    const dup = publishJsmpeg(jsmpegPort, keyA, 320, 240, { seconds: 2 });
    procs.push(dup);
    assert.notStrictEqual((await dup.exited).code, 0);
    assert.strictEqual((await openSession(streamA)).id, sessionA.id, 'the source session is unaffected');
});

let streamB;
let pubB;
let ingest2;

t('a new jsmpeg generation takes new sessions; generation 1 drains but keeps A', async () => {
    ingest2 = startChild('workers/jsmpeg.js');
    await waitFor(() => /generation 2 ready: ingest\+ws/.test(ingest2.output), { what: 'generation 2 ready' });
    await waitFor(() => /draining/.test(ingest1.output) && /public listener closed/.test(ingest1.output), { what: 'generation 1 draining', timeoutMs: 10000 });

    const r = await request(base, 'POST', '/api/v1/streams', { token, body: { title: 'B', protocols: ['jsmpeg'], recording_mode: 'none' } });
    streamB = r.body.stream.id;
    pubB = publishJsmpeg(jsmpegPort, r.body.key.key, 320, 240);
    procs.push(pubB);
    const sB = await waitFor(async () => await openSession(streamB), { what: 'session B live', timeoutMs: 20000 });
    assert.strictEqual(sB.worker.generation, 2, 'new sessions reach the newest generation');
    const sA = await openSession(streamA);
    assert.strictEqual(sA.id, sessionA.id);
    assert.strictEqual(sA.worker.generation, 1, 'the running session stays on its generation');
    assert.strictEqual(ingest1.exitCode, null);
});

t('when session A ends, generation 1 exits by itself; session B is unaffected', async () => {
    pubA.kill('SIGKILL');
    const end = await waitFor(async () => (await detail(sessionA.id)).state === 'ended', { what: 'session A ended', timeoutMs: 30000 }).then(() => true, () => false);
    assert.ok(end, `session A did not end: ${JSON.stringify(await detail(sessionA.id))}`);
    const exit = await Promise.race([ingest1.exited, sleep(10000).then(() => ({ code: 'timeout' }))]);
    assert.strictEqual(exit.code, 0, 'the drained generation exited cleanly');
    const idB = (await openSession(streamB)).id;
    assert.strictEqual((await detail(idB)).state, 'live');
});

t('a killed worker fails its session after the lease expires', async () => {
    ingest2.kill('SIGKILL');
    await ingest2.exited;
    const idB = (await openSession(streamB)).id;
    const s = await waitFor(async () => {
        const d = await detail(idB);
        return d.state === 'failed' ? d : null;
    }, { what: 'session B failed after lease loss', timeoutMs: 20000 });
    assert.match(s.failure_reason, /lease|lost|expired/i);
});

t('no OpenRe process crashed along the way, and no key reached a log', () => {
    assert.strictEqual(coordinator.exitCode, null, `coordinator exited:\n${coordinator.output}`);
    assert.strictEqual(api.exitCode, null, `api exited:\n${api.output}`);
    for (const p of procs) {
        if (!p.output) continue;
        assert.ok(!p.output.includes(keyA), 'no ingest key in logs');
        assert.ok(!p.output.includes('sinkkey'), 'no destination key in logs');
    }
});

t('teardown', async () => {
    if (process.exitCode || process.env.DEBUG) for (const p of procs) if (p.output) console.log(p.output);
    if (viewer) { try { viewer.close(); } catch { /* */ } }
    for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* */ } }
    for (const s of stubs) { s.closeAllConnections?.(); s.close(); }
    stubs = [];
});

t.run();
