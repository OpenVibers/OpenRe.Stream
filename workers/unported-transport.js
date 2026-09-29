'use strict';
/**
 * The worker interface for the transports OpenRe does not carry yet. Today only WebRTC: the port
 * (WHIP ingest + mediasoup SFU + viewer signaling) is T4's next job (decision 1, one worker owns
 * all of it). It registers a generation with the coordinator, takes part in the drain protocol and
 * heartbeats like a real transport worker, and carries nothing: activeCount() is always 0, and no
 * 'webrtc' session is ever admitted (a definition may list the protocol, but its HTTP error is
 * 'protocol_not_allowed' — no worker accepts it, so encoders keep using Live).
 *
 * This is the seam the port lands in: it replaces `admit nothing` with its session code and reports
 * sessions through store.sessions exactly like rtmp-ingest.js / jsmpeg.js.
 */
const path = require('path');
const { createWorkerRuntime } = require('./runtime');

const PORT_STATUS = Object.freeze({
    webrtc: 'WebRTC (WHIP ingest + mediasoup SFU + viewer signaling; Live: server/streaming/whip-handler.js + webrtc-sfu.js + broadcast-server.js) — not ported',
});

function createUnportedTransport({ rt, kind, log = console, exit = (code) => process.exit(code) }) {
    if (!PORT_STATUS[kind]) throw new Error(`no unported transport "${kind}"`);
    const runtime = createWorkerRuntime({ rt, kind, log, exit, hooks: { activeCount: () => 0 } });
    return {
        runtime,
        async start() {
            await runtime.register({ ported: false, note: PORT_STATUS[kind] });
            await runtime.ready();
            log.log(`[${kind}] registered generation ${runtime.me.generation}: ${PORT_STATUS[kind]}`);
            return runtime.me;
        },
        drain: async (reason) => await runtime.drainNow(reason),
    };
}

async function main(kind) {
    require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
    const { load, exitIfDrill } = require('../server/config');
    const { openRuntime } = require('../server/store');
    const config = load();
    exitIfDrill(config, `openre-${kind}`);
    const w = createUnportedTransport({ rt: await openRuntime({ config }), kind });
    await w.start();
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => w.drain(sig).catch((err) => console.error(`[${kind}] drain failed on ${sig}: ${err && (err.stack || err.message) || err}`)));
}

module.exports = { createUnportedTransport, PORT_STATUS, main };
