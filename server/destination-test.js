'use strict';
/**
 * "Test" for a restream destination, without pushing any media: the URL passes the SSRF rules,
 * the host resolves to public addresses, and (RTMP/RTMPS) a TCP connection to the ingest port
 * opens within 5 s. SRT is UDP, so only the first two checks apply. It says nothing about whether
 * the platform accepts the key; that is only known once an output runs (its health shows it).
 */
const net = require('net');
const { validateDestinationUrl, checkResolvedHost } = require('./destination-url');

function tcpProbe(host, port, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const socket = net.connect({ host, port });
        const done = (ok, error) => { socket.destroy(); resolve({ ok, error, ms: Date.now() - started }); };
        socket.setTimeout(timeoutMs, () => done(false, `no answer from ${host}:${port} within ${timeoutMs / 1000}s`));
        socket.once('connect', () => done(true, null));
        socket.once('error', (err) => done(false, `${err.code || 'error'} connecting to ${host}:${port}`));
    });
}

async function testDestination(dest, { allowPrivate = false, lookup, probe = tcpProbe } = {}) {
    const checks = [];
    const v = validateDestinationUrl(dest.server_url, { allowPrivate });
    checks.push({ check: 'url', ok: v.ok, detail: v.ok ? 'rtmp/rtmps/srt URL with a public host' : v.error });
    if (!v.ok) return { ok: false, checks };
    const r = await checkResolvedHost(v.host, { allowPrivate, ...(lookup ? { lookup } : {}) });
    checks.push({ check: 'dns', ok: r.ok, detail: r.ok ? (r.addresses.length ? `resolves to ${r.addresses.join(', ')}` : 'not checked (private hosts allowed)') : r.error });
    if (!r.ok) return { ok: false, checks };
    checks.push({ check: 'stream_key', ok: Boolean(dest.stream_key_enc || dest.has_stream_key), detail: dest.stream_key_enc || dest.has_stream_key ? 'set' : 'missing' });
    if (v.url.protocol === 'srt:') {
        checks.push({ check: 'connect', ok: true, detail: 'SRT is UDP; the receiver is only reached when an output runs' });
    } else {
        const port = Number(v.url.port) || (v.url.protocol === 'rtmps:' ? 443 : 1935);
        const p = await probe(v.host, port);
        checks.push({ check: 'connect', ok: p.ok, detail: p.ok ? `TCP ${v.host}:${port} answered in ${p.ms} ms` : p.error });
    }
    return { ok: checks.every(c => c.ok), checks };
}

module.exports = { testDestination, tcpProbe };
