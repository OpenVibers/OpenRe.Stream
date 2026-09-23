#!/usr/bin/env node
'use strict';
/**
 * Live's OpenVibe.Events subscription to OpenRe's session events (docs/cutover.md step A5):
 * topic `openre.session.*` → Live's `POST /internal/openre-events`, signed with the secret Live holds
 * as OPENRE_EVENTS_SECRET. Events names the consumer after the calling service, so this runs AS LIVE:
 * it reads Live's env file (Live's OAuth client, grant [live, events.subscription.manage,
 * openvibe.events]) and asks Network for a token with it. No secret is printed. Run on the host as
 * root (the env file is 0600):
 *
 *   sudo node /opt/openre.stream/current/scripts/subscribe-live-events.js            # create (or report)
 *   sudo node /opt/openre.stream/current/scripts/subscribe-live-events.js --dry-run  # list, change nothing
 *   sudo node /opt/openre.stream/current/scripts/subscribe-live-events.js --disable  # rollback
 *   sudo node /opt/openre.stream/current/scripts/subscribe-live-events.js --enable   # undo a --disable
 *
 *   [--live-env /etc/openvibe/live.env] [--endpoint http://127.0.0.1:3000/internal/openre-events]
 *
 * Env names used (from the Live env file): OV_OAUTH_CLIENT_ID, OV_OAUTH_CLIENT_SECRET,
 * OV_NETWORK_INTERNAL_URL (scripts/live-credentials.js), EVENTS_URL (default http://127.0.0.1:4300)
 * and OPENRE_EVENTS_SECRET (32+ characters; generate it with `openssl rand -hex 32` and put it in the
 * Live env file first). An existing subscription with the same topic and endpoint is reported, not
 * duplicated; its secret cannot be read back through the API, so `cutover-preflight.js --only events`
 * compares it with Live's by hash. A new subscription gets no history: sessions from before it
 * (the 2026-09-23 rehearsal) are not mirrored into Live.
 */
const { readLiveEnv, readJson, liveToken, DEFAULT_LIVE_ENV } = require('./live-credentials');

const TOPIC = 'openre.session.*';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:3000/internal/openre-events';

function parseArgs(argv) {
    const o = { liveEnv: DEFAULT_LIVE_ENV, endpoint: DEFAULT_ENDPOINT, action: 'create' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') o.action = 'list';
        else if (a === '--disable') o.action = 'disable';
        else if (a === '--enable') o.action = 'enable';
        else if (a === '--live-env') o.liveEnv = argv[++i];
        else if (a === '--endpoint') o.endpoint = argv[++i];
        else throw new Error(`unknown argument ${a}`);
    }
    if (!o.liveEnv || !o.endpoint) throw new Error('--live-env and --endpoint need a value');
    return o;
}

/**
 * run({ action, endpoint, env, fetchImpl, log }) -> { action, subscription_id?, created?, existed?, enabled? }
 * `env` is the parsed Live env file.
 */
async function run({ action = 'create', endpoint = DEFAULT_ENDPOINT, env, fetchImpl = globalThis.fetch, log = console.log }) {
    const events = String(env.EVENTS_URL || 'http://127.0.0.1:4300').replace(/\/+$/, '');
    const secret = env.OPENRE_EVENTS_SECRET || '';
    if (!env.OV_OAUTH_CLIENT_SECRET) throw new Error('OV_OAUTH_CLIENT_SECRET is not set in the Live env file');
    if (action === 'create' && secret.length < 32) throw new Error('OPENRE_EVENTS_SECRET must be set in the Live env file first (32+ characters: openssl rand -hex 32)');

    const { token, clientId } = await liveToken({ env, audience: 'openvibe.events', fetchImpl });
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    const listRes = await fetchImpl(`${events}/api/v1/subscriptions`, { headers, signal: AbortSignal.timeout(15000) });
    const list = await readJson(listRes);
    if (!listRes.ok) throw new Error(`Events answered ${listRes.status} listing subscriptions: ${list.code || ''} ${list.detail || ''}`.trim());
    const mine = (list.subscriptions || []).filter((s) => s.topic_pattern === TOPIC && s.endpoint === endpoint);
    const existing = mine[0] || null;
    const describe = (s) => `${s.id} (${TOPIC} → ${endpoint}, ${s.enabled === false || s.enabled === 0 ? 'disabled' : 'enabled'})`;

    if (action === 'list') {
        if (!existing) log(`no subscription ${TOPIC} → ${endpoint} for ${clientId}; would create one`);
        for (const s of mine) log(`exists: ${describe(s)}`);
        return { action, subscription_id: existing ? existing.id : null, existed: Boolean(existing) };
    }
    if (action === 'disable' || action === 'enable') {
        if (!existing) throw new Error(`no subscription ${TOPIC} → ${endpoint} to ${action}`);
        const r = await fetchImpl(`${events}/api/v1/subscriptions/${encodeURIComponent(existing.id)}/${action}`, { method: 'POST', headers, signal: AbortSignal.timeout(15000) });
        const b = await readJson(r);
        if (!r.ok) throw new Error(`Events answered ${r.status} to ${action}: ${b.code || ''} ${b.detail || ''}`.trim());
        log(`${action}d: ${describe(b.id ? b : { ...existing, enabled: action === 'enable' })}`);
        return { action, subscription_id: existing.id, enabled: action === 'enable' };
    }
    if (existing) {
        log(`subscription exists: ${describe(existing)}. Check its secret with: cutover-preflight.js --only events`);
        return { action, subscription_id: existing.id, existed: true, created: false };
    }
    const r = await fetchImpl(`${events}/api/v1/subscriptions`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic_pattern: TOPIC, endpoint, secret }),
        signal: AbortSignal.timeout(15000),
    });
    const b = await readJson(r);
    if (r.status === 409 && b.subscription_id) {
        log(`subscription exists: ${b.subscription_id}`);
        return { action, subscription_id: b.subscription_id, existed: true, created: false };
    }
    if (!r.ok) throw new Error(`Events answered ${r.status}: ${b.code || ''} ${b.detail || ''}`.trim());
    log(`subscribed: ${b.id} (${TOPIC} → ${endpoint}), signed with Live's OPENRE_EVENTS_SECRET`);
    return { action, subscription_id: b.id, existed: false, created: true };
}

if (require.main === module) {
    let o;
    let env;
    try { o = parseArgs(process.argv.slice(2)); env = readLiveEnv(o.liveEnv); } catch (err) { console.error(`subscribe-live-events: ${err.message}`); process.exit(2); }
    run({ action: o.action, endpoint: o.endpoint, env }).then(() => process.exit(0), (err) => { console.error(`subscribe-live-events: ${err.message}`); process.exit(1); });
}

module.exports = { run, parseArgs, TOPIC, DEFAULT_ENDPOINT };
