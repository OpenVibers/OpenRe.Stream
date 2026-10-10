'use strict';
// OpenVibe.Services reads only the public stream summaries, using a first-party service token.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { streamSummary, filtersOf } = require('../server/registry/resource-index');
const { bootApi, request, serviceToken, userToken, suite, OWNER, OTHER } = require('./helpers');

const t = suite('resource-index');
const reader = serviceToken('services', ['openre.resource.read']);
let api;
let ids;

const get = (path, token = reader) => request(api.base, 'GET', `/api/v1/resources${path}`, { token });

t('summary and query functions keep the contract shape without a socket', () => {
    const row = { id: 'std_01J0000000000000000000000A', owner_subject: OWNER, title: 'Public title',
        state: 'disabled', created_at: 1000, updated_at: 2000, description: 'private', ingest_key: 'secret' };
    const summary = streamSummary(row);
    assert.deepStrictEqual(summary, { id: row.id, kind: 'openre.stream', service: 'openre',
        name: row.title, state: row.state, created_at: new Date(1000).toISOString(),
        updated_at: new Date(2000).toISOString(), owner: { type: 'user', id: OWNER } });
    assert.ok(contracts.validate('common.resource-summary@1', summary).valid);
    assert.strictEqual(contracts.resources.nameOf(summary), null);
    assert.strictEqual(filtersOf({ project: 'bad' }).error, 'project must be a prj_ id');
    assert.deepStrictEqual(filtersOf({}), { project: null, kind: null, limit: 100, cursor: null });
});

t('boot and list schema, ordered rows, and safe summary fields', async () => {
    api = await bootApi();
    const a = (await api.rt.store.definitions.create({ owner_subject: OWNER, title: 'First stream' })).definition;
    const b = (await api.rt.store.definitions.create({ owner_subject: OTHER, title: 'Second stream' })).definition;
    const archived = (await api.rt.store.definitions.create({ owner_subject: OWNER, title: 'Archived' })).definition;
    ids = [a.id, b.id].sort();
    await api.rt.db.prepare("UPDATE stream_definitions SET state = 'disabled' WHERE id = ?").run(b.id);
    await api.rt.db.prepare("UPDATE stream_definitions SET state = 'archived' WHERE id = ?").run(archived.id);
    const page = await get('');
    assert.strictEqual(page.status, 200, page.text);
    const validation = contracts.validate('common.resource-list-result@1', page.body);
    assert.ok(validation.valid, JSON.stringify(validation.errors));
    assert.deepStrictEqual(page.body.resources.map((s) => s.id), ids);
    assert.strictEqual(page.body.next_cursor, null);
    for (const summary of page.body.resources) {
        assert.deepStrictEqual(Object.keys(summary).sort(), ['created_at', 'id', 'kind', 'name', 'owner', 'service', 'state', 'updated_at'].sort());
        assert.strictEqual(summary.kind, 'openre.stream');
        assert.strictEqual(summary.service, 'openre');
        assert.match(summary.created_at, /^\d{4}-\d\d-\d\dT/);
        assert.match(summary.updated_at, /^\d{4}-\d\d-\d\dT/);
    }
    assert.deepStrictEqual(new Set(page.body.resources.map((s) => s.state)), new Set(['active', 'disabled']));
    assert.deepStrictEqual(new Set(page.body.resources.map((s) => s.owner.id)), new Set([OWNER, OTHER]));
});

t('cursor visits each row exactly once and filters follow person ownership', async () => {
    const visited = [];
    let cursor = null;
    do {
        const page = await get(`?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        assert.strictEqual(page.status, 200, page.text);
        assert.ok(contracts.validate('common.resource-list-result@1', page.body).valid);
        visited.push(...page.body.resources.map((s) => s.id));
        cursor = page.body.next_cursor;
    } while (cursor);
    assert.deepStrictEqual(visited, ids);
    assert.deepStrictEqual((await get('?kind=openre.stream')).body.resources.map((s) => s.id), ids);
    assert.deepStrictEqual((await get('?kind=unknown.kind')).body, { resources: [], next_cursor: null });
    assert.deepStrictEqual((await get('?project=prj_01J0000000000000000000000A')).body, { resources: [], next_cursor: null });
    assert.strictEqual((await get('?project=bad')).status, 400);
    assert.strictEqual((await get('?cursor=bad')).status, 400);
    assert.strictEqual((await get('?limit=1001')).status, 400);
});

// An OVRN carries a slash (<type>/<id>): callers (OpenVibe.Services included) encode it as one path segment.
t('only a service token with the capability reaches either route', async () => {
    for (const path of ['', `/${encodeURIComponent('ovrn:openre:prj_01J0000000000000000000000A:stream/std_01J0000000000000000000000A')}`]) {
        const absent = await get(path, null);
        assert.strictEqual(absent.status, 401);
        assert.strictEqual(absent.body.code, 'token.missing');
        const missingCap = await get(path, serviceToken('services', ['openre.stream.read']));
        assert.strictEqual(missingCap.status, 403);
        const person = await get(path, userToken());
        assert.strictEqual(person.status, 403);
        assert.strictEqual(person.body.code, 'capability.denied');
    }
});

t('person-owned rows have no OVRN and every single-resource lookup is unknown', async () => {
    const page = await get('');
    for (const summary of page.body.resources) assert.strictEqual(contracts.resources.nameOf(summary), null);
    const one = await get(`/${encodeURIComponent('ovrn:openre:prj_01J0000000000000000000000A:stream/std_01J0000000000000000000000A')}`);
    assert.strictEqual(one.status, 404);
    assert.strictEqual(one.body.code, 'resources.unknown_resource');
    await api.close();
});

t.run();
