#!/usr/bin/env node
'use strict';
/**
 * The one-time move of OpenRe's SQLite database (OPENRE_DB_PATH) into its PostgreSQL schema (ADR-035; the procedure is
 * openvibe-sdk docs/migrating-to-postgresql.md, section 6, carried out by openvibe-sdk/db runSqliteMigration).
 *
 *   node scripts/migrate-to-postgres.js [--sqlite <file>] [--pglite] [--json]
 *
 * Applies migrations/ as the owner (DATABASE_DIRECT_URL), copies every table into emptied tables, verifies row counts
 * and checksums, and exits 1 unless everything verified. The SQLite file is opened read-only. Every table keeps its
 * name and columns; the SDK outbox's rows move into its PostgreSQL outbox (the same columns). Run with every OpenRe
 * process stopped (OpenVibe.Host roles/data/switch-service.sh with SWITCH_UNITS).
 */
require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || require('path').join(process.cwd(), '.env') });
const { runSqliteMigration } = require('openvibe-sdk/db');
const { load } = require('../server/config');
const { MIGRATIONS } = require('../server/db');

const TABLES = {};

if (require.main === module) {
    const config = load();
    runSqliteMigration({ service: 'openre', sqlite: config.dbPath, directUrl: config.db.directUrl, migrations: MIGRATIONS, tables: TABLES })
        .then((code) => process.exit(code), (err) => { console.error(`migrate-to-postgres failed: ${err.message}`); process.exit(1); });
}

module.exports = { TABLES };
