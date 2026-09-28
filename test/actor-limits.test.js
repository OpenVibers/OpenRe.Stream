'use strict';
// Per-actor limits on the ingest API's writes (server/api/actor-limits.js; roadmap WS-R task 4): a signed-in person is
// counted by subject and refused 429 rate_limited with Retry-After before the route runs, while another person passes;
// key rotations have their own tighter number; service callers (Live manages every streamer) and reads are never
// counted; the window reopens.
//   node test/actor-limits.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createOpenReActorLimits } = require('../server/api/actor-limits');

console.warn = () => {};
(async () => {
    let t = Date.UTC(2026, 8, 28, 3, 0, 0);
    const app = express();
    app.use((req, res, next) => {
        const who = req.headers['x-who'] || '';
        req.caller = who.startsWith('svc:') ? { kind: 'service', claims: { sub: who } } : who ? { kind: 'user', subject: who } : { kind: 'anonymous' };
        next();
    });
    app.use('/api/v1', createOpenReActorLimits({ env: { OPENRE_LIMITS_MINUTE: '5' }, now: () => t }));
    let ran = 0;
    app.all('/api/v1/*', (req, res) => { ran++; res.json({ ok: true }); });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = async (method, p, who) => {
        const r = await fetch(base + p, { method, headers: who ? { 'x-who': who } : {} });
        return { status: r.status, retry: r.headers.get('retry-after'), body: await r.json().catch(() => ({})) };
    };
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await call('PATCH', '/streams/s1', 'usr_a')).status, 200);
        const before = ran;
        const r = await call('PATCH', '/streams/s1', 'usr_a');
        assert.deepStrictEqual([r.status, r.body.code, Number(r.retry) > 0, ran], [429, 'rate_limited', true, before]);
        assert.strictEqual((await call('PATCH', '/streams/s1', 'usr_b')).status, 200, 'another person passes');
        for (let i = 0; i < 20; i++) {
            assert.strictEqual((await call('POST', '/streams/s1/keys/rotate', 'svc:live')).status, 200, 'Live (service) is never counted');
            assert.strictEqual((await call('GET', '/streams', 'usr_a')).status, 200, 'reads are never counted');
        }
        t += 60 * 1000;
        const rotations = [];
        for (let i = 0; i < 6; i++) rotations.push((await call('POST', '/streams/s1/keys/rotate', 'usr_c')).status);
        assert.deepStrictEqual(rotations, [200, 200, 200, 200, 200, 429], 'five key rotations a minute');
        t += 60 * 1000;
        assert.strictEqual((await call('PATCH', '/streams/s1', 'usr_a')).status, 200, 'the next minute');
    } finally {
        server.close();
    }
    console.log('actor limits: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
