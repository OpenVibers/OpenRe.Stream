'use strict';
/** OpenRestream's authority index for OpenVibe.Services (ADR-048). Stream definitions are person-owned.
 * GET /api/v1/resources accepts project, kind, owner, cursor, and limit query parameters. */
const express = require('express');
const contracts = require('openvibe-contracts');

const SERVICE = 'openre';
const KIND = 'openre.stream';
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const USER_SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const OWNER_SUBJECT_RE = /^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** The public resource shape for a definition; no private definition fields leave this index. */
function streamSummary(row) {
    const summary = {
        id: row.id, kind: KIND, service: SERVICE,
        name: row.title, state: row.state,
        created_at: new Date(Number(row.created_at)).toISOString(),
        updated_at: new Date(Number(row.updated_at)).toISOString(),
    };
    if (USER_SUBJECT_RE.test(String(row.owner_subject || ''))) summary.owner = { type: 'user', id: row.owner_subject };
    const ovrn = contracts.resources.nameOf(summary);
    if (ovrn) summary.ovrn = ovrn;
    return summary;
}

/** An opaque keyset position, encoded like Host's [kind, id] cursor. */
const encodeCursor = (row) => Buffer.from(JSON.stringify([KIND, row.id])).toString('base64url');
function decodeCursor(raw) {
    let value;
    try { value = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(value) && value.length === 2 && value[0] === KIND &&
        typeof value[1] === 'string' && value[1] !== '' ? value[1] : null;
}

function filtersOf(query) {
    const project = query.project === undefined || query.project === '' ? null : query.project;
    if (project !== null && (typeof project !== 'string' || !PROJECT_ID_RE.test(project))) return { error: 'project must be a prj_ id' };
    const owner = query.owner === undefined || query.owner === '' ? null : query.owner;
    if (owner !== null && (typeof owner !== 'string' || !OWNER_SUBJECT_RE.test(owner))) return { error: 'owner must be a usr_ or agt_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    let limit = DEFAULT_LIMIT;
    if (typeof query.limit === 'string' && query.limit !== '') {
        if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        limit = Number(query.limit);
    }
    let cursor = null;
    if (typeof query.cursor === 'string' && query.cursor !== '') {
        cursor = decodeCursor(query.cursor);
        if (!cursor) return { error: 'cursor is not one this index issued' };
    }
    return { project, owner, kind, limit, cursor };
}

function router({ db, guard }) {
    const r = express.Router();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const handle = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

    // The shared guard allows owners on ordinary API routes; this first-party index requires a service.
    r.use((req, res, next) => {
        const caller = req.caller || { kind: 'anonymous' };
        if (caller.kind === 'service') return next();
        if (caller.kind === 'anonymous') return problem(req, res, 401, 'token.missing', 'sign in, or call with a service token');
        return problem(req, res, 403, 'capability.denied', 'openre.resource.read is first-party and requires a service token');
    });

    r.get('/', guard, handle(async (req, res) => {
        const f = filtersOf(req.query);
        if (f.error) return problem(req, res, 400, 'resources.bad_query', f.error);
        if (f.project || (f.kind && f.kind !== KIND)) return res.set('Cache-Control', 'private, max-age=60').json({ resources: [], next_cursor: null });
        const ownerClause = f.owner ? ' AND owner_subject = ?' : '';
        const rows = await db.prepare(`SELECT id, owner_subject, title, state, created_at, updated_at FROM stream_definitions WHERE state != 'archived' AND id > ?${ownerClause} ORDER BY id LIMIT ?`).all(f.cursor || '', ...(f.owner ? [f.owner] : []), f.limit + 1);
        const resources = rows.slice(0, f.limit).map(streamSummary);
        const next_cursor = rows.length > f.limit ? encodeCursor(rows[f.limit - 1]) : null;
        return res.set('Cache-Control', 'private, max-age=60').json({ resources, next_cursor });
    }));
    r.get('/:ovrn', guard, (req, res) => problem(req, res, 404, 'resources.unknown_resource', `no resource named ${req.params.ovrn}`));
    return r;
}

module.exports = { router, streamSummary, filtersOf, encodeCursor, SERVICE, KIND, DEFAULT_LIMIT, MAX_LIMIT };
