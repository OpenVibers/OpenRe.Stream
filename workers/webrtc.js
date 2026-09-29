'use strict';
/**
 * openre-webrtc — the WebRTC transport worker (unit openre-webrtc@<release>.service).
 *
 * One worker owns WHIP ingest, the mediasoup producers/consumers and viewer signaling (T4 decision
 * 1: mediasoup is single-process, so ingest and consumption cannot be split). This replaces the
 * webrtc-ingest.js and sfu.js stubs.
 *
 * Not ported yet: it registers a real generation and takes part in the drain protocol, but carries
 * nothing (see unported-transport.js). The next T4 job ports it.
 */
if (require.main === module) require('./unported-transport').main('webrtc').catch((err) => { console.error(`[webrtc] failed to start: ${err && err.stack || err}`); process.exit(1); });
module.exports = require('./unported-transport');
