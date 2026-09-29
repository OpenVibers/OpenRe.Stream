'use strict';
/**
 * NODE_OPTIONS=--require for test/worker-async.test.js: the restream worker's boot IIFE must await
 * worker.start(), so a failing register is reported by its own `.catch` (exit 1) instead of becoming
 * an unhandled rejection. openRuntime is replaced with a runtime whose workers.register rejects, so
 * no database is opened and the child runs the same way under PGlite and PostgreSQL.
 */
const store = require('../../server/store');
const { load } = require('../../server/config');

store.openRuntime = async () => ({
    config: load(),
    store: { workers: { register: async () => { throw new Error('register boom'); } } },
    events: {},
    db: { close() {} },
});
