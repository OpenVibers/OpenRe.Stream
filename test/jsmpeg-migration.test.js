'use strict';
// The 0002 naming migration, run for real: a fresh database is built from migrations/0001_initial.sql,
// legacy rows ('whip' protocols, 'webrtc-ingest'/'sfu' workers) are inserted, the 0002 SQL is applied,
// and the stored rows are asserted rewritten (protocols deduplicated, worker kinds merged and
// renumbered so UNIQUE (kind, generation) holds).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { suite, ROOT } = require('./helpers');

const MIG1 = path.join(ROOT, 'migrations', '0001_initial.sql');
const MIG2 = path.join(ROOT, 'migrations', '0002_protocol_names.sql');

const t = suite('jsmpeg-migration');
const log = { log() {}, warn() {}, error: console.error };

t('stored whip protocols become webrtc (deduplicated); webrtc-ingest/sfu worker rows become webrtc', async () => {
    const db = createDb({ pglite: true, service: 'jsmpeg-migration', log });
    try {
        await db.exec(fs.readFileSync(MIG1, 'utf8'));
        await db.exec(`INSERT INTO stream_definitions (id, owner_subject, protocols, created_at, updated_at) VALUES
            ('stream_a', 'usr_01J0000000000000000000000A', '["whip","webrtc","rtmp"]', 1, 1),
            ('stream_b', 'usr_01J0000000000000000000000A', '["whip","whip"]', 1, 1),
            ('stream_c', 'usr_01J0000000000000000000000A', '["rtmp","jsmpeg"]', 1, 1)`);
        await db.exec(`INSERT INTO workers (id, kind, generation, state, started_at, heartbeat_at) VALUES
            ('w_wi1','webrtc-ingest',1,'stopped',1,1),
            ('w_wi2','webrtc-ingest',2,'stopped',2,2),
            ('w_sfu','sfu',1,'stopped',3,3)`);
        await db.exec(fs.readFileSync(MIG2, 'utf8'));

        const defs = Object.fromEntries((await db.prepare('SELECT id, protocols FROM stream_definitions').all()).map(r => [r.id, r.protocols]));
        assert.deepStrictEqual(JSON.parse(defs.stream_a), ['webrtc', 'rtmp']);
        assert.deepStrictEqual(JSON.parse(defs.stream_b), ['webrtc']);
        assert.deepStrictEqual(JSON.parse(defs.stream_c), ['rtmp', 'jsmpeg'], 'a row without whip is untouched');
        const workers = await db.prepare('SELECT kind, generation FROM workers ORDER BY generation').all();
        assert.ok(workers.every(w => w.kind === 'webrtc'), 'every legacy kind is webrtc');
        assert.deepStrictEqual(workers.map(w => w.generation).sort((a, b) => a - b), [1, 2, 3], 'generations stay unique');
    } finally {
        await db.close();
    }
});

t.run();
