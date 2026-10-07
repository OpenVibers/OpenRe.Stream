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
            summary: 'Live ingest and restream for the OpenVibe network. Go live from a browser over WHIP (WebRTC) with no OBS or encoder install, or publish with an RTMP encoder such as OBS or an ffmpeg MPEG-TS (JSMPEG) feed; OpenRe carries the session and restreams it to RTMP, RTMPS and SRT destinations.',
            details: [
                'OpenRe.Stream is the ingest and restream authority behind OpenVibe.Live: channels, discovery and watch pages stay on openvibe.live, which plays an OpenRe session from its playback descriptor. OpenRe itself serves a JSON/REST API and a small server-rendered owner UI at openre.stream.',
                '',
                'Ingest options, as the code and README describe them today:',
                '- Browser WebRTC (WHIP, RFC 9725): POST /whip/<key> on ingest.openre.stream, one mediasoup router per session and WebSocket viewer signaling at /w/<session id>. The /b/<key> broadcaster signaling endpoint is what the OpenVibe.Live broadcast page speaks, so a streamer can go live from a browser without OBS.',
                '- RTMP: any RTMP encoder, e.g. OBS, to rtmp://ingest.openre.stream:1936/live with the stream key shown once when the stream is created.',
                '- JSMPEG: an ffmpeg MPEG-TS HTTP POST to ingest.openre.stream:9736/<key>/<width>/<height>/ with WebSocket viewers; JSMPEG sessions are not recorded.',
                '',
                'Restream: a session can fan out to RTMP, RTMPS and SRT destinations (Twitch, YouTube, Kick or a custom server) with per-output health, logs, backoff and a rapid-crash circuit breaker. Recording: OpenRe asks OpenVibe.Media to record a VOD or clips for RTMP and WebRTC sessions (not JSMPEG). Playback: a live, non-private session is served as HTTP-FLV at https://openre.stream/play/<session id>.flv.',
                '',
                'Ingest keys are random, stored only as a SHA-256 hash and shown once at creation or rotation. There is no follower minimum or eligibility threshold to go live: a signed-in OpenVibe account can create a stream. The service is alpha.',
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
