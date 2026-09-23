'use strict';
/**
 * OpenRe API v1 (openre-api). Every route checks one capability for service callers; owners
 * (Network user JWT) act on their own streams. Errors are RFC 9457 problem+json.
 *
 *   GET    /api/v1/streams                      openre.stream.read     list (owner, ?external_ref=live:managed_stream:12)
 *   POST   /api/v1/streams                      openre.stream.write    create → first ingest key, shown once
 *   GET    /api/v1/streams/:id                  openre.stream.read     definition + ingest URLs + key hints
 *   PATCH  /api/v1/streams/:id                  openre.stream.write
 *   DELETE /api/v1/streams/:id                  openre.stream.write    archive (refused while live)
 *   GET    /api/v1/streams/:id/keys             openre.stream.read     key metadata (never a key)
 *   POST   /api/v1/streams/:id/keys/rotate      openre.key.rotate      { grace_seconds, end_sessions } → new key, shown once
 *   GET    /api/v1/streams/:id/destinations     openre.output.read
 *   POST   /api/v1/streams/:id/destinations     openre.output.write
 *   PATCH  /api/v1/destinations/:id             openre.output.write    stream_key / srt_passphrase are write-only
 *   DELETE /api/v1/destinations/:id             openre.output.write
 *   POST   /api/v1/destinations/:id/test        openre.output.write    URL rules + DNS + TCP reachability
 *   POST   /api/v1/destinations/:id/start|stop  openre.output.write    for the stream's live session
 *   GET    /api/v1/destinations/:id/logs        openre.output.read
 *   GET    /api/v1/sessions                     openre.session.read    ?stream_id=&state=open|live|ended|failed
 *   GET    /api/v1/sessions/:id                 openre.session.read    session + transitions + outputs + recording
 *   GET    /api/v1/sessions/:id/playback        openre.session.read    playback descriptor
 *   POST   /api/v1/sessions/:id/end             openre.session.end     the owning worker disconnects the encoder
 *   GET    /api/v1/sessions/:id/outputs         openre.output.read     outputs with health
 *   GET    /api/v1/outputs/:id/logs             openre.output.read
 *   GET    /api/v1/workers                      openre.session.read    worker generations (staff/services)
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { StoreError } = require('../store/definitions');
const { testDestination } = require('../destination-test');

function iso(ms) { return ms ? new Date(ms).toISOString() : null; }

function createV1Router({ rt, auth }) {
    const { store, config } = rt;
    const router = express.Router();
    const guard = auth.guard;

    const fail = (req, res, status, code, detail) => http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const handle = (fn) => async (req, res, next) => {
        try { await fn(req, res, next); } catch (err) {
            if (err instanceof StoreError) return fail(req, res, err.status, err.code, err.message);
            if (err && err.code === 'openre.secrets_unavailable') return fail(req, res, 503, err.code, err.message);
            return next(err);
        }
    };

    function publicDefinition(d, { withSessions = true } = {}) {
        const keys = store.definitions.keys(d.id).filter(k => k.status !== 'revoked');
        const open = withSessions ? store.sessions.openFor(d.id)[0] || null : null;
        return {
            id: d.id,
            title: d.title,
            description: d.description,
            owner: { type: 'user', id: d.owner_subject },
            protocols: d.protocols,
            recording_mode: d.recording_mode,
            recording_visibility: d.recording_visibility,
            playback_visibility: d.playback_visibility,
            mirror_to_live: d.mirror_to_live,
            state: d.state,
            revision: d.revision,
            external_refs: d.external_refs,
            ingest: store.definitions.ingestEndpoints(d),
            keys: keys.map(k => ({ id: k.id, hint: k.hint, status: k.status, grace_until: iso(k.grace_until), created_at: iso(k.created_at), last_used_at: iso(k.last_used_at) })),
            session: open ? { id: open.id, state: open.state, protocol: open.protocol, live_at: iso(open.live_at) } : null,
            created_at: iso(d.created_at),
            updated_at: iso(d.updated_at),
        };
    }

    function publicSession(s, { detail = false } = {}) {
        const out = {
            id: s.id,
            stream_id: s.definition_id,
            protocol: s.protocol,
            state: s.state,
            desired_state: s.desired_state,
            worker: s.worker_id ? { id: s.worker_id, kind: s.worker_kind, generation: s.worker_generation } : null,
            lease_expires_at: iso(s.lease_expires_at),
            key_id: s.key_id,
            end_reason: s.end_reason,
            failure_reason: s.failure_reason,
            media_info: s.media_info,
            revision: s.revision,
            created_at: iso(s.created_at),
            live_at: iso(s.live_at),
            ended_at: iso(s.ended_at),
            duration_seconds: s.live_at ? Math.round(((s.ended_at || Date.now()) - s.live_at) / 1000) : 0,
        };
        if (detail) {
            out.transitions = store.sessions.transitions(s.id).map(t => ({ ...t, at: iso(t.at) }));
            out.outputs = store.outputs.outputsOfSession(s.id);
            const rec = store.recordings.bySession(s.id);
            out.recording = rec ? { id: rec.id, mode: rec.mode, state: rec.state, media: rec.media_vod_id ? { app: rec.media_app, vod_id: rec.media_vod_id } : null, last_error: rec.last_error } : null;
            out.playback = store.sessions.playback(s);
        }
        return out;
    }

    function loadDefinition(req, res, id) {
        const d = store.definitions.get(id);
        if (!d || d.state === 'archived' || !auth.canAccess(req.caller, d.owner_subject)) {
            fail(req, res, 404, 'openre.stream_not_found', 'no such stream definition');
            return null;
        }
        return d;
    }

    function loadDestination(req, res, id) {
        const dest = store.outputs.destinationRow(id);
        const d = dest ? store.definitions.get(dest.definition_id) : null;
        if (!dest || !d || !auth.canAccess(req.caller, d.owner_subject)) {
            fail(req, res, 404, 'openre.destination_not_found', 'no such destination');
            return null;
        }
        return dest;
    }

    function loadSession(req, res, id) {
        const s = store.sessions.get(id);
        const d = s ? store.definitions.row(s.definition_id) : null;
        if (!s || !d || !auth.canAccess(req.caller, d.owner_subject)) {
            fail(req, res, 404, 'openre.session_not_found', 'no such session');
            return null;
        }
        return s;
    }

    // ── Streams ───────────────────────────────────────────────

    router.get('/streams', guard('openre.stream.read'), handle((req, res) => {
        const ref = String(req.query.external_ref || '');
        if (ref) {
            const [service, type, ...rest] = ref.split(':');
            const d = store.definitions.findByRef(service, type, rest.join(':'));
            const visible = d && d.state !== 'archived' && auth.canAccess(req.caller, d.owner_subject);
            return res.json({ streams: visible ? [publicDefinition(d)] : [] });
        }
        const c = req.caller;
        let owner = c.subject || null;
        if (c.kind === 'user' && c.staff && req.query.all === '1') owner = null;
        const list = store.definitions.list({ owner_subject: owner || undefined, limit: Number(req.query.limit) || 100 });
        return res.json({ streams: list.map(d => publicDefinition(d)) });
    }));

    router.post('/streams', guard('openre.stream.write'), handle((req, res) => {
        const owner = req.caller.kind === 'user' ? req.caller.subject : (req.caller.subject || (req.body && req.body.owner_subject));
        if (!owner) return fail(req, res, 400, 'openre.invalid_owner', 'name the owner (X-OV-Subject)');
        if (req.caller.kind === 'service' && req.caller.subject && req.body && req.body.owner_subject && req.body.owner_subject !== req.caller.subject) {
            return fail(req, res, 400, 'openre.invalid_owner', 'owner_subject differs from X-OV-Subject');
        }
        const b = req.body || {};
        const { definition, key } = store.definitions.create({
            owner_subject: owner,
            title: b.title, description: b.description, protocols: b.protocols,
            recording_mode: b.recording_mode, recording_visibility: b.recording_visibility, playback_visibility: b.playback_visibility,
            mirror_to_live: b.mirror_to_live, external_refs: b.external_refs,
            created_by: auth.actorOf(req.caller),
        });
        res.set('Cache-Control', 'no-store');
        return res.status(201).json({ stream: publicDefinition(definition), key: { id: key.id, key: key.key, hint: key.hint, shown_once: true } });
    }));

    router.get('/streams/:id', guard('openre.stream.read'), handle((req, res) => {
        const d = loadDefinition(req, res, req.params.id);
        if (d) res.json({ stream: publicDefinition(d) });
    }));

    router.patch('/streams/:id', guard('openre.stream.write'), handle((req, res) => {
        const d = loadDefinition(req, res, req.params.id);
        if (!d) return;
        const b = req.body || {};
        const updated = store.definitions.update(d.id, {
            title: b.title, description: b.description, protocols: b.protocols, recording_mode: b.recording_mode,
            recording_visibility: b.recording_visibility, playback_visibility: b.playback_visibility, mirror_to_live: b.mirror_to_live, state: b.state,
        });
        res.json({ stream: publicDefinition(updated) });
    }));

    router.delete('/streams/:id', guard('openre.stream.write'), handle((req, res) => {
        const d = loadDefinition(req, res, req.params.id);
        if (!d) return;
        store.definitions.archive(d.id);
        res.status(204).end();
    }));

    router.get('/streams/:id/keys', guard('openre.stream.read'), handle((req, res) => {
        const d = loadDefinition(req, res, req.params.id);
        if (d) res.json({ keys: store.definitions.keys(d.id).map(k => ({ ...k, created_at: iso(k.created_at), grace_until: iso(k.grace_until), revoked_at: iso(k.revoked_at), last_used_at: iso(k.last_used_at) })) });
    }));

    router.post('/streams/:id/keys/rotate', guard('openre.key.rotate'), handle((req, res) => {
        const d = loadDefinition(req, res, req.params.id);
        if (!d) return;
        const b = req.body || {};
        const r = store.definitions.rotateKey(d.id, { grace_seconds: b.grace_seconds, rotated_by: auth.actorOf(req.caller), reason: 'rotated' });
        let ended = 0;
        if (b.end_sessions) {
            for (const s of store.sessions.openFor(d.id)) if (store.sessions.requestEnd(s.id, `key_rotation:${auth.actorOf(req.caller)}`)) ended++;
        }
        res.set('Cache-Control', 'no-store');
        res.json({
            key: { id: r.key.id, key: r.key.key, hint: r.key.hint, shown_once: true },
            retired: r.retired,
            grace_until: iso(r.grace_until),
            sessions_ending: ended,
            ingest: store.definitions.ingestEndpoints(store.definitions.get(d.id)),
        });
    }));

    // ── Destinations ──────────────────────────────────────────

    router.get('/streams/:id/destinations', guard('openre.output.read'), handle((req, res) => {
        const d = loadDefinition(req, res, req.params.id);
        if (d) res.json({ destinations: store.outputs.destinations(d.id) });
    }));

    router.post('/streams/:id/destinations', guard('openre.output.write'), handle((req, res) => {
        const d = loadDefinition(req, res, req.params.id);
        if (d) res.status(201).json({ destination: store.outputs.createDestination(d.id, req.body || {}) });
    }));

    router.patch('/destinations/:id', guard('openre.output.write'), handle((req, res) => {
        const dest = loadDestination(req, res, req.params.id);
        if (dest) res.json({ destination: store.outputs.updateDestination(dest.id, req.body || {}) });
    }));

    router.delete('/destinations/:id', guard('openre.output.write'), handle((req, res) => {
        const dest = loadDestination(req, res, req.params.id);
        if (!dest) return;
        store.outputs.deleteDestination(dest.id);
        res.status(204).end();
    }));

    router.post('/destinations/:id/test', guard('openre.output.write'), handle(async (req, res) => {
        const dest = loadDestination(req, res, req.params.id);
        if (!dest) return;
        const result = await testDestination(dest, { allowPrivate: config.outputs.allowPrivateHosts });
        store.outputs.log(null, dest.id, result.ok ? 'info' : 'warn', `test ${result.ok ? 'passed' : 'failed'}: ${result.checks.map(c => `${c.check} ${c.ok ? 'ok' : 'FAIL'} (${c.detail})`).join('; ')}`);
        res.json(result);
    }));

    router.post('/destinations/:id/start', guard('openre.output.write'), handle((req, res) => {
        const dest = loadDestination(req, res, req.params.id);
        if (dest) res.json({ output: store.outputs.startDestination(dest.id) });
    }));

    router.post('/destinations/:id/stop', guard('openre.output.write'), handle((req, res) => {
        const dest = loadDestination(req, res, req.params.id);
        if (dest) res.json({ stopping: store.outputs.stopDestination(dest.id) });
    }));

    router.get('/destinations/:id/logs', guard('openre.output.read'), handle((req, res) => {
        const dest = loadDestination(req, res, req.params.id);
        if (dest) res.json({ logs: store.outputs.logsOfDestination(dest.id, Math.min(Number(req.query.limit) || 100, 500)).map(l => ({ ...l, at: iso(l.at) })) });
    }));

    // ── Sessions ──────────────────────────────────────────────

    router.get('/sessions', guard('openre.session.read'), handle((req, res) => {
        const q = req.query;
        if (q.stream_id) {
            const d = loadDefinition(req, res, String(q.stream_id));
            if (!d) return;
        }
        const c = req.caller;
        // Owners see their own sessions; staff may ask for all (?all=1); a service sees the
        // sessions of the subject it acts for, or every session without X-OV-Subject.
        let owner = c.subject || null;
        if (c.kind === 'user' && c.staff && q.all === '1') owner = null;
        const list = store.sessions.list({
            definition_id: q.stream_id ? String(q.stream_id) : undefined,
            owner_subject: q.stream_id ? undefined : (owner || undefined),
            state: q.state ? String(q.state) : undefined,
            limit: q.limit,
            before: q.before,
        });
        res.json({ sessions: list.map(s => publicSession(s)) });
    }));

    router.get('/sessions/:id', guard('openre.session.read'), handle((req, res) => {
        const s = loadSession(req, res, req.params.id);
        if (s) res.json({ session: publicSession(s, { detail: true }) });
    }));

    router.get('/sessions/:id/playback', guard('openre.session.read'), handle((req, res) => {
        const s = loadSession(req, res, req.params.id);
        if (s) res.json({ playback: store.sessions.playback(s) });
    }));

    router.post('/sessions/:id/end', guard('openre.session.end'), handle((req, res) => {
        const s = loadSession(req, res, req.params.id);
        if (!s) return;
        const requested = store.sessions.requestEnd(s.id, auth.actorOf(req.caller));
        res.status(requested ? 202 : 409).json({ requested, state: store.sessions.get(s.id).state });
    }));

    router.get('/sessions/:id/outputs', guard('openre.output.read'), handle((req, res) => {
        const s = loadSession(req, res, req.params.id);
        if (s) res.json({ outputs: store.outputs.outputsOfSession(s.id) });
    }));

    router.get('/outputs/:id/logs', guard('openre.output.read'), handle((req, res) => {
        const o = store.outputs.outputRow(req.params.id);
        const s = o ? loadSession(req, res, o.session_id) : null;
        if (!o) return fail(req, res, 404, 'openre.output_not_found', 'no such output');
        if (s) res.json({ logs: store.outputs.logsOfOutput(o.id, Math.min(Number(req.query.limit) || 100, 500)).map(l => ({ ...l, at: iso(l.at) })) });
    }));

    router.get('/workers', guard('openre.session.read'), handle((req, res) => {
        if (req.caller.kind === 'user' && !req.caller.staff) return fail(req, res, 403, 'capability.denied', 'staff only');
        res.json({ workers: store.workers.recent(100).map(w => ({ ...w, started_at: iso(w.started_at), ready_at: iso(w.ready_at), heartbeat_at: iso(w.heartbeat_at), drain_started_at: iso(w.drain_started_at), drain_deadline: iso(w.drain_deadline), stopped_at: iso(w.stopped_at) })) });
    }));

    return { router, publicDefinition, publicSession };
}

module.exports = { createV1Router };
