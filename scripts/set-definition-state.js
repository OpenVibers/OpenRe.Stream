#!/usr/bin/env node
'use strict';
/**
 * Disable (or re-enable) the OpenRe stream definition of one Live slot, AS LIVE (docs/cutover.md,
 * per-slot rollback). A disabled definition's keys are refused at the RTMP handshake
 * (`stream_disabled`), so after a slot goes back to Live nobody can publish to OpenRe with the key
 * the broadcaster got at the cutover, and OpenRe never pushes that slot's destinations. Running
 * sessions are not ended (Live holds no openre.session.end grant): do it with the slot offline.
 *
 *   sudo node /opt/openre.stream/current/scripts/set-definition-state.js --slot 12 --state disabled
 *   sudo node /opt/openre.stream/current/scripts/set-definition-state.js --slot 12 --state active
 *   [--live-env /etc/openvibe/live.env]
 *
 * Uses Live's OAuth client (grants openre.stream.read + openre.stream.write on openvibe.openre, both
 * held since 2026-09-23) and OPENRE_URL from Live's env file (default http://127.0.0.1:4500). Prints
 * no secret and no key.
 */
const { readLiveEnv, readJson, liveToken, DEFAULT_LIVE_ENV } = require('./live-credentials');

function parseArgs(argv) {
    const o = { liveEnv: DEFAULT_LIVE_ENV, slot: null, state: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--slot') o.slot = argv[++i];
        else if (a === '--state') o.state = argv[++i];
        else if (a === '--live-env') o.liveEnv = argv[++i];
        else throw new Error(`unknown argument ${a}`);
    }
    if (!/^\d+$/.test(String(o.slot || ''))) throw new Error('--slot <Live managed stream id> is required');
    if (!['active', 'disabled'].includes(o.state)) throw new Error('--state must be active or disabled');
    return o;
}

async function run({ slot, state, env, fetchImpl = globalThis.fetch, log = console.log }) {
    const openre = String(env.OPENRE_URL || 'http://127.0.0.1:4500').replace(/\/+$/, '');
    const { token } = await liveToken({ env, audience: 'openvibe.openre', fetchImpl });
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const ref = `live:managed_stream:${slot}`;
    const found = await fetchImpl(`${openre}/api/v1/streams?external_ref=${encodeURIComponent(ref)}`, { headers, signal: AbortSignal.timeout(15000) });
    const list = await readJson(found);
    if (!found.ok) throw new Error(`OpenRe answered ${found.status}: ${list.code || ''} ${list.detail || ''}`.trim());
    const d = (list.streams || [])[0];
    if (!d) throw new Error(`OpenRe has no stream definition for ${ref}`);
    if (d.state === state) {
        log(`${d.id} (${ref}) is already ${state}`);
        return { id: d.id, state, changed: false, open_session: d.session ? d.session.id : null };
    }
    const r = await fetchImpl(`${openre}/api/v1/streams/${encodeURIComponent(d.id)}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
        signal: AbortSignal.timeout(15000),
    });
    const b = await readJson(r);
    if (!r.ok) throw new Error(`OpenRe answered ${r.status}: ${b.code || ''} ${b.detail || ''}`.trim());
    log(`${d.id} (${ref}): ${d.state} → ${b.stream ? b.stream.state : state}${d.session ? `; session ${d.session.id} is still ${d.session.state} (not ended by this)` : ''}`);
    return { id: d.id, state: b.stream ? b.stream.state : state, changed: true, open_session: d.session ? d.session.id : null };
}

if (require.main === module) {
    let o;
    let env;
    try { o = parseArgs(process.argv.slice(2)); env = readLiveEnv(o.liveEnv); } catch (err) { console.error(`set-definition-state: ${err.message}`); process.exit(2); }
    run({ slot: o.slot, state: o.state, env }).then(() => process.exit(0), (err) => { console.error(`set-definition-state: ${err.message}`); process.exit(1); });
}

module.exports = { run, parseArgs };
