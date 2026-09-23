'use strict';
/**
 * Import OpenVibe.Live stream slots (managed_streams) and their restream destinations from a
 * read-only snapshot of Live's database into OpenRe (scripts/migrate-from-live.js is the CLI).
 *
 * Rules (ADR-009, plan §8.1):
 *   - Live's database is opened read-only; nothing is written to it.
 *   - Stream keys are NEVER imported. Every imported slot gets a new OpenRe key that nobody has
 *     seen; the streamer gets a usable key by rotating (Live's "Regenerate" once the slot is
 *     switched to OpenRe, or openre.stream). Every key that existed before the cutover is dead
 *     at the cutover.
 *   - Every source row is imported, held with a reason, or excluded with a reason, and recorded in
 *     migration_map. Re-running is idempotent: imported rows are skipped, held rows are retried.
 *   - Ownership is the canonical subject (linked_accounts.subject_id); Live's integer ids travel
 *     only as typed references (live:managed_stream, live:user) for Media's 'live' tenant and the
 *     Live mirror.
 */

const { validateDestinationUrl } = require('./destination-url');

function columns(db, table) {
    try { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)); } catch { return new Set(); }
}

function recordingModeOf(ms, channel) {
    let vod = !channel ? true : Boolean(channel.vod_recording_enabled) && !channel.force_vod_recording_disabled;
    if (vod && ms.slot_vod_recording_enabled === 0) vod = false;
    if (vod) return 'vod';
    return ms.slot_clip_recording_enabled === 0 ? 'none' : 'clips';
}

function visibilityOf(ms, channel) {
    const v = ms.default_vod_visibility || (channel && channel.default_vod_visibility) || 'public';
    return ['public', 'unlisted', 'private'].includes(v) ? v : 'public';
}

/**
 * migrate({ liveDb, rt, apply, onlySlots }) -> report
 * report = { slots: [...], destinations: [...], channels: Map username → {...}, counts }
 */
function migrate({ liveDb, rt, apply = false, onlySlots = null, now = () => Date.now() }) {
    const { db, store, config } = rt;
    const msCols = columns(liveDb, 'managed_streams');
    if (!msCols.size) throw new Error('the Live snapshot has no managed_streams table');
    const rdCols = columns(liveDb, 'restream_destinations');
    const laCols = columns(liveDb, 'linked_accounts');
    const chCols = columns(liveDb, 'channels');

    const mapGet = db.prepare("SELECT * FROM migration_map WHERE source_system = 'live' AND source_type = ? AND source_id = ?");
    const mapPut = db.prepare(`INSERT INTO migration_map (source_system, source_type, source_id, target_type, target_id, status, reason, imported_at)
        VALUES ('live', @source_type, @source_id, @target_type, @target_id, @status, @reason, @at)
        ON CONFLICT(source_system, source_type, source_id) DO UPDATE SET target_type = @target_type, target_id = @target_id, status = @status, reason = @reason, imported_at = @at`);
    const record = (row) => { if (apply) mapPut.run({ target_type: null, target_id: null, reason: null, ...row, at: now() }); };

    const slots = liveDb.prepare(`SELECT ms.*, u.username, u.display_name, u.is_banned FROM managed_streams ms JOIN users u ON u.id = ms.user_id ORDER BY ms.user_id, ms.id`).all()
        .filter(ms => !onlySlots || onlySlots.includes(Number(ms.id)));
    const subjectOf = laCols.has('subject_id')
        ? liveDb.prepare("SELECT subject_id FROM linked_accounts WHERE service = 'network' AND user_id = ? AND subject_id IS NOT NULL")
        : null;
    const channelOf = chCols.size ? liveDb.prepare('SELECT * FROM channels WHERE user_id = ?') : null;
    const destsOfSlot = rdCols.has('managed_stream_id') ? liveDb.prepare('SELECT * FROM restream_destinations WHERE managed_stream_id = ? ORDER BY id') : null;
    const unboundOfUser = rdCols.size
        ? liveDb.prepare(`SELECT * FROM restream_destinations WHERE user_id = ? ${rdCols.has('managed_stream_id') ? 'AND managed_stream_id IS NULL' : ''} ORDER BY id`)
        : null;
    const slotsOfUser = liveDb.prepare('SELECT COUNT(*) AS n FROM managed_streams WHERE user_id = ?');

    const report = { apply, slots: [], destinations: [], channels: new Map(), counts: { imported: 0, held: 0, excluded: 0, skipped: 0 } };
    const channel = (ms) => {
        if (!report.channels.has(ms.user_id)) report.channels.set(ms.user_id, { user_id: ms.user_id, username: ms.username, display_name: ms.display_name, slots: [], notes: [] });
        return report.channels.get(ms.user_id);
    };
    const count = (status) => { report.counts[status] = (report.counts[status] || 0) + 1; };

    for (const ms of slots) {
        const ch = channel(ms);
        const prior = mapGet.get('managed_stream', String(ms.id));
        const entry = { live_id: ms.id, slug: ms.slug || null, title: ms.title, protocol: ms.protocol, streaming_method: ms.streaming_method || null, definition_id: null, status: null, reason: null, destinations: [] };
        ch.slots.push(entry);

        if (prior && prior.status === 'imported' && store.definitions.get(prior.target_id)) {
            entry.definition_id = prior.target_id;
            entry.status = 'imported';
            entry.reason = 'already imported';
            count('skipped');
        } else {
            const subject = subjectOf ? (subjectOf.get(ms.user_id) || {}).subject_id : null;
            if (!subject) {
                entry.status = 'held';
                entry.reason = `Live user ${ms.user_id} has no canonical subject yet (it is recorded when they next sign in to Live); the slot is imported on a later run`;
                record({ source_type: 'managed_stream', source_id: String(ms.id), status: 'held', reason: entry.reason });
                count('held');
            } else if (ms.is_banned) {
                entry.status = 'excluded';
                entry.reason = 'the Live account is banned';
                record({ source_type: 'managed_stream', source_id: String(ms.id), status: 'excluded', reason: entry.reason });
                count('excluded');
            } else {
                const chRow = channelOf ? channelOf.get(ms.user_id) : null;
                const fields = {
                    owner_subject: subject,
                    title: ms.title || `${ms.display_name || ms.username}'s stream`,
                    description: ms.description || '',
                    protocols: ['rtmp'],
                    recording_mode: recordingModeOf(ms, chRow),
                    recording_visibility: visibilityOf(ms, chRow),
                    mirror_to_live: true,
                    // live:user is what Media's 'live' tenant files the VOD under (Live-local ids).
                    external_refs: [
                        { service: 'live', type: 'managed_stream', id: String(ms.id), label: ms.slug || ms.title || null },
                        { service: 'live', type: 'user', id: String(ms.user_id), label: ms.username },
                    ],
                    created_by: 'svc:openre-migration',
                };
                entry.recording_mode = fields.recording_mode;
                if (apply) {
                    const existing = store.definitions.findByRef('live', 'managed_stream', String(ms.id));
                    const def = existing || store.definitions.create(fields).definition;   // the new key is discarded unseen
                    entry.definition_id = def.id;
                    record({ source_type: 'managed_stream', source_id: String(ms.id), target_type: 'stream_definition', target_id: def.id, status: 'imported', reason: 'new key issued, old key not imported' });
                }
                entry.status = 'imported';
                entry.reason = 'new key issued, old key not imported';
                count('imported');
            }
        }

        // Destinations: the slot's own, plus unbound ones when the user has exactly one slot.
        const own = destsOfSlot ? destsOfSlot.all(ms.id) : [];
        const unbound = unboundOfUser ? unboundOfUser.all(ms.user_id) : [];
        const oneSlot = slotsOfUser.get(ms.user_id).n === 1;
        const candidates = [...own.map(d => ({ d, unbound: false })), ...unbound.map(d => ({ d, unbound: true }))];
        for (const { d, unbound: isUnbound } of candidates) {
            const di = { live_id: d.id, platform: d.platform, name: d.name || d.platform, status: null, reason: null, destination_id: null, oauth_linked: Boolean(d.connection_id) };
            entry.destinations.push(di);
            report.destinations.push(di);
            const priorD = mapGet.get('restream_destination', String(d.id));
            if (priorD && priorD.target_id && store.outputs.destinationRow(priorD.target_id)) {
                di.status = priorD.status; di.reason = priorD.reason || 'already imported'; di.destination_id = priorD.target_id; count('skipped');
                continue;
            }
            if (isUnbound && !oneSlot) {
                di.status = 'held';
                di.reason = 'not bound to a slot and the user has several slots (Live pushed unbound destinations from every slot); bind it in Live or add it on openre.stream';
                record({ source_type: 'restream_destination', source_id: String(d.id), status: 'held', reason: di.reason });
                count('held');
                continue;
            }
            if (entry.status !== 'imported') {
                di.status = 'held';
                di.reason = `its slot is ${entry.status}`;
                record({ source_type: 'restream_destination', source_id: String(d.id), status: 'held', reason: di.reason });
                count('held');
                continue;
            }
            const v = validateDestinationUrl(d.server_url, { allowPrivate: config.outputs.allowPrivateHosts });
            const hold = !v.ok ? `server URL refused by OpenRe's destination rules: ${v.error}` : null;
            const input = {
                platform: ['youtube', 'twitch', 'kick', 'custom'].includes(d.platform) ? d.platform : 'custom',
                name: d.name || null,
                server_url: v.ok ? v.value : 'rtmp://held.invalid/app',
                stream_key: d.stream_key || '',
                srt_passphrase: d.srt_passphrase || '',
                srt_latency_ms: d.srt_latency_ms == null ? undefined : d.srt_latency_ms,
                enabled: Boolean(d.enabled),
                auto_start: Boolean(d.auto_start),
                quality_preset: ['auto', 'low', 'medium', 'high', 'ultra', 'source'].includes(d.quality_preset) ? d.quality_preset : 'auto',
                custom_video_bitrate: d.custom_video_bitrate == null ? undefined : d.custom_video_bitrate,
                custom_audio_bitrate: d.custom_audio_bitrate == null ? undefined : d.custom_audio_bitrate,
                custom_fps: d.custom_fps == null ? undefined : d.custom_fps,
                custom_encoder_preset: d.custom_encoder_preset || undefined,
            };
            if (apply) {
                let created;
                if (hold) {
                    // Keep the (sealed) key so the owner only has to fix the URL; the row stays
                    // disabled until they do. The original URL is kept in the hold reason.
                    created = store.outputs.createDestination(entry.definition_id, { ...input, server_url: 'rtmp://held.invalid/app', enabled: false }, { hold_reason: `${hold} (was ${String(d.server_url || '').replace(/\/[^/]*$/, '/…')})` });
                } else {
                    created = store.outputs.createDestination(entry.definition_id, input);
                }
                di.destination_id = created.id;
                record({ source_type: 'restream_destination', source_id: String(d.id), target_type: 'destination', target_id: created.id, status: hold ? 'held' : 'imported', reason: hold || null });
            }
            di.status = hold ? 'held' : 'imported';
            di.reason = hold;
            count(hold ? 'held' : 'imported');
        }
        if (own.some(d => d.connection_id) || unbound.some(d => d.connection_id)) {
            ch.notes.push('OAuth-linked destination(s): Live refreshed their ingest key (and created the YouTube broadcast) on every go-live; OpenRe pushes to the key stored at import. Check the platform key is a persistent one, or re-enter it on openre.stream after the cutover.');
        }
    }
    return report;
}

/** Markdown checklist per channel, for the lead and the broadcaster. Contains no secret. */
function checklist(report, { openreUrl = 'https://openre.stream', rtmpUrl } = {}) {
    const lines = [];
    lines.push(`# OpenRe RTMP cutover checklist${report.apply ? '' : ' (dry run: nothing was written)'}`);
    lines.push('');
    lines.push(`Imported ${report.counts.imported}, held ${report.counts.held}, excluded ${report.counts.excluded}, already done ${report.counts.skipped}.`);
    lines.push('');
    for (const ch of report.channels.values()) {
        lines.push(`## @${ch.username} (Live user ${ch.user_id})`);
        lines.push('');
        for (const s of ch.slots) {
            lines.push(`### Slot ${s.live_id}${s.slug ? ` "${s.slug}"` : ''}: ${s.title || ''} — ${s.status}${s.definition_id ? ` → ${s.definition_id}` : ''}`);
            if (s.reason && s.status !== 'imported') lines.push(`- ${s.status}: ${s.reason}`);
            if (s.status === 'imported') {
                if (s.protocol !== 'rtmp' && !['rtmp', 'obs'].includes(String(s.streaming_method || '').toLowerCase())) {
                    lines.push(`- Slot protocol is ${s.protocol}${s.streaming_method ? ` / ${s.streaming_method}` : ''}: only RTMP moves to OpenRe; leave this slot on Live unless the broadcaster streams it with OBS/RTMP.`);
                }
                lines.push(`- [ ] Maintenance window agreed with @${ch.username} (the slot must be offline when it is switched).`);
                lines.push(`- [ ] Destinations reviewed on ${openreUrl}/streams/${s.definition_id || '<id>'}: ${s.destinations.length ? s.destinations.map(d => `${d.name} (${d.platform}) ${d.status}${d.reason ? `: ${d.reason}` : ''}`).join('; ') : 'none'}`);
                lines.push(`- [ ] Recording: ${s.recording_mode || 'as imported'} (from the slot's VOD/clip settings on Live).`);
                lines.push(`- [ ] Switch: \`PUT https://openvibe.live/api/admin/openre/managed/${s.live_id}/ingest-authority {"authority":"openre"}\` (rotates Live's own key for the slot at the same time).`);
                lines.push(`- [ ] Broadcaster presses "Regenerate stream key" on Live's Go Live page (or rotates on openre.stream) and pastes the new server${rtmpUrl ? ` \`${rtmpUrl}\`` : ''} and key into OBS. The old key no longer works anywhere.`);
                lines.push('- [ ] Test broadcast: the stream shows on the Live channel page, restreams go live, a VOD appears in Media when it ends.');
                lines.push(`- [ ] Rollback if needed: \`{"authority":"live"}\` on the same route; the broadcaster regenerates the key on Live.`);
            }
            lines.push('');
        }
        lines.push(`- [ ] Personal key: rotate @${ch.username}'s personal stream key on Live (users.stream_key is not migrated; any leaked copy must die too).`);
        for (const n of ch.notes) lines.push(`- Note: ${n}`);
        lines.push('');
    }
    return lines.join('\n');
}

module.exports = { migrate, checklist, recordingModeOf };
