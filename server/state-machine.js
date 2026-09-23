'use strict';
/**
 * Ingest session lifecycle:
 *
 *     starting ──► live ──► ending ──► ended
 *        │          │         │
 *        └──────────┴─────────┴──────► failed
 *
 *   starting  the worker accepted the publish handshake (key valid, lease taken)
 *   live      media is flowing (RTMP postPublish)
 *   ending    the publisher left or an end was requested; outputs and recording are wound down
 *   ended     terminal, clean
 *   failed    terminal, the transport was lost (worker died, lease expired, internal error)
 *
 * A session that never reached live may still go starting → ending → ended (a publisher that
 * disconnects during the handshake); it produced no started event, so it produces no ended event.
 */

const STATES = Object.freeze(['starting', 'live', 'ending', 'ended', 'failed']);
const TERMINAL = new Set(['ended', 'failed']);
const NEXT = Object.freeze({
    starting: ['live', 'ending', 'failed'],
    live: ['ending', 'failed'],
    ending: ['ended', 'failed'],
    ended: [],
    failed: [],
});

function canTransition(from, to) {
    return Boolean(NEXT[from]) && NEXT[from].includes(to);
}

function isTerminal(state) {
    return TERMINAL.has(state);
}

module.exports = { STATES, NEXT, TERMINAL, canTransition, isTerminal };
