'use strict';
/** openre-jsmpeg: worker interface only, the transport is not ported yet (see unported-transport.js). */
if (require.main === module) require('./unported-transport').main('jsmpeg').catch((err) => { console.error(`[jsmpeg] failed to start: ${err && err.stack || err}`); process.exit(1); });
