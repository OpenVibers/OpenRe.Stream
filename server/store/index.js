'use strict';
/**
 * One entry point for every process: open the database, the event outbox and the store modules.
 *
 *   const rt = openRuntime({ config });   // rt.db, rt.events, rt.store.{definitions,sessions,...}
 */
const { openDb } = require('../db');
const { createEvents } = require('../events');
const { createBox } = require('../secrets');
const { createDefinitions } = require('./definitions');
const { createWorkers } = require('./workers');
const { createSessions } = require('./sessions');
const { createOutputs } = require('./outputs');
const { createRecordings } = require('./recordings');

function createStore({ db, config, events, clock, box, log = console }) {
    const definitions = createDefinitions({ db, config, events, clock });
    const workers = createWorkers({ db, config, clock });
    const sessions = createSessions({ db, config, events, clock, definitions, workers });
    const outputs = createOutputs({ db, config, events, clock, box, definitions, sessions });
    const recordings = createRecordings({ db, config, events, clock, definitions, sessions, log });
    return { definitions, workers, sessions, outputs, recordings };
}

function openRuntime({ config, clock = { now: () => Date.now() }, fetchImpl = globalThis.fetch, log = console, db } = {}) {
    db = db || openDb(config.dbPath);
    const events = createEvents({ config, db, fetchImpl, now: () => clock.now(), log });
    const box = createBox({ key: config.secretsKey, previous: config.secretsKeyPrevious });
    const store = createStore({ db, config, events, clock, box, log });
    return { db, events, box, store, clock, config };
}

module.exports = { openRuntime, createStore };
