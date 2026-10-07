'use strict';
// The discovery routes (server/discovery.js) answer with the right content types: robots.txt
// names the sitemap, sitemap.xml lists the public pages including /, and llms.txt describes what
// OpenRe.Stream does today. All three come from openvibe-shared/seo, the shared toolkit.
const assert = require('assert');
const seo = require('openvibe-shared/seo');
const { bootApi, request, suite } = require('./helpers');

const t = suite('discovery');

t('robots.txt welcomes crawlers, keeps the owner pages out, and names the sitemap', async () => {
    const api = await bootApi({});
    try {
        const r = await request(api.base, 'GET', '/robots.txt');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^text\/plain/);
        assert.ok(r.text.includes(`Sitemap: ${seo.absolute('/sitemap.xml', api.config.baseUrl)}`), 'names the sitemap');
        assert.ok(r.text.includes('Disallow: /streams'), 'signed-in owner pages stay out');
        assert.ok(r.text.includes('Disallow: /api/'), 'the API stays out');
    } finally {
        await api.close();
    }
});

t('sitemap.xml is XML and lists the public pages, including /', async () => {
    const api = await bootApi({});
    try {
        const r = await request(api.base, 'GET', '/sitemap.xml');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /xml/);
        assert.ok(r.text.includes(`<loc>${seo.absolute('/', api.config.baseUrl)}</loc>`), 'lists /');
        assert.ok(r.text.includes(`<loc>${seo.absolute('/updates', api.config.baseUrl)}</loc>`), 'lists /updates');
    } finally {
        await api.close();
    }
});

t('llms.txt is plain text and leads with browser WHIP go-live', async () => {
    const api = await bootApi({});
    try {
        const r = await request(api.base, 'GET', '/llms.txt');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^text\/plain/);
        assert.ok(r.text.startsWith('# OpenRe.Stream\n'), 'starts with the site heading');
        assert.ok(/WHIP/.test(r.text) && /browser/i.test(r.text), 'browser WHIP go-live is stated');
    } finally {
        await api.close();
    }
});

t.run();
