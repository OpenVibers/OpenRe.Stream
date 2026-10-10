#!/usr/bin/env node
'use strict';
/**
 * Import Live's stream slots and restream destinations from Live's PostgreSQL database
 * in a read-only transaction, and print the per-channel RTMP cutover checklist.
 *
 *   node scripts/migrate-from-live.js                                                # dry run; env:/etc/openvibe/live.env
 *   node scripts/migrate-from-live.js --live-db env:/etc/openvibe/live.env --apply   # import
 *   node scripts/migrate-from-live.js --live-db postgres://user:pass@host/ov_live    # explicit URL
 *   ... [--slots 12,31] [--checklist /path/to/checklist.md]
 *
 * The Live env file is parsed only for DATABASE_URL and is never loaded into process.env. Uses the OpenRestream environment
 * (.env or OPENRE_ENV_FILE) for its own database and OPENRE_SECRETS_KEY; in production set
 * OPENRE_ENV_FILE=/etc/openvibe/openre.env and NODE_ENV=production (a unit sets NODE_ENV itself)
 * — docs/cutover.md has the command. Prints no secret: old keys are not imported and the new
 * keys are never shown (the broadcaster rotates to get one). Safe to re-run.
 */
const fs = require('fs');
const path = require('path');
const { liveDbUrl, openLiveDb } = require('./lib/live-db');
const USAGE = 'usage: migrate-from-live.js [--live-db env:/etc/openvibe/live.env|postgres://...] [--apply] [--slots 1,2] [--checklist out.md]';

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : null;
}

async function main({ config: suppliedConfig, openLive = openLiveDb, openRestream } = {}) {
    if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(USAGE); return; }
    if (!suppliedConfig) require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
    const { load } = require('../server/config');
    const { openRuntime } = require('../server/store');
    const { migrate, checklist } = require('../server/migrate-live');
    const liveTarget = arg('live-db') || 'env:/etc/openvibe/live.env';
    const apply = process.argv.includes('--apply');
    const config = suppliedConfig || load();
    if (apply && !config.secretsKey) { console.error('OPENRE_SECRETS_KEY is required to import destinations'); process.exit(2); }
    const liveDb = openLive(liveDbUrl(liveTarget, (file) => fs.readFileSync(file, 'utf8')), 'openre-migration');
    let rt;
    try {
        rt = await (openRestream || openRuntime)({ config, log: { log() {}, warn: console.warn, error: console.error } });
        const onlySlots = arg('slots') ? arg('slots').split(',').map(Number).filter(Number.isFinite) : null;
        const report = await liveDb.tx(async () => {
            await liveDb.exec('SET TRANSACTION READ ONLY');
            return migrate({ liveDb, rt, apply, onlySlots });
        });
        const r = config.rtmp;
        const md = checklist(report, { openreUrl: config.baseUrl, rtmpUrl: `rtmp://${r.publicHost}${r.publicPort === 1935 ? '' : `:${r.publicPort}`}/live` });
        const out = arg('checklist');
        if (out) { fs.writeFileSync(out, md + '\n'); console.log(`checklist written to ${out}`); } else console.log(md);
        console.error(`[migrate] ${apply ? 'applied' : 'dry run'}: ${JSON.stringify(report.counts)}`);
    } finally {
        await liveDb.close();
        if (rt) await rt.db.close();
    }
}

if (require.main === module) main();

module.exports = { main };
