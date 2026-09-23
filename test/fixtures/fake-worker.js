'use strict';
/**
 * A fake transport worker for test/api-restart.test.js: a separate process that registers an
 * rtmp-ingest generation, admits a session for the stream named in FAKE_STREAM_ID, takes it live
 * and keeps heartbeating (renewing its lease) until killed. It holds no socket: the point is that
 * nothing the API does can reach into it.
 */
const { load } = require('../../server/config');
const { openRuntime } = require('../../server/store');
const { createWorkerRuntime } = require('../../workers/runtime');

const rt = openRuntime({ config: load(), log: { log() {}, warn() {}, error: console.error } });
const worker = createWorkerRuntime({ rt, kind: 'rtmp-ingest', hooks: { activeCount: () => 1 }, log: { log() {}, warn() {}, error: console.error } });
worker.register({ publicPort: 0, rtmpPlayPort: 0, flvPort: 0 });
worker.ready();
const definition = rt.store.definitions.get(process.env.FAKE_STREAM_ID);
const a = rt.store.sessions.admit({ definition, key: null, protocol: 'rtmp', worker: worker.me });
rt.store.sessions.transition(a.session.id, 'live', { reason: 'fake_media' });
console.log(`SESSION ${a.session.id} WORKER ${worker.me.id}`);
setInterval(() => {}, 1 << 30);
