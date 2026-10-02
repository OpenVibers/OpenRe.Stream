'use strict';
/**
 * The mediasoup SFU, one Router per OpenRe session, ported from OpenVibe.Live
 * server/streaming/webrtc-sfu.js. The differences that matter:
 *
 *   - a "room" is an OpenRe ingest session id (not Live's `stream-<id>`), so a router's lifetime
 *     is exactly the session's;
 *   - consumer/producer/transport bookkeeping is unchanged, so the viewer signaling and the
 *     PlainRTP egress paths behave like Live's;
 *   - PlainRTP consumers (restream, Media's RTP recording, thumbnails) send to an explicit remote
 *     ip:port the caller chose, because on OpenRe the consumer side (ffmpeg) runs in another process.
 *
 * `mediasoup` is required lazily: the module loads (and its turn-free helpers run) on a host where
 * the native dependency is not installed, and `createSfu().available` is false there. The worker
 * refuses to start in that case rather than register a generation that can never take a session.
 */
const { EventEmitter } = require('events');

function createSfu({ config, log = console }) {
    let mediasoup = null;
    try { mediasoup = require('mediasoup'); } catch { mediasoup = null; }

    const media = config.webrtc.media;
    const emitter = new EventEmitter();
    const workers = [];
    let rr = 0;
    /** sessionId → { router, producers: Map<id,{producer,peerId,transportId}>, consumers: Map<id,{consumer,peerId}>, transports: Map<key,transport> } */
    const routers = new Map();
    let announcedIp = '';

    async function init() {
        if (!mediasoup) throw new Error('mediasoup is not installed (add it to package.json and npm install)');
        if (workers.length) return workers[0];
        for (let i = 0; i < media.workers; i++) {
            const w = await mediasoup.createWorker({
                logLevel: 'warn',
                rtcMinPort: media.minPort,
                rtcMaxPort: media.maxPort,
            });
            w.on('died', () => {
                log.error(`[webrtc] mediasoup worker ${w.pid} died`);
                try { w.close(); } catch { /* already gone */ }
                emitter.emit('worker-died', w);
            });
            workers.push(w);
        }
        log.log(`[webrtc] mediasoup: ${workers.length} worker(s), RTC UDP ${media.minPort}-${media.maxPort}`);
        return workers[0];
    }

    function setAnnouncedIp(ip) { announcedIp = ip || ''; }

    function pickWorker() {
        if (!workers.length) throw new Error('SFU not initialised');
        return workers[rr++ % workers.length];
    }

    async function getOrCreateRouter(sessionId) {
        if (routers.has(sessionId)) return routers.get(sessionId);
        if (!workers.length) throw new Error('SFU not initialised');
        const router = await pickWorker().createRouter({ mediaCodecs: media.mediaCodecs });
        const room = { router, producers: new Map(), consumers: new Map(), transports: new Map() };
        routers.set(sessionId, room);
        return room;
    }

    function room(sessionId) { return routers.get(sessionId) || null; }

    function hasRouter(sessionId) { return routers.has(sessionId); }

    async function getRouterCapabilities(sessionId) {
        return (await getOrCreateRouter(sessionId)).router.rtpCapabilities;
    }

    const listenIps = () => [{ ip: media.listenIp, ...(announcedIp ? { announcedIp } : {}) }];

    async function createTransport(sessionId, peerId, options = {}) {
        const r = await getOrCreateRouter(sessionId);
        const transportOptions = {
            listenIps: listenIps(),
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate: 3000000,
        };
        // OBS/libdatachannel WHIP clients do not answer RFC 7675 consent requests; Live disables the
        // consent timeout for them the same way.
        if (typeof options.iceConsentTimeout === 'number') transportOptions.iceConsentTimeout = options.iceConsentTimeout;
        const transport = await r.router.createWebRtcTransport(transportOptions);
        transport.on('dtlsstatechange', (state) => {
            if (state === 'closed' || state === 'failed') { try { transport.close(); } catch { /* gone */ } }
        });
        r.transports.set(`${peerId}-${transport.id}`, transport);
        return {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
            transport,
        };
    }

    function lookupTransport(sessionId, peerId, transportId) {
        const r = room(sessionId);
        return r ? r.transports.get(`${peerId}-${transportId}`) : null;
    }

    async function connectTransport(sessionId, peerId, transportId, dtlsParameters) {
        const transport = lookupTransport(sessionId, peerId, transportId);
        if (!transport) throw new Error('Transport not found');
        await transport.connect({ dtlsParameters });
        return transport;
    }

    /**
     * WHIP ICE restart (RFC 9725 §4.3.2). mediasoup's WebRtcTransport is ICE-lite and always the
     * controlled agent: it has no remote candidates to add (it learns the peer's address from the
     * peer's connectivity checks), so a restart only issues new local credentials.
     */
    async function restartIce(sessionId, peerId, transportId) {
        const transport = lookupTransport(sessionId, peerId, transportId);
        if (!transport) throw new Error('Transport not found');
        return await transport.restartIce();
    }

    async function produce(sessionId, peerId, transportId, kind, rtpParameters) {
        const r = room(sessionId);
        if (!r) throw new Error('Router not found');
        const transport = r.transports.get(`${peerId}-${transportId}`);
        if (!transport) throw new Error('Transport not found');
        const producer = await transport.produce({ kind, rtpParameters });
        r.producers.set(producer.id, { producer, peerId, transportId });
        producer.on('transportclose', () => { r.producers.delete(producer.id); emitter.emit('producer-removed', { sessionId, producerId: producer.id, kind }); });
        emitter.emit('producer-added', { sessionId, producerId: producer.id, kind, peerId });
        return { id: producer.id, producer };
    }

    async function consume(sessionId, peerId, transportId, producerId, rtpCapabilities) {
        const r = room(sessionId);
        if (!r) throw new Error('Router not found');
        if (!r.router.canConsume({ producerId, rtpCapabilities })) throw new Error('Cannot consume this producer');
        const transport = r.transports.get(`${peerId}-${transportId}`);
        if (!transport) throw new Error('Transport not found');
        const consumer = await transport.consume({ producerId, rtpCapabilities, paused: false });
        r.consumers.set(consumer.id, { consumer, peerId });
        consumer.on('transportclose', () => { r.consumers.delete(consumer.id); });
        consumer.on('producerclose', () => {
            try { consumer.close(); } catch { /* gone */ }
            r.consumers.delete(consumer.id);
            emitter.emit('consumer-closed', { sessionId, peerId, consumerId: consumer.id, kind: consumer.kind });
        });
        if (consumer.kind === 'video') {
            // A late viewer must not wait for the source's GOP boundary: nudge it a few times.
            for (const d of [0, 400, 1200]) setTimeout(() => { consumer.requestKeyFrame().catch(() => {}); }, d).unref?.();
        }
        return {
            id: consumer.id, producerId: consumer.producerId, kind: consumer.kind,
            rtpParameters: consumer.rtpParameters, consumer,
        };
    }

    /**
     * A PlainRTP consumer that sends a producer's RTP to an explicit remote ip:port pair (the
     * restream worker's ffmpeg, Media's RTP ingest, or the thumbnail grabber). Returns the codec
     * facts the caller needs to write an SDP.
     */
    async function createPlainConsumer(sessionId, producerId, { remoteIp = '127.0.0.1', remotePort, remoteRtcpPort }) {
        const r = room(sessionId);
        if (!r) throw new Error('Router not found');
        const transport = await r.router.createPlainTransport({ listenIp: { ip: '127.0.0.1' }, rtcpMux: false, comedia: false });
        try {
            await transport.connect({ ip: remoteIp, port: remotePort, rtcpPort: remoteRtcpPort });
        } catch (err) {
            try { transport.close(); } catch { /* gone */ }
            throw err;
        }
        const consumer = await transport.consume({ producerId, rtpCapabilities: r.router.rtpCapabilities, paused: false });
        const key = `plain-${transport.id}`;
        r.transports.set(key, transport);
        r.consumers.set(consumer.id, { consumer, peerId: '__egress__' });
        const cleanup = () => { r.consumers.delete(consumer.id); r.transports.delete(key); };
        consumer.on('transportclose', cleanup);
        consumer.on('producerclose', () => {
            cleanup();
            try { transport.close(); } catch { /* gone */ }
            emitter.emit('consumer-closed', { sessionId, peerId: '__egress__', consumerId: consumer.id, kind: consumer.kind });
        });
        const codec = consumer.rtpParameters.codecs[0];
        const encoding = consumer.rtpParameters.encodings && consumer.rtpParameters.encodings[0];
        if (consumer.kind === 'video') {
            for (const d of [0, 500, 1500, 3000]) setTimeout(() => { consumer.requestKeyFrame().catch(() => {}); }, d).unref?.();
        }
        return {
            transportId: transport.id,
            consumerId: consumer.id,
            kind: consumer.kind,
            payloadType: codec && codec.payloadType,
            clockRate: codec && codec.clockRate,
            mimeType: codec && codec.mimeType,
            channels: codec && codec.channels,
            ssrc: encoding && encoding.ssrc,
            codecParameters: codec && codec.parameters,
        };
    }

    function closePlainConsumer(sessionId, transportId) {
        const r = room(sessionId);
        if (!r) return;
        const key = `plain-${transportId}`;
        const transport = r.transports.get(key);
        if (!transport) return;
        for (const [id, entry] of r.consumers) {
            if (entry.peerId === '__egress__' && entry.consumer && entry.consumer.transportId === transportId) { try { entry.consumer.close(); } catch { /* gone */ } r.consumers.delete(id); }
        }
        try { transport.close(); } catch { /* gone */ }
        r.transports.delete(key);
    }

    function findProducerByKind(sessionId, kind) {
        const r = room(sessionId);
        if (!r) return null;
        for (const [id, { producer, peerId }] of r.producers) if (producer.kind === kind && !producer.closed) return { id, peerId };
        return null;
    }

    function hasProducers(sessionId) {
        const r = room(sessionId);
        return r ? [...r.producers.values()].some(({ producer }) => !producer.closed) : false;
    }

    function getProducers(sessionId) {
        const r = room(sessionId);
        if (!r) return [];
        return [...r.producers.entries()]
            .filter(([, { producer }]) => !producer.closed)
            .map(([id, { producer, peerId, transportId }]) => {
                const transport = r.transports.get(`${peerId}-${transportId}`);
                return { id, peerId, kind: producer.kind, paused: producer.paused, dtlsState: transport ? transport.dtlsState : 'no-transport', iceState: transport ? transport.iceState : 'no-transport' };
            });
    }

    /** Live counts unique consumer peers (viewers) in a room. */
    function getViewerCount(sessionId) {
        const r = room(sessionId);
        if (!r) return 0;
        const peers = new Set();
        for (const { peerId } of r.consumers.values()) if (peerId !== '__egress__') peers.add(peerId);
        return peers.size;
    }

    function closePeer(sessionId, peerId) {
        const r = room(sessionId);
        if (!r) return;
        for (const [id, entry] of [...r.consumers]) {
            if (entry.peerId === peerId) { try { entry.consumer.close(); } catch { /* gone */ } r.consumers.delete(id); }
        }
        for (const [key, transport] of [...r.transports]) {
            if (key.startsWith(`${peerId}-`)) { try { transport.close(); } catch { /* gone */ } r.transports.delete(key); }
        }
        for (const [id, entry] of [...r.producers]) {
            if (entry.peerId === peerId) { try { entry.producer.close(); } catch { /* gone */ } r.producers.delete(id); }
        }
    }

    function closeSession(sessionId) {
        const r = routers.get(sessionId);
        if (!r) return;
        for (const transport of r.transports.values()) { try { transport.close(); } catch { /* gone */ } }
        try { r.router.close(); } catch { /* gone */ }
        routers.delete(sessionId);
    }

    function closeAll() {
        for (const sessionId of [...routers.keys()]) closeSession(sessionId);
        for (const w of workers.splice(0)) { try { w.close(); } catch { /* gone */ } }
    }

    return {
        get available() { return Boolean(mediasoup); },
        on: (...args) => emitter.on(...args),
        off: (...args) => emitter.off(...args),
        init, setAnnouncedIp,
        getOrCreateRouter, hasRouter, getRouterCapabilities,
        createTransport, connectTransport, restartIce, produce, consume,
        createPlainConsumer, closePlainConsumer,
        findProducerByKind, hasProducers, getProducers, getViewerCount,
        closePeer, closeSession, closeAll,
    };
}

module.exports = { createSfu };
