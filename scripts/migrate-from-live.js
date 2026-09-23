#!/usr/bin/env node
'use strict';
/**
 * Import Live's stream slots and restream destinations into OpenRe, from a read-only snapshot of
 * Live's database, and print the per-channel RTMP cutover checklist.
 *
 *   node scripts/migrate-from-live.js --live-db /path/to/live-snapshot.db            # dry run
 *   node scripts/migrate-from-live.js --live-db /path/to/live-snapshot.db --apply    # write
 *   ... [--slots 12,31] [--checklist /path/to/checklist.md]
 *
 * Take the snapshot with `sqlite3 /opt/openvibe.live/data/openvibe.db ".backup /tmp/live-snapshot.db"`
 * (never point this at the live file). Uses the OpenRe environment (.env or OPENRE_ENV_FILE) for
 * its own database and OPENRE_SECRETS_KEY. Prints no secret: old keys are not imported and the new
 * keys are never shown (the broadcaster rotates to get one). Safe to re-run.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : null;
}

function main() {
    require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
    const { load } = require('../server/config');
    const { openRuntime } = require('../server/store');
    const { migrate, checklist } = require('../server/migrate-live');
    const liveDbPath = arg('live-db');
    if (!liveDbPath) { console.error('usage: migrate-from-live.js --live-db <snapshot.db> [--apply] [--slots 1,2] [--checklist out.md]'); process.exit(2); }
    const apply = process.argv.includes('--apply');
    const config = load();
    if (apply && !config.secretsKey) { console.error('OPENRE_SECRETS_KEY is required to import destinations'); process.exit(2); }
    const liveDb = new Database(liveDbPath, { readonly: true, fileMustExist: true });
    const rt = openRuntime({ config, log: { log() {}, warn: console.warn, error: console.error } });
    const onlySlots = arg('slots') ? arg('slots').split(',').map(Number).filter(Number.isFinite) : null;
    const report = migrate({ liveDb, rt, apply, onlySlots });
    const r = config.rtmp;
    const md = checklist(report, { openreUrl: config.baseUrl, rtmpUrl: `rtmp://${r.publicHost}${r.publicPort === 1935 ? '' : `:${r.publicPort}`}/live` });
    const out = arg('checklist');
    if (out) { fs.writeFileSync(out, md + '\n'); console.log(`checklist written to ${out}`); } else console.log(md);
    console.error(`[migrate] ${apply ? 'applied' : 'dry run'}: ${JSON.stringify(report.counts)}`);
    liveDb.close();
    rt.db.close();
}

if (require.main === module) main();
