'use strict';
/**
 * OpenVibe Live on by default (owner, 2026-10-09; contracts 0.126.0). A person's new stream asks Live for a slot on
 * their channel (POST /internal/openre/slots with OpenRestream's service token) unless they untick it; the slot becomes
 * the stream's live:managed_stream ref and mirror_to_live turns on. A refusal keeps the stream with Live off and says
 * why. Services (Live's own slots, Bot's robots) are never linked here. Switching it on later links once.
 */
const assert = require('assert');
const { bootApi, request, userToken, serviceToken, suite, OWNER, OTHER } = require('./helpers');
const { csrfFor } = require('../server/ui/routes');

const t = suite('live-link');
const liveCalls = [];
let slotSeq = 70;
const realFetch = globalThis.fetch;
async function fetchImpl(url, opts = {}) {
    const u = String(url);
    if (u.endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'svc-openre-live', token_type: 'Bearer', expires_in: 300 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u === 'http://127.0.0.1:3000/internal/openre/slots') {
        assert.strictEqual(opts.headers.Authorization, 'Bearer svc-openre-live');
        const b = JSON.parse(opts.body);
        liveCalls.push(b);
        if (b.subject === OTHER) {
            return new Response(JSON.stringify({ type: 'https://openvibe.network/problems/live.no_account', status: 409, code: 'live.no_account', detail: 'no Live account' }), { status: 409, headers: { 'Content-Type': 'application/problem+json' } });
        }
        return new Response(JSON.stringify({ managed_stream_id: ++slotSeq, channel_url: 'https://openvibe.live/@owner', created: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
}

let api;
const ownerToken = userToken({ subjectId: OWNER });
const otherToken = userToken({ subjectId: OTHER });
const form = (token, fields) => ({ cookie: `ov_token=${token}`, form: { ...fields, _csrf: csrfFor(token) } });
const streamOf = async (id, token = ownerToken) => (await request(api.base, 'GET', `/api/v1/streams/${id}`, { token })).body.stream;
const liveRef = (s) => (s.external_refs || []).find(r => r.service === 'live' && r.type === 'managed_stream');

t('a new stream made on the page is on OpenVibe Live by default', async () => {
    api = await bootApi({ env: { OV_OAUTH_CLIENT_ID: 'openre', OV_OAUTH_CLIENT_SECRET: 'test-secret' }, fetchImpl });
    const page = await request(api.base, 'GET', '/streams', { cookie: `ov_token=${ownerToken}` });
    assert.match(page.text, /name="show_on_live" value="1" checked/, 'the box is ticked on the form');
    const created = await request(api.base, 'POST', '/streams', form(ownerToken, { title: 'Saturday', recording_mode: 'none', recording_visibility: 'public', show_on_live: '1' }));
    assert.strictEqual(created.status, 200, created.text.slice(0, 300));
    assert.match(created.text, /OpenVibe Live is on/);
    assert.match(created.text, /href="https:\/\/openvibe\.live\/@owner"/);
    assert.strictEqual(liveCalls.length, 1);
    assert.strictEqual(liveCalls[0].subject, OWNER);
    assert.strictEqual(liveCalls[0].title, 'Saturday');
    const id = /\/streams\/(std_[0-9A-Z]+)/.exec(created.text)[1];
    assert.strictEqual(liveCalls[0].openre_stream_id, id);
    const s = await streamOf(id);
    assert.strictEqual(s.mirror_to_live, true);
    assert.deepStrictEqual(liveRef(s) && { id: liveRef(s).id, label: liveRef(s).label }, { id: '71', label: 'https://openvibe.live/@owner' });
    const shown = await request(api.base, 'GET', `/streams/${id}`, { cookie: `ov_token=${ownerToken}` });
    assert.match(shown.text, /OpenVibe Live: sessions show on <a href="https:\/\/openvibe\.live\/@owner"/);
});

t('unticked, the stream stays off Live and Live is not asked', async () => {
    const before = liveCalls.length;
    const created = await request(api.base, 'POST', '/streams', form(ownerToken, { title: 'Off', recording_mode: 'none', recording_visibility: 'public' }));
    assert.strictEqual(created.status, 200);
    assert.doesNotMatch(created.text, /OpenVibe Live is on/);
    assert.strictEqual(liveCalls.length, before);
    const id = /\/streams\/(std_[0-9A-Z]+)/.exec(created.text)[1];
    const s = await streamOf(id);
    assert.strictEqual(s.mirror_to_live, false);
    assert.ok(!liveRef(s));

    // Switching it on in Settings links once; saving again does not ask Live again.
    const save = (v) => request(api.base, 'POST', `/streams/${id}`, form(ownerToken, { title: 'Off', recording_mode: 'none', recording_visibility: 'public', playback_visibility: 'public', state: 'active', ...(v ? { mirror_to_live: '1' } : {}) }));
    let r = await save(true);
    assert.strictEqual(r.status, 303);
    assert.strictEqual(r.headers.get('location'), `/streams/${id}`);
    assert.strictEqual(liveCalls.length, before + 1);
    assert.strictEqual((await streamOf(id)).mirror_to_live, true);
    r = await save(true);
    assert.strictEqual(liveCalls.length, before + 1, 'already linked: Live is not asked again');
    r = await save(false);
    const off = await streamOf(id);
    assert.strictEqual(off.mirror_to_live, false, 'switched off');
    assert.ok(liveRef(off), 'the slot stays recorded, so switching on again needs no new slot');
    r = await save(true);
    assert.strictEqual(liveCalls.length, before + 1);
    assert.strictEqual((await streamOf(id)).mirror_to_live, true);
});

t('without a Live account the stream is made, Live stays off, and the page says why', async () => {
    const created = await request(api.base, 'POST', '/streams', form(otherToken, { title: 'Theirs', recording_mode: 'none', recording_visibility: 'public', show_on_live: '1' }));
    assert.strictEqual(created.status, 200);
    assert.match(created.text, /Sign in to openvibe\.live once/);
    const id = /\/streams\/(std_[0-9A-Z]+)/.exec(created.text)[1];
    const s = await streamOf(id, otherToken);
    assert.strictEqual(s.mirror_to_live, false);
    assert.ok(!liveRef(s));
    const r = await request(api.base, 'POST', `/streams/${id}`, form(otherToken, { title: 'Theirs', recording_mode: 'none', recording_visibility: 'public', playback_visibility: 'public', state: 'active', mirror_to_live: '1' }));
    assert.strictEqual(r.headers.get('location'), `/streams/${id}?live=live.no_account`);
    const page = await request(api.base, 'GET', `/streams/${id}?live=live.no_account`, { cookie: `ov_token=${otherToken}` });
    assert.match(page.text, /flash bad">You have no OpenVibe Live channel yet/);
    assert.strictEqual((await streamOf(id, otherToken)).mirror_to_live, false);
});

t('the API links a person\'s stream by default, never a service\'s', async () => {
    let before = liveCalls.length;
    const mine = await request(api.base, 'POST', '/api/v1/streams', { token: ownerToken, body: { title: 'From an app' } });
    assert.strictEqual(mine.status, 201, mine.text);
    assert.deepStrictEqual(mine.body.live, { linked: true, channel_url: 'https://openvibe.live/@owner' });
    assert.strictEqual(mine.body.stream.mirror_to_live, true);
    assert.strictEqual(liveCalls.length, before + 1);
    const optOut = await request(api.base, 'POST', '/api/v1/streams', { token: ownerToken, body: { title: 'Not on Live', show_on_live: false } });
    assert.strictEqual(optOut.body.live, undefined);
    assert.strictEqual(optOut.body.stream.mirror_to_live, false);
    before = liveCalls.length;
    const svc = await request(api.base, 'POST', '/api/v1/streams', { token: serviceToken('live', ['openre.stream.write']), headers: { 'X-OV-Subject': OWNER }, body: { title: 'A Live slot', external_refs: [{ service: 'live', type: 'managed_stream', id: '9001' }] } });
    assert.strictEqual(svc.status, 201, svc.text);
    assert.strictEqual(svc.body.live, undefined);
    assert.strictEqual(liveCalls.length, before, 'a service names its own refs');
    const theirs = await request(api.base, 'POST', '/api/v1/streams', { token: otherToken, body: { title: 'No account' } });
    assert.strictEqual(theirs.body.live.linked, false);
    assert.strictEqual(theirs.body.live.code, 'live.no_account');
    assert.strictEqual(theirs.body.stream.mirror_to_live, false);
});

t('teardown', async () => { await api.close(); });

t.run();
