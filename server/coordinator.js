'use strict';
/**
 * The session coordinator (unit openre-session-coordinator). Stateless between ticks: everything it
 * knows is in the database, so it can restart at any time without touching a transport.
 *
 * Each tick:
 *   1. lease         only one coordinator acts at a time (a deploy overlap is harmless)
 *   2. liveness      workers without a heartbeat for leaseMs are 'lost'; their open sessions fail
 *                    (worker_lost) and their outputs go back to pending for another worker
 *   3. orphans       open sessions whose lease expired with no live worker fail too
 *   4. generations   per kind, every ready worker older than the newest ready generation drains
 *                    (deadline = now + drainMaxMs). New sessions then only reach the newest one.
 *   5. outputs       live sessions get their auto-start outputs; pending outputs are assigned to
 *                    the newest ready restream generation
 *   6. keys          grace periods that ended become revocations
 *   7. recordings    live sessions get a recording request; requests advance (Media calls)
 * The event relay (outbox → OpenVibe.Events) runs in this process too.
 */
const { KINDS } = require('./store/workers');
const { assertNotDrill } = require('./config');

function createCoordinator({ rt, media, log = console, holder = `coordinator:${process.pid}` }) {
    const { db, store, config, clock } = rt;
    assertNotDrill(config, 'The session coordinator');
    const now = () => clock.now();
    const lease = {
        take: db.prepare(`INSERT INTO leases (name, holder, expires_at) VALUES ('coordinator', @holder, @exp)
            ON CONFLICT(name) DO UPDATE SET holder = @holder, expires_at = @exp WHERE leases.holder = @holder OR leases.expires_at < @now`),
        release: db.prepare("DELETE FROM leases WHERE name = 'coordinator' AND holder = ?"),
    };
    let timer = null;
    let running = false;
    let ticking = null;
    const stats = { ticks: 0, lastTickAt: null, lastError: null, holdsLease: false };

    function takeLease() {
        const ok = lease.take.run({ holder, exp: now() + config.workers.leaseMs, now: now() }).changes > 0;
        stats.holdsLease = ok;
        return ok;
    }

    function failSessionsOf(worker, reason) {
        let n = 0;
        for (const s of store.sessions.ofWorker(worker.id)) {
            const r = store.sessions.transition(s.id, 'failed', { reason, actor: 'coordinator' });
            if (r.ok) n++;
        }
        return n;
    }

    /** The synchronous part of a tick (everything but Media calls and the relay). */
    function syncTick() {
        const out = { lost: 0, failed: 0, drained: 0, outputsCreated: 0, outputsAssigned: 0, keysRevoked: 0, recordingsCreated: 0 };
        // 2. liveness
        for (const w of store.workers.stale(now() - config.workers.leaseMs)) {
            if (store.workers.lose(w.id, 'heartbeat_missed')) {
                out.lost++;
                out.failed += failSessionsOf(w, 'worker_lost');
                store.outputs.release(w.id);
                log.warn(`[coordinator] worker ${w.kind}#${w.generation} (${w.id}) lost; sessions failed, outputs released`);
            }
        }
        // 3. orphans (lease expired, worker not alive)
        for (const s of store.sessions.expiredLeases()) {
            const w = s.worker_id ? store.workers.get(s.worker_id) : null;
            if (w && ['starting', 'ready', 'draining'].includes(w.state) && w.heartbeat_at >= now() - config.workers.leaseMs) continue;
            if (store.sessions.transition(s.id, 'failed', { reason: 'lease_expired', actor: 'coordinator' }).ok) out.failed++;
        }
        // 4. generations
        for (const kind of KINDS) {
            const newest = store.workers.newestReady(kind);
            if (!newest) continue;
            for (const old of store.workers.olderReady(kind, newest.generation)) {
                if (store.workers.drain(old.id, now() + config.workers.drainMaxMs)) {
                    out.drained++;
                    log.log(`[coordinator] ${kind}#${old.generation} drains (newest ready is #${newest.generation})`);
                }
            }
        }
        // 5. outputs
        out.outputsCreated = store.outputs.ensureAutoOutputs();
        const restream = store.workers.newestReady('restream');
        if (restream) out.outputsAssigned = store.outputs.assignPending(restream);
        store.outputs.stopOrphans();
        // 6. keys
        out.keysRevoked = store.definitions.expireGraceKeys();
        // 7. recordings (requests only; the Media calls are async below)
        if (media && media.configured) out.recordingsCreated = store.recordings.ensureRequests();
        return out;
    }

    async function tick() {
        if (ticking) return ticking;
        ticking = (async () => {
            try {
                if (!takeLease()) return { skipped: 'lease held by another coordinator' };
                const out = syncTick();
                if (media) out.recordingSteps = await store.recordings.process(media);
                stats.ticks++;
                stats.lastTickAt = now();
                stats.lastError = null;
                return out;
            } catch (err) {
                stats.lastError = err.message;
                log.error(`[coordinator] tick failed: ${err.stack || err}`);
                return { error: err.message };
            }
        })().finally(() => { ticking = null; });
        return ticking;
    }

    function schedule() {
        if (!running) return;
        timer = setTimeout(async () => { await tick(); schedule(); }, config.workers.coordinatorIntervalMs);
    }

    return {
        tick,
        syncTick,
        start() { if (!running) { running = true; rt.events.start(); tick().finally(schedule); } },
        async stop() {
            running = false;
            clearTimeout(timer);
            if (ticking) await ticking.catch(() => {});
            await rt.events.stop();
            lease.release.run(holder);
        },
        stats: () => ({ ...stats }),
    };
}

module.exports = { createCoordinator };
