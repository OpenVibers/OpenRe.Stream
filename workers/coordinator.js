'use strict';
/**
 * openre-session-coordinator — leases, generations, output assignment, recording requests and the
 * event relay (unit openre-session-coordinator.service). See server/coordinator.js.
 *
 * Restarting it never touches a transport: workers keep their sessions and heartbeats; a stopped
 * coordinator only delays output assignment, recording requests and event publishing.
 */
const path = require('path');

if (require.main === module) {
    require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
    const { load, exitIfDrill } = require('../server/config');
    const { openRuntime } = require('../server/store');
    const { createCoordinator } = require('../server/coordinator');
    const { createMediaClient } = require('../server/media-client');
    const config = load();
    exitIfDrill(config, 'openre-session-coordinator');
    const rt = openRuntime({ config });
    const media = createMediaClient({ config });
    const coordinator = createCoordinator({ rt, media });
    coordinator.start();
    console.log(`[coordinator] running (events relay ${rt.events.configured ? 'on' : 'off: EVENTS_URL/OV_OAUTH_CLIENT_SECRET not set'}, recordings ${media.configured ? `on → ${config.media.url} app ${config.media.appId}` : 'off'})`);
    const prune = setInterval(() => { try { rt.events.outbox.prune(); } catch { /* next time */ } }, 6 * 60 * 60 * 1000);
    prune.unref();
    const shutdown = (sig) => {
        console.log(`[coordinator] ${sig}: stopping`);
        coordinator.stop().then(() => { rt.db.close(); process.exit(0); }, () => process.exit(1));
        setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
