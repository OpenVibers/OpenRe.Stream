'use strict';
/**
 * Live lineage for OpenRe definitions (roadmap D20): which OpenVibe.Live channel a stream belongs to,
 * answered by Live's canonical resolver (GET /internal/lineage/resolve, capability live.lineage.resolve,
 * OpenRe's Network service token for audience openvibe.live) instead of a mapping of OpenRe's own.
 * A definition is asked about when it mirrors into Live or points at a Live slot (external ref
 * live:managed_stream), with its owner subject and that slot id; display names are never sent.
 *
 * The coordinator calls refresh() on its tick: at most `batch` definitions whose answer is missing or
 * older than `maxAgeMs`, stored in definition_lineage and carried by session events (payload.lineage).
 * Off without OV_OAUTH_CLIENT_SECRET, or with OPENRE_LINEAGE=off.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

function createLineage({ db, config, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), maxAgeMs = 15 * 60 * 1000, batch = 20, log = console }) {
    const base = String(env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const enabled = Boolean(config.oauth && config.oauth.clientSecret) && env.OPENRE_LINEAGE !== 'off' && !config.drill;
    const tokens = enabled ? createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.live', fetch: fetchImpl }) : null;
    const stats = { refreshed: 0, resolved: 0, unresolved: 0, failed: 0, lastError: null };
    const q = {
        due: db.prepare(`SELECT d.id, d.owner_subject,
                (SELECT r.ref_id FROM external_refs r WHERE r.definition_id = d.id AND r.service = 'live' AND r.type = 'managed_stream' LIMIT 1) AS slot_id
            FROM stream_definitions d LEFT JOIN definition_lineage l ON l.definition_id = d.id
            WHERE d.state = 'active'
              AND (d.mirror_to_live = 1 OR EXISTS (SELECT 1 FROM external_refs r WHERE r.definition_id = d.id AND r.service = 'live'))
              AND (l.checked_at IS NULL OR l.checked_at < ?)
            ORDER BY l.checked_at IS NOT NULL, l.checked_at LIMIT ?`),
        save: db.prepare(`INSERT INTO definition_lineage (definition_id, resolution, checked_at) VALUES (?, ?, ?)
            ON CONFLICT(definition_id) DO UPDATE SET resolution = excluded.resolution, checked_at = excluded.checked_at`),
    };

    async function resolveOne(def) {
        const qs = new URLSearchParams();
        if (def.owner_subject) qs.set('owner_subject', def.owner_subject);
        if (def.slot_id && /^[0-9]{1,15}$/.test(def.slot_id)) qs.set('slot_id', def.slot_id);
        const res = await fetchImpl(`${base}/internal/lineage/resolve?${qs}`, { headers: { Accept: 'application/json', Authorization: `Bearer ${await tokens.getToken()}` }, signal: AbortSignal.timeout(10000) });
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || (body.status !== 'resolved' && body.status !== 'unresolved')) throw new Error(`resolver answered ${res.status}`);
        return body;
    }

    async function refresh() {
        if (!enabled) return { skipped: 'off' };
        const out = { checked: 0, resolved: 0 };
        for (const def of q.due.all(now() - maxAgeMs, batch)) {
            try {
                const r = await resolveOne(def);
                q.save.run(def.id, JSON.stringify(r), now());
                out.checked++; stats.refreshed++;
                if (r.status === 'resolved') { out.resolved++; stats.resolved++; } else stats.unresolved++;
            } catch (err) {
                stats.failed++;
                if (err.message !== stats.lastError) log.warn(`[lineage] ${def.id}: ${err.message}`);
                stats.lastError = err.message;
                break;   // Live is down or refusing: try again next tick
            }
        }
        return out;
    }

    return { enabled, refresh, stats: () => ({ enabled, ...stats }) };
}

module.exports = { createLineage };
