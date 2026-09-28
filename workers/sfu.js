'use strict';
/** openre-sfu: worker interface only, the transport is not ported yet (see unported-transport.js). */
if (require.main === module) require('./unported-transport').main('sfu').catch((err) => { console.error(`[sfu] failed to start: ${err && err.stack || err}`); process.exit(1); });
