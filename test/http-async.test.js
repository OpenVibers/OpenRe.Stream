'use strict';
// Express 4 ignores what an `async (req, res)` handler returns, so a rejection becomes an unhandled
// rejection and Node ends the API process. server/app.js calls openvibe-shared/metrics instrument(),
// which installs openvibe-shared/express-async's routeAsyncErrors on the app (one prototype patch, so
// it covers app-level handlers and every Router alike). This guards that wiring: a store call that
// rejects answers 500 problem+json and nothing floats.
const assert = require('assert');
const { bootApi, request, userToken, suite, OWNER } = require('./helpers');

const t = suite('http-async');

const cookie = `ov_token=${userToken({ subjectId: OWNER })}`;

t('a rejecting store call in an async GET answers 500, with no unhandled rejection', async () => {
    const api = await bootApi();
    const seen = [];
    const onUnhandled = (err) => seen.push(err);
    process.on('unhandledRejection', onUnhandled);
    const list = api.rt.store.definitions.list;
    const get = api.rt.store.sessions.get;
    try {
        // server/ui/routes.js `/streams`: a bare async GET on a Router, reached as the signed-in owner.
        api.rt.store.definitions.list = async () => { throw new Error('db down (definitions.list)'); };
        const ui = await request(api.base, 'GET', '/streams', { cookie });
        assert.strictEqual(ui.status, 500, ui.text);
        assert.match(ui.headers.get('content-type'), /application\/problem\+json/);
        assert.strictEqual(ui.body.code, 'openre.internal');

        // server/app.js `/play/:file`: a bare async GET on the app itself.
        api.rt.store.sessions.get = async () => { throw new Error('db down (sessions.get)'); };
        const play = await request(api.base, 'GET', `/play/${'ses_' + '0'.repeat(26)}.flv`);
        assert.strictEqual(play.status, 500, play.text);
        assert.strictEqual(play.body.code, 'openre.internal');

        await new Promise((r) => setTimeout(r, 50));
        assert.deepStrictEqual(seen.map((e) => String(e && e.message)), [], 'a handler rejection floated unhandled');
    } finally {
        api.rt.store.definitions.list = list;
        api.rt.store.sessions.get = get;
        process.removeListener('unhandledRejection', onUnhandled);
        await api.close();
    }
});
