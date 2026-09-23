'use strict';
/**
 * Stream (input) definitions and their ingest keys.
 *
 * A definition belongs to one owner subject (usr_… from OpenVibe.Network) and may carry typed
 * references to other services' entities, e.g. { service: 'live', type: 'managed_stream', id: '12' }
 * for the Live slot it serves. A reference is a pointer, never identity: ownership is the subject.
 */
const { ids } = require('openvibe-contracts');
const { newId, isId } = require('../ids');
const { newIngestKey, hashIngestKey, isIngestKeyShape, hintOf } = require('../secrets');
const { TYPES } = require('../events');

const PROTOCOLS = Object.freeze(['rtmp', 'whip', 'webrtc', 'jsmpeg']);
const RECORDING_MODES = Object.freeze(['vod', 'clips', 'none']);
const VISIBILITIES = Object.freeze(['public', 'unlisted', 'private']);
const REF_SERVICE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const REF_TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;
// Owner-level reference types may be shared by several definitions of the same person.
const SHARED_REF_TYPES = new Set(['user', 'channel']);

class StoreError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

function parseJson(v, d) {
    if (v == null) return d;
    try { return JSON.parse(v); } catch { return d; }
}

function cleanText(v, max, d = '') {
    if (v == null) return d;
    return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

function validateRefs(refs) {
    if (refs == null) return [];
    if (!Array.isArray(refs) || refs.length > 10) throw new StoreError(400, 'openre.invalid_ref', 'external_refs must be an array of at most 10 references');
    return refs.map((r) => {
        const service = String(r && r.service || '');
        const type = String(r && r.type || '');
        const id = String(r && r.id != null ? r.id : '');
        if (!REF_SERVICE_RE.test(service) || !REF_TYPE_RE.test(type) || !id || id.length > 128) {
            throw new StoreError(400, 'openre.invalid_ref', 'each external ref needs service, type and id');
        }
        return { service, type, id, label: r.label ? cleanText(r.label, 120) : null };
    });
}

function createDefinitions({ db, config, events, clock }) {
    const now = () => clock.now();

    const q = {
        insert: db.prepare(`INSERT INTO stream_definitions (id, owner_subject, title, description, protocols, recording_mode,
            recording_visibility, playback_visibility, mirror_to_live, state, revision, created_at, updated_at)
            VALUES (@id, @owner_subject, @title, @description, @protocols, @recording_mode, @recording_visibility,
            @playback_visibility, @mirror_to_live, 'active', 1, @now, @now)`),
        get: db.prepare('SELECT * FROM stream_definitions WHERE id = ?'),
        refs: db.prepare('SELECT service, type, ref_id AS id, label FROM external_refs WHERE definition_id = ? ORDER BY created_at, service, type'),
        insertRef: db.prepare('INSERT INTO external_refs (definition_id, service, type, ref_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
        byRef: db.prepare(`SELECT r.definition_id FROM external_refs r JOIN stream_definitions d ON d.id = r.definition_id
            WHERE r.service = ? AND r.type = ? AND r.ref_id = ? ORDER BY (d.state = 'archived'), d.created_at LIMIT 1`),
        insertKey: db.prepare(`INSERT INTO ingest_keys (id, definition_id, key_hash, hint, status, created_by, created_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?)`),
        activeKeys: db.prepare("SELECT * FROM ingest_keys WHERE definition_id = ? AND status = 'active'"),
        keysOf: db.prepare('SELECT id, hint, status, created_by, created_at, grace_until, revoked_at, revoked_reason, last_used_at FROM ingest_keys WHERE definition_id = ? ORDER BY created_at DESC LIMIT 50'),
        keyByHash: db.prepare('SELECT * FROM ingest_keys WHERE key_hash = ?'),
        touchKey: db.prepare('UPDATE ingest_keys SET last_used_at = ? WHERE id = ?'),
        revokeKey: db.prepare("UPDATE ingest_keys SET status = 'revoked', revoked_at = ?, revoked_reason = ?, grace_until = NULL WHERE id = ? AND status != 'revoked'"),
        graceKey: db.prepare("UPDATE ingest_keys SET status = 'grace', grace_until = ? WHERE id = ? AND status = 'active'"),
        expiredGrace: db.prepare("SELECT id FROM ingest_keys WHERE status = 'grace' AND grace_until <= ?"),
    };

    function row(id) {
        const d = q.get.get(id);
        if (!d) return null;
        return {
            ...d,
            protocols: parseJson(d.protocols, ['rtmp']),
            mirror_to_live: Boolean(d.mirror_to_live),
            external_refs: q.refs.all(id),
        };
    }

    function get(id) {
        return isId('stream', id) ? row(id) : null;
    }

    function list({ owner_subject, state, limit = 100 } = {}) {
        const where = [];
        const args = [];
        if (owner_subject) { where.push('owner_subject = ?'); args.push(owner_subject); }
        if (state) { where.push('state = ?'); args.push(state); } else where.push("state != 'archived'");
        const rows = db.prepare(`SELECT id FROM stream_definitions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY created_at DESC LIMIT ?`).all(...args, Math.min(Math.max(limit, 1), 500));
        return rows.map(r => row(r.id));
    }

    function findByRef(service, type, refId) {
        const r = q.byRef.get(String(service), String(type), String(refId));
        return r ? row(r.definition_id) : null;
    }

    function normalize(input, base = {}) {
        const out = {};
        if (input.title !== undefined || base.title === undefined) out.title = cleanText(input.title, 140, '') || base.title || 'Untitled stream';
        if (input.description !== undefined) out.description = cleanText(input.description, 2000, '');
        if (input.protocols !== undefined) {
            const p = Array.isArray(input.protocols) ? [...new Set(input.protocols.map(String))] : null;
            if (!p || !p.length || p.some(x => !PROTOCOLS.includes(x))) throw new StoreError(400, 'openre.invalid_protocols', `protocols must be a non-empty subset of ${PROTOCOLS.join(', ')}`);
            out.protocols = JSON.stringify(p);
        }
        for (const [k, allowed] of [['recording_mode', RECORDING_MODES], ['recording_visibility', VISIBILITIES], ['playback_visibility', VISIBILITIES]]) {
            if (input[k] !== undefined) {
                if (!allowed.includes(input[k])) throw new StoreError(400, 'openre.invalid_field', `${k} must be one of ${allowed.join(', ')}`);
                out[k] = input[k];
            }
        }
        if (input.mirror_to_live !== undefined) out.mirror_to_live = input.mirror_to_live ? 1 : 0;
        if (input.state !== undefined) {
            if (!['active', 'disabled'].includes(input.state)) throw new StoreError(400, 'openre.invalid_field', 'state must be active or disabled');
            out.state = input.state;
        }
        return out;
    }

    /** Issue a new active key (inside the caller's transaction). Returns the plain key once. */
    function issueKey(definitionId, createdBy) {
        const plain = newIngestKey();
        const id = newId('key', now());
        q.insertKey.run(id, definitionId, hashIngestKey(plain), hintOf(plain), createdBy || null, now());
        return { id, key: plain, hint: hintOf(plain) };
    }

    /**
     * create({ owner_subject, title, ..., external_refs, created_by }) -> { definition, key: { id, key, hint } }
     * The first ingest key is issued with the definition; its plain value is only in this return.
     */
    function create(input) {
        if (!ids.isSubjectId('user', input.owner_subject)) throw new StoreError(400, 'openre.invalid_owner', 'owner_subject must be a usr_… subject id');
        const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== ''));
        const fields = normalize({ protocols: ['rtmp'], recording_mode: 'vod', recording_visibility: 'public', playback_visibility: 'public', mirror_to_live: false, ...given });
        const refs = validateRefs(input.external_refs);
        const id = newId('stream', now());
        return db.transaction(() => {
            for (const r of refs) {
                if (SHARED_REF_TYPES.has(r.type)) continue;
                const taken = q.byRef.get(r.service, r.type, r.id);
                if (taken && row(taken.definition_id).state !== 'archived') throw new StoreError(409, 'openre.ref_taken', `${r.service}:${r.type}:${r.id} already belongs to another stream definition`);
            }
            q.insert.run({ id, owner_subject: input.owner_subject, description: '', ...fields, now: now() });
            for (const r of refs) q.insertRef.run(id, r.service, r.type, r.id, r.label, now());
            const key = issueKey(id, input.created_by);
            return { definition: row(id), key };
        })();
    }

    function update(id, input) {
        const current = get(id);
        if (!current || current.state === 'archived') throw new StoreError(404, 'openre.stream_not_found', 'no such stream definition');
        const fields = normalize(input, current);
        const keys = Object.keys(fields);
        if (!keys.length) return current;
        db.prepare(`UPDATE stream_definitions SET ${keys.map(k => `${k} = @${k}`).join(', ')}, revision = revision + 1, updated_at = @now WHERE id = @id`)
            .run({ ...fields, id, now: now() });
        return row(id);
    }

    function archive(id) {
        const current = get(id);
        if (!current || current.state === 'archived') throw new StoreError(404, 'openre.stream_not_found', 'no such stream definition');
        const live = db.prepare("SELECT id FROM ingest_sessions WHERE definition_id = ? AND state IN ('starting', 'live', 'ending')").get(id);
        if (live) throw new StoreError(409, 'openre.stream_live', 'end the live session before archiving this stream');
        db.transaction(() => {
            db.prepare("UPDATE stream_definitions SET state = 'archived', revision = revision + 1, updated_at = ? WHERE id = ?").run(now(), id);
            for (const k of q.activeKeys.all(id)) q.revokeKey.run(now(), 'archived', k.id);
            db.prepare("UPDATE ingest_keys SET status = 'revoked', revoked_at = ?, revoked_reason = 'archived' WHERE definition_id = ? AND status = 'grace'").run(now(), id);
        })();
        return row(id);
    }

    /**
     * Rotate: issue a new key and retire every active one. grace_seconds = 0 revokes them now;
     * > 0 lets them keep authenticating NEW publishes until then (they are revoked by the
     * coordinator when the grace ends). Sessions already running are never cut by a rotation
     * unless end_sessions is set (the caller then asks the owning worker to end them).
     */
    function rotateKey(id, { grace_seconds = 0, rotated_by = null, reason = 'rotated' } = {}) {
        const current = get(id);
        if (!current || current.state === 'archived') throw new StoreError(404, 'openre.stream_not_found', 'no such stream definition');
        const grace = Math.max(0, Math.min(Number(grace_seconds) || 0, 7 * 24 * 3600));
        return db.transaction(() => {
            const old = q.activeKeys.all(id);
            const graceUntil = grace ? now() + grace * 1000 : null;
            for (const k of old) {
                if (graceUntil) q.graceKey.run(graceUntil, k.id);
                else q.revokeKey.run(now(), reason, k.id);
            }
            const key = issueKey(id, rotated_by);
            events.enqueue({
                event_type: TYPES.keyRotated,
                actor: rotated_by && /^usr_/.test(rotated_by) ? { type: 'user', id: rotated_by } : { type: 'service', id: rotated_by ? String(rotated_by).replace(/^svc:/, '') : 'openre' },
                subject: { type: 'stream', id, revision: current.revision },
                visibility: 'internal',
                priority: 'important',
                payload: {
                    stream_id: id,
                    owner: { type: 'user', id: current.owner_subject },
                    key_id: key.id,
                    key_hint: key.hint,
                    retired_key_ids: old.map(k => k.id),
                    grace_until: graceUntil ? new Date(graceUntil).toISOString() : null,
                    external_refs: current.external_refs,
                },
            });
            return { key, retired: old.map(k => ({ id: k.id, hint: k.hint, status: graceUntil ? 'grace' : 'revoked' })), grace_until: graceUntil };
        })();
    }

    /** Revoke keys whose grace period is over (coordinator). */
    function expireGraceKeys() {
        const rows = q.expiredGrace.all(now());
        for (const r of rows) q.revokeKey.run(now(), 'grace_ended', r.id);
        return rows.length;
    }

    function keys(id) {
        return q.keysOf.all(id);
    }

    /**
     * The RTMP (or later WHIP) worker's check, synchronous by design: a publish handshake is
     * answered inside node-media-server's prePublish handler. Only OpenRe's own hashed keys count:
     * this never looks at any other service's database.
     */
    function resolveIngestKey(plain, protocol) {
        if (!isIngestKeyShape(plain)) return { error: 'malformed_key' };
        const key = q.keyByHash.get(hashIngestKey(plain));
        if (!key) return { error: 'unknown_key' };
        if (key.status === 'revoked') return { error: 'revoked_key' };
        if (key.status === 'grace' && !(key.grace_until > now())) return { error: 'revoked_key' };
        const definition = row(key.definition_id);
        if (!definition || definition.state !== 'active') return { error: 'stream_disabled' };
        if (!definition.protocols.includes(protocol)) return { error: 'protocol_not_allowed' };
        q.touchKey.run(now(), key.id);
        return { definition, key: { id: key.id, hint: key.hint, status: key.status } };
    }

    /** What an encoder needs: server URL and which key (by hint) is current. Never the key. */
    function ingestEndpoints(definition) {
        const r = config.rtmp;
        const portSuffix = r.publicPort === 1935 ? '' : `:${r.publicPort}`;
        const active = keys(definition.id).find(k => k.status === 'active');
        const out = {};
        if (definition.protocols.includes('rtmp')) {
            out.rtmp = {
                url: `rtmp://${r.publicHost}${portSuffix}/live`,
                key_hint: active ? active.hint : null,
                key_id: active ? active.id : null,
            };
        }
        return out;
    }

    return { get, list, findByRef, create, update, archive, rotateKey, expireGraceKeys, keys, resolveIngestKey, ingestEndpoints, issueKey, row };
}

module.exports = { createDefinitions, StoreError, PROTOCOLS, RECORDING_MODES, VISIBILITIES, cleanText, parseJson, validateRefs };
