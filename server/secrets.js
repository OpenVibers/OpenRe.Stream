'use strict';
/**
 * Two kinds of secret, handled differently:
 *
 * Ingest keys (what a streamer pastes into OBS) are OpenRe's own credentials. Only their SHA-256
 * is stored; the plain key exists once, in the response that created or rotated it. 256 bits of
 * randomness make a plain digest safe (no dictionary to try), and lookup stays one indexed read,
 * which matters because the RTMP worker authenticates synchronously inside the publish handshake.
 *
 * Destination stream keys (Twitch/YouTube/Kick/custom) belong to other platforms and must be
 * handed back to ffmpeg, so they are encrypted at rest with AES-256-GCM under OPENRE_SECRETS_KEY
 * and never returned in full by any API.
 */
const crypto = require('crypto');

const KEY_PREFIX = 'ork_';
// ork_ + 43 base64url chars. Matches the RTMP path rule Live uses (/^[a-zA-Z0-9_-]{8,128}$/).
const INGEST_KEY_RE = /^ork_[A-Za-z0-9_-]{43}$/;

function newIngestKey() {
    return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function hashIngestKey(key) {
    return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

function isIngestKeyShape(key) {
    return typeof key === 'string' && INGEST_KEY_RE.test(key);
}

/** Last four characters, the only part of any secret that is ever displayed again. */
function hintOf(secret) {
    const s = String(secret || '');
    return s.length > 4 ? s.slice(-4) : '';
}

// ── AES-256-GCM box ────────────────────────────────────────────

function parseKey(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    let buf = null;
    if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, 'hex');
    else {
        try { buf = Buffer.from(s, 'base64'); } catch { buf = null; }
    }
    if (!buf || buf.length !== 32) throw new Error('OPENRE_SECRETS_KEY must be 32 bytes (64 hex chars or base64)');
    return buf;
}

function keyId(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

/**
 * createBox({ key, previous }) -> { seal(plain) -> 'v1.<kid>.<iv>.<tag>.<ct>', open(sealed) -> plain, ready }
 * Without a key the box refuses to seal (destinations cannot be saved) rather than storing plain text.
 */
function createBox({ key, previous } = {}) {
    const current = parseKey(key);
    const old = parseKey(previous);
    const keys = new Map();
    if (current) keys.set(keyId(current), current);
    if (old) keys.set(keyId(old), old);

    function seal(plain) {
        if (plain == null || plain === '') return null;
        if (!current) throw Object.assign(new Error('OPENRE_SECRETS_KEY is not configured'), { code: 'openre.secrets_unavailable' });
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', current, iv);
        const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return ['v1', keyId(current), iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
    }

    function open(sealed) {
        if (!sealed) return null;
        const parts = String(sealed).split('.');
        if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('unrecognised sealed secret');
        const k = keys.get(parts[1]);
        if (!k) throw Object.assign(new Error('sealed with a key that is not configured'), { code: 'openre.secrets_unavailable' });
        const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(parts[2], 'base64url'));
        decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
    }

    return { seal, open, ready: Boolean(current) };
}

module.exports = { newIngestKey, hashIngestKey, isIngestKeyShape, hintOf, createBox, KEY_PREFIX };
