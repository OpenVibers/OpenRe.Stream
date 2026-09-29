'use strict';
/**
 * One entry point for every process: open the database, the event outbox and the store modules.
 *
 *   const rt = await openRuntime({ config });   // rt.db, rt.events, rt.store.{definitions,sessions,...}
 */
const { openDb } = require('../db');
const { createEvents } = require('../events');
const { createBox } = require('../secrets');
const { createDefinitions } = require('./definitions');
const { createWorkers } = require('./workers');
const { createSessions } = require('./sessions');
const { createOutputs } = require('./outputs');
const { createRecordings } = require('./recordings');

/**
 * The handle every store gets: its transactions are SERIALIZABLE. Several OpenRe processes change the same rows (a
 * publish admitted by ingest while the coordinator fails a lost worker's session); PostgreSQL detects the conflict
 * and the SDK runs the loser again (40001 is retried).
 */
function serializable(db) {
    if (db.serializable) return db;
    return new Proxy(db, {
        get(target, key) {
            if (key === 'serializable') return true;
            if (key === 'tx') return async (fn, opts = {}) => await target.tx(fn, { isolation: 'serializable', ...opts });
            const v = target[key];
            return typeof v === 'function' ? v.bind(target) : v;
        },
    });
}

function createStore({ db, config, events, clock, box, log = console }) {
    db = serializable(db);
    const definitions = createDefinitions({ db, config, events, clock });
    const workers = createWorkers({ db, config, clock });
    const sessions = createSessions({ db, config, events, clock, definitions, workers });
    const outputs = createOutputs({ db, config, events, clock, box, definitions, sessions });
    const recordings = createRecordings({ db, config, events, clock, definitions, sessions, log });
    return { definitions, workers, sessions, outputs, recordings };
}

async function openRuntime({ config, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, db } = {}) {
    db = serializable(db || await openDb(config, { log }));
    const events = createEvents({ config, db, fetchImpl, now: () => clock.now(), log });
    const box = createBox({ key: config.secretsKey, previous: config.secretsKeyPrevious });
    const store = createStore({ db, config, events, clock, box, log });
    return { db, events, box, store, clock, config };
}

module.exports = { openRuntime, createStore, serializable };
