'use strict';
// The cutover's bind switch (docs/cutover.md step 5), with real worker processes: generation 1
// listens on 127.0.0.1 only (production today), generation 2 starts with OPENRE_RTMP_BIND=0.0.0.0 on
// the same port (SO_REUSEPORT lets both bind), the coordinator drains generation 1, which closes its
// listener and exits 0 by itself, and from then on the port answers the RTMP handshake on the
// host's other addresses too. No worker is restarted. Needs no ffmpeg.
const assert = require('assert');
const { load } = require('../server/config');
const { openRuntime } = require('../server/store');
const { createCoordinator } = require('../server/coordinator');
const { localAddresses, rtmpProbe } = require('../scripts/cutover-preflight');
const { tmpDir, testEnv, child, waitFor, freePort, suite, silent } = require('./helpers');

const t = suite('bind-switch');
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });

// A non-loopback IPv4 address of this machine (the "public" address in the test).
const outside = localAddresses().find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));

let env;
let port;
let g1;
let g2;
let rt;

function startWorker(bind) {
    const p = child('workers/rtmp-ingest.js', { ...env, OPENRE_RTMP_BIND: bind });
    procs.push(p);
    return p;
}

t('generation 1 on 127.0.0.1 only: the host\'s other addresses are refused', async () => {
    port = await freePort();
    const internal = await freePort();
    env = testEnv(tmpDir(), {
        OPENRE_RTMP_PORT: String(port),
        OPENRE_RTMP_INTERNAL_PORT_MIN: String(internal),
        OPENRE_RTMP_INTERNAL_PORT_MAX: String(internal + 20),
        OPENRE_WORKER_HEARTBEAT_MS: '200',
    });
    g1 = startWorker('127.0.0.1');
    await waitFor(() => /generation 1 ready: publish 127\.0\.0\.1:/.test(g1.output), { what: 'generation 1 ready' });
    const local = await rtmpProbe('127.0.0.1', port, 2000);
    assert.ok(local.ok && local.rtmp, 'loopback answers the RTMP handshake');
    if (outside) {
        const r = await rtmpProbe(outside, port, 2000);
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.code, 'ECONNREFUSED', `${outside}:${port} must be refused while bound to loopback`);
    } else console.log('  (no non-loopback IPv4 address here: only loopback is checked)');
});

t('generation 2 starts with OPENRE_RTMP_BIND=0.0.0.0 on the same port while generation 1 still listens', async () => {
    g2 = startWorker('0.0.0.0');
    await waitFor(() => /generation 2 ready: publish 0\.0\.0\.0:/.test(g2.output), { what: 'generation 2 ready' });
    assert.strictEqual(g1.exitCode, null, 'generation 1 is still running');
});

t('the coordinator drains generation 1; it closes its listener and exits 0 by itself', async () => {
    rt = openRuntime({ config: load(env), log: silent });
    const coordinator = createCoordinator({ rt, media: null, log: silent });
    const out = coordinator.syncTick();
    assert.strictEqual(out.drained, 1);
    const r = await g1.exited;
    assert.strictEqual(r.code, 0, 'a drained, idle generation exits cleanly');
    assert.match(g1.output, /public listener closed/);
    const rows = rt.db.prepare("SELECT generation, state, stop_reason FROM workers WHERE kind = 'rtmp-ingest' ORDER BY generation").all();
    assert.deepStrictEqual(rows.map((w) => [w.generation, w.state]), [[1, 'stopped'], [2, 'ready']]);
});

t('the port now answers on every address, served by generation 2', async () => {
    const local = await rtmpProbe('127.0.0.1', port, 2000);
    assert.ok(local.ok && local.rtmp, 'loopback still answers (0.0.0.0 covers it)');
    if (outside) {
        const r = await rtmpProbe(outside, port, 2000);
        assert.ok(r.ok && r.rtmp, `${outside}:${port} answers the RTMP handshake`);
    }
    assert.strictEqual(g2.exitCode, null);
});

t('teardown: SIGTERM drains generation 2, which exits 0 when idle', async () => {
    g2.kill('SIGTERM');
    const r = await g2.exited;
    assert.strictEqual(r.code, 0);
    rt.db.close();
});

t.run();
