/**
 * Per-actor limits on the ingest API's writes (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * A signed-in person (req.caller.kind === 'user') is counted by subject. Service callers are not: Live manages every
 * streamer's ingest with its service token, so counting svc:live as one caller would refuse the whole site; their
 * capability grant is their limit. Reads are not counted. Every write takes OPENRE_LIMITS_MINUTE / OPENRE_LIMITS_HOUR
 * (120 and 3000); key rotations, destination tests (an outbound connection to a third party) and new streams have
 * tighter numbers on top. Past a limit: 429 problem+json `rate_limited` with Retry-After, before the route runs,
 * logged and counted in openre_rate_limited_total{limit,window}. Counters live in this process.
 */
'use strict';

const { createActorLimiter } = require('openvibe-sdk/limits');

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };

/** [name, method regex, path regex (relative to /api/v1), { minute, hour }]; the first match wins. */
const ROUTES = [
    // A rotation invalidates the key every encoder uses.
    ['openre.key.rotate', /^POST$/, /^\/streams\/[^/]+\/keys\/rotate$/, { minute: 5, hour: 20 }],
    // A test opens a connection to someone else's server.
    ['openre.destination.test', /^POST$/, /^\/destinations\/[^/]+\/test$/, { minute: 10, hour: 100 }],
    ['openre.stream.create', /^POST$/, /^\/streams\/?$/, { minute: 10, hour: 100 }],
];

function createOpenReActorLimits({ env = process.env, registry = null, now } = {}) {
    const refused = registry && typeof registry.counter === 'function'
        ? registry.counter({ name: 'openre_rate_limited_total', help: 'API writes refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limits = createActorLimiter({
        limits: { minute: num(env.OPENRE_LIMITS_MINUTE, 120), hour: num(env.OPENRE_LIMITS_HOUR, 3000) },
        actor: (req) => (req.caller && req.caller.kind === 'user' && req.caller.subject ? `user:${req.caller.subject}` : null),
        ...(now ? { now } : {}),
        onLimited(e) {
            console.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    const write = limits('openre.api.write');
    const named = ROUTES.map(([name, method, pathRe, own]) => ({ method, pathRe, mw: limits(name, own) }));
    const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    return function openreActorLimits(req, res, next) {
        if (!WRITE.has(req.method)) return next();
        const own = named.find((r) => r.method.test(req.method) && r.pathRe.test(req.path));
        return write(req, res, (err) => (err ? next(err) : own ? own.mw(req, res, next) : next()));
    };
}

module.exports = { createOpenReActorLimits, ROUTES };
