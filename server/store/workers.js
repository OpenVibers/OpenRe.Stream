'use strict';
/**
 * Transport worker registry: which process of which kind and generation is alive, and which
 * generation takes new sessions.
 *
 *   register()   a worker process starts: it gets the next generation number for its kind
 *   ready()      it can take new sessions; the coordinator then drains every older generation
 *   heartbeat()  every few seconds; the same write renews the lease of every session it owns
 *   draining     set by the coordinator: take no new sessions, keep the running ones until they
 *                end or the drain deadline passes
 *   stopped      the worker exited cleanly (idle after a drain, or never had a session)
 *   lost         no heartbeat within the lease: the coordinator fails its sessions
 *
 * Generation numbers are per kind and only ever grow, so "the newest ready generation" is one
 * indexed read and two releases can run side by side without guessing which is newer.
 */
const os = require('os');
const { newId } = require('../ids');
const { parseJson } = require('./definitions');

const KINDS = Object.freeze(['rtmp-ingest', 'restream', 'webrtc-ingest', 'sfu', 'jsmpeg']);
const ALIVE = "('starting', 'ready', 'draining')";

function createWorkers({ db, config, clock }) {
    const now = () => clock.now();
    const q = {
        maxGen: db.prepare('SELECT COALESCE(MAX(generation), 0) AS g FROM workers WHERE kind = ?'),
        insert: db.prepare(`INSERT INTO workers (id, kind, generation, release, pid, host, state, endpoints, started_at, heartbeat_at)
            VALUES (@id, @kind, @generation, @release, @pid, @host, 'starting', @endpoints, @now, @now)`),
        get: db.prepare('SELECT * FROM workers WHERE id = ?'),
        heartbeat: db.prepare(`UPDATE workers SET heartbeat_at = ? WHERE id = ? AND state IN ${ALIVE}`),
        renewLeases: db.prepare("UPDATE ingest_sessions SET lease_expires_at = ? WHERE worker_id = ? AND state IN ('starting', 'live', 'ending')"),
        setReady: db.prepare("UPDATE workers SET state = 'ready', ready_at = ?, heartbeat_at = ? WHERE id = ? AND state = 'starting'"),
        setEndpoints: db.prepare('UPDATE workers SET endpoints = ? WHERE id = ?'),
        drain: db.prepare(`UPDATE workers SET state = 'draining', drain_started_at = ?, drain_deadline = ? WHERE id = ? AND state IN ('starting', 'ready')`),
        stop: db.prepare(`UPDATE workers SET state = 'stopped', stopped_at = ?, stop_reason = ? WHERE id = ? AND state IN ${ALIVE}`),
        lose: db.prepare(`UPDATE workers SET state = 'lost', stopped_at = ?, stop_reason = ? WHERE id = ? AND state IN ${ALIVE}`),
        newestReady: db.prepare("SELECT * FROM workers WHERE kind = ? AND state = 'ready' ORDER BY generation DESC LIMIT 1"),
        stale: db.prepare(`SELECT * FROM workers WHERE state IN ${ALIVE} AND heartbeat_at < ?`),
        olderReady: db.prepare("SELECT * FROM workers WHERE kind = ? AND state IN ('starting', 'ready') AND generation < ?"),
        alive: db.prepare(`SELECT * FROM workers WHERE state IN ${ALIVE} ORDER BY kind, generation`),
        recent: db.prepare('SELECT * FROM workers ORDER BY started_at DESC LIMIT ?'),
    };

    const shape = (w) => (w ? { ...w, endpoints: parseJson(w.endpoints, {}) } : null);

    function register({ kind, release = config.release, pid = process.pid, host = os.hostname(), endpoints = {} }) {
        if (!KINDS.includes(kind)) throw new Error(`unknown worker kind ${kind}`);
        const id = newId('worker', now());
        db.transaction(() => {
            const generation = q.maxGen.get(kind).g + 1;
            q.insert.run({ id, kind, generation, release, pid, host, endpoints: JSON.stringify(endpoints), now: now() });
        }).immediate();
        return shape(q.get.get(id));
    }

    return {
        KINDS,
        register,
        get: (id) => shape(q.get.get(id)),
        ready: (id) => q.setReady.run(now(), now(), id).changes > 0,
        setEndpoints: (id, endpoints) => q.setEndpoints.run(JSON.stringify(endpoints), id),
        /** Heartbeat + renew the leases of every session this worker owns, in one transaction. */
        heartbeat(id) {
            return db.transaction(() => {
                const alive = q.heartbeat.run(now(), id).changes > 0;
                if (alive) q.renewLeases.run(now() + config.workers.leaseMs, id);
                return shape(q.get.get(id));
            })();
        },
        drain: (id, deadline) => q.drain.run(now(), deadline, id).changes > 0,
        stop: (id, reason) => q.stop.run(now(), reason || 'exit', id).changes > 0,
        lose: (id, reason) => q.lose.run(now(), reason || 'lease_expired', id).changes > 0,
        newestReady: (kind) => shape(q.newestReady.get(kind)),
        stale: (before) => q.stale.all(before).map(shape),
        olderReady: (kind, generation) => q.olderReady.all(kind, generation).map(shape),
        alive: () => q.alive.all().map(shape),
        recent: (limit = 50) => q.recent.all(limit).map(shape),
    };
}

module.exports = { createWorkers, KINDS };
