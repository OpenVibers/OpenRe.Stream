'use strict';
/**
 * OpenVibe Live on by default (owner, 2026-10-09; contracts 0.126.0). A stream someone makes here also shows on their
 * OpenVibe Live channel unless they switch it off:
 *
 *   link(definition) asks Live for a slot on the owner's channel bound to this stream (POST /internal/openre/slots,
 *   capability live.openre.slot.bind, OpenRestream's Network service token for audience openvibe.live). Live answers
 *   with the slot; the definition records it as its live:managed_stream ref (label: the channel URL) and turns
 *   mirror_to_live on. Live's mirror then makes each session a live stream on openvibe.live/@username.
 *
 * A refusal leaves the stream as it is with mirror_to_live off and says why (no Live account yet: the person signs in
 * to openvibe.live once and switches it on again). Off without OV_OAUTH_CLIENT_SECRET, in a restore drill, or with
 * OPENRE_LIVE_LINK=off.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const REASONS = {
    'live.no_account': 'You have no OpenVibe Live channel yet. Sign in to openvibe.live once, then switch this on again.',
    'live.slot_limit': 'Your OpenVibe Live channel already has all its stream slots. Remove one on openvibe.live, then switch this on again.',
    'live.slot_taken': 'This stream is linked to another OpenVibe Live channel.',
    'live.account_banned': 'Your OpenVibe Live account cannot go live.',
};

function createLiveLink({ store, config, env = process.env, fetchImpl = globalThis.fetch, log = console }) {
    const base = String(env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const enabled = Boolean(config.oauth && config.oauth.clientSecret) && env.OPENRE_LIVE_LINK !== 'off' && !config.drill;
    const tokens = enabled ? createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.live', fetch: fetchImpl }) : null;

    /** The Live slot this definition already shows on, or null. */
    function slotOf(d) {
        return (d.external_refs || []).find(r => r.service === 'live' && r.type === 'managed_stream') || null;
    }

    async function bind(d) {
        const res = await fetchImpl(`${base}/internal/openre/slots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${await tokens.getToken()}` },
            body: JSON.stringify({ subject: d.owner_subject, openre_stream_id: d.id, title: d.title, protocol: (d.protocols || ['rtmp'])[0] }),
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        const body = await res.json().catch(() => null);
        if (res.ok && body && Number.isInteger(body.managed_stream_id)) return { ok: true, slotId: body.managed_stream_id, channelUrl: body.channel_url || null };
        const code = (body && (body.code || body.error)) || `live.http_${res.status}`;
        return { ok: false, code, reason: REASONS[code] || `OpenVibe Live did not link the stream (${code}).` };
    }

    /**
     * Show definition `d` on its owner's OpenVibe Live channel: { linked: true, channel_url } or
     * { linked: false, code, reason }. mirror_to_live follows the outcome.
     */
    async function link(d) {
        if (!enabled) return { linked: false, code: 'openre.live_link_off', reason: 'Linking to OpenVibe Live is not configured here.' };
        const have = slotOf(d);
        if (have) {
            if (!d.mirror_to_live) await store.definitions.update(d.id, { mirror_to_live: true });
            return { linked: true, channel_url: have.label || null };
        }
        let r;
        try { r = await bind(d); } catch (err) {
            log.warn(`[live-link] ${d.id}: ${err.message}`);
            r = { ok: false, code: 'live.unreachable', reason: 'OpenVibe Live did not answer. Try switching it on again in a minute.' };
        }
        if (!r.ok) {
            if (d.mirror_to_live) await store.definitions.update(d.id, { mirror_to_live: false });
            return { linked: false, code: r.code, reason: r.reason };
        }
        await store.definitions.addRef(d.id, { service: 'live', type: 'managed_stream', id: String(r.slotId), label: r.channelUrl ? r.channelUrl.slice(0, 120) : null });
        await store.definitions.update(d.id, { mirror_to_live: true });
        return { linked: true, channel_url: r.channelUrl };
    }

    return { enabled, link, slotOf };
}

module.exports = { createLiveLink, REASONS };
