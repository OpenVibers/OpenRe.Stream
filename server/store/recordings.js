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

// JSMPEG has no recording (Live has none either, decision 8: parity). A jsmpeg definition with
// recording on gets an explicit failure, never a silent no-op.
const RECORDING_UNSUPPORTED = 'recording is not available for jsmpeg';
const BACKOFF_MS = [5000, 15000, 30000, 60000, 120000, 300000];
const MAX_ATTEMPTS = 10;
// Media refuses a recording while its disk is critically low and frees space within minutes;
// keep asking while the stream is live (Live's recorder does the same: 12 × 5 min).
const DISK_RETRY_MS = 5 * 60 * 1000;
const DISK_MAX_ATTEMPTS = 12;

function createRecordings({ db, config, events, clock, definitions, sessions, workers, log = console, fetchImpl = globalThis.fetch }) {
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

    async function update(id, fields) {
        await q.set(Object.keys(fields)).run({ ...fields, id, now: now() });
        return await q.get.get(id);
    }

    async function ensureRequests() {
        const rows = await q.missing.all(now() - config.media.startDelayMs);
        for (const r of rows) await q.insert.run(newId('recording', now()), r.session_id, r.mode, config.media.appId, now(), now());
        return rows.length;
    }

    async function retryLater(rec, err, { disk = false } = {}) {
        const attempts = rec.attempts + 1;
        const limit = disk ? DISK_MAX_ATTEMPTS : MAX_ATTEMPTS;
        if (attempts >= limit) return await update(rec.id, { attempts, state: 'failed', last_error: String(err.message || err).slice(0, 300) });
        const wait = disk ? DISK_RETRY_MS : BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
        return await update(rec.id, { attempts, next_attempt_at: now() + wait, last_error: String(err.message || err).slice(0, 300) });
    }

    function refOf(definition, service, type) {
        const r = definition.external_refs.find(x => x.service === service && x.type === type);
        return r ? r.id : undefined;
    }

    /** The egress base URL of the worker that owns this session (its RTP descriptor API), or null. */
    async function egressBase(session) {
        const owner = session.worker_id ? await workers.get(session.worker_id) : null;
        const ep = (owner && owner.endpoints) || {};
        return ep.egressPort ? `http://127.0.0.1:${ep.egressPort}` : null;
    }

    async function fetchJson(url, opts) {
        const res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(10000) });
        const text = await res.text().catch(() => '');
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { json = null; } }
        if (!res.ok) { const e = new Error((json && json.error) || `egress ${res.status}`); e.status = res.status; throw e; }
        return json;
    }

    /** Stop the worker sending RTP to Media: close the PlainRTP consumer it opened for us. */
    async function closeWebrtcEgress(rec, session) {
        if (!rec.rtp_handle) return;
        const base = await egressBase(session);
        if (base) { try { await fetchJson(`${base}/rtp/${session.id}/${rec.rtp_handle}`, { method: 'DELETE' }); } catch { /* best effort */ } }
        await update(rec.id, { rtp_handle: null });
        rec.rtp_handle = null;
    }

    /**
     * Record a webrtc session through Media's RTP ingest (brief §4.4): Media allocates a video (and
     * optional audio) RTP/RTCP port pair, the owning worker opens a PlainRTP consumer sending to it,
     * and on finalize the consumer is closed and ingestRtpStop/finalize close the Media recording.
     */
    async function stepWebrtc(rec, media, session, definition) {
        const ended = isTerminal(session.state) || session.state === 'ending';
        const base = await egressBase(session);

        if (rec.state === 'pending') {
            if (ended) return await update(rec.id, { state: 'cancelled' });
            if (!base) return await retryLater(rec, new Error('the WebRTC worker exposes no egress endpoint yet'));
            let desc;
            try { desc = await fetchJson(`${base}/rtp/${session.id}/describe`); } catch (err) { return await retryLater(rec, err); }
            if (!desc.video) return await retryLater(rec, new Error('no WebRTC video producer yet'));
            let vodId = rec.media_vod_id;
            try {
                if (!vodId) {
                    const liveUser = refOf(definition, 'live', 'user');
                    const liveSlot = refOf(definition, 'live', 'managed_stream');
                    const out = await media.createVod({
                        title: definition.title || 'Stream Recording',
                        user_id: liveUser != null ? Number(liveUser) : undefined,
                        managed_stream_id: liveSlot != null ? Number(liveSlot) : undefined,
                        clips_only: rec.mode === 'clips' || undefined,
                        visibility: definition.recording_visibility,
                        meta: { source: 'openre', openre_session_id: session.id, openre_stream_id: definition.id, protocol: 'webrtc', mode: rec.mode },
                    });
                    vodId = String(out && out.id);
                    rec = await update(rec.id, { media_vod_id: vodId, state: 'requested' });
                }
                const ports = await media.ingestRtpStart(vodId, { video: desc.video, audio: desc.audio || undefined });
                const videoPort = ports && (ports.videoPort || ports.video_port);
                const audioPort = ports && (ports.audioPort || ports.audio_port);
                if (!videoPort) throw new Error('Media returned no RTP ports for the recording');
                const egress = await fetchJson(`${base}/rtp/${session.id}?vport=${videoPort}${audioPort ? `&aport=${audioPort}` : ''}`);
                await update(rec.id, { rtp_handle: egress.handle || null, rtp_video_port: videoPort, rtp_audio_port: audioPort || null });
            } catch (err) {
                log.warn(`[recording] ${rec.id} (webrtc) request failed: ${err.message}`);
                if (vodId) await media.deleteVod(vodId).catch(() => {});
                await update(rec.id, { media_vod_id: null, state: 'pending' });
                return await retryLater(await q.get.get(rec.id), err, { disk: /disk/i.test(String(err.message)) });
            }
            return await db.tx(async () => {
                const r = await update(rec.id, { state: 'recording', attempts: 0, last_error: null, next_attempt_at: 0 });
                await events.enqueue({
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
            });
        }

        if (rec.state === 'requested') return await update(rec.id, { state: 'pending' });

        if (rec.state === 'recording' && ended) rec = await update(rec.id, { state: 'finalizing' });
        if (rec.state === 'finalizing') {
            await closeWebrtcEgress(rec, session);
            try { await media.ingestRtpStop(rec.media_vod_id); } catch (err) { if (err.status !== 409) return await retryLater(rec, err); }
            try {
                await media.finalizeVod(rec.media_vod_id);
                if (rec.mode === 'clips') await media.deleteVod(rec.media_vod_id).catch(() => {});
            } catch (err) {
                if (err.status !== 409) return await retryLater(rec, err);
            }
            return await update(rec.id, { state: 'finalized', last_error: null });
        }
        return rec;
    }

    async function step(rec, media) {
        const session = await sessions.get(rec.session_id);
        if (!session) return await update(rec.id, { state: 'failed', last_error: 'session missing' });
        const definition = await definitions.row(session.definition_id);
        const ended = isTerminal(session.state) || session.state === 'ending';

        if (session.protocol === 'jsmpeg') {
            return await db.tx(async () => {
                const r = await update(rec.id, { state: 'failed', last_error: RECORDING_UNSUPPORTED });
                await events.enqueue({
                    event_type: TYPES.recordingFailed,
                    actor: { type: 'service', id: 'openre' },
                    subject: { type: 'recording', id: rec.id, revision: 1 },
                    visibility: 'internal',
                    priority: 'important',
                    payload: {
                        recording_id: rec.id,
                        session_id: session.id,
                        stream_id: definition.id,
                        owner: { type: 'user', id: definition.owner_subject },
                        protocol: session.protocol,
                        reason: RECORDING_UNSUPPORTED,
                        external_refs: definition.external_refs,
                    },
                });
                return r;
            });
        }

        if (session.protocol === 'webrtc') return await stepWebrtc(rec, media, session, definition);

        if (rec.state === 'pending') {
            if (ended) return await update(rec.id, { state: 'cancelled' });
            const pb = await sessions.playback(session);
            if (!pb || !pb.rtmp) return await retryLater(rec, new Error('no loopback play URL for this session yet'));
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
                    rec = await update(rec.id, { media_vod_id: vodId, state: 'requested' });
                }
                await media.ingestRtmp(vodId, pb.rtmp.internal_url);
            } catch (err) {
                log.warn(`[recording] ${rec.id} request failed: ${err.message}`);
                // Media may have made the VOD row before the ingest was refused (disk low): drop the
                // empty shell so it never shows as a 0:00 VOD, and start over next time.
                if (vodId) await media.deleteVod(vodId).catch(() => {});
                await update(rec.id, { media_vod_id: null, state: 'pending' });
                return await retryLater(await q.get.get(rec.id), err, { disk: /disk/i.test(String(err.message)) });
            }
            return await db.tx(async () => {
                const r = await update(rec.id, { state: 'recording', attempts: 0, last_error: null, next_attempt_at: 0 });
                await events.enqueue({
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
            });
        }

        if (rec.state === 'requested') {
            // A create that succeeded and an ingest that did not: handled above; a requested row
            // here means the process died in between. Start the ingest again.
            return await update(rec.id, { state: 'pending' });
        }

        if (rec.state === 'recording' && ended) rec = await update(rec.id, { state: 'finalizing' });
        if (rec.state === 'finalizing') {
            try {
                await media.finalizeVod(rec.media_vod_id);
                if (rec.mode === 'clips') await media.deleteVod(rec.media_vod_id).catch(() => {});
            } catch (err) {
                // 409 = Media already finalising it (its ffmpeg saw the source end): that is success.
                if (err.status !== 409) return await retryLater(rec, err);
            }
            return await update(rec.id, { state: 'finalized', last_error: null });
        }
        return rec;
    }

    /** One pass over due requests (coordinator). */
    async function process(media) {
        if (!media.configured) return 0;
        let n = 0;
        for (const rec of await q.due.all(now())) {
            try { await step(rec, media); n++; } catch (err) { log.error(`[recording] ${rec.id}: ${err.stack || err}`); }
        }
        return n;
    }

    return {
        ensureRequests,
        process,
        bySession: async (sessionId) => await q.bySession.get(sessionId) || null,
    };
}

module.exports = { createRecordings };
