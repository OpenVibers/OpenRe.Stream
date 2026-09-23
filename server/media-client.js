'use strict';
/**
 * OpenVibe.Media recording requests: the same Media API v1 contract Live's recorder uses
 * (OpenVibe.Live server/media-client.js + server/streaming/recorder.js), cut down to the calls a
 * recording needs:
 *
 *   POST /api/v1/:app/vods                   { title, user_id?, managed_stream_id?, meta, visibility, clips_only } → { id }
 *   POST /api/v1/:app/vods/:id/ingest/rtmp   { rtmp_url }  → 202  (Media pulls the URL with its own ffmpeg)
 *   POST /api/v1/:app/vods/:id/finalize      → Media closes the recording, probes, thumbnails, fires vod.ready
 *   DELETE /api/v1/:app/vods/:id             → drop an empty shell / an ephemeral clips-only recording
 *
 * The rtmp_url is the owning worker's loopback play URL (rtmp://127.0.0.1:<port>/live/<session id>):
 * no ingest key ever leaves OpenRe. Media records and finalises; OpenRe only asks.
 *
 * Auth: config.media.auth === 'key' sends the tenant app key (MEDIA_API_KEY), which Media's VOD
 * routes accept today. 'service' sends a Network service token (audience openvibe.media); Media's
 * VOD routes do not accept service tokens yet (they name no capability) — see README "Recording".
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

class MediaError extends Error {
    constructor(message, status, body) { super(message); this.status = status || 0; this.body = body || null; }
}

function createMediaClient({ config, fetchImpl = globalThis.fetch }) {
    const base = `${config.media.url}/api/v1/${encodeURIComponent(config.media.appId)}`;
    const tokens = config.media.auth === 'service' && config.oauth.clientSecret
        ? createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.media', fetch: fetchImpl })
        : null;

    const configured = config.media.enabled && Boolean(config.media.auth === 'service' ? tokens : config.media.apiKey);

    async function authHeader() {
        if (tokens) return { Authorization: `Bearer ${await tokens.getToken()}` };
        return config.media.apiKey ? { Authorization: `Bearer ${config.media.apiKey}` } : {};
    }

    async function request(method, path, { body, timeoutMs = 15000 } = {}) {
        const headers = { Accept: 'application/json', ...(await authHeader()) };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        let res;
        let text = '';
        try {
            res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
            text = await res.text().catch(() => '');
        } catch (err) {
            throw new MediaError(`Media unreachable (${method} ${path}): ${err.message}`, 0, null);
        }
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { json = null; } }
        if (!res.ok) throw new MediaError((json && (json.error || json.detail)) || `Media ${res.status} on ${method} ${path}`, res.status, json);
        return json;
    }

    return {
        configured,
        appId: config.media.appId,
        createVod: (fields) => request('POST', '/vods', { body: fields }),
        ingestRtmp: (vodId, rtmpUrl) => request('POST', `/vods/${encodeURIComponent(vodId)}/ingest/rtmp`, { body: { rtmp_url: rtmpUrl } }),
        finalizeVod: (vodId) => request('POST', `/vods/${encodeURIComponent(vodId)}/finalize`, { timeoutMs: 30000 }),
        deleteVod: (vodId) => request('DELETE', `/vods/${encodeURIComponent(vodId)}`),
    };
}

module.exports = { createMediaClient, MediaError };
