'use strict';
// The discovery routes (server/discovery.js) answer with the right content types: robots.txt
// names the sitemap, sitemap.xml lists the public pages including /, and llms.txt describes what
// OpenRestream does today. All three come from openvibe-shared/seo, the shared toolkit.
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

t('llms.txt is plain text, leads with browser go-live and says what runs today', async () => {
    const api = await bootApi({});
    try {
        const r = await request(api.base, 'GET', '/llms.txt');
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^text\/plain/);
        assert.ok(r.text.startsWith('# OpenRestream\n'), 'starts with the site heading');
        assert.match(r.text.split('\n').slice(0, 4).join(' '), /Go live from your browser with no OBS and no follower minimum/, 'browser go-live leads');
        // Only the RTMP ingest and restream workers run in production: WHIP and JSMPEG are ported, not served yet.
        assert.match(r.text, /WHIP, RFC 9725\) and JSMPEG ingest are ported to OpenRestream and tested, but their workers do not run in production yet/);
    } finally {
        await api.close();
    }
});

t('the front page leads with browser go-live, links to Live for it, and says what runs here', async () => {
    const api = await bootApi({});
    try {
        const r = await request(api.base, 'GET', '/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<h1>Go live from your browser\.<span class="sc-accent"> No OBS, no follower minimum\.<\/span><\/h1>/);
        assert.match(r.text, /<meta name="description" content="Go live from your browser with no OBS and no follower minimum/);
        assert.ok(r.text.includes(`href="${api.config.liveUrl}"`), 'the primary action opens OpenVibe.Live, where browser go-live runs today');
        assert.match(r.text, /browser \(WHIP\) and JSMPEG ingest are still served by OpenVibe\.Live/);
        assert.match(r.text, /href="\/shared\/showcase\.css\?v=[0-9a-f]{12}"/);
        assert.strictEqual((r.text.match(/<h1[ >]/g) || []).length, 1, 'one h1');
    } finally {
        await api.close();
    }
});

t.run();
