'use strict';
/**
 * The worker interface for the transports OpenRe does not carry yet: WHIP/WebRTC ingest
 * (werift), the mediasoup SFU and JSMPEG. Each registers a generation with the coordinator, takes
 * part in the drain protocol and heartbeats like a real transport worker, and carries nothing:
 * activeCount() is always 0, and no session of these protocols is ever admitted (their stream
 * definitions may list the protocol, but no worker accepts it, so encoders keep using Live).
 *
 * This is the seam the port lands in: a ported transport replaces `admit nothing` with its
 * session code and reports its sessions through store.sessions exactly like rtmp-ingest.js.
 * Nothing in production runs these (deploy/ has no unit for them).
 */
const path = require('path');
const { createWorkerRuntime } = require('./runtime');

const PORT_STATUS = Object.freeze({
    'webrtc-ingest': 'WHIP/WebRTC ingest (Live: server/streaming/whip-handler.js, werift) — not ported',
    sfu: 'WebRTC SFU (Live: server/streaming/webrtc-sfu.js + broadcast-server.js, mediasoup) — not ported',
    jsmpeg: 'JSMPEG relay (Live: server/streaming/jsmpeg-relay.js) — not ported',
});

function createUnportedTransport({ rt, kind, log = console, exit = (code) => process.exit(code) }) {
    if (!PORT_STATUS[kind]) throw new Error(`no unported transport "${kind}"`);
    const runtime = createWorkerRuntime({ rt, kind, log, exit, hooks: { activeCount: () => 0 } });
    return {
        runtime,
        start() {
            runtime.register({ ported: false, note: PORT_STATUS[kind] });
            runtime.ready();
            log.log(`[${kind}] registered generation ${runtime.me.generation}: ${PORT_STATUS[kind]}`);
            return runtime.me;
        },
        drain: (reason) => runtime.drainNow(reason),
    };
}

function main(kind) {
    require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
    const { load, exitIfDrill } = require('../server/config');
    const { openRuntime } = require('../server/store');
    const config = load();
    exitIfDrill(config, `openre-${kind}`);
    const w = createUnportedTransport({ rt: openRuntime({ config }), kind });
    w.start();
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => w.drain(sig));
}

module.exports = { createUnportedTransport, PORT_STATUS, main };
