'use strict';
// Migration from a Live DB snapshot: read-only, new keys (never the old ones), destinations
// sealed, held/excluded rows recorded with reasons, idempotent re-runs, and the checklist.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { runtime, tmpDir, testEnv, suite, ROOT } = require('./helpers');
const { migrate, checklist } = require('../server/migrate-live');
const { hashIngestKey } = require('../server/secrets');

const t = suite('migration');
const SUBJECT_A = 'usr_01J00000000000000000000A01';
const SUBJECT_B = 'usr_01J00000000000000000000B01';

function liveSnapshot(dir) {
    const file = path.join(dir, 'live-snapshot.db');
    const db = new Database(file);
    db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, password_hash TEXT, stream_key TEXT, is_banned INTEGER DEFAULT 0);
        CREATE TABLE channels (id INTEGER PRIMARY KEY, user_id INTEGER, vod_recording_enabled INTEGER DEFAULT 1, force_vod_recording_disabled INTEGER DEFAULT 0, default_vod_visibility TEXT DEFAULT 'public');
        CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY, user_id INTEGER, service TEXT, service_user_id TEXT, subject_id TEXT);
        CREATE TABLE managed_streams (id INTEGER PRIMARY KEY, user_id INTEGER, slug TEXT, title TEXT, description TEXT, protocol TEXT, stream_key TEXT,
            streaming_method TEXT, default_vod_visibility TEXT, slot_vod_recording_enabled INTEGER DEFAULT 1, slot_clip_recording_enabled INTEGER DEFAULT 1);
        CREATE TABLE restream_destinations (id INTEGER PRIMARY KEY, user_id INTEGER, managed_stream_id INTEGER, platform TEXT, name TEXT, server_url TEXT,
            stream_key TEXT, enabled INTEGER, auto_start INTEGER, quality_preset TEXT, connection_id INTEGER, srt_latency_ms INTEGER, srt_passphrase TEXT,
            custom_video_bitrate INTEGER, custom_audio_bitrate INTEGER, custom_fps INTEGER, custom_encoder_preset TEXT);
        INSERT INTO users VALUES (1, 'japaneseoldguy', 'JOG', 'x', 'personalkey111', 0), (2, 'nosubject', 'NS', 'x', 'k2', 0), (3, 'banned', 'B', 'x', 'k3', 1), (4, 'twoslots', 'TS', 'x', 'k4', 0);
        INSERT INTO channels (user_id, vod_recording_enabled, default_vod_visibility) VALUES (1, 1, 'unlisted'), (4, 0, 'public');
        INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '57', '${SUBJECT_A}'), (3, 'network', '58', 'usr_01J00000000000000000000C01'), (4, 'network', '59', '${SUBJECT_B}');
        INSERT INTO managed_streams VALUES
            (10, 1, 'main', 'Morning walk', '', 'rtmp', 'a3f9c2leakedkey0000000000000000000000000', 'obs', NULL, 1, 1),
            (11, 2, NULL, 'No subject yet', '', 'rtmp', 'b000000000000000000000000000000000000000', NULL, NULL, 1, 1),
            (12, 3, NULL, 'Banned', '', 'rtmp', 'c000000000000000000000000000000000000000', NULL, NULL, 1, 1),
            (13, 4, 'a', 'Slot A', '', 'webrtc', 'd000000000000000000000000000000000000000', 'browser', NULL, 1, 0),
            (14, 4, 'b', 'Slot B', '', 'rtmp', 'e000000000000000000000000000000000000000', 'obs', 'private', 1, 1);
        INSERT INTO restream_destinations VALUES
            (100, 1, 10, 'twitch', 'Twitch', 'rtmps://live.twitch.tv/app', 'live_twitchsecret_1', 1, 1, 'auto', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
            (101, 1, 10, 'youtube', 'YT', 'rtmp://a.rtmp.youtube.com/live2', 'yt-secret-2222', 1, 0, 'high', 7, NULL, NULL, 4500, NULL, NULL, NULL),
            (102, 1, 10, 'custom', 'LAN box', 'rtmp://192.168.1.20/live', 'lan-secret-333', 1, 1, 'auto', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
            (103, 4, NULL, 'kick', 'Kick', 'rtmps://fa723fc1b171.global-contribute.live-video.net', 'kick-secret-44', 1, 1, 'auto', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
    `);
    db.close();
    return file;
}

t('dry run writes nothing', () => {
    const dir = tmpDir();
    const rt = runtime({ dir });
    const live = new Database(liveSnapshot(dir), { readonly: true });
    const report = migrate({ liveDb: live, rt, apply: false });
    assert.strictEqual(rt.db.prepare('SELECT COUNT(*) AS n FROM stream_definitions').get().n, 0);
    assert.strictEqual(rt.db.prepare('SELECT COUNT(*) AS n FROM migration_map').get().n, 0);
    assert.ok(report.counts.imported > 0);
    assert.match(checklist(report), /dry run/);
});

let dir;
let rt;
let liveFile;
t('apply: slots with a subject are imported with new keys; the rest are held or excluded with reasons', () => {
    dir = tmpDir();
    rt = runtime({ dir, env: { OPENRE_DEST_ALLOW_PRIVATE: '0' } });
    liveFile = liveSnapshot(dir);
    const before = fs.readFileSync(liveFile);
    const live = new Database(liveFile, { readonly: true });
    const report = migrate({ liveDb: live, rt, apply: true });
    live.close();
    assert.ok(before.equals(fs.readFileSync(liveFile)), 'the Live snapshot is untouched');

    const map = Object.fromEntries(rt.db.prepare('SELECT source_type, source_id, status, reason, target_id FROM migration_map').all().map(r => [`${r.source_type}:${r.source_id}`, r]));
    assert.strictEqual(map['managed_stream:10'].status, 'imported');
    assert.strictEqual(map['managed_stream:11'].status, 'held');
    assert.match(map['managed_stream:11'].reason, /no canonical subject/);
    assert.strictEqual(map['managed_stream:12'].status, 'excluded');
    assert.strictEqual(map['managed_stream:13'].status, 'imported');
    assert.strictEqual(map['managed_stream:14'].status, 'imported');

    const def10 = rt.store.definitions.get(map['managed_stream:10'].target_id);
    assert.strictEqual(def10.owner_subject, SUBJECT_A);
    assert.strictEqual(def10.recording_visibility, 'unlisted', 'from the channel default');
    assert.strictEqual(def10.recording_mode, 'vod');
    assert.deepStrictEqual(def10.external_refs.map(r => `${r.service}:${r.type}:${r.id}`), ['live:managed_stream:10', 'live:user:1']);
    assert.strictEqual(rt.store.definitions.get(map['managed_stream:13'].target_id).recording_mode, 'none', 'VOD off on the channel, clips off on the slot');
    assert.strictEqual(rt.store.definitions.get(map['managed_stream:14'].target_id).recording_mode, 'clips');
    assert.strictEqual(rt.store.definitions.get(map['managed_stream:14'].target_id).recording_visibility, 'private');

    // Old keys: none of them authenticates, and none is stored in any form.
    for (const old of ['a3f9c2leakedkey0000000000000000000000000', 'personalkey111']) {
        assert.strictEqual(rt.db.prepare('SELECT COUNT(*) AS n FROM ingest_keys WHERE key_hash = ?').get(hashIngestKey(old)).n, 0);
        assert.ok(rt.store.definitions.resolveIngestKey(old, 'rtmp').error);
    }
    assert.strictEqual(rt.db.prepare("SELECT COUNT(*) AS n FROM ingest_keys WHERE status = 'active'").get().n, 3, 'one new key per imported slot');

    // Destinations: sealed, LAN one held, OAuth-linked flagged, unbound one held (two slots).
    assert.strictEqual(map['restream_destination:100'].status, 'imported');
    assert.strictEqual(map['restream_destination:101'].status, 'imported');
    assert.strictEqual(map['restream_destination:102'].status, 'held');
    assert.match(map['restream_destination:102'].reason, /private/);
    assert.strictEqual(map['restream_destination:103'].status, 'held');
    assert.match(map['restream_destination:103'].reason, /several slots/);
    const d100 = rt.store.outputs.destinationForWorker(map['restream_destination:100'].target_id);
    assert.strictEqual(d100.stream_key, 'live_twitchsecret_1');
    assert.ok(!JSON.stringify(rt.db.prepare('SELECT * FROM destinations').all()).includes('live_twitchsecret_1'), 'sealed at rest');
    const d101 = rt.store.outputs.getDestination(map['restream_destination:101'].target_id);
    assert.strictEqual(d101.auto_start, false);
    assert.strictEqual(d101.custom_video_bitrate, 4500);
    const d102 = rt.store.outputs.getDestination(map['restream_destination:102'].target_id);
    assert.strictEqual(d102.enabled, false);
    assert.ok(d102.hold_reason);

    const md = checklist(report, { rtmpUrl: 'rtmp://ingest.openre.stream:1936/live' });
    assert.match(md, /## @japaneseoldguy/);
    assert.match(md, /ingest-authority/);
    assert.match(md, /OAuth-linked/);
    assert.match(md, /only RTMP moves to OpenRe/, 'the WebRTC slot is flagged');
    for (const secret of ['a3f9c2leakedkey', 'live_twitchsecret_1', 'yt-secret-2222', 'personalkey111', 'kick-secret-44']) assert.ok(!md.includes(secret), `no ${secret} in the checklist`);
});

t('re-running is idempotent; a held slot is imported once its user has a subject', () => {
    const counts = () => ({
        defs: rt.db.prepare('SELECT COUNT(*) AS n FROM stream_definitions').get().n,
        dests: rt.db.prepare('SELECT COUNT(*) AS n FROM destinations').get().n,
        keys: rt.db.prepare('SELECT COUNT(*) AS n FROM ingest_keys').get().n,
    });
    const before = counts();
    let live = new Database(liveFile, { readonly: true });
    const again = migrate({ liveDb: live, rt, apply: true });
    live.close();
    assert.deepStrictEqual(counts(), before);
    assert.strictEqual(again.counts.imported, 0);
    const w = new Database(liveFile);
    w.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'network', '60', 'usr_01J00000000000000000000D01')").run();
    w.close();
    live = new Database(liveFile, { readonly: true });
    migrate({ liveDb: live, rt, apply: true });
    live.close();
    assert.strictEqual(counts().defs, before.defs + 1);
    assert.strictEqual(rt.db.prepare("SELECT status FROM migration_map WHERE source_type = 'managed_stream' AND source_id = '11'").get().status, 'imported');
});

t('the CLI runs a dry run against a snapshot and prints the checklist', () => {
    const d = tmpDir();
    const file = liveSnapshot(d);
    const env = testEnv(d);
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate-from-live.js'), '--live-db', file], {
        env: { ...process.env, ...env, OPENRE_ENV_FILE: '/nonexistent' }, cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(out, /OpenRe RTMP cutover checklist \(dry run/);
    assert.match(out, /@twoslots/);
});

t.run();
