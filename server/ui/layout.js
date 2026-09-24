'use strict';
/**
 * Page shell for openre.stream: server-rendered HTML that works without JavaScript, with the shared
 * OpenVibe Frame (theme loader, navbar and footer from openvibe.network, footer SSR from the
 * pinned openvibe-shared release) the way OpenVibe.Community renders it.
 */
const NETWORK_URL = 'https://openvibe.network';
const SITE = 'OpenRe.Stream';

function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CSS = `
:root{--ore-bg:#0d131d;--ore-panel:#141c2b;--ore-line:#233049;--ore-text:#e6ecf5;--ore-muted:#93a2bd;--ore-accent:#3b82f6;--ore-ok:#22c55e;--ore-warn:#f59e0b;--ore-bad:#ef4444}
body{margin:0;background:var(--ore-bg);color:var(--ore-text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main.ore{max-width:1040px;margin:0 auto;padding:24px 16px 64px}
.ore h1{font-size:1.6rem;margin:.2em 0 .4em}.ore h2{font-size:1.15rem;margin:1.6em 0 .6em}.ore h3{font-size:1rem;margin:1em 0 .4em}
.ore a{color:#93c5fd}.ore p.muted,.ore .muted{color:var(--ore-muted)}
.ore .card{background:var(--ore-panel);border:1px solid var(--ore-line);border-radius:10px;padding:14px 16px;margin:12px 0}
.ore table{width:100%;border-collapse:collapse;font-size:.92rem}.ore th,.ore td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--ore-line);vertical-align:top}
.ore code,.ore .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88rem;word-break:break-all}
.ore .secret{display:block;background:#0a0f18;border:1px dashed var(--ore-warn);padding:10px;border-radius:8px;user-select:all}
.ore form.inline{display:inline}.ore label{display:block;margin:.4em 0 .15em;color:var(--ore-muted);font-size:.88rem}
.ore input[type=text],.ore input[type=password],.ore input[type=number],.ore select,.ore textarea{width:100%;box-sizing:border-box;background:#0a0f18;color:var(--ore-text);border:1px solid var(--ore-line);border-radius:6px;padding:7px 9px}
.ore .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.ore button{background:var(--ore-accent);color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font-weight:600;margin:6px 6px 0 0}
.ore button.secondary{background:#334155}.ore button.danger{background:var(--ore-bad)}
.ore .pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.8rem;font-weight:600;background:#334155}
.ore .pill.live,.ore .pill.ok{background:var(--ore-ok);color:#04110a}.ore .pill.starting,.ore .pill.ending,.ore .pill.pending,.ore .pill.error,.ore .pill.draining{background:var(--ore-warn);color:#1a1000}
.ore .pill.failed,.ore .pill.lost{background:var(--ore-bad)}
.ore .flash{border-left:4px solid var(--ore-accent);padding:8px 12px;background:var(--ore-panel);margin:12px 0}.ore .flash.bad{border-color:var(--ore-bad)}
@media (max-width:640px){.ore th:nth-child(n+4),.ore td:nth-child(n+4){display:none}}
`;

function renderPage({ title, body, user, canonicalPath = '/', robots = 'noindex,nofollow', config }) {
    const pageTitle = title ? `${title} · ${SITE}` : `${SITE} — ingest and restream for OpenVibe`;
    const nav = {
        service: 'openre',
        apiBase: NETWORK_URL,
        links: [
            { label: 'Streams', href: '/streams' },
            { label: 'Sessions', href: '/sessions' },
        ],
        sessionUrl: '/auth/me',
        loginUrl: `/auth/login?next=${encodeURIComponent(canonicalPath)}`,
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
    };
    const foot = { service: 'openre', variant: 'compact', mount: '#ov-footer', brandName: SITE, legalBase: config.liveUrl, updates: '/updates',
        links: [{ heading: SITE, items: [{ name: 'Streams', url: '/streams' }, { name: 'Source code', url: 'https://github.com/OpenVibers/OpenRe.Stream' }] }] };
    let footerSsr = '';
    try { footerSsr = require('openvibe-shared/footer').ssr({ service: 'openre', variant: 'compact', updates: '/updates' }); } catch { footerSsr = '<footer id="ov-footer"></footer>'; }
    let icon = '';
    try { icon = require('openvibe-shared/app-icon').headTags({ site: 'network' }); } catch { icon = ''; }
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="OpenRe.Stream: stream definitions, ingest keys, sessions and restream outputs for the OpenVibe network.">
<meta name="robots" content="${esc(robots)}">
<link rel="canonical" href="${esc(config.baseUrl + canonicalPath)}">
${icon}
<script src="${NETWORK_URL}/shared/theme-loader.js" defer></script>
<style>${CSS}</style>
<script src="${NETWORK_URL}/shared/navbar.js" defer></script>
<script src="${NETWORK_URL}/shared/footer.js" defer></script>
</head>
<body>
<div id="navbar-mount"></div>
<noscript><nav class="ore" style="padding:8px 16px"><a href="/">OpenRe.Stream</a> · <a href="/streams">Streams</a> · <a href="/sessions">Sessions</a> · ${user ? '<a href="/auth/logout">Sign out</a>' : '<a href="/auth/login">Sign in</a>'}</nav></noscript>
<main id="main" class="ore">
${body}
</main>
${footerSsr}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer: foot }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeNavbar) OpenVibeNavbar.init(window.__OV_PAGE.navbar); } catch (e) { /* the Frame is optional */ }
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* */ }
});
</script>
</body>
</html>`;
}

module.exports = { renderPage, esc };
