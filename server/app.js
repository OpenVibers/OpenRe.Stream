'use strict';
/** openre-api Express app: request context, health/readiness, API v1, playback proxy, SSO, UI. */
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const contracts = require('openvibe-contracts');
const { createV1Router } = require('./api/v1');
const { createSsoRoutes } = require('./auth/sso');
const { createUiRouter } = require('./ui/routes');
const pkg = require('../package.json');

const SESSION_FLV_RE = /^(ses_[0-9A-HJKMNP-TV-Z]{26})\.flv$/;

function createApp({ rt, auth, keys, log = console, fetchImpl }) {
    const { config, store, events, db } = rt;
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // GET /metrics (loopback only, Track O): request rates and latencies, process metrics and live
    // sessions by state, from openvibe-shared/metrics (mounted before every route).
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'openre' });
    metrics.registry.gauge({ name: 'openre_sessions', help: 'Ingest sessions by state', labelNames: ['state'],
        collect: () => db.prepare("SELECT state, count(*) AS n FROM ingest_sessions WHERE state IN ('starting','live') GROUP BY state").all().map((r) => ({ labels: { state: r.state }, value: r.n })) });
    app.use(contracts.http.middleware());
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        next();
    });
    app.use(cookieParser());

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

    // Ready = the database answers and the Network key is loaded. Worker and coordinator state is
    // reported, not required: the API serves reads while a worker generation rolls over.
    app.get('/api/ready', (_req, res) => {
        let dbOk = false;
        try { dbOk = db.prepare('SELECT 1 AS ok').get().ok === 1; } catch { dbOk = false; }
        const checks = { db: dbOk, key: keys.loaded() };
        const ready = Object.values(checks).every(Boolean);
        let workers = [];
        let coordinator = null;
        try {
            workers = store.workers.alive().map(w => ({ kind: w.kind, generation: w.generation, state: w.state, heartbeat_age_ms: Date.now() - w.heartbeat_at }));
            const l = db.prepare("SELECT holder, expires_at FROM leases WHERE name = 'coordinator'").get();
            coordinator = l ? { holder: l.holder, lease_valid: l.expires_at > Date.now() } : null;
        } catch { /* reported as empty */ }
        res.status(ready ? 200 : 503).json({
            status: ready ? 'ready' : 'not_ready',
            ...(config.drill ? { mode: 'drill' } : {}),
            checks,
            store: { engine: 'sqlite', path_configured: Boolean(config.dbPath) },
            workers,
            coordinator,
            events: dbOk ? events.status() : null,
        });
    });

    const apiJson = express.json({ limit: '256kb', type: ['application/json', 'application/*+json'] });
    const v1 = createV1Router({ rt, auth });
    app.use('/api/v1', apiJson, auth.middleware({ services: true }), v1.router);

    // Public HTTP-FLV playback of a live session, proxied from the worker that holds it. A viewer
    // deploy of this API interrupts viewers of this URL (they reconnect), never the ingest.
    app.get('/play/:file', (req, res) => {
        const m = SESSION_FLV_RE.exec(req.params.file);
        const s = m ? store.sessions.get(m[1]) : null;
        const d = s ? store.definitions.row(s.definition_id) : null;
        if (!s || !d || s.state !== 'live' || d.playback_visibility === 'private') return res.status(404).end();
        const pb = store.sessions.playback(s);
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
    app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nAllow: /$\nDisallow: /streams\nDisallow: /sessions\nDisallow: /destinations\nDisallow: /api/\nDisallow: /play/\n'));
    app.use('/', createUiRouter({ rt, auth }));

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
