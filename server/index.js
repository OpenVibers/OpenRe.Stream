'use strict';
/**
 * openre-api entry point (unit openre-api.service, port 4500).
 *
 * The API owns no transport: it reads and writes the store (definitions, keys, destinations,
 * end requests) and serves the UI. Restarting or redeploying it never touches a worker process,
 * a session or an ffmpeg output; see test/api-restart.test.js.
 *
 * start() is what the tests use too: it takes a config plus injectable clock/fetch/log (and a database handle).
 */
const path = require('path');
const { gracefulStop } = require('openvibe-sdk/service');
const { load } = require('./config');
const { openRuntime } = require('./store');
const { createNetworkKeys } = require('openvibe-sdk/auth');
const { createAuth } = require('./auth');
const { createApp } = require('./app');

async function start({ config, clock, fetchImpl = globalThis.fetch, log = console, listen = true, db } = {}) {
    config = config || load();
    const rt = await openRuntime({ config, clock, fetchImpl, log, db });
    const keys = createNetworkKeys({ network: config.networkInternalUrl, publicKey: config.networkPublicKey, fetch: fetchImpl, log });
    const auth = createAuth({ config, keys });
    const app = createApp({ rt, auth, keys, log, fetchImpl });
    const keyLoaded = keys.start().catch(() => null);

    let server = null;
    if (listen) {
        server = await new Promise((resolve, reject) => {
            const s = app.listen(config.port, config.host, () => resolve(s));
            s.on('error', reject);
        });
        log.log(`[openre-api] listening on http://${config.host}:${server.address().port} (release ${config.release})`);
    }

    async function close() {
        keys.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(() => resolve()));
        }
        if (app.locals.valkey) await app.locals.valkey.close().catch(() => {});
        await rt.db.close();
    }

    return { config, rt, keys, keyLoaded, auth, app, server, close };
}

if (require.main === module) {
    require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
    start().then((h) => {
        // SIGTERM/SIGINT (openvibe-sdk/service, docs/service.md's OpenRestream entry): the keys poller stops, requests
        // in flight get 8 s, then Valkey and the database close in that order. A database close failure exits 1;
        // past the 10 s deadline the process also exits 1. Workers are separate processes and keep running.
        gracefulStop({
            name: 'openre-api',
            server: h.server,
            stop: [() => h.keys.stop()],
            close: [() => h.app.locals.valkey && h.app.locals.valkey.close()],
            handles: [() => h.rt.db.close()],
            drainMs: 8000,
            deadlineMs: 10000,
        });
    }).catch((err) => {
        console.error(`[openre-api] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };
