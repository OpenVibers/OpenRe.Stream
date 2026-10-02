'use strict';
// Cache-Control comes from openvibe-shared/cache-policy (plan T11), never a hand-written string:
// robots.txt takes the shared HTML policy, the /shared browser assets are content-addressed and
// immutable for a year (openvibe-shared/serve already uses the module), and the API's own
// no-store values are left to openvibe-shared/serve and the media/API routes that need them.
const assert = require('assert');
const cache = require('openvibe-shared/cache-policy');
const { bootApi, request, suite } = require('./helpers');

const t = suite('asset-cache');

t('the module is the only source of the asset/HTML policy values', () => {
    assert.strictEqual(cache.assetHeaders('theme-loader.js?v=deadbeefdeadbeef', { hashed: true }), 'public, max-age=31536000, immutable');
    assert.strictEqual(cache.assetHeaders('theme-loader.js?v=deadbeefdeadbeef', { hashed: false }), 'public, max-age=300, stale-while-revalidate=86400');
    assert.strictEqual(cache.htmlHeaders({ private: true }), 'private, no-store');
    assert.strictEqual(cache.htmlHeaders(), 'public, max-age=120, stale-while-revalidate=3600');
});

t('robots.txt carries the shared HTML policy', async () => {
    const api = await bootApi({});
    try {
        const r = await request(api.base, 'GET', '/robots.txt');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), cache.htmlHeaders());
    } finally {
        await api.close();
    }
});

t('content-addressed /shared assets are immutable for a year', async () => {
    const api = await bootApi({});
    try {
        const serve = require('openvibe-shared/serve');
        const name = 'theme-loader.js';
        const hit = await request(api.base, 'GET', `/shared/${name}?v=${serve.hashOf(name)}`);
        assert.strictEqual(hit.status, 200);
        assert.strictEqual(hit.headers.get('cache-control'), cache.IMMUTABLE);
        const miss = await request(api.base, 'GET', `/shared/${name}?v=deadbeefdeadbeef`);
        assert.strictEqual(miss.headers.get('cache-control'), cache.assetHeaders(name, { hashed: false, swr: 60 }));
    } finally {
        await api.close();
    }
});

t.run();
