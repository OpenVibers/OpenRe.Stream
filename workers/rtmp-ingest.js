'use strict';
/**
 * openre-rtmp-ingest — the RTMP transport worker (unit openre-rtmp-ingest@<release>.service).
 *
 * The same node-media-server 2.7.4 session code Live runs in-process (OpenVibe.Live
 * server/streaming/rtmp-server.js), with the lifecycle and ownership moved here:
 *
 *   public   0.0.0.0:OPENRE_RTMP_PORT (1936 until the RTMP cutover), SO_REUSEPORT so two
 *            generations can listen during a drain. Publish only; play is refused here.
 *   internal 127.0.0.1:<rtmpPlayPort>  RTMP play for Media's recorder (rtmp://…/live/<session id>)
 *            127.0.0.1:<flvPort>       HTTP-FLV for the restream worker and the playback proxy
 *            Both ports are this generation's own (from OPENRE_RTMP_INTERNAL_PORT_MIN..MAX) and are
 *            published in its worker row, so consumers always reach the process that holds the
 *            publisher.
 *
 * Authentication happens inside the publish handshake, synchronously, against OpenRe's hashed
 * keys only. An accepted publish is renamed from /live/<key> to /live/<session id> before
 * node-media-server registers it, so the key never appears in any play URL, log or descriptor.
 *
 * Drain: when the coordinator marks this generation draining (a newer one is ready) the public
 * listener closes — new encoder connections reach the new generation through the shared port —
 * and running publishers stay until they leave or the drain deadline passes. Then the process
 * exits by itself. SIGTERM starts the same drain; it never drops a live publisher.
 */
const http = require('http');
const net = require('net');
const path = require('path');
const NodeRtmpSession = require('node-media-server/src/node_rtmp_session');
const NodeFlvSession = require('node-media-server/src/node_flv_session');
const context = require('node-media-server/src/node_core_ctx');
const NmsLogger = require('node-media-server/src/node_core_logger');
const { createWorkerRuntime } = require('./runtime');

const SESSION_PATH_RE = /^\/live\/(ses_[0-9A-HJKMNP-TV-Z]{26})$/;

/** Bind the first free loopback port in [min, max] (skipping `skip`). */
function listenInRange(server, min, max, skip = new Set()) {
    return new Promise((resolve, reject) => {
        let port = min;
        const tryNext = () => {
            while (skip.has(port)) port++;
            if (port > max) { reject(new Error(`no free loopback port in ${min}-${max}`)); return; }
            const onError = (err) => {
                server.removeListener('listening', onListening);
                if (err.code === 'EADDRINUSE' || err.code === 'EACCES') { port++; tryNext(); } else reject(err);
            };
            const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, '127.0.0.1');
        };
        tryNext();
    });
}

function createRtmpIngest({ rt, log = console, exit = (code) => process.exit(code) }) {
    const { store, config } = rt;
    NmsLogger.setLogType(1); // errors only: the library's info lines would print stream paths
    const nmsConfig = {
        logType: 1,
        rtmp: { port: config.rtmp.port, chunk_size: config.rtmp.chunkSize, gop_cache: true, ping: 30, ping_timeout: 60 },
    };
    /** node-media-server session id → { sessionId, definitionId, endReason } */
    const publishers = new Map();
    let publicServers = [];
    const publicPorts = new Set([config.rtmp.port, ...config.rtmp.extraPorts]);
    let playServer = null;
    let flvServer = null;
    let endpoints = null;
    const handlers = [];

    const runtime = createWorkerRuntime({
        rt, kind: 'rtmp-ingest', log, exit,
        hooks: {
            onDrain: () => closePublic(),
            onDrainDeadline: () => endAll('drain_deadline'),
            onEndRequested: (s) => endSession(s.id, 'end_requested'),
            onLost: () => { for (const [nmsId] of publishers) stopNms(nmsId); return closeAll(); },
            onHeartbeat: () => refreshMediaInfo(),
            activeCount: () => publishers.size,
            onExit: () => closeAll(),
        },
    });

    function nms(id) { return context.sessions.get(id); }
    function stopNms(id) { const s = nms(id); if (s) { try { s.reject(); } catch { /* socket already gone */ } } }

    function on(event, fn) {
        const wrapped = (...args) => {
            try { fn(...args); } catch (err) {
                // A throw inside a node-media-server event is an uncaught exception, and that would
                // take every publisher on this worker with it.
                log.error(`[rtmp] ${event} handler failed: ${err.stack || err}`);
            }
        };
        context.nodeEvent.on(event, wrapped);
        handlers.push([event, wrapped]);
    }

    function isPublicSocket(session) {
        return Boolean(session && session.socket && publicPorts.has(session.socket.localPort));
    }

    on('prePublish', (id, streamPath) => {
        const s = nms(id);
        if (!s) return;
        const reject = (why) => { log.log(`[rtmp] publish refused (${why}) from ${s.ip}`); s.reject(); };
        // A second publish on a connection that already publishes: leave it to node-media-server,
        // which answers NetStream.Publish.BadConnection without touching the first stream.
        if (publishers.has(id)) return undefined;
        if (!isPublicSocket(s)) return reject('not the public listener');
        if (runtime.draining || !runtime.me || runtime.me.state !== 'ready') return reject('generation not taking sessions');
        if (publishers.size >= config.rtmp.maxPublishersPerWorker) return reject('worker full');
        const parts = String(streamPath).split('/');
        if (parts.length !== 3 || parts[1] !== 'live') return reject('bad path');
        const r = store.definitions.resolveIngestKey(parts[2], 'rtmp');
        if (r.error) return reject(r.error);
        const a = store.sessions.admit({ definition: r.definition, key: r.key, protocol: 'rtmp', worker: runtime.me });
        if (a.error) return reject(a.error);
        // Rename before node-media-server registers the publisher (it reads publishStreamPath
        // right after this synchronous event): from here on the stream is /live/<session id>.
        s.publishStreamPath = `/live/${a.session.id}`;
        publishers.set(id, { sessionId: a.session.id, definitionId: r.definition.id, endReason: null });
        log.log(`[rtmp] session ${a.session.id} accepted for ${r.definition.id} (key …${r.key.hint})`);
    });

    on('postPublish', (id) => {
        const p = publishers.get(id);
        if (!p) return;
        const t = store.sessions.transition(p.sessionId, 'live', { reason: 'media_flowing', actor: `worker:${runtime.me.id}` });
        if (!t.ok) {
            // The coordinator failed it meanwhile (lease) — the transport must not outlive its record.
            log.warn(`[rtmp] session ${p.sessionId} could not go live (${t.code}); closing`);
            stopNms(id);
        }
    });

    on('donePublish', (id) => {
        const p = publishers.get(id);
        if (!p) return;
        publishers.delete(id);
        store.sessions.finish(p.sessionId, { reason: p.endReason || 'publisher_disconnected', actor: `worker:${runtime.me.id}` });
        log.log(`[rtmp] session ${p.sessionId} ended (${p.endReason || 'publisher_disconnected'})`);
        if (runtime.draining) runtime.exitWhenIdle();
    });

    on('prePlay', (id, streamPath) => {
        const s = nms(id);
        if (!s) return;
        // RTMP play only on the loopback play port, and only by session path.
        if (s instanceof NodeRtmpSession && s.socket.localPort !== endpoints.rtmpPlayPort) { s.reject(); return; }
        if (!SESSION_PATH_RE.test(String(streamPath))) s.reject();
    });

    function refreshMediaInfo() {
        for (const [id, p] of publishers) {
            const s = nms(id);
            if (!s || !s.isPublishing) continue;
            store.sessions.setMediaInfo(p.sessionId, {
                video_codec: s.videoCodecName || null,
                width: s.videoWidth || null,
                height: s.videoHeight || null,
                fps: s.videoFps || null,
                audio_codec: s.audioCodecName || null,
                audio_samplerate: s.audioSamplerate || null,
                bitrate_kbps: s.bitrate || null,
            });
        }
    }

    function endSession(sessionId, reason) {
        for (const [id, p] of publishers) {
            if (p.sessionId === sessionId) { p.endReason = reason; stopNms(id); return true; }
        }
        // Not ours any more (publisher already gone): make sure the record is closed.
        store.sessions.finish(sessionId, { reason, actor: `worker:${runtime.me.id}` });
        return false;
    }

    function endAll(reason) {
        for (const [id, p] of publishers) { p.endReason = reason; stopNms(id); }
    }

    function closePublic() {
        if (!publicServers.length) return;
        for (const srv of publicServers.splice(0)) srv.close();
        log.log('[rtmp] public listener closed; running publishers stay until they leave');
    }

    function closeAll() {
        closePublic();
        const closing = [];
        for (const srv of [playServer, flvServer]) {
            if (!srv) continue;
            // Loopback players (Media's recorder, restream ffmpeg, the playback proxy) would keep
            // close() waiting forever: node-media-server parks them as idle players.
            for (const sock of srv.openSockets || []) sock.destroy();
            srv.closeAllConnections?.();
            closing.push(new Promise(r => srv.close(() => r())));
        }
        playServer = null;
        flvServer = null;
        for (const [event, fn] of handlers.splice(0)) context.nodeEvent.removeListener(event, fn);
        return Promise.all(closing);
    }

    function newRtmpServer() {
        const srv = net.createServer((socket) => {
            srv.openSockets.add(socket);
            socket.on('close', () => srv.openSockets.delete(socket));
            const session = new NodeRtmpSession(nmsConfig, socket);
            session.run();
        });
        srv.openSockets = new Set();
        return srv;
    }

    async function start() {
        // Internal endpoints first: they are how this generation is reached, so they go in the
        // worker row before it can take a session.
        playServer = newRtmpServer();
        const rtmpPlayPort = await listenInRange(playServer, config.rtmp.internalPortMin, config.rtmp.internalPortMax);
        flvServer = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1');
            const m = /^\/live\/(ses_[0-9A-HJKMNP-TV-Z]{26})\.flv$/.exec(url.pathname);
            if (req.method !== 'GET' || !m) { res.statusCode = 404; return res.end(); }
            if (!context.publishers.has(`/live/${m[1]}`)) { res.statusCode = 404; return res.end(); }
            res.setHeader('Content-Type', 'video/x-flv');
            res.setHeader('Cache-Control', 'no-cache, no-store');
            req.nmsConnectionType = 'http';
            new NodeFlvSession(nmsConfig, req, res).run();
            return undefined;
        });
        const flvPort = await listenInRange(flvServer, config.rtmp.internalPortMin, config.rtmp.internalPortMax, new Set([rtmpPlayPort]));
        endpoints = { publicPort: config.rtmp.port, publicPorts: [...publicPorts], rtmpPlayPort, flvPort };
        runtime.register(endpoints);

        for (const port of publicPorts) {
            const srv = newRtmpServer();
            await new Promise((resolve, reject) => {
                srv.once('error', reject);
                srv.listen({ port, host: config.rtmp.bindHost, reusePort: true }, () => resolve());
            });
            srv.on('error', (err) => log.error(`[rtmp] public listener ${port}: ${err.message}`));
            publicServers.push(srv);
        }
        runtime.ready();
        log.log(`[rtmp] generation ${runtime.me.generation} ready: publish ${config.rtmp.bindHost}:${[...publicPorts].join(',')}, play 127.0.0.1:${rtmpPlayPort}, flv 127.0.0.1:${flvPort}`);
        return endpoints;
    }

    return {
        start,
        runtime,
        endpoints: () => endpoints,
        publishers: () => [...publishers.values()],
        drain: (reason) => runtime.drainNow(reason),
        close: closeAll,
    };
}

if (require.main === module) {
    require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
    const { load } = require('../server/config');
    const { openRuntime } = require('../server/store');
    const rt = openRuntime({ config: load() });
    const worker = createRtmpIngest({ rt });
    let started = false;
    worker.start().then(() => { started = true; }, (err) => { console.error(`[rtmp] failed to start: ${err.stack || err}`); process.exit(1); });
    // node-media-server's own server logs an uncaught exception and keeps going (NodeMediaServer.run
    // registers exactly that). A malformed packet from one encoder must not take every other
    // publisher on this worker down with it, so the worker keeps that behaviour once it is up.
    process.on('uncaughtException', (err) => {
        console.error(`[rtmp] uncaught exception (worker keeps running): ${err && err.stack || err}`);
        if (!started) process.exit(1);
    });
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => worker.drain(sig));
}

module.exports = { createRtmpIngest, listenInRange };
