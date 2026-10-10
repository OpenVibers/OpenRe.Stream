'use strict';
/** openre-api Express app: request context, health/readiness, API v1, playback proxy, SSO, UI. */
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const contracts = require('openvibe-contracts');
const { createDiscoveryRoutes } = require('./discovery');
const { createV1Router } = require('./api/v1');
const resourceIndex = require('./registry/resource-index');
const { createSsoRoutes } = require('./auth/sso');
const { createUiRouter } = require('./ui/routes');
const pkg = require('../package.json');

const SESSION_FLV_RE = /^(ses_[0-9A-HJKMNP-TV-Z]{26})\.flv$/;
const PROTOCOL_WORKERS = Object.freeze({ rtmp: 'rtmp-ingest', jsmpeg: 'jsmpeg', webrtc: 'webrtc' });

function createApp({ rt, auth, keys, log = console, fetchImpl }) {
    const { config, store, events, db } = rt;
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // GET /metrics (loopback only, Track O): request rates and latencies, process metrics and live
    // sessions by state, from openvibe-shared/metrics (mounted before every route).
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'openre' });
    metrics.registry.gauge({ name: 'openre_sessions', help: 'Ingest sessions by state', labelNames: ['state'],
        collect: async () => (await db.prepare("SELECT state, count(*) AS n FROM ingest_sessions WHERE state IN ('starting','live') GROUP BY state").all()).map((r) => ({ labels: { state: r.state }, value: r.n })) });
    app.use(contracts.http.middleware());
    // One W3C trace across services (openvibe-shared/trace): calls made while serving a request carry its traceparent.
    require('openvibe-shared/trace').install(app);
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        // No page is meant to be framed: a framed form carries the session and its CSRF token (clickjacking).
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        next();
    });
    app.use(cookieParser());
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());

    // Restore drill (OPENRE_DRILL, ovhost drill): serve reads from the restored copy and nothing
    // else. No writes (they would only change the copy, but a drill must not look like it works),
    // no /play/ (it would pull from production's worker on loopback), no sign-in (it would redeem
    // codes at Network).
    if (config.drill) {
        app.use((req, res, next) => {
            const read = req.method === 'GET' || req.method === 'HEAD';
            if (read && !req.path.startsWith('/play/') && !req.path.startsWith('/auth/')) return next();
            return contracts.http.sendProblem(res, 503, 'openre.drill_read_only', { detail: 'this is a restore-drill instance (OPENRE_DRILL): reads only', ctx: req.ov });
        });
    }

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openre-api', version: pkg.version, release: config.release }));
    // GET /release.json (ADR-016, D43): which release this API runs, its contracts and packages.
    // A release directory (/opt/openre.stream/releases/<sha>) is named by its commit and has no .git of its own.
    const releaseRoot = require('path').join(__dirname, '..');
    const commit = [process.env.RELEASE_COMMIT, config.release, require('path').basename(releaseRoot)].find((v) => /^[0-9a-f]{7,40}$/.test(String(v || '')));
    const release = require('openvibe-shared/release').createRelease({
        service: 'openre', root: releaseRoot, packages: ['openvibe-shared', 'openvibe-sdk', 'openvibe-contracts'],
        env: commit ? { ...process.env, RELEASE_COMMIT: commit } : process.env,
    });
    release.mount(app);

    // Readiness in the openvibe-shared/ready shape (roadmap WS-Q task 7: the registry reads nothing else as green).
    // Required: the database answers and the Network key is loaded. Optional: a ready worker of each kind, a valid
    // coordinator lease and the event relay, so a worker generation rolling over degrades the API, which keeps
    // serving reads, rather than failing it. The worker list, the lease and the outbox stay in the body for
    // scripts/cutover-preflight.js; a restore drill never publishes, so its relay check is skipped, never ok.
    const { createReadiness, skip } = require('openvibe-shared/ready');
    const workerView = async () => (await store.workers.alive()).map(w => ({ kind: w.kind, generation: w.generation, state: w.state, heartbeat_age_ms: Date.now() - w.heartbeat_at }));
    const requiredWorkerKinds = async () => {
        const rows = await db.prepare("SELECT protocols FROM stream_definitions WHERE state != 'archived'").all();
        const kinds = new Set();
        // Before a stream is created, retain the RTMP readiness baseline.
        if (!rows.length) kinds.add('rtmp-ingest');
        for (const row of rows) {
            for (const protocol of JSON.parse(row.protocols)) kinds.add(PROTOCOL_WORKERS[protocol]);
        }
        kinds.add('restream');
        return [...kinds];
    };
    const leaseView = async () => {
        const l = await db.prepare("SELECT holder, expires_at FROM leases WHERE name = 'coordinator'").get();
        return l ? { holder: l.holder, lease_valid: l.expires_at > Date.now() } : null;
    };
    // Valkey (ADR-035): the per-actor limit counters (optional: without VALKEY_URL they count in this process).
    const valkey = config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix }) : null;
    app.locals.valkey = valkey;
    const readiness = createReadiness({
        service: 'openre',
        release: release.release,
        checks: [
            { name: 'db', required: true, description: 'PostgreSQL answers a query', check: async () => (await db.prepare('SELECT 1 AS ok').get()).ok === 1 },
            { name: 'network_key', required: true, description: 'OpenVibe.Network RS256 key (sign-in and service tokens)', check: () => keys.loaded() || 'Network public key not loaded yet' },
            {
                name: 'workers', required: false, description: 'ready workers for stored stream protocols and restream',
                check: async () => {
                    const alive = await workerView();
                    const missing = (await requiredWorkerKinds()).filter(k => !alive.some(w => w.kind === k && w.state === 'ready'));
                    return missing.length ? `no ready ${missing.join(' or ')} worker` : { ok: true, detail: { ready: alive.filter(w => w.state === 'ready').map(w => `${w.kind}#${w.generation}`) } };
                },
            },
            { name: 'valkey', required: false, description: 'per-actor limit counters', check: async () => (valkey ? await valkey.ready() : skip('VALKEY_URL not set: limits count in this process')) },
            { name: 'coordinator', required: false, description: 'the coordinator holds a valid lease', check: async () => { const l = await leaseView(); return (l && l.lease_valid) || 'no valid coordinator lease'; } },
            {
                name: 'events_relay', required: false, description: 'durable events to OpenVibe.Events',
                check: async () => {
                    const st = await events.status();
                    if (!st.configured) return config.drill ? skip('restore drill: never publishes') : 'relay off (EVENTS_URL or OV_OAUTH_CLIENT_SECRET unset): openre.* events wait in the outbox';
                    return { ok: true, detail: { pending: st.pending, rejected: st.rejected } };
                },
            },
        ],
        details: async (body) => {
            let workers = [];
            let coordinator = null;
            try { workers = await workerView(); coordinator = await leaseView(); } catch { /* reported as empty */ }
            const dbOk = body.checks.db && body.checks.db.status === 'ok';
            return {
                ...(config.drill ? { mode: 'drill' } : {}),
                store: { engine: 'postgresql' },
                workers,
                coordinator,
                events: dbOk ? await events.status() : null,
            };
        },
    });
    app.get('/api/ready', readiness.handler);

    const apiJson = express.json({ limit: '256kb', type: ['application/json', 'application/*+json'] });
    // OpenVibe Live on by default: a person's new stream also shows on their Live channel (server/live-link.js).
    const liveLink = require('./live-link').createLiveLink({ store, config, fetchImpl, log });
    const v1 = createV1Router({ rt, auth, liveLink });
    // Per-actor limits on a signed-in person's writes (server/api/actor-limits.js; roadmap WS-R task 4).
    const actorLimits = require('./api/actor-limits').createOpenReActorLimits({ registry: metrics.registry, valkey });
    app.use('/api/v1', apiJson, auth.middleware({ services: true }), actorLimits);
    app.use('/api/v1/resources', resourceIndex.router({ db, guard: auth.guard('openre.resource.read') }));
    app.use('/api/v1', v1.router);

    // Public HTTP-FLV playback of a live session, proxied from the worker that holds it. A viewer
    // deploy of this API interrupts viewers of this URL (they reconnect), never the ingest.
    app.get('/play/:file', async (req, res) => {
        const m = SESSION_FLV_RE.exec(req.params.file);
        const s = m ? await store.sessions.get(m[1]) : null;
        const d = s ? await store.definitions.row(s.definition_id) : null;
        if (!s || !d || s.state !== 'live' || d.playback_visibility === 'private') return res.status(404).end();
        const pb = await store.sessions.playback(s);
        if (!pb || !pb.flv) return res.status(404).end();
        const upstream = http.get(pb.flv.internal_url, (up) => {
            if (up.statusCode !== 200) { res.status(502).end(); up.resume(); return; }
            res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-cache, no-store', 'Access-Control-Allow-Origin': '*' });
            up.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.end(); });
        req.on('close', () => upstream.destroy());
        return undefined;
    });

    app.use('/auth', createSsoRoutes({ config, auth, fetchImpl }));
    // Crawl and machine-readability artifacts (robots.txt, sitemap.xml, llms.txt): openvibe-shared/seo.
    app.use('/', createDiscoveryRoutes({ config }));
    app.use('/', createUiRouter({ rt, auth, limits: actorLimits, liveLink }));

    app.use((req, res) => contracts.http.sendProblem(res, 404, 'openre.not_found', { detail: `no route ${req.method} ${req.path}`, ctx: req.ov }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        if (err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'openre.bad_json', { detail: 'request body is not valid JSON', ctx: req.ov });
        if (err.type === 'entity.too.large') return contracts.http.sendProblem(res, 413, 'openre.too_large', { detail: 'request body too large', ctx: req.ov });
        log.error(`[app] ${req.method} ${req.path}: ${err.stack || err}`);
        if (res.headersSent) return res.end();
        return contracts.http.sendProblem(res, 500, 'openre.internal', { detail: 'internal error', ctx: req.ov });
    });
    return app;
}

module.exports = { createApp };
