'use strict';
/**
 * OpenRe → OpenVibe.Events through the openvibe-sdk transactional outbox (ADR-004).
 *
 * Every OpenRe process can enqueue (the row commits in the same SQLite transaction as the change
 * it describes); only the session coordinator runs the relay that publishes rows with OpenRe's
 * service token (audience openvibe.events, capability events.event.publish). Events down, Network
 * down or no credentials yet: rows wait and are retried; nothing in the transport path waits.
 *
 * Event types (source "openre"):
 *   openre.session.started      a session reached live                    subject ingest_session
 *   openre.session.ended        a session that had been live ended        subject ingest_session
 *   openre.session.failed       a session failed (worker lost, error)     subject ingest_session
 *   openre.output.healthy       a restream output confirmed live          subject output
 *   openre.output.failed        an output gave up (circuit breaker)       subject output
 *   openre.recording.requested  Media accepted a recording request        subject recording
 *   openre.key.rotated          an ingest key was rotated                 subject stream
 * Payloads never carry an ingest key or a destination key.
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');

const TYPES = Object.freeze({
    sessionStarted: 'openre.session.started',
    sessionEnded: 'openre.session.ended',
    sessionFailed: 'openre.session.failed',
    outputHealthy: 'openre.output.healthy',
    outputFailed: 'openre.output.failed',
    recordingRequested: 'openre.recording.requested',
    keyRotated: 'openre.key.rotated',
});

/**
 * createEvents({ config, db, fetchImpl, now, log }) -> { outbox, enqueue, configured, start, stop, status }
 * enqueue(envelope) must run inside the transaction that makes the change.
 */
function createEvents({ config, db, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console }) {
    // A restore drill (OPENRE_DRILL) never publishes: its outbox rows describe a restored copy.
    const configured = Boolean(config.events.url && config.oauth.clientSecret && config.events.publish && !config.drill);
    let tokenProvider = null;
    if (configured) {
        tokenProvider = createServiceTokenClient({
            tokenUrl: `${config.networkInternalUrl}/oauth/token`,
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            fetch: fetchImpl,
        });
    }
    // Without credentials the client is only used to fill envelopes (prepare), never to send.
    const client = createClient({
        baseUrls: { events: config.events.url || 'http://127.0.0.1:4300' },
        ...(tokenProvider ? { tokenProvider } : { token: 'unconfigured' }),
        fetch: fetchImpl,
        retries: 0,
        autoDiscover: false,
        onWarning: () => {},
    });
    const eventsClient = createEventsClient(client, { source: 'openre' });
    let lastError = null;
    const outbox = createOutbox(db, {
        events: eventsClient,
        intervalMs: config.events.intervalMs,
        now,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) log.warn(`[events] publish failed (will retry): ${msg}`);
            lastError = msg;
        },
    });
    outbox.ensureSchema();

    return {
        outbox,
        configured,
        enqueue: (envelope) => outbox.enqueue(envelope),
        start() { if (configured) outbox.start(); return configured; },
        stop: () => outbox.stop(),
        status: () => ({ configured, pending: outbox.pending(), rejected: outbox.rejected(), last_error: lastError }),
    };
}

module.exports = { createEvents, TYPES };
