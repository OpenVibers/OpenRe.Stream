'use strict';
/**
 * Ingest sessions: admission, the state machine, leases and the playback descriptor.
 *
 * Every transition is one SQLite transaction that also writes the session_transitions audit row
 * and, where the transition is externally visible, the outbox event (so the event exists if and
 * only if the change committed). Workers and the coordinator can race on the same session (a
 * publisher leaving while its lease is being expired); whoever commits first wins and the other
 * gets { ok: false, code: 'invalid_transition' } without side effects.
 */
const { newId, isId } = require('../ids');
const { canTransition, isTerminal } = require('../state-machine');
const { TYPES } = require('../events');
const { parseJson } = require('./definitions');

const OPEN = "('starting', 'live', 'ending')";

function iso(ms) { return ms ? new Date(ms).toISOString() : null; }

function createSessions({ db, config, events, clock, definitions, workers }) {
    const now = () => clock.now();
    const q = {
        get: db.prepare('SELECT * FROM ingest_sessions WHERE id = ?'),
        openForDefinition: db.prepare(`SELECT * FROM ingest_sessions WHERE definition_id = ? AND state IN ${OPEN} ORDER BY created_at DESC`),
        insert: db.prepare(`INSERT INTO ingest_sessions (id, definition_id, key_id, protocol, state, worker_id, worker_kind, worker_generation,
            lease_expires_at, created_at, updated_at) VALUES (@id, @definition_id, @key_id, @protocol, 'starting', @worker_id, @worker_kind,
            @worker_generation, @lease, @now, @now)`),
        transitionRow: db.prepare('INSERT INTO session_transitions (session_id, from_state, to_state, reason, actor, at) VALUES (?, ?, ?, ?, ?, ?)'),
        transitions: db.prepare('SELECT from_state, to_state, reason, actor, at FROM session_transitions WHERE session_id = ? ORDER BY id'),
        mediaInfo: db.prepare(`UPDATE ingest_sessions SET media_info = ? WHERE id = ? AND state IN ${OPEN}`),
        requestEnd: db.prepare(`UPDATE ingest_sessions SET desired_state = 'end', end_requested_by = ?, updated_at = ? WHERE id = ? AND state IN ${OPEN}`),
        endRequests: db.prepare(`SELECT * FROM ingest_sessions WHERE worker_id = ? AND desired_state = 'end' AND state IN ${OPEN}`),
        ofWorker: db.prepare(`SELECT * FROM ingest_sessions WHERE worker_id = ? AND state IN ${OPEN}`),
        expiredLeases: db.prepare(`SELECT * FROM ingest_sessions WHERE state IN ${OPEN} AND lease_expires_at < ?`),
        live: db.prepare("SELECT * FROM ingest_sessions WHERE state = 'live' ORDER BY live_at"),
    };

    function shape(s) {
        if (!s) return null;
        return { ...s, media_info: parseJson(s.media_info, null) };
    }

    function get(id) {
        return isId('session', id) ? shape(q.get.get(id)) : null;
    }

    function list({ definition_id, owner_subject, state, limit = 50, before } = {}) {
        const where = [];
        const args = [];
        if (definition_id) { where.push('s.definition_id = ?'); args.push(definition_id); }
        if (owner_subject) { where.push('d.owner_subject = ?'); args.push(owner_subject); }
        if (state === 'open') where.push(`s.state IN ${OPEN}`);
        else if (state) { where.push('s.state = ?'); args.push(state); }
        if (before) { where.push('s.created_at < ?'); args.push(Number(before)); }
        return db.prepare(`SELECT s.* FROM ingest_sessions s JOIN stream_definitions d ON d.id = s.definition_id
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.created_at DESC LIMIT ?`)
            .all(...args, Math.min(Math.max(Number(limit) || 50, 1), 200)).map(shape);
    }

    function envelopeFor(type, session, definition, extra = {}) {
        const worker = session.worker_id ? workers.get(session.worker_id) : null;
        const payload = {
            session_id: session.id,
            stream_id: definition.id,
            title: definition.title,
            owner: { type: 'user', id: definition.owner_subject },
            protocol: session.protocol,
            state: session.state,
            started_at: iso(session.live_at),
            worker: worker ? { id: worker.id, kind: worker.kind, generation: worker.generation } : null,
            external_refs: definition.external_refs,
            mirror_to_live: definition.mirror_to_live,
            ...extra,
        };
        return {
            event_type: type,
            actor: { type: 'user', id: definition.owner_subject },
            subject: { type: 'ingest_session', id: session.id, revision: session.revision },
            visibility: 'internal',
            priority: 'important',
            payload,
        };
    }

    /**
     * Admit a publish on `worker` (synchronous; called inside the RTMP handshake).
     * One open session per definition: a second publisher with a valid key is refused while the
     * first is alive, exactly like Live's in-process ingest. A leftover open session whose lease
     * has expired (its worker died) is failed first, so a crashed worker never locks a stream out.
     */
    function admit({ definition, key, protocol, worker }) {
        return db.transaction(() => {
            for (const open of q.openForDefinition.all(definition.id)) {
                const leaseOk = open.lease_expires_at && open.lease_expires_at > now();
                if (leaseOk) return { error: 'duplicate_publisher', existing: open.id };
                applyTransition(open, 'failed', { reason: 'lease_expired', actor: `worker:${worker.id}` });
            }
            const id = newId('session', now());
            q.insert.run({
                id, definition_id: definition.id, key_id: key ? key.id : null, protocol,
                worker_id: worker.id, worker_kind: worker.kind, worker_generation: worker.generation,
                lease: now() + config.workers.leaseMs, now: now(),
            });
            q.transitionRow.run(id, null, 'starting', 'publish_accepted', `worker:${worker.id}`, now());
            return { session: shape(q.get.get(id)) };
        }).immediate();
    }

    // Inside a transaction.
    function applyTransition(current, to, { reason = null, actor = null, media_info } = {}) {
        if (!canTransition(current.state, to)) return { ok: false, code: 'invalid_transition', session: shape(current) };
        const t = now();
        const set = { state: to, updated_at: t, revision: current.revision + 1 };
        if (to === 'live') set.live_at = t;
        if (to === 'ending') { set.ending_at = t; set.end_reason = reason; }
        if (to === 'ended') { set.ended_at = t; if (!current.end_reason) set.end_reason = reason; }
        if (to === 'failed') { set.ended_at = t; set.failure_reason = reason; }
        if (media_info !== undefined) set.media_info = media_info ? JSON.stringify(media_info) : null;
        if (isTerminal(to)) set.lease_expires_at = null;
        const cols = Object.keys(set);
        db.prepare(`UPDATE ingest_sessions SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id AND state = @from`)
            .run({ ...set, id: current.id, from: current.state });
        q.transitionRow.run(current.id, current.state, to, reason, actor, t);
        const session = shape(q.get.get(current.id));
        const definition = definitions.row(session.definition_id);
        if (to === 'live') {
            events.enqueue(envelopeFor(TYPES.sessionStarted, session, definition, { playback: playback(session) }));
        } else if (to === 'ended' && session.live_at) {
            events.enqueue(envelopeFor(TYPES.sessionEnded, session, definition, {
                ended_at: iso(session.ended_at),
                duration_seconds: Math.round((session.ended_at - session.live_at) / 1000),
                end_reason: session.end_reason,
            }));
        } else if (to === 'failed') {
            events.enqueue(envelopeFor(TYPES.sessionFailed, session, definition, {
                ended_at: iso(session.ended_at),
                was_live: Boolean(session.live_at),
                duration_seconds: session.live_at ? Math.round((session.ended_at - session.live_at) / 1000) : 0,
                failure_reason: reason,
            }));
        }
        if (isTerminal(to) || to === 'ending') {
            // Outputs follow their session down; they never pull the session with them.
            db.prepare("UPDATE outputs SET desired = 'stop', updated_at = ? WHERE session_id = ? AND desired = 'run'").run(t, session.id);
        }
        return { ok: true, session };
    }

    /** transition(id, to, { reason, actor, media_info }) -> { ok, session } | { ok: false, code } */
    function transition(id, to, opts = {}) {
        return db.transaction(() => {
            const current = q.get.get(id);
            if (!current) return { ok: false, code: 'not_found' };
            return applyTransition(current, to, opts);
        }).immediate();
    }

    /** ending → ended in one call (the common clean stop). */
    function finish(id, { reason, actor } = {}) {
        return db.transaction(() => {
            let current = q.get.get(id);
            if (!current) return { ok: false, code: 'not_found' };
            if (current.state === 'starting' || current.state === 'live') {
                const r = applyTransition(current, 'ending', { reason, actor });
                if (!r.ok) return r;
                current = q.get.get(id);
            }
            return applyTransition(current, 'ended', { reason, actor });
        }).immediate();
    }

    function requestEnd(id, by) {
        return q.requestEnd.run(String(by || 'unknown'), now(), id).changes > 0;
    }

    /**
     * Where to watch a session. Internal URLs are loopback addresses on the OpenRe host (Live and
     * Media run there too); public_url is served by openre-api's /play proxy.
     */
    function playback(session) {
        if (!session) return null;
        const worker = session.worker_id ? workers.get(session.worker_id) : null;
        const ep = (worker && worker.endpoints) || {};
        const descriptor = {
            session_id: session.id,
            protocol: session.protocol,
            state: session.state,
            live: session.state === 'live',
            worker: worker ? { id: worker.id, kind: worker.kind, generation: worker.generation, state: worker.state } : null,
            flv: null,
            rtmp: null,
            webrtc: null,
            hls: null,
        };
        if (session.protocol === 'rtmp' && ep.flvPort) {
            descriptor.flv = {
                internal_url: `http://127.0.0.1:${ep.flvPort}/live/${session.id}.flv`,
                public_url: `${config.baseUrl}/play/${session.id}.flv`,
                content_type: 'video/x-flv',
            };
        }
        if (session.protocol === 'rtmp' && ep.rtmpPlayPort) {
            descriptor.rtmp = { internal_url: `rtmp://127.0.0.1:${ep.rtmpPlayPort}/live/${session.id}` };
        }
        return descriptor;
    }

    return {
        get,
        list,
        admit,
        transition,
        finish,
        requestEnd,
        playback,
        setMediaInfo: (id, info) => q.mediaInfo.run(JSON.stringify(info), id).changes > 0,
        transitions: (id) => q.transitions.all(id),
        endRequestsFor: (workerId) => q.endRequests.all(workerId).map(shape),
        ofWorker: (workerId) => q.ofWorker.all(workerId).map(shape),
        expiredLeases: () => q.expiredLeases.all(now()).map(shape),
        live: () => q.live.all().map(shape),
        openFor: (definitionId) => q.openForDefinition.all(definitionId).map(shape),
    };
}

module.exports = { createSessions };
