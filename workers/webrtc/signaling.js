'use strict';
/**
 * WS signaling for WebRTC, modelled on the producer and viewer halves of OpenVibe.Live's
 * server/streaming/broadcast-server.js so Live's broadcast and watch pages can point their
 * mediasoup-client at OpenRe:
 *
 *   ws://<host>:<port>/b/<ingest key>        the broadcaster (Live's role: produce into the SFU)
 *   ws://<host>:<port>/w/<session playback id>  a viewer (consume; never carries the key)
 *
 * Broadcaster messages:  sfu-get-capabilities | sfu-create-transport | sfu-connect-transport |
 *                        sfu-produce | sfu-stop-produce   → the sfu-* replies Live's client expects.
 * Viewer messages:       watch | sfu-viewer-create-transport | sfu-viewer-connect-transport |
 *                        sfu-viewer-consume             → sfu-viewer-ready/…-consumed.
 *
 * Admission of the broadcaster uses the same resolveIngestKey/admit path as WHIP and RTMP (it is the
 * caller's `admit` callback). A viewer is keyed by the session's playback id and served by the
 * generation that holds the session; another generation drops the socket (same rule as JSMPEG).
 * Viewer counts are read from the SFU (active consumer peers) by the worker's heartbeat, not here.
 */
const { WebSocketServer } = require('ws');

const BACKPRESSURE = 512 * 1024;

function safeSend(ws, obj, log) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > BACKPRESSURE) { log.warn(`[webrtc] dropping ${obj && obj.type} — ws backpressure ${ws.bufferedAmount}`); return; }
    try { ws.send(JSON.stringify(obj)); } catch (err) { log.warn(`[webrtc] send ${obj && obj.type} failed: ${err.message}`); }
}

function createSignaling({ sfu, iceServers, admit, endSession, log = console }) {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    /** ws → { role, sessionId, peerId } */
    const clients = new Map();

    const ice = () => (iceServers || []).map(urls => ({ urls }));

    function handleBroadcaster(ws, key) {
        ws.on('message', async (data) => {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }
            const client = clients.get(ws);
            if (!client) return;
            const { sessionId, peerId } = client;
            try {
                switch (msg.type) {
                    case 'sfu-get-capabilities':
                        safeSend(ws, { type: 'sfu-capabilities', rtpCapabilities: await sfu.getRouterCapabilities(sessionId) }, log);
                        break;
                    case 'sfu-create-transport': {
                        const t = await sfu.createTransport(sessionId, peerId);
                        safeSend(ws, { type: 'sfu-transport-created', id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters, iceServers: ice() }, log);
                        break;
                    }
                    case 'sfu-connect-transport':
                        await sfu.connectTransport(sessionId, peerId, msg.transportId, msg.dtlsParameters);
                        safeSend(ws, { type: 'sfu-transport-connected', transportId: msg.transportId }, log);
                        break;
                    case 'sfu-produce': {
                        const r = await sfu.produce(sessionId, peerId, msg.transportId, msg.kind, msg.rtpParameters);
                        safeSend(ws, { type: 'sfu-produced', id: r.id, kind: msg.kind }, log);
                        break;
                    }
                    case 'sfu-stop-produce':
                        sfu.closePeer(sessionId, peerId);
                        break;
                    default:
                        break;
                }
            } catch (err) {
                log.warn(`[webrtc] signaling ${msg.type} failed for ${sessionId}: ${err.message}`);
                safeSend(ws, { type: 'sfu-error', error: err.message }, log);
            }
        });
    }

    function handleViewer(ws, sessionId) {
        ws.on('message', async (data) => {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }
            const client = clients.get(ws);
            if (!client) return;
            const peerId = client.peerId;
            try {
                switch (msg.type) {
                    case 'watch': {
                        if (!sfu.hasProducers(sessionId)) { safeSend(ws, { type: 'watch-queued', reason: 'awaiting_source' }, log); break; }
                        safeSend(ws, {
                            type: 'sfu-viewer-ready',
                            rtpCapabilities: await sfu.getRouterCapabilities(sessionId),
                            producers: sfu.getProducers(sessionId).filter(p => !p.paused && p.dtlsState === 'connected' && (p.iceState === 'connected' || p.iceState === 'completed')).map(p => ({ id: p.id, kind: p.kind })),
                        }, log);
                        break;
                    }
                    case 'sfu-viewer-create-transport': {
                        const t = await sfu.createTransport(sessionId, peerId);
                        safeSend(ws, { type: 'sfu-viewer-transport-created', id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters, iceServers: ice() }, log);
                        break;
                    }
                    case 'sfu-viewer-connect-transport':
                        await sfu.connectTransport(sessionId, peerId, msg.transportId, msg.dtlsParameters);
                        safeSend(ws, { type: 'sfu-viewer-transport-connected', transportId: msg.transportId }, log);
                        break;
                    case 'sfu-viewer-consume': {
                        const r = await sfu.consume(sessionId, peerId, msg.transportId, msg.producerId, msg.rtpCapabilities);
                        safeSend(ws, { type: 'sfu-viewer-consumed', id: r.id, producerId: r.producerId, kind: r.kind, rtpParameters: r.rtpParameters }, log);
                        break;
                    }
                    default:
                        break;
                }
            } catch (err) {
                log.warn(`[webrtc] viewer signaling ${msg.type} failed for ${sessionId}: ${err.message}`);
                safeSend(ws, { type: 'sfu-viewer-error', error: err.message }, log);
            }
        });
    }

    /** http server 'upgrade' handler. Returns true when the request was a signaling upgrade. */
    async function handleUpgrade(req, socket, head) {
        let pathname;
        try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { return false; }
        const bMatch = /^\/b\/([^/]+)\/?$/.exec(pathname);
        const wMatch = /^\/w\/(ses_[0-9A-HJKMNP-TV-Z]{26})\/?$/.exec(pathname);
        if (!bMatch && !wMatch) return false;

        if (bMatch) {
            // Admission runs before the handshake is completed, so a bad key never gets a socket.
            let adm;
            try { adm = await admit(decodeURIComponent(bMatch[1])); } catch (err) { adm = { error: err.message }; }
            if (!adm || adm.error) {
                log.log(`[webrtc] broadcast refused (${adm && adm.error}) from ${socket.remoteAddress || '?'}`);
                socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nX-OpenRe-Error: ' + (adm && adm.error || 'refused') + '\r\n\r\n');
                socket.destroy();
                return true;
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
                const peerId = adm.peerId || `bc-${adm.sessionId}`;
                clients.set(ws, { role: 'broadcaster', sessionId: adm.sessionId, peerId });
                ws.on('close', () => { clients.delete(ws); sfu.closePeer(adm.sessionId, peerId); endSession?.(adm.sessionId, 'broadcaster_disconnected'); });
                ws.on('error', () => {});
                safeSend(ws, { type: 'welcome', peerId, role: 'broadcaster', sessionId: adm.sessionId, iceServers: ice() }, log);
                handleBroadcaster(ws, adm);
            });
            return true;
        }

        // Viewer: only the generation that holds the session serves it.
        if (!sfu.hasRouter(wMatch[1])) { socket.destroy(); return true; }
        const peerId = `vw-${Math.random().toString(36).slice(2, 10)}`;
        wss.handleUpgrade(req, socket, head, (ws) => {
            clients.set(ws, { role: 'viewer', sessionId: wMatch[1], peerId });
            ws.on('close', () => { clients.delete(ws); sfu.closePeer(wMatch[1], peerId); });
            ws.on('error', () => {});
            safeSend(ws, { type: 'welcome', peerId, role: 'viewer', sessionId: wMatch[1], viewerCount: sfu.getViewerCount(wMatch[1]), iceServers: ice() }, log);
            handleViewer(ws, wMatch[1]);
        });
        return true;
    }

    function closeAll() {
        for (const ws of clients.keys()) { try { ws.close(); } catch { /* gone */ } }
        clients.clear();
        try { wss.close(); } catch { /* gone */ }
    }

    return { handleUpgrade, closeAll, clients };
}

module.exports = { createSignaling };
