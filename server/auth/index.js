'use strict';
/**
 * Who is calling openre-api, resolved once per request into req.caller:
 *
 *   { kind: 'service', sub: 'svc:live', claims, subject: 'usr_…'|null }
 *       An OpenVibe.Network client-credentials token (RS256, audience openvibe.openre), verified
 *       offline. Each route checks ONE capability (guard('openre.<noun>.<verb>')). A service may
 *       name the person it acts for in X-OV-Subject; it is then limited to that owner's streams.
 *       Without it the grant applies to every stream (first-party integrations such as Live's
 *       mirror read sessions for any channel that opted in).
 *   { kind: 'user', subject: 'usr_…', staff, claims }
 *       A browser/owner with the Network user JWT (ov_token cookie or Bearer). Owners act on
 *       their own streams; Network role admin is staff (read everything, end sessions).
 *   { kind: 'anonymous' }
 *
 * The capability ids are proposed in docs/capabilities-proposal/ and are not in openvibe-contracts
 * yet. Until the release that defines them, allows() grants them with the contracts rule (exact id
 * or a `family.*` grant) and hands the decision to capabilities.check() once contracts know the id
 * (the same bridge OpenVibe.Events used).
 */
const crypto = require('crypto');
const { serviceAuth, capabilities, http, ids } = require('openvibe-contracts');

const PRINCIPAL_SUB = /^(svc|app|mod):/;
const STAFF_ROLES = new Set(['admin']);

// ── Network public key ─────────────────────────────────────────

function createKeyStore({ urls = [], pem = null, fetchImpl = globalThis.fetch, log = console } = {}) {
    let key = pem ? toPem(pem) : null;
    let retryTimer = null;
    let refreshTimer = null;

    function toPem(value) { return crypto.createPublicKey(value).export({ type: 'spki', format: 'pem' }); }

    async function fetchOnce() {
        for (const base of urls) {
            if (!base) continue;
            const url = `${base}/api/.well-known/jwks`;
            try {
                const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                const jwk = (body.keys || []).find(k => k.kty === 'RSA');
                if (jwk) key = toPem({ key: jwk, format: 'jwk' });
                else if (typeof body.public_key === 'string' && body.public_key.includes('BEGIN')) key = toPem(body.public_key);
                else throw new Error('no RSA key in response');
                log.log(`[auth] Network public key loaded from ${base}`);
                return key;
            } catch (err) {
                log.warn(`[auth] key fetch from ${url} failed: ${err.message}`);
            }
        }
        return null;
    }

    function start() {
        if (pem) return Promise.resolve(key);
        const attempt = async () => {
            const k = await fetchOnce();
            if (!k && !key) { retryTimer = setTimeout(attempt, 30000); retryTimer.unref?.(); }
            return k;
        };
        refreshTimer = setInterval(() => { fetchOnce().catch(() => {}); }, 6 * 60 * 60 * 1000);
        refreshTimer.unref?.();
        return attempt();
    }

    return { get: () => key, loaded: () => Boolean(key), start, stop() { clearTimeout(retryTimer); clearInterval(refreshTimer); }, fetchOnce };
}

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

function verifyUserJwt(token, { publicKey, issuer, audiences, now = Date.now() }) {
    if (!publicKey || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const header = b64json(parts[0]);
        if (header.alg !== 'RS256') return null;
        if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) return null;
        const claims = b64json(parts[1]);
        const t = Math.floor(now / 1000);
        if (typeof claims.exp !== 'number' || claims.exp + 30 < t) return null;
        if (issuer && claims.iss !== issuer) return null;
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!aud.some(a => audiences.includes(a))) return null;
        if (claims.actor_type || PRINCIPAL_SUB.test(String(claims.sub))) return null;
        return claims;
    } catch {
        return null;
    }
}

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
    function verifyService(token) {
        const publicKey = keys.get();
        if (!publicKey) return { ok: false, code: 'token.unavailable', reason: 'signing key not loaded yet' };
        return serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.issuer, audience: config.audience });
    }

    function verifyUser(token) {
        return verifyUserJwt(token, { publicKey: keys.get(), issuer: config.issuer, audiences: config.userAudiences });
    }

    function userCaller(claims, token) {
        const subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
        return { kind: 'user', subject, staff: STAFF_ROLES.has(claims.role), claims, token, name: claims.display_name || claims.username || null };
    }

    /**
     * resolve(req, { services }) — services: false for server-rendered pages (a service token is
     * no identity there). A presented service token must verify: it is never downgraded.
     */
    function resolve(req, { services = true } = {}) {
        const token = bearer(req);
        if (token) {
            const payload = decodePayload(token);
            if (payload && PRINCIPAL_SUB.test(String(payload.sub))) {
                if (!services) return { kind: 'anonymous' };
                const r = verifyService(token);
                if (!r.ok) throw new AuthError(r.code === 'token.unavailable' ? 503 : 401, r.code, r.reason);
                const subjectHeader = req.get('x-ov-subject');
                let subject = null;
                if (subjectHeader) {
                    if (!ids.isSubjectId('user', subjectHeader)) throw new AuthError(400, 'subject.invalid', 'X-OV-Subject must be a usr_… subject id');
                    subject = subjectHeader;
                }
                return { kind: 'service', sub: r.claims.sub, claims: r.claims, subject };
            }
            const claims = verifyUser(token);
            if (claims) return userCaller(claims, token);
            if (!keys.loaded()) throw new AuthError(503, 'token.unavailable', 'signing key not loaded yet');
            throw new AuthError(401, 'token.invalid', 'token does not verify');
        }
        const fromCookie = cookie(req, 'ov_token');
        const claims = fromCookie ? verifyUser(fromCookie) : null;
        if (claims) return userCaller(claims, fromCookie);
        return { kind: 'anonymous' };
    }

    function middleware(opts) {
        return (req, res, next) => {
            try {
                req.caller = resolve(req, opts);
                next();
            } catch (err) {
                if (!(err instanceof AuthError)) return next(err);
                http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            }
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

module.exports = { createKeyStore, createAuth, allows, hasCap, verifyUserJwt, bearer, cookie, AuthError };
