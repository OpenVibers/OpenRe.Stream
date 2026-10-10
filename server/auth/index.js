'use strict';
/**
 * Who is calling openre-api, resolved once per request into req.caller:
 *
 *   { kind: 'service', sub: 'svc:live', claims, subject: 'usr_…'|null }
 *       An OpenVibe.Network client-credentials token (RS256, audience openvibe.openre), verified
 *       offline (openvibe-sdk/auth verifyServiceToken with the pinned openvibe-contracts rules and the
 *       key the token's kid names). Each route checks ONE capability (guard('openre.<noun>.<verb>')). A service may
 *       name the person it acts for in X-OV-Subject; it is then limited to that owner's streams.
 *       Without it the grant applies to every stream (first-party integrations such as Live's
 *       mirror read sessions for any channel that opted in).
 *   { kind: 'user', subject: 'usr_…', staff, claims }
 *       A browser/owner with the Network user JWT (ov_token cookie or Bearer; openvibe-sdk/auth
 *       verifyUserToken, which refuses service principals and typed tokens such as a realtime ticket
 *       or a FedCM assertion). Owners act on their own streams; Network role admin is staff (read
 *       everything, end sessions).
 *   { kind: 'anonymous' }
 *
 * The capability ids are proposed in docs/capabilities-proposal/ and are not in openvibe-contracts
 * yet. Until the release that defines them, allows() grants them with the contracts rule (exact id
 * or a `family.*` grant) and hands the decision to capabilities.check() once contracts know the id
 * (the same bridge OpenVibe.Events used).
 *
 * The keys are openvibe-sdk/auth createNetworkKeys (server/index.js): a pinned OV_NETWORK_PUBLIC_KEY, or Network's
 * JWKS with a rotation honoured on an unknown kid and the last good keys kept through an outage.
 */
const contracts = require('openvibe-contracts');
const sdkAuth = require('openvibe-sdk/auth');

const { capabilities, http, ids } = contracts;

const PRINCIPAL_SUB = /^(svc|app|mod):/;
const STAFF_ROLES = new Set(['admin']);

// ── Capabilities ───────────────────────────────────────────────

function hasCap(claims, id) {
    const granted = claims && Array.isArray(claims.cap) ? claims.cap : [];
    return granted.some(g => g === id || (g.endsWith('.*') && id.startsWith(g.slice(0, -1))));
}

function allows(claims, id) {
    if (!hasCap(claims, id)) return { allowed: false, code: 'capability.denied', reason: `${id} not granted` };
    const c = capabilities.check(claims, id);
    if (c.code === 'capability.unknown' && !capabilities.get(id)) return { allowed: true, code: null, reason: null };
    return c;
}

// ── Tokens ─────────────────────────────────────────────────────

const b64json = (s) => JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));

function bearer(req) {
    const h = String(req.headers.authorization || '');
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function cookie(req, name) {
    if (req.cookies && req.cookies[name]) return req.cookies[name];
    const raw = String(req.headers.cookie || '');
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
        }
    }
    return null;
}

function decodePayload(token) {
    try { return b64json(String(token).split('.')[1]); } catch { return null; }
}

class AuthError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

function createAuth({ config, keys }) {
    /** → { ok: true, claims } | { ok: false, code, reason }; token.unavailable while no key has loaded. */
    async function verifyService(token) {
        return await sdkAuth.verifyServiceToken(token, { ...keys.verifyOptions, issuer: config.issuer, audience: config.audience, contracts });
    }

    /** A person's session token → its claims, or null. */
    async function verifyUser(token) {
        try {
            return await sdkAuth.verifyUserToken(token, { ...keys.verifyOptions, issuer: config.issuer, audience: config.userAudiences });
        } catch {
            return null;
        }
    }

    function userCaller(claims, token) {
        const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
        return { kind: 'user', subject, staff: STAFF_ROLES.has(claims.role), claims, token, name: claims.display_name || claims.username || null };
    }

    /**
     * resolve(req, { services }) — services: false for server-rendered pages (a service token is
     * no identity there). A presented service token must verify: it is never downgraded.
     */
    async function resolve(req, { services = true } = {}) {
        const token = bearer(req);
        if (token) {
            const payload = decodePayload(token);
            if (payload && PRINCIPAL_SUB.test(String(payload.sub))) {
                if (!services) return { kind: 'anonymous' };
                const r = await verifyService(token);
                if (!r.ok) throw new AuthError(r.code === 'token.unavailable' ? 503 : 401, r.code, r.reason);
                const subjectHeader = req.get('x-ov-subject');
                let subject = null;
                if (subjectHeader) {
                    if (!ids.isSubjectId('user', subjectHeader)) throw new AuthError(400, 'subject.invalid', 'X-OV-Subject must be a usr_… subject id');
                    subject = subjectHeader;
                }
                return { kind: 'service', sub: r.claims.sub, claims: r.claims, subject };
            }
            const claims = await verifyUser(token);
            if (claims) return userCaller(claims, token);
            if (!keys.loaded()) throw new AuthError(503, 'token.unavailable', 'signing key not loaded yet');
            throw new AuthError(401, 'token.invalid', 'token does not verify');
        }
        const fromCookie = cookie(req, 'ov_token');
        const claims = fromCookie ? await verifyUser(fromCookie) : null;
        if (claims) return userCaller(claims, fromCookie);
        return { kind: 'anonymous' };
    }

    function middleware(opts) {
        return (req, res, next) => {
            resolve(req, opts).then((caller) => {
                req.caller = caller;
                next();
            }, (err) => {
                if (!(err instanceof AuthError)) return next(err);
                http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            });
        };
    }

    /**
     * API guard: a service needs the capability; a signed-in owner may act on their own streams
     * (the route checks ownership with canAccess). Anonymous callers are refused.
     */
    function guard(capabilityId) {
        return function capGuard(req, res, next) {
            const c = req.caller || { kind: 'anonymous' };
            if (c.kind === 'service') {
                const r = allows(c.claims, capabilityId);
                if (!r.allowed) return http.sendProblem(res, 403, r.code, { detail: r.reason, ctx: req.ov });
                req.capability = capabilityId;
                return next();
            }
            if (c.kind === 'user') {
                if (!c.subject) return http.sendProblem(res, 403, 'subject.missing', { detail: 'this account has no canonical subject yet; sign in again', ctx: req.ov });
                req.capability = capabilityId;
                return next();
            }
            return http.sendProblem(res, 401, 'token.missing', { detail: 'sign in, or call with a service token', ctx: req.ov });
        };
    }

    /** May this caller act on a stream owned by ownerSubject? */
    function canAccess(caller, ownerSubject, { staffAllowed = true } = {}) {
        if (!caller) return false;
        if (caller.kind === 'service') return !caller.subject || caller.subject === ownerSubject;
        if (caller.kind === 'user') return caller.subject === ownerSubject || (staffAllowed && caller.staff);
        return false;
    }

    /** The subject recorded as the actor of a change. */
    function actorOf(caller) {
        if (!caller) return null;
        if (caller.kind === 'user') return caller.subject;
        if (caller.kind === 'service') return caller.subject || caller.sub;
        return null;
    }

    return { resolve, middleware, guard, canAccess, actorOf, verifyService, verifyUser };
}

module.exports = { createAuth, allows, hasCap, bearer, cookie, AuthError };
