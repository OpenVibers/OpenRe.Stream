'use strict';
/**
 * OpenRe's durable store: one PostgreSQL database (ov_openre, ADR-035) shared by every OpenRe process.
 *
 *   openre-api                  definitions, keys, destinations (owner writes)
 *   openre-session-coordinator  worker liveness, drain, output assignment, recordings, event relay
 *   openre-rtmp-ingest          sessions it admits, their leases and transitions
 *   openre-restream-worker      output state, health and logs
 *
 * Several writer processes were the trigger ADR-007 named for leaving SQLite; every statement lives behind
 * server/store/*, and every transaction there is SERIALIZABLE (store/index.js), as SQLite's one writer made them.
 * The schema is migrations/NNNN_*.sql, applied at boot by the owner role. Times are epoch milliseconds.
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle: DATABASE_URL through PgBouncer, after the migrations ran as the owner (DATABASE_DIRECT_URL).
 * Without DATABASE_URL (development, tests), an embedded PGlite database: in OPENRE_PGLITE_DIR or data/pglite, or in
 * memory with { memory: true }. PGlite is one process: run the other OpenRe processes against PostgreSQL.
 */
async function openDb(config, { memory = false, log = console, registry } = {}) {
    const quiet = { ...log, info() {}, log() {} };
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh openre)');
        const dir = memory ? null : (config.db.pgliteDir || DEV_PGLITE);
        if (dir) fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir || true, service: 'openre', registry, log });
        await db.migrate({ dir: MIGRATIONS, log: quiet });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'openre-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log: quiet }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'openre', registry, log });
}

module.exports = { openDb, MIGRATIONS };
