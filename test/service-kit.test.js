'use strict';
/**
 * openvibe-sdk/service in OpenRe.Stream (plan T1, lane A): the API's SIGTERM/SIGINT shutdown is the kit's
 * gracefulStop, not a hand-written handler. The keys poller stops, requests in flight drain for 8 s, then the
 * store closes in today's order (Valkey, then the database); a step that throws is logged and the stop goes on,
 * a clean stop exits 0, and past the 10 s deadline the process exits 1. The static half reads server/index.js;
 * the behavioural half drives gracefulStop with the same options OpenRe passes, exits stubbed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { gracefulStop } = require('openvibe-sdk/service');
const { suite } = require('./helpers');

const t = suite('service-kit');
const quiet = { log() {}, warn() {}, error() {} };
const source = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');

t('server/index.js imports gracefulStop from openvibe-sdk/service and owns no signal handler', () => {
    assert.match(source, /const \{ gracefulStop \} = require\('openvibe-sdk\/service'\)/);
    assert.doesNotMatch(source, /process\.on\('SIGTERM'/);
    assert.doesNotMatch(source, /process\.on\('SIGINT'/);
    assert.doesNotMatch(source, /setTimeout\(\(\) => process\.exit\(1\), 10000\)/, 'the old 10 s exit-1 timer is gone');
});

t('the one stop names openre-api, passes the server and the store steps, and uses drainMs 8000 / deadlineMs 10000', () => {
    const at = source.indexOf('gracefulStop({');
    const call = source.slice(at, at + 500);
    assert.match(call, /name: 'openre-api'/);
    assert.match(call, /server: h\.server/);
    assert.match(call, /stop: \[\(\) => h\.keys\.stop\(\)\]/, 'the keys poller stops first');
    assert.match(call, /close: \[\(\) => h\.app\.locals\.valkey && h\.app\.locals\.valkey\.close\(\), \(\) => h\.rt\.db\.close\(\)\]/, "today's order: Valkey, then the database");
    assert.match(call, /drainMs: 8000/);
    assert.match(call, /deadlineMs: 10000/);
    assert.doesNotMatch(call, /deadlineExitCode/, 'the default exit 1 past the deadline is kept');
});

t('the stop steps run once, in order, after the drain; a clean stop exits 0 and a second signal changes nothing', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const order = [];
    const keys = { stop: () => order.push('keys.stop') };
    const valkey = { close: async () => order.push(server.listening ? 'valkey.close while listening' : 'valkey.close') };
    const db = { close: async () => order.push('db.close') };
    let exited = null;
    let exits = 0;
    const kit = gracefulStop({
        name: 'openre-api', server,
        stop: [() => keys.stop()],
        close: [() => valkey.close(), () => db.close()],
        drainMs: 8000, deadlineMs: 10000, signals: false,
        exit: (c) => { exited = c; exits++; }, log: quiet,
    });
    const [code, again] = await Promise.all([kit.stop('SIGTERM'), kit.stop('SIGINT')]);
    assert.deepStrictEqual(order, ['keys.stop', 'valkey.close', 'db.close'], 'the stop step first, then the closes once the server has stopped listening');
    assert.strictEqual(code, 0);
    assert.strictEqual(again, code, 'a second signal returns the first stop');
    assert.strictEqual(exited, 0);
    assert.strictEqual(exits, 1, 'exit is called once');
    assert.strictEqual(kit.stopping(), true);
    assert.strictEqual(server.listening, false);
});

t('a request in flight finishes during the drain, before the store closes', async () => {
    let received;
    const inFlight = new Promise((r) => { received = r; });
    const server = http.createServer((_req, res) => { received(); setTimeout(() => res.end('done'), 80); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const order = [];
    const kit = gracefulStop({
        name: 'openre-api', server,
        stop: [],
        close: [() => order.push('valkey.close'), () => order.push('db.close')],
        drainMs: 8000, deadlineMs: 10000, signals: false, exit: () => {}, log: quiet,
    });
    const body = new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, (res) => {
            let s = '';
            res.on('data', (c) => { s += c; });
            res.on('end', () => resolve(s));
        }).on('error', reject);
    });
    await inFlight;                    // the request is in flight when the signal arrives
    const stopping = kit.stop('SIGTERM');
    assert.strictEqual(await body, 'done', 'the drain let it finish');
    assert.strictEqual(await stopping, 0);
    assert.deepStrictEqual(order, ['valkey.close', 'db.close'], 'the store closed after the drain');
});

t('a close step that throws is logged, the stop goes on and exits 0', async () => {
    const order = [];
    const kit = gracefulStop({
        name: 'openre-api', server: null,
        stop: [],
        close: [() => { order.push('valkey.close'); throw new Error('valkey down'); }, () => order.push('db.close')],
        drainMs: 8000, deadlineMs: 10000, signals: false, exit: () => {}, log: quiet,
    });
    assert.strictEqual(await kit.stop('SIGTERM'), 0);
    assert.deepStrictEqual(order, ['valkey.close', 'db.close']);
});

t('past the deadline the process exits 1, even with a close step stuck', async () => {
    let exited = null;
    const kit = gracefulStop({
        name: 'openre-api', server: null,
        stop: [],
        close: [() => new Promise(() => {})],
        drainMs: 8000, deadlineMs: 40, signals: false,
        exit: (c) => { exited = c; }, log: quiet,
    });
    assert.strictEqual(await kit.stop('SIGTERM'), 1);
    assert.strictEqual(exited, 1);
});

t.run();
