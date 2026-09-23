'use strict';
/**
 * Restream destination URLs become ffmpeg's OUTPUT argument, so they are the SSRF surface of this
 * service (plan anti-goal 13). Rules, checked when a destination is written and again right
 * before ffmpeg starts (DNS can change in between):
 *
 *   - rtmp://, rtmps:// or srt:// only (ffmpeg picks its output protocol from the URL: a path or
 *     file:/http: URL would write files or talk to arbitrary hosts), with a hostname, no
 *     user:password@, no whitespace or control characters, at most 2048 characters
 *   - the host may not be (or resolve to) loopback, private, link-local, CGNAT, multicast or
 *     unspecified addresses, unless OPENRE_DEST_ALLOW_PRIVATE is on (tests, a restream box on the
 *     operator's LAN). Live allowed private hosts; OpenRe does not by default, and the migration
 *     holds such destinations with a recorded reason instead of importing them enabled.
 */
const dns = require('dns');
const net = require('net');

const PROTOCOLS = new Set(['rtmp:', 'rtmps:', 'srt:']);

function isPrivateAddress(ip) {
    const v = net.isIP(ip);
    if (v === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0)
            || (a === 198 && (b === 18 || b === 19)) || a >= 224;
    }
    if (v === 6) {
        const s = ip.toLowerCase();
        if (s === '::' || s === '::1') return true;
        if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
        return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
    }
    return true;
}

/** Syntax + literal-address check. { ok, value, url } | { ok: false, error } */
function validateDestinationUrl(raw, { allowPrivate = false } = {}) {
    const value = String(raw || '').trim();
    if (!value) return { ok: false, error: 'Server URL is required' };
    if (value.length > 2048) return { ok: false, error: 'Server URL is too long' };
    if (/[\s\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: 'Server URL contains invalid characters' };
    let u;
    try { u = new URL(value); } catch { return { ok: false, error: 'Server URL must be a full rtmp://, rtmps:// or srt:// address' }; }
    if (!PROTOCOLS.has(u.protocol)) return { ok: false, error: `Server URL must start with rtmp://, rtmps:// or srt:// (got "${u.protocol.replace(':', '')}")` };
    if (!u.hostname) return { ok: false, error: 'Server URL needs a hostname' };
    if (u.username || u.password) return { ok: false, error: 'Put credentials in the stream key, not in the server URL' };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate) {
        if (/^localhost$/i.test(host) || /\.localhost$/i.test(host) || /\.(internal|local|lan|home|arpa)$/i.test(host)) {
            return { ok: false, error: 'Server URL may not point at a local or internal host' };
        }
        if (net.isIP(host) && isPrivateAddress(host)) return { ok: false, error: 'Server URL may not point at a private, loopback or link-local address' };
    }
    return { ok: true, value, url: u, host };
}

/** Resolve and refuse private answers (DNS rebinding guard). Resolves { ok } | { ok: false, error }. */
async function checkResolvedHost(host, { allowPrivate = false, lookup = dns.promises.lookup } = {}) {
    if (allowPrivate) return { ok: true, addresses: [] };
    if (net.isIP(host)) return isPrivateAddress(host) ? { ok: false, error: 'private address' } : { ok: true, addresses: [host] };
    let answers;
    try { answers = await lookup(host, { all: true }); } catch (err) { return { ok: false, error: `could not resolve ${host} (${err.code || err.message})` }; }
    const addresses = answers.map(a => a.address);
    if (!addresses.length) return { ok: false, error: `could not resolve ${host}` };
    if (addresses.some(isPrivateAddress)) return { ok: false, error: `${host} resolves to a private or loopback address` };
    return { ok: true, addresses };
}

module.exports = { validateDestinationUrl, checkResolvedHost, isPrivateAddress };
