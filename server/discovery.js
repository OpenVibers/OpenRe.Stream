'use strict';
/**
 * Crawl and machine-readability artifacts for openre.stream, built from openvibe-shared/seo the
 * same way every other OpenVibe site builds them:
 *
 *   GET /robots.txt    welcomes search and AI crawlers, keeps the signed-in owner pages, sign-in,
 *                      the API and playback out of the index, and always names the sitemap
 *   GET /sitemap.xml   the public, server-rendered pages (server/ui/routes.js) only
 *   GET /llms.txt      what OpenRe.Stream does today, in plain language
 *
 * Read-only and viewer-independent: built from the config (the public base URL) and nothing else.
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const seo = require('openvibe-shared/seo');

// Public pages only. /streams, /streams/:id, /sessions, /sessions/:id and /destinations/:id render
// one signed-in owner's data (server/ui/routes.js), so they never appear in the sitemap.
const PUBLIC_PATHS = ['/', '/updates'];
const DISALLOW = ['/streams', '/sessions', '/destinations', '/auth/', '/api/', '/play/'];

function createDiscoveryRoutes({ config }) {
    const router = express.Router();
    const abs = (p) => seo.absolute(p, config.baseUrl);

    router.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders()).send(
        seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW })));

    router.get('/sitemap.xml', (_req, res) => res.type('application/xml').set('Cache-Control', cache.htmlHeaders()).send(
        seo.sitemapXml(PUBLIC_PATHS.map((loc) => ({ loc: abs(loc) })))));

    router.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders()).send(
        seo.llmsTxt({
            name: 'OpenRe.Stream',
            summary: 'Go live from your browser with no OBS and no follower minimum: on the OpenVibe network you open openvibe.live, press Go Live and allow your camera. OpenRe.Stream is the network\'s ingest and restream service behind it: it takes an RTMP feed from an encoder such as OBS and restreams the session to RTMP and SRT destinations.',
            details: [
                'OpenRe.Stream is the ingest and restream authority behind OpenVibe.Live: channels, discovery and watch pages stay on openvibe.live. OpenRe itself serves a JSON/REST API and a small server-rendered owner UI at openre.stream. The service is alpha.',
                '',
                'Going live, as it runs today:',
                '- From a browser, with nothing to install: on OpenVibe.Live (https://openvibe.live, the Go Live button; guide at https://openvibe.live/docs/go-live-in-your-browser). There is no follower, subscriber or eligibility threshold.',
                '- With an encoder such as OBS: RTMP to rtmp://ingest.openre.stream:1936/live with the stream key OpenRe shows once when the stream is created. Any signed-in OpenVibe account can create a stream.',
                '- Browser WebRTC (WHIP, RFC 9725) and JSMPEG ingest are ported to OpenRe and tested, but their workers do not run in production yet; until they do, OpenVibe.Live serves them.',
                '',
                'Restream: a session can fan out to several RTMP and SRT destinations at once, with per-output health, logs, backoff and a rapid-crash circuit breaker. Recording: OpenRe asks OpenVibe.Media to record a VOD or clips of an RTMP session. Playback: a live, non-private session is served as HTTP-FLV at https://openre.stream/play/<session id>.flv.',
                '',
                'Ingest keys are random, stored only as a SHA-256 hash and shown once at creation or rotation.',
            ].join('\n'),
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenRe.Stream home', url: abs('/') },
                    { title: 'What shipped', url: abs('/updates') },
                    { title: 'Source code', url: 'https://github.com/OpenVibers/OpenRe.Stream' },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'robots.txt', url: abs('/robots.txt') },
                ] },
            ],
        })));

    return router;
}

module.exports = { createDiscoveryRoutes };
