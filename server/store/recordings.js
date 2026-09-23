'use strict';
/**
 * Recording requests to OpenVibe.Media (plan §15.10: "recordings are independent Media jobs").
 *
 *   pending ─► requested ─► recording ─► finalizing ─► finalized
 *      │           │            │             │
 *      └───────────┴────────────┴─────────────┴──► failed          (retries exhausted)
 *   pending ─► cancelled   (the session ended before Media was asked)
 *
 * Driven by the session coordinator, never by a transport worker or the API: a worker only has to
 * keep the loopback play URL up, and Media's ffmpeg pulls from it. Media finalises.
 */
const { newId } = require('../ids');
const { TYPES } = require('../events');
const { isTerminal } = require('../state-machine');

const BACKOFF_MS = [5000, 15000, 30000, 60000, 120000, 300000];
const MAX_ATTEMPTS = 10;
// Media refuses a recording while its disk is critically low and frees space within minutes;
// keep asking while the stream is live (Live's recorder does the same: 12 × 5 min).
const DISK_RETRY_MS = 5 * 60 * 1000;
const DISK_MAX_ATTEMPTS = 12;

function createRecordings({ db, config, events, clock, definitions, sessions, log = console }) {
    const now = () => clock.now();
    const q = {
        get: db.prepare('SELECT * FROM recordings WHERE id = ?'),
        bySession: db.prepare('SELECT * FROM recordings WHERE session_id = ?'),
        missing: db.prepare(`SELECT s.id AS session_id, d.recording_mode AS mode FROM ingest_sessions s
            JOIN stream_definitions d ON d.id = s.definition_id LEFT JOIN recordings r ON r.session_id = s.id
            WHERE s.state = 'live' AND d.recording_mode IN ('vod', 'clips') AND s.live_at <= ? AND r.id IS NULL`),
        insert: db.prepare(`INSERT INTO recordings (id, session_id, mode, state, media_app, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', ?, ?, ?)`),
        due: db.prepare(`SELECT r.* FROM recordings r JOIN ingest_sessions s ON s.id = r.session_id
            WHERE r.next_attempt_at <= ? AND (r.state IN ('pending', 'requested', 'finalizing')
              OR (r.state = 'recording' AND s.state IN ('ending', 'ended', 'failed')))
            ORDER BY r.created_at LIMIT 20`),
        set: (cols) => db.prepare(`UPDATE recordings SET ${cols.map(c => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE id = @id`),
    };

    function update(id, fields) {
        q.set(Object.keys(fields)).run({ ...fields, id, now: now() });
        return q.get.get(id);
    }

    function ensureRequests() {
        const rows = q.missing.all(now() - config.media.startDelayMs);
        for (const r of rows) q.insert.run(newId('recording', now()), r.session_id, r.mode, config.media.appId, now(), now());
        return rows.length;
    }

    function retryLater(rec, err, { disk = false } = {}) {
        const attempts = rec.attempts + 1;
        const limit = disk ? DISK_MAX_ATTEMPTS : MAX_ATTEMPTS;
        if (attempts >= limit) return update(rec.id, { attempts, state: 'failed', last_error: String(err.message || err).slice(0, 300) });
        const wait = disk ? DISK_RETRY_MS : BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
        return update(rec.id, { attempts, next_attempt_at: now() + wait, last_error: String(err.message || err).slice(0, 300) });
    }

    function refOf(definition, service, type) {
        const r = definition.external_refs.find(x => x.service === service && x.type === type);
        return r ? r.id : undefined;
    }

    async function step(rec, media) {
        const session = sessions.get(rec.session_id);
        if (!session) return update(rec.id, { state: 'failed', last_error: 'session missing' });
        const definition = definitions.row(session.definition_id);
        const ended = isTerminal(session.state) || session.state === 'ending';

        if (rec.state === 'pending') {
            if (ended) return update(rec.id, { state: 'cancelled' });
            const pb = sessions.playback(session);
            if (!pb || !pb.rtmp) return retryLater(rec, new Error('no loopback play URL for this session yet'));
            let vodId = rec.media_vod_id;
            try {
                if (!vodId) {
                    // Media's 'live' tenant files VODs under Live-local ids; they travel as typed
                    // references on the definition (compatibility only, never identity).
                    const liveUser = refOf(definition, 'live', 'user');
                    const liveSlot = refOf(definition, 'live', 'managed_stream');
                    const out = await media.createVod({
                        title: definition.title || 'Stream Recording',
                        user_id: liveUser != null ? Number(liveUser) : undefined,
                        managed_stream_id: liveSlot != null ? Number(liveSlot) : undefined,
                        clips_only: rec.mode === 'clips' || undefined,
                        visibility: definition.recording_visibility,
                        meta: { source: 'openre', openre_session_id: session.id, openre_stream_id: definition.id, protocol: session.protocol, mode: rec.mode },
                    });
                    vodId = String(out && out.id);
                    rec = update(rec.id, { media_vod_id: vodId, state: 'requested' });
                }
                await media.ingestRtmp(vodId, pb.rtmp.internal_url);
            } catch (err) {
                log.warn(`[recording] ${rec.id} request failed: ${err.message}`);
                // Media may have made the VOD row before the ingest was refused (disk low): drop the
                // empty shell so it never shows as a 0:00 VOD, and start over next time.
                if (vodId) await media.deleteVod(vodId).catch(() => {});
                update(rec.id, { media_vod_id: null, state: 'pending' });
                return retryLater(q.get.get(rec.id), err, { disk: /disk/i.test(String(err.message)) });
            }
            return db.transaction(() => {
                const r = update(rec.id, { state: 'recording', attempts: 0, last_error: null, next_attempt_at: 0 });
                events.enqueue({
                    event_type: TYPES.recordingRequested,
                    actor: { type: 'service', id: 'openre' },
                    subject: { type: 'recording', id: rec.id, revision: 1 },
                    visibility: 'internal',
                    priority: 'important',
                    payload: {
                        recording_id: rec.id,
                        session_id: session.id,
                        stream_id: definition.id,
                        owner: { type: 'user', id: definition.owner_subject },
                        mode: rec.mode,
                        media: { app: config.media.appId, vod_id: r.media_vod_id },
                        external_refs: definition.external_refs,
                    },
                });
                return r;
            })();
        }

        if (rec.state === 'requested') {
            // A create that succeeded and an ingest that did not: handled above; a requested row
            // here means the process died in between. Start the ingest again.
            return update(rec.id, { state: 'pending' });
        }

        if (rec.state === 'recording' && ended) rec = update(rec.id, { state: 'finalizing' });
        if (rec.state === 'finalizing') {
            try {
                await media.finalizeVod(rec.media_vod_id);
                if (rec.mode === 'clips') await media.deleteVod(rec.media_vod_id).catch(() => {});
            } catch (err) {
                // 409 = Media already finalising it (its ffmpeg saw the source end): that is success.
                if (err.status !== 409) return retryLater(rec, err);
            }
            return update(rec.id, { state: 'finalized', last_error: null });
        }
        return rec;
    }

    /** One pass over due requests (coordinator). */
    async function process(media) {
        if (!media.configured) return 0;
        let n = 0;
        for (const rec of q.due.all(now())) {
            try { await step(rec, media); n++; } catch (err) { log.error(`[recording] ${rec.id}: ${err.stack || err}`); }
        }
        return n;
    }

    return {
        ensureRequests,
        process,
        bySession: (sessionId) => q.bySession.get(sessionId) || null,
    };
}

module.exports = { createRecordings };
