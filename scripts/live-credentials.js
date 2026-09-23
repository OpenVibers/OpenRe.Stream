'use strict';
/**
 * The cutover scripts that act AS LIVE (subscribe-live-events.js, set-definition-state.js) read
 * Live's env file and ask Network for a client-credentials token with Live's OAuth client. Only
 * these names are used: OV_OAUTH_CLIENT_ID (default live), OV_OAUTH_CLIENT_SECRET and
 * OV_NETWORK_INTERNAL_URL (default http://127.0.0.1:4000). No value is ever printed.
 */
const fs = require('fs');

const DEFAULT_LIVE_ENV = '/etc/openvibe/live.env';

/** Parse Live's env file (root-only, 0600: the scripts run under sudo). */
function readLiveEnv(file = DEFAULT_LIVE_ENV) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
        throw new Error(`cannot read ${file} (${err.code}); run as root`);
    }
    return require('dotenv').parse(text);
}

async function readJson(res) {
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { detail: text.slice(0, 200) }; }
}

/** A service token for Live's client, for one audience (openvibe.events, openvibe.openre). */
async function liveToken({ env, audience, fetchImpl = globalThis.fetch }) {
    const clientId = env.OV_OAUTH_CLIENT_ID || 'live';
    const clientSecret = env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret) throw new Error('OV_OAUTH_CLIENT_SECRET is not set in the Live env file');
    const network = String(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const res = await fetchImpl(`${network}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience }).toString(),
        signal: AbortSignal.timeout(15000),
    });
    const tok = await readJson(res);
    if (!res.ok || !tok.access_token) throw new Error(`Network refused a token for ${clientId} (${res.status} ${tok.error || tok.code || ''})`.trim());
    return { token: tok.access_token, clientId };
}

module.exports = { readLiveEnv, readJson, liveToken, DEFAULT_LIVE_ENV };
