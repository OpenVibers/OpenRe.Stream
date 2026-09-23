'use strict';
/**
 * Browser sign-in for the standalone UI: OAuth2 authorization-code client of OpenVibe.Network
 * (client `openre`, redirect https://openre.stream/auth/callback). The same shape as
 * OpenVibe.Community's session layer, without FedCM:
 *
 *   GET  /auth/login     → Network /oauth/authorize (state cookie; ?next= same-site path)
 *   GET  /auth/callback  → code exchange server-side, sets ov_token (+ ov_refresh)
 *   GET  /auth/logout    → clears cookies
 *   GET  /auth/me        → the signed-in user (offline JWT verification)
 *   POST /auth/refresh   → refresh_token grant (the shared navbar calls it)
 */
const crypto = require('crypto');
const express = require('express');
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');

const ACCESS = 'ov_token';
const REFRESH = 'ov_refresh';
const HINT = 'ov_sso_hint';
const STATE = 'ov_oauth_state';
const NEXT = 'ov_oauth_next';

function sanitizeNext(next) {
    if (typeof next === 'string' && /^\/(?!\/|\\)/.test(next)) return next;
    return '/';
}

function createSsoRoutes({ config, auth, fetchImpl = globalThis.fetch }) {
    const router = express.Router();
    const client = new OpenVibeAuthClient({
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, redirectUri: config.oauth.redirectUri,
        publicKey: null, authBase: config.networkUrl, internalBase: config.networkInternalUrl,
    });
    const base = { sameSite: 'lax', secure: config.cookies.secure };
    const flow = { ...base, httpOnly: true, path: '/auth', maxAge: 10 * 60 * 1000 };

    async function tokenGrant(body) {
        let lastErr = null;
        for (const b of [config.networkInternalUrl, config.networkUrl]) {
            try {
                const res = await fetchImpl(`${b}/oauth/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, ...body }),
                    signal: AbortSignal.timeout(10000),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || `token grant failed (${res.status})`), { status: res.status });
                return data;
            } catch (err) {
                lastErr = err;
                if (err.status && err.status < 500) throw err;
            }
        }
        throw lastErr || new Error('Network unreachable');
    }

    function setSession(res, access, refresh) {
        res.cookie(ACCESS, access, { ...base, httpOnly: false, path: '/', maxAge: 24 * 60 * 60 * 1000 });
        if (refresh) res.cookie(REFRESH, refresh, { ...base, httpOnly: true, path: '/auth', maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.cookie(HINT, 'account', { ...base, httpOnly: false, path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
    }

    router.get('/login', (req, res) => {
        const { url, state } = client.getAuthorizationUrl(config.oauth.scope);
        res.cookie(STATE, state, flow);
        res.cookie(NEXT, sanitizeNext(req.query.next), flow);
        res.redirect(url);
    });

    router.get('/callback', async (req, res) => {
        const { code, state, error } = req.query;
        const next = sanitizeNext(req.cookies && req.cookies[NEXT]);
        const expected = req.cookies && req.cookies[STATE];
        res.clearCookie(STATE, { path: '/auth' });
        res.clearCookie(NEXT, { path: '/auth' });
        if (error) return res.redirect(`/?auth_error=${encodeURIComponent(String(error))}`);
        if (!code) return res.status(400).type('text/plain').send('Missing authorization code');
        if (!expected || !state || !crypto.timingSafeEqual(
            Buffer.from(String(state).padEnd(64).slice(0, 64)), Buffer.from(String(expected).padEnd(64).slice(0, 64)),
        )) return res.status(400).type('text/plain').send('OAuth state mismatch, please sign in again.');
        try {
            const data = await tokenGrant({ grant_type: 'authorization_code', redirect_uri: config.oauth.redirectUri, code });
            setSession(res, data.access_token, data.refresh_token);
            return res.redirect(next);
        } catch (err) {
            return res.status(502).type('text/plain').send(`Sign-in failed: ${err.message}`);
        }
    });

    router.get('/logout', (req, res) => {
        res.clearCookie(ACCESS, { path: '/' });
        res.clearCookie(REFRESH, { path: '/auth' });
        res.cookie(HINT, 'guest', { ...base, httpOnly: false, path: '/', maxAge: 365 * 24 * 60 * 60 * 1000 });
        res.redirect(sanitizeNext(req.query.next));
    });

    router.get('/me', (req, res) => {
        const token = (req.cookies && req.cookies[ACCESS]) || null;
        const claims = token ? auth.verifyUser(token) : null;
        if (!claims) return res.status(401).json({ error: 'Not authenticated' });
        const { iat, exp, aud, iss, nbf, jti, ...user } = claims;
        return res.json({ user, expires_at: exp ? exp * 1000 : null });
    });

    router.post('/refresh', async (req, res) => {
        const refresh = req.cookies && req.cookies[REFRESH];
        if (!refresh) return res.status(401).json({ error: 'No refresh token' });
        try {
            const data = await tokenGrant({ grant_type: 'refresh_token', refresh_token: refresh });
            setSession(res, data.access_token, data.refresh_token);
            return res.json({ token: data.access_token });
        } catch (err) {
            if (err.status && err.status < 500) return res.status(401).json({ error: 'Refresh token rejected, please sign in again' });
            return res.status(502).json({ error: 'Could not reach OpenVibe.Network' });
        }
    });

    return router;
}

module.exports = { createSsoRoutes, sanitizeNext };
