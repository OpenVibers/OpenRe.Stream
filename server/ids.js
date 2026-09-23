'use strict';
/**
 * OpenRe identifiers: <prefix>_<ULID> (the ULID from openvibe-contracts ids, so they sort by
 * creation time like every other OpenVibe id). Prefixes are OpenRe's own entity types.
 */
const { ids } = require('openvibe-contracts');

const PREFIX = Object.freeze({
    stream: 'std',        // stream (input) definition
    key: 'key',           // ingest key record (never the key itself)
    session: 'ses',       // ingest session
    destination: 'dst',   // restream destination
    output: 'out',        // one destination run inside one session
    worker: 'wrk',        // one transport worker process (one generation)
    recording: 'rec',     // recording request to Media
});

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const RE = Object.fromEntries(Object.entries(PREFIX).map(([k, p]) => [k, new RegExp(`^${p}_${ULID}$`)]));

function newId(kind, now) {
    const p = PREFIX[kind];
    if (!p) throw new TypeError(`no OpenRe id prefix for "${kind}"`);
    return `${p}_${ids.ulid(now)}`;
}

function isId(kind, value) {
    return typeof value === 'string' && Boolean(RE[kind]) && RE[kind].test(value);
}

module.exports = { newId, isId, PREFIX };
