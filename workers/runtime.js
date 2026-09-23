'use strict';
/**
 * The worker interface every OpenRe transport worker implements (RTMP ingest, restream, and the
 * WHIP/WebRTC/SFU/JSMPEG kinds as they are ported):
 *
 *   const w = createWorkerRuntime({ rt, kind, log, hooks });
 *   w.register(endpoints)   → a new generation of `kind` ('starting')
 *   w.ready()               → takes new sessions; the coordinator drains older generations
 *   hooks.onDrain()         → coordinator marked this generation draining: take nothing new
 *   hooks.onDrainDeadline() → the drain lifetime is over: end what is left (encoders reconnect
 *                             to the newest generation)
 *   hooks.onEndRequested(s) → an owner/Live asked for session s to end
 *   hooks.onLost()          → the coordinator gave this worker up (missed heartbeats): its
 *                             sessions are already failed, so drop the transports and exit
 *   hooks.activeCount()     → how many transports this process still carries
 *   w.exitWhenIdle()        → when draining and activeCount() is 0: mark stopped and exit(0)
 *
 * The heartbeat (every heartbeatMs) is also the lease renewal for every session the worker owns.
 * A worker never depends on openre-api being up; it needs only the database.
 */
const { assertNotDrill } = require('../server/config');

/** Run a cleanup hook, but never let it keep the process from exiting (5 s at most). */
function settle(fn) {
    return Promise.race([
        Promise.resolve().then(() => fn && fn()).catch(() => {}),
        new Promise((r) => { const t = setTimeout(r, 5000); t.unref?.(); }),
    ]);
}

function createWorkerRuntime({ rt, kind, log = console, hooks = {}, exit = (code) => process.exit(code) }) {
    const { store, config } = rt;
    assertNotDrill(config, `The ${kind} worker`);
    let me = null;
    let timer = null;
    let draining = false;
    let deadlineHandled = false;
    let stopped = false;

    function register(endpoints = {}) {
        me = store.workers.register({ kind, endpoints });
        log.log(`[${kind}] registered ${me.id} generation ${me.generation} (release ${me.release})`);
        return me;
    }

    function ready() {
        store.workers.ready(me.id);
        me = store.workers.get(me.id);
        schedule();
        return me;
    }

    function beat() {
        if (stopped || !me) return null;
        const row = store.workers.heartbeat(me.id);
        me = row;
        if (!row) return null;
        if (row.state === 'lost') {
            log.error(`[${kind}] coordinator marked ${me.id} lost; dropping transports and exiting`);
            stopped = true;
            clearTimeout(timer);
            settle(hooks.onLost).finally(() => exit(1));
            return row;
        }
        if (row.state === 'draining' && !draining) {
            draining = true;
            log.log(`[${kind}] generation ${row.generation} draining (deadline ${new Date(row.drain_deadline).toISOString()})`);
            try { hooks.onDrain && hooks.onDrain(row); } catch (err) { log.error(`[${kind}] onDrain: ${err.message}`); }
        }
        if (draining && row.drain_deadline && row.drain_deadline <= Date.now() && !deadlineHandled) {
            deadlineHandled = true;
            log.warn(`[${kind}] drain deadline reached; ending remaining transports`);
            try { hooks.onDrainDeadline && hooks.onDrainDeadline(row); } catch (err) { log.error(`[${kind}] onDrainDeadline: ${err.message}`); }
        }
        if (hooks.onEndRequested) {
            for (const s of store.sessions.endRequestsFor(me.id)) {
                try { hooks.onEndRequested(s); } catch (err) { log.error(`[${kind}] onEndRequested: ${err.message}`); }
            }
        }
        if (hooks.onHeartbeat) {
            try { hooks.onHeartbeat(row); } catch (err) { log.error(`[${kind}] onHeartbeat: ${err.message}`); }
        }
        if (draining) exitWhenIdle();
        return row;
    }

    function schedule() {
        clearTimeout(timer);
        if (stopped) return;
        timer = setTimeout(() => {
            try { beat(); } catch (err) { log.error(`[${kind}] heartbeat failed: ${err.message}`); }
            schedule();
        }, config.workers.heartbeatMs);
    }

    /** SIGTERM: the operator (or systemd) asks this generation to go away → same as a drain. */
    function drainNow(reason = 'signal') {
        if (!me || stopped) return;
        if (!draining) {
            store.workers.drain(me.id, Date.now() + config.workers.drainMaxMs);
            log.log(`[${kind}] draining on ${reason}`);
        }
        beat();
    }

    function exitWhenIdle() {
        const active = hooks.activeCount ? hooks.activeCount() : 0;
        if (active > 0 || stopped) return false;
        stopped = true;
        clearTimeout(timer);
        store.workers.stop(me.id, draining ? 'drained' : 'exit');
        log.log(`[${kind}] generation ${me.generation} idle after drain; exiting`);
        settle(hooks.onExit).finally(() => exit(0));
        return true;
    }

    return {
        register,
        ready,
        beat,
        drainNow,
        exitWhenIdle,
        get me() { return me; },
        get draining() { return draining; },
        stop() { stopped = true; clearTimeout(timer); if (me) store.workers.stop(me.id, 'stopped'); },
    };
}

module.exports = { createWorkerRuntime };
