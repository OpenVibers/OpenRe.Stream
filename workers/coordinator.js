'use strict';
/**
 * openre-session-coordinator — leases, generations, output assignment, recording requests and the
 * event relay (unit openre-session-coordinator.service). See server/coordinator.js.
 *
 * Restarting it never touches a transport: workers keep their sessions and heartbeats; a stopped
 * coordinator only delays output assignment, recording requests and event publishing.
 */
const path = require('path');

/**
 * Best-effort housekeeping on a 6-hour timer: `prune` is async and the timer is fire-and-forget, so its rejection
 * must be handled — an unhandled one ends the coordinator (Node 22), delaying output assignment and the events
 * relay. Wrapping the call also turns a synchronous throw (an absent outbox) into the same logged path.
 */
function pruneOutbox(outbox, log = console) {
    return Promise.resolve().then(() => outbox.prune()).catch((err) => log.error(`[coordinator] outbox prune failed (next time): ${err && err.message || err}`));
}

if (require.main === module) {
    (async () => {
        require('dotenv').config({ path: process.env.OPENRE_ENV_FILE || path.join(process.cwd(), '.env') });
        const { load, exitIfDrill } = require('../server/config');
        const { openRuntime } = require('../server/store');
        const { createCoordinator } = require('../server/coordinator');
        const { createMediaClient } = require('../server/media-client');
        const config = load();
        exitIfDrill(config, 'openre-session-coordinator');
        const rt = await openRuntime({ config });
        const media = createMediaClient({ config });
        const lineage = require('../server/lineage').createLineage({ db: rt.db, config });
        const coordinator = createCoordinator({ rt, media, lineage });
        coordinator.start();
        console.log(`[coordinator] running (events relay ${rt.events.configured ? 'on' : 'off: EVENTS_URL/OV_OAUTH_CLIENT_SECRET not set'}, recordings ${media.configured ? `on → ${config.media.url} app ${config.media.appId}` : 'off'}, Live lineage ${lineage.enabled ? 'on' : 'off'})`);
        // prune is async: a bare call would reject unhandled (Node ends the coordinator) instead of being caught.
        const prune = setInterval(() => pruneOutbox(rt.events.outbox, console), 6 * 60 * 60 * 1000);
        prune.unref();
        const shutdown = (sig) => {
            console.log(`[coordinator] ${sig}: stopping`);
            coordinator.stop().then(() => { rt.db.close(); process.exit(0); }, () => process.exit(1));
            setTimeout(() => process.exit(1), 10000).unref();
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    })().catch((err) => { console.error(`[coordinator] failed to start: ${err && err.stack || err}`); process.exit(1); });
}

module.exports = { pruneOutbox };
