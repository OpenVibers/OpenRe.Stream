'use strict';
/** openre-webrtc-ingest: worker interface only, the transport is not ported yet (see unported-transport.js). */
if (require.main === module) require('./unported-transport').main('webrtc-ingest').catch((err) => { console.error(`[webrtc-ingest] failed to start: ${err && err.stack || err}`); process.exit(1); });
