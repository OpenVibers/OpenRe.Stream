'use strict';
/**
 * openre-restream-worker — runs restream outputs (unit openre-restream-worker@<release>.service).
 *
 * The coordinator assigns each pending output to the newest ready restream generation; this
 * process picks up the outputs assigned to it, runs one ffmpeg per output (OutputRunner, ported
 * from Live's restream manager) and reports state, progress and logs. It pulls the source from the
 * RTMP worker that owns the session (its loopback HTTP-FLV endpoint), so it never needs a key.
 *
 * Drain: a draining generation keeps its outputs running until their sessions end; at the drain
 * deadline it stops them and releases them to the coordinator, which hands them to the newest
 * generation (the destination sees one reconnect). Then the process exits.
 */
const path = require('path');
const { OutputRunner } = require('./restream/output-runner');
const { createWorkerRuntime } = require('./runtime');

function createRestreamWorker({ rt, log = console, exit = (code) => process.exit(code), spawnImpl, lookup }) {
    const { store, config } = rt;
    const runners = new Map(); // output id → OutputRunner
    let pollTimer = null;
    let closing = false;

    const runtime = createWorkerRuntime({
        rt, kind: 'restream', log, exit,
        hooks: {
            onDrainDeadline: () => handOver(),
            onLost: () => stopAll('worker lost'),
            activeCount: () => runners.size,
            onExit: () => { closing = true; clearTimeout(pollTimer); if (runtime.me) store.outputs.release(runtime.me.id); },
        },
    });

    function inputUrlFor(session) {
        if (session.protocol !== 'rtmp') return null;
        const pb = store.sessions.playback(session);
        return pb && pb.flv ? pb.flv.internal_url : null;
    }

    function poll() {
        if (closing || !runtime.me) return;
        const rows = store.outputs.forWorker(runtime.me.id);
        const seen = new Set();
        for (const row of rows) {
            seen.add(row.id);
            let runner = runners.get(row.id);
            const session = store.sessions.get(row.session_id);
            const shouldRun = row.desired === 'run' && session && session.state === 'live';
            if (!shouldRun) {
                if (runner) { runner.stop(row.desired === 'stop' ? 'stop requested' : 'session not live'); runners.delete(row.id); } else store.outputs.report(row.id, { state: 'stopped', ended_at: Date.now() }, { workerId: runtime.me.id });
                continue;
            }
            if (runner && runner.stopped) { runners.delete(row.id); runner = null; continue; }
            if (runner) continue;
            // A draining generation starts nothing new: an output assigned to it but not started yet
            // goes back to the coordinator for the newest generation.
            if (runtime.draining) { store.outputs.unassign(row.id); seen.delete(row.id); continue; }
            const input = inputUrlFor(session);
            if (!input) { store.outputs.report(row.id, { state: 'failed', last_error: `restream from ${session.protocol} sessions is not supported by OpenRe yet`, ended_at: Date.now() }, { workerId: runtime.me.id }); continue; }
            // Let the ingest settle before pulling (Live waits 3 s for node-media-server's FLV).
            if (session.live_at && Date.now() - session.live_at < config.outputs.startDelayMs) continue;
            runner = new OutputRunner({ outputId: row.id, destinationId: row.destination_id, inputUrl: input, store, config, log, spawnImpl, lookup, workerId: runtime.me.id });
            runners.set(row.id, runner);
            runner.start().catch((err) => runner.fail(err.message, { cooldown: false }));
        }
        for (const [id, runner] of runners) {
            if (!seen.has(id)) { runner.stop('no longer assigned'); runners.delete(id); }
            else if (runner.stopped && !runner.proc) runners.delete(id);
        }
        if (runtime.draining) runtime.exitWhenIdle();
    }

    function schedule() {
        clearTimeout(pollTimer);
        if (closing) return;
        pollTimer = setTimeout(() => {
            try { poll(); } catch (err) { log.error(`[restream] poll failed: ${err.stack || err}`); }
            schedule();
        }, config.workers.restreamPollMs);
    }

    function stopAll(reason) {
        for (const [id, r] of runners) { r.stop(reason); runners.delete(id); }
    }

    /** Drain deadline: stop here and let the coordinator give the outputs to the newest generation. */
    function handOver() {
        for (const [id, r] of runners) { r.stopped = true; r.clearTimers(); if (r.proc) { try { r.proc.kill('SIGTERM'); } catch { /* */ } } runners.delete(id); }
        const n = store.outputs.release(runtime.me.id);
        log.log(`[restream] drain deadline: released ${n} output(s) to the newest generation`);
    }

    function start() {
        runtime.register({});
        runtime.ready();
        schedule();
        log.log(`[restream] generation ${runtime.me.generation} ready`);
        return runtime.me;
    }

    return {
        start,
        poll,
        runtime,
        runners: () => runners,
        drain: (reason) => runtime.drainNow(reason),
        close() { closing = true; clearTimeout(pollTimer); stopAll('closing'); runtime.stop(); },
    };
}

if (require.main === module) {
    require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
    const { load } = require('../server/config');
    const { openRuntime } = require('../server/store');
    const rt = openRuntime({ config: load() });
    const worker = createRestreamWorker({ rt });
    worker.start();
    // If this process dies, its ffmpeg children must not keep pushing unsupervised: the outputs are
    // reassigned to another worker, and two pushes to one ingest make platforms drop both.
    process.on('exit', () => {
        for (const r of worker.runners().values()) { try { if (r.proc) r.proc.kill('SIGKILL'); } catch { /* */ } }
    });
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => worker.drain(sig));
}

module.exports = { createRestreamWorker };
