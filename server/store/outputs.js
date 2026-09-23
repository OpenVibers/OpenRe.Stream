'use strict';
/**
 * Restream destinations (per stream definition) and outputs (one destination running inside one
 * session), with health, a circuit breaker and bounded logs.
 *
 * Isolation rule: nothing in this file changes an ingest session. An output that fails, however
 * badly, ends in its own 'failed' row and an openre.output.failed event; the session carries on.
 */
const { newId, isId } = require('../ids');
const { hintOf } = require('../secrets');
const { TYPES } = require('../events');
const { validateDestinationUrl } = require('../destination-url');
const { StoreError, cleanText, parseJson } = require('./definitions');

const PLATFORMS = Object.freeze(['youtube', 'twitch', 'kick', 'custom']);
const QUALITY_PRESETS = Object.freeze(['auto', 'low', 'medium', 'high', 'ultra', 'source']);
const ENCODER_PRESETS = Object.freeze(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow']);
const OPEN = "('pending', 'starting', 'live', 'error')";

function createOutputs({ db, config, events, clock, box, definitions, sessions }) {
    const now = () => clock.now();
    const q = {
        getDest: db.prepare('SELECT * FROM destinations WHERE id = ?'),
        destsOf: db.prepare('SELECT * FROM destinations WHERE definition_id = ? ORDER BY created_at'),
        countOf: db.prepare('SELECT COUNT(*) AS n FROM destinations WHERE definition_id = ?'),
        deleteDest: db.prepare('DELETE FROM destinations WHERE id = ?'),
        getOut: db.prepare('SELECT * FROM outputs WHERE id = ?'),
        outBySessionDest: db.prepare('SELECT * FROM outputs WHERE session_id = ? AND destination_id = ?'),
        outsOfSession: db.prepare('SELECT * FROM outputs WHERE session_id = ? ORDER BY created_at'),
        insertOut: db.prepare(`INSERT INTO outputs (id, session_id, destination_id, desired, state, created_at, updated_at)
            VALUES (?, ?, ?, 'run', 'pending', ?, ?)`),
        pendingUnassigned: db.prepare(`SELECT o.* FROM outputs o JOIN ingest_sessions s ON s.id = o.session_id
            WHERE o.desired = 'run' AND o.state = 'pending' AND o.worker_id IS NULL AND s.state = 'live' ORDER BY o.created_at`),
        assign: db.prepare("UPDATE outputs SET worker_id = ?, worker_generation = ?, updated_at = ? WHERE id = ? AND worker_id IS NULL AND state = 'pending'"),
        forWorker: db.prepare(`SELECT * FROM outputs WHERE worker_id = ? AND state IN ${OPEN}`),
        unassign: db.prepare("UPDATE outputs SET worker_id = NULL, worker_generation = NULL, updated_at = ? WHERE id = ? AND state = 'pending'"),
        release: db.prepare(`UPDATE outputs SET worker_id = NULL, worker_generation = NULL, state = 'pending', updated_at = ?
            WHERE worker_id = ? AND state IN ${OPEN} AND desired = 'run'`),
        stopOrphans: db.prepare(`UPDATE outputs SET state = 'stopped', ended_at = ?, updated_at = ?
            WHERE state IN ${OPEN} AND (desired = 'stop' AND (worker_id IS NULL OR worker_id IN (SELECT id FROM workers WHERE state IN ('stopped', 'lost'))))`),
        insertLog: db.prepare('INSERT INTO output_logs (output_id, destination_id, level, message, at) VALUES (?, ?, ?, ?, ?)'),
        pruneLogs: db.prepare(`DELETE FROM output_logs WHERE id IN (SELECT id FROM output_logs WHERE destination_id = ? AND
            (output_id IS ? OR output_id = ?) ORDER BY id DESC LIMIT -1 OFFSET ?)`),
        logsOfOutput: db.prepare('SELECT level, message, at FROM output_logs WHERE output_id = ? ORDER BY id DESC LIMIT ?'),
        logsOfDest: db.prepare('SELECT output_id, level, message, at FROM output_logs WHERE destination_id = ? ORDER BY id DESC LIMIT ?'),
    };

    // ── Destinations ──────────────────────────────────────────

    function publicDest(d) {
        if (!d) return null;
        return {
            id: d.id,
            stream_id: d.definition_id,
            platform: d.platform,
            name: d.name,
            server_url: d.server_url,
            transport: /^srt:\/\//i.test(d.server_url) ? 'srt' : 'rtmp',
            has_stream_key: Boolean(d.stream_key_enc),
            stream_key_hint: d.key_hint ? `****${d.key_hint}` : null,
            has_srt_passphrase: Boolean(d.srt_passphrase_enc),
            srt_latency_ms: d.srt_latency_ms,
            enabled: Boolean(d.enabled),
            auto_start: Boolean(d.auto_start),
            quality_preset: d.quality_preset,
            custom_video_bitrate: d.custom_video_bitrate,
            custom_audio_bitrate: d.custom_audio_bitrate,
            custom_fps: d.custom_fps,
            custom_encoder_preset: d.custom_encoder_preset,
            hold_reason: d.hold_reason,
            consecutive_failures: d.consecutive_failures,
            cooldown_until: d.cooldown_until ? new Date(d.cooldown_until).toISOString() : null,
            cooldown_ms: cooldownMs(d),
            last_error: d.last_error,
            last_failed_at: d.last_failed_at ? new Date(d.last_failed_at).toISOString() : null,
            created_at: new Date(d.created_at).toISOString(),
            updated_at: new Date(d.updated_at).toISOString(),
        };
    }

    function cooldownMs(d) {
        return d && d.cooldown_until && d.cooldown_until > now() ? d.cooldown_until - now() : 0;
    }

    const intIn = (v, lo, hi) => {
        if (v === null || v === '') return null;
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
    };

    /** Validate and map API input to columns. Secrets are sealed here and never read back out. */
    function destFields(input, { creating }) {
        const f = {};
        if (creating || input.platform !== undefined) {
            if (!PLATFORMS.includes(input.platform)) throw new StoreError(400, 'openre.invalid_platform', `platform must be one of ${PLATFORMS.join(', ')}`);
            f.platform = input.platform;
        }
        if (input.name !== undefined) f.name = cleanText(input.name, 80, '') || null;
        if (creating || input.server_url !== undefined) {
            const v = validateDestinationUrl(input.server_url, { allowPrivate: config.outputs.allowPrivateHosts });
            if (!v.ok) throw new StoreError(400, 'openre.invalid_destination_url', v.error);
            f.server_url = v.value;
        }
        if (input.stream_key !== undefined && input.stream_key !== '__keep__') {
            const key = input.stream_key == null ? '' : String(input.stream_key).trim();
            if (key.length > 512 || /[\s\u0000-\u001f\u007f]/.test(key)) throw new StoreError(400, 'openre.invalid_stream_key', 'stream key must be at most 512 characters without spaces');
            f.stream_key_enc = key ? box.seal(key) : null;
            f.key_hint = key ? hintOf(key) : null;
        }
        if (input.srt_passphrase !== undefined && input.srt_passphrase !== '__keep__') {
            const p = input.srt_passphrase == null ? '' : String(input.srt_passphrase);
            if (p && (p.length < 10 || p.length > 79)) throw new StoreError(400, 'openre.invalid_srt_passphrase', 'SRT passphrase must be 10–79 characters');
            f.srt_passphrase_enc = p ? box.seal(p) : null;
        }
        if (input.srt_latency_ms !== undefined) f.srt_latency_ms = intIn(input.srt_latency_ms, 20, 8000);
        if (input.enabled !== undefined) f.enabled = input.enabled ? 1 : 0;
        if (input.auto_start !== undefined) f.auto_start = input.auto_start ? 1 : 0;
        if (input.quality_preset !== undefined) {
            if (!QUALITY_PRESETS.includes(input.quality_preset)) throw new StoreError(400, 'openre.invalid_field', `quality_preset must be one of ${QUALITY_PRESETS.join(', ')}`);
            f.quality_preset = input.quality_preset;
        }
        if (input.custom_video_bitrate !== undefined) f.custom_video_bitrate = intIn(input.custom_video_bitrate, 500, 50000);
        if (input.custom_audio_bitrate !== undefined) f.custom_audio_bitrate = intIn(input.custom_audio_bitrate, 32, 512);
        if (input.custom_fps !== undefined) f.custom_fps = intIn(input.custom_fps, 15, 120);
        if (input.custom_encoder_preset !== undefined) f.custom_encoder_preset = ENCODER_PRESETS.includes(input.custom_encoder_preset) ? input.custom_encoder_preset : null;
        return f;
    }

    function createDestination(definitionId, input, { hold_reason = null } = {}) {
        const def = definitions.get(definitionId);
        if (!def || def.state === 'archived') throw new StoreError(404, 'openre.stream_not_found', 'no such stream definition');
        if (q.countOf.get(definitionId).n >= config.outputs.maxPerStream) throw new StoreError(409, 'openre.too_many_destinations', `at most ${config.outputs.maxPerStream} destinations per stream`);
        const f = destFields(input, { creating: true });
        const id = newId('destination', now());
        const row = { id, definition_id: definitionId, enabled: 1, auto_start: 1, quality_preset: 'auto', ...f, hold_reason, created_at: now(), updated_at: now() };
        if (hold_reason) row.enabled = 0;
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO destinations (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(row);
        return publicDest(q.getDest.get(id));
    }

    function updateDestination(id, input) {
        const d = q.getDest.get(id);
        if (!d) throw new StoreError(404, 'openre.destination_not_found', 'no such destination');
        const f = destFields(input, { creating: false });
        // Re-enabling a held destination is an explicit owner decision: the hold is lifted only
        // when its URL now passes the rules (destFields validated any new server_url).
        if (f.enabled === 1 && d.hold_reason) {
            const v = validateDestinationUrl(f.server_url || d.server_url, { allowPrivate: config.outputs.allowPrivateHosts });
            if (!v.ok) throw new StoreError(409, 'openre.destination_held', `held: ${d.hold_reason} (${v.error})`);
            f.hold_reason = null;
        }
        if (!Object.keys(f).length) return publicDest(d);
        f.updated_at = now();
        const cols = Object.keys(f);
        db.prepare(`UPDATE destinations SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...f, id });
        return publicDest(q.getDest.get(id));
    }

    function deleteDestination(id) {
        const d = q.getDest.get(id);
        if (!d) throw new StoreError(404, 'openre.destination_not_found', 'no such destination');
        db.transaction(() => {
            db.prepare(`UPDATE outputs SET desired = 'stop', updated_at = ? WHERE destination_id = ? AND state IN ${OPEN}`).run(now(), id);
            const running = db.prepare(`SELECT 1 FROM outputs WHERE destination_id = ? AND state IN ${OPEN} AND worker_id IS NOT NULL`).get(id);
            if (running) throw new StoreError(409, 'openre.destination_running', 'the destination is running; it has been asked to stop, delete it again in a few seconds');
            q.deleteDest.run(id);
        })();
        return true;
    }

    /** Destination row with its secrets opened, for the restream worker only. */
    function destinationForWorker(id) {
        const d = q.getDest.get(id);
        if (!d) return null;
        return { ...d, stream_key: box.open(d.stream_key_enc), srt_passphrase: box.open(d.srt_passphrase_enc) };
    }

    function markDestinationFailure(id, error) {
        const d = q.getDest.get(id);
        if (!d) return null;
        const n = (d.consecutive_failures || 0) + 1;
        // Same escalation as Live: 15 min, 1 h, 6 h, then 24 h.
        const mins = n <= 1 ? 15 : n === 2 ? 60 : n === 3 ? 360 : 1440;
        db.prepare('UPDATE destinations SET consecutive_failures = ?, last_error = ?, last_failed_at = ?, cooldown_until = ?, updated_at = ? WHERE id = ?')
            .run(n, String(error || 'restream failed to go live').slice(0, 300), now(), now() + mins * 60000, now(), id);
        return { failures: n, cooldownMinutes: mins };
    }

    function clearDestinationCooldown(id) {
        db.prepare('UPDATE destinations SET consecutive_failures = 0, cooldown_until = NULL, last_error = NULL WHERE id = ? AND (consecutive_failures > 0 OR cooldown_until IS NOT NULL OR last_error IS NOT NULL)').run(id);
    }

    // ── Outputs ───────────────────────────────────────────────

    function publicOutput(o) {
        if (!o) return null;
        return {
            id: o.id,
            session_id: o.session_id,
            destination_id: o.destination_id,
            desired: o.desired,
            state: o.state,
            worker: o.worker_id ? { id: o.worker_id, generation: o.worker_generation } : null,
            restart_attempts: o.restart_attempts,
            max_restart_attempts: config.outputs.maxRestarts,
            next_restart_at: o.next_restart_at ? new Date(o.next_restart_at).toISOString() : null,
            ever_live: Boolean(o.ever_live),
            last_error: o.last_error,
            progress: parseJson(o.progress, null),
            started_at: o.started_at ? new Date(o.started_at).toISOString() : null,
            live_at: o.live_at ? new Date(o.live_at).toISOString() : null,
            uptime_ms: o.state === 'live' && o.live_at ? now() - o.live_at : 0,
            ended_at: o.ended_at ? new Date(o.ended_at).toISOString() : null,
            updated_at: new Date(o.updated_at).toISOString(),
        };
    }

    /** Coordinator: every live session gets an output per enabled, auto-start, usable destination. */
    function ensureAutoOutputs() {
        const rows = db.prepare(`SELECT s.id AS session_id, d.id AS destination_id FROM ingest_sessions s
            JOIN destinations d ON d.definition_id = s.definition_id
            LEFT JOIN outputs o ON o.session_id = s.id AND o.destination_id = d.id
            WHERE s.state = 'live' AND d.enabled = 1 AND d.auto_start = 1 AND d.hold_reason IS NULL
              AND d.stream_key_enc IS NOT NULL AND (d.cooldown_until IS NULL OR d.cooldown_until <= ?) AND o.id IS NULL`).all(now());
        for (const r of rows) q.insertOut.run(newId('output', now()), r.session_id, r.destination_id, now(), now());
        return rows.length;
    }

    /**
     * Manual start (the owner pressed Start): creates or re-arms the output for the destination's
     * current live session. A manual start ignores a failure cooldown, like Live's.
     */
    function startDestination(destinationId) {
        const d = q.getDest.get(destinationId);
        if (!d) throw new StoreError(404, 'openre.destination_not_found', 'no such destination');
        if (d.hold_reason) throw new StoreError(409, 'openre.destination_held', `held: ${d.hold_reason}`);
        if (!d.enabled) throw new StoreError(409, 'openre.destination_disabled', 'enable the destination first');
        if (!d.stream_key_enc) throw new StoreError(409, 'openre.destination_no_key', 'the destination has no stream key');
        const session = sessions.list({ definition_id: d.definition_id, state: 'live', limit: 1 })[0];
        if (!session) throw new StoreError(409, 'openre.not_live', 'the stream is not live');
        return db.transaction(() => {
            clearDestinationCooldown(d.id);
            const existing = q.outBySessionDest.get(session.id, d.id);
            if (!existing) {
                const id = newId('output', now());
                q.insertOut.run(id, session.id, d.id, now(), now());
                return publicOutput(q.getOut.get(id));
            }
            if (['pending', 'starting', 'live', 'error'].includes(existing.state) && existing.desired === 'run') return publicOutput(existing);
            if (['pending', 'starting', 'live', 'error'].includes(existing.state)) {
                db.prepare("UPDATE outputs SET desired = 'run', updated_at = ? WHERE id = ?").run(now(), existing.id);
            } else {
                db.prepare(`UPDATE outputs SET desired = 'run', state = 'pending', worker_id = NULL, worker_generation = NULL,
                    restart_attempts = 0, next_restart_at = NULL, last_error = NULL, ended_at = NULL, updated_at = ? WHERE id = ?`).run(now(), existing.id);
            }
            return publicOutput(q.getOut.get(existing.id));
        })();
    }

    function stopDestination(destinationId) {
        const n = db.prepare(`UPDATE outputs SET desired = 'stop', updated_at = ? WHERE destination_id = ? AND desired = 'run' AND state IN ${OPEN}`).run(now(), destinationId).changes;
        // Pending outputs nobody has picked up can stop right here.
        db.prepare("UPDATE outputs SET state = 'stopped', ended_at = ?, updated_at = ? WHERE destination_id = ? AND desired = 'stop' AND state = 'pending' AND worker_id IS NULL").run(now(), now(), destinationId);
        return n;
    }

    /** Coordinator: hand pending outputs to the newest ready restream generation. */
    function assignPending(worker) {
        let n = 0;
        for (const o of q.pendingUnassigned.all()) n += q.assign.run(worker.id, worker.generation, now(), o.id).changes;
        return n;
    }

    /** State changes reported by the restream worker, with the events they imply. */
    /**
     * State reported by a restream worker. With { workerId }, the report only lands while the output
     * is still assigned to that worker: a worker the coordinator has given up (lost) or that handed
     * the output over must not overwrite what the new owner does.
     */
    function report(outputId, change, { workerId } = {}) {
        return db.transaction(() => {
            const o = q.getOut.get(outputId);
            if (!o) return null;
            if (workerId && o.worker_id !== workerId) return null;
            const set = { updated_at: now() };
            for (const k of ['state', 'last_error', 'restart_attempts', 'next_restart_at', 'started_at', 'live_at', 'ended_at']) {
                if (change[k] !== undefined) set[k] = change[k];
            }
            if (change.progress !== undefined) set.progress = change.progress ? JSON.stringify(change.progress) : null;
            if (change.state === 'live') set.ever_live = 1;
            const cols = Object.keys(set);
            db.prepare(`UPDATE outputs SET ${cols.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...set, id: outputId });
            const after = q.getOut.get(outputId);
            if (change.state && change.state !== o.state && (change.state === 'live' || change.state === 'failed')) {
                const dest = q.getDest.get(o.destination_id);
                const session = sessions.get(o.session_id);
                if (dest && session) {
                    events.enqueue({
                        event_type: change.state === 'live' ? TYPES.outputHealthy : TYPES.outputFailed,
                        actor: { type: 'service', id: 'openre' },
                        subject: { type: 'output', id: o.id, revision: after.restart_attempts + 1 },
                        visibility: 'internal',
                        priority: change.state === 'failed' ? 'important' : 'low',
                        payload: {
                            output_id: o.id,
                            session_id: o.session_id,
                            stream_id: session.definition_id,
                            destination: { id: dest.id, platform: dest.platform, name: dest.name },
                            state: change.state,
                            error: change.state === 'failed' ? after.last_error : null,
                            cooldown_minutes: change.cooldown_minutes || null,
                        },
                    });
                }
            }
            return after;
        })();
    }

    function log(outputId, destinationId, level, message) {
        const text = String(message || '').slice(0, 500);
        q.insertLog.run(outputId || null, destinationId, level, text, now());
        q.pruneLogs.run(destinationId, outputId || null, outputId || null, config.outputs.logsPerOutput);
    }

    return {
        PLATFORMS, QUALITY_PRESETS, ENCODER_PRESETS,
        publicDest,
        publicOutput,
        getDestination: (id) => (isId('destination', id) ? publicDest(q.getDest.get(id)) : null),
        destinationRow: (id) => q.getDest.get(id),
        destinations: (definitionId) => q.destsOf.all(definitionId).map(publicDest),
        createDestination,
        updateDestination,
        deleteDestination,
        destinationForWorker,
        markDestinationFailure,
        clearDestinationCooldown,
        getOutput: (id) => (isId('output', id) ? publicOutput(q.getOut.get(id)) : null),
        outputRow: (id) => q.getOut.get(id),
        outputsOfSession: (sessionId) => q.outsOfSession.all(sessionId).map(publicOutput),
        ensureAutoOutputs,
        startDestination,
        stopDestination,
        assignPending,
        forWorker: (workerId) => q.forWorker.all(workerId),
        release: (workerId) => q.release.run(now(), workerId).changes,
        unassign: (outputId) => q.unassign.run(now(), outputId).changes,
        stopOrphans: () => q.stopOrphans.run(now(), now()).changes,
        report,
        log,
        logsOfOutput: (id, limit = 100) => q.logsOfOutput.all(id, limit),
        logsOfDestination: (id, limit = 100) => q.logsOfDest.all(id, limit),
    };
}

module.exports = { createOutputs, PLATFORMS, QUALITY_PRESETS, ENCODER_PRESETS };
