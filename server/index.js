'use strict';
/**
 * openre-api entry point (unit openre-api.service, port 4500).
 *
 * The API owns no transport: it reads and writes the store (definitions, keys, destinations,
 * end requests) and serves the UI. Restarting or redeploying it never touches a worker process,
 * a session or an ffmpeg output; see test/api-restart.test.js.
 *
 * start() is what the tests use too: it takes a config plus injectable clock/fetch/log.
 */
const path = require('path');
const { load } = require('./config');
const { openRuntime } = require('./store');
const { createKeyStore, createAuth } = require('./auth');
const { createApp } = require('./app');

async function start({ config, clock, fetchImpl = globalThis.fetch, log = console, listen = true } = {}) {
    config = config || load();
    const rt = openRuntime({ config, clock, fetchImpl, log });
    const keys = createKeyStore({ urls: [config.networkInternalUrl, config.networkUrl], pem: config.networkPublicKey, fetchImpl, log });
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
        rt.db.close();
    }

    return { config, rt, keys, keyLoaded, auth, app, server, close };
}

if (require.main === module) {
    require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
    start().then((h) => {
        const shutdown = (sig) => {
            console.log(`[openre-api] ${sig}: shutting down (workers are separate processes and keep running)`);
            h.close().then(() => process.exit(0), () => process.exit(1));
            setTimeout(() => process.exit(1), 10000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }).catch((err) => {
        console.error(`[openre-api] failed to start: ${err.stack || err}`);
        process.exit(1);
    });
}

module.exports = { start };
