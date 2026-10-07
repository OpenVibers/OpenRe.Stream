'use strict';
/**
 * The standalone UI (openre.stream). Server-rendered, useful without JavaScript, forms post back
 * to the same process and go through the same store rules as the API.
 *
 *   /                         what OpenRe is, and the signed-in owner's streams
 *   /streams                  definitions + create
 *   /streams/:id              ingest URL, keys (rotate: the new key is shown once), settings,
 *                             destinations (add, edit, delete, test, start, stop), sessions
 *   /sessions                 recent sessions
 *   /sessions/:id             lifecycle, outputs with health and logs, recording, playback
 *
 * CSRF: every form carries a token derived from the session cookie (an attacker's page cannot
 * read the cookie, so it cannot produce the token); SameSite=Lax cookies are the second layer.
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const express = require('express');
const { renderPage, esc } = require('./layout');
const { StoreError } = require('../store/definitions');
const { testDestination } = require('../destination-test');

const iso = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');
const pill = (state) => `<span class="pill ${esc(state)}">${esc(state)}</span>`;

function csrfFor(token) { return crypto.createHash('sha256').update(`openre-csrf:${token}`).digest('hex').slice(0, 32); }

function createUiRouter({ rt, auth }) {
    const { store, config } = rt;
    const router = express.Router();
    router.use(express.urlencoded({ extended: false, limit: '64kb' }));
    router.use(auth.middleware({ services: false }));

    const page = (req, res, o, status = 200) => res.status(status).type('html').send(renderPage({ ...o, user: req.caller.kind === 'user' ? req.caller : null, config }));
    const csrfField = (req) => `<input type="hidden" name="_csrf" value="${esc(csrfFor(req.caller.token))}">`;
    const form = (req, action, inner, { cls = '', confirm } = {}) => `<form method="post" action="${esc(action)}" class="${cls}"${confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : ''}>${csrfField(req)}${inner}</form>`;

    function needUser(req, res) {
        if (req.caller.kind === 'user' && req.caller.subject) return true;
        page(req, res, {
            title: 'Sign in', canonicalPath: req.path,
            body: `<h1>Sign in</h1><p>OpenRe.Stream uses your OpenVibe account.</p><p><a href="/auth/login?next=${encodeURIComponent(req.originalUrl)}">Sign in with OpenVibe</a></p>`,
        }, 401);
        return false;
    }

    function checkCsrf(req, res) {
        const given = String((req.body && req.body._csrf) || '');
        const expected = csrfFor(req.caller.token || '');
        if (given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return true;
        page(req, res, { title: 'Expired form', body: '<h1>That form expired</h1><p>Go back, reload the page and try again.</p>' }, 403);
        return false;
    }

    async function ownDefinition(req, res, id) {
        const d = await store.definitions.get(id);
        if (!d || d.state === 'archived' || !auth.canAccess(req.caller, d.owner_subject)) {
            page(req, res, { title: 'Not found', body: '<h1>Stream not found</h1><p><a href="/streams">Your streams</a></p>' }, 404);
            return null;
        }
        return d;
    }

    async function ownDestination(req, res, id) {
        const dest = await store.outputs.destinationRow(id);
        const d = dest ? await ownDefinition(req, res, dest.definition_id) : null;
        if (!dest && !res.headersSent) page(req, res, { title: 'Not found', body: '<h1>Destination not found</h1>' }, 404);
        return d ? { dest, definition: d } : null;
    }

    const post = (path, fn) => router.post(path, async (req, res, next) => {
        if (!needUser(req, res) || !checkCsrf(req, res)) return;
        try { await fn(req, res); } catch (err) {
            if (err instanceof StoreError || err.code === 'openre.secrets_unavailable') {
                return page(req, res, { title: 'Could not save', body: `<div class="flash bad">${esc(err.message)}</div><p><a href="javascript:history.back()">Back</a></p>` }, err.status || 400);
            }
            return next(err);
        }
    });

    // ── Pages ─────────────────────────────────────────────────

    // What shipped on OpenRe.Stream: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => page(req, res, { canonicalPath: '/updates', robots: 'index,follow', title: 'What shipped on OpenRe.Stream', body: frame.updatesBody({ service: 'openre', siteName: 'OpenRe.Stream' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>` }));
    router.get('/', async (req, res) => {
        const signedIn = req.caller.kind === 'user' && req.caller.subject;
        const mine = signedIn ? await store.definitions.list({ owner_subject: req.caller.subject }) : [];
        page(req, res, {
            canonicalPath: '/', robots: 'index,follow', styles: [showcase.STYLESHEET],
            description: 'Go live from your browser with no OBS and no follower minimum on OpenVibe.Live, or restream an OBS feed to your other channels with OpenRe.Stream.',
            body: `${frontPage(config)}
${signedIn ? `<h2>Your streams</h2>${mine.length ? await streamTable(mine) : '<p class="muted">No streams yet.</p>'}<p><a href="/streams">Manage streams</a></p>` : '<p><a href="/auth/login?next=/streams">Sign in with OpenVibe</a> to manage your streams.</p>'}
${frame.shipped({ service: 'openre', title: 'Recently shipped on OpenRe.Stream' })}`,
        });
    });

    /**
     * The front page (openvibe-shared/showcase). It leads with going live from a browser, which today happens on
     * OpenVibe.Live; it states that only RTMP ingest and RTMP/SRT restreaming run here, and that WHIP and JSMPEG
     * are still Live's (the WebRTC and JSMPEG workers are ported but not deployed).
     */
    function frontPage(cfg) {
        const live = cfg.liveUrl;
        return showcase.hero({
            eyebrow: 'OpenRe.Stream · alpha',
            title: 'Go live from your browser.', accent: 'No OBS, no follower minimum.',
            lede: 'Open OpenVibe.Live, press Go Live and allow your camera: nothing to install, and no follower or subscriber threshold. OpenRe.Stream is the ingest and restream service behind it. With an encoder such as OBS, it takes your RTMP feed and sends the session on to your other channels.',
            actions: [
                { label: 'Go live in your browser', href: live, primary: true },
                { label: 'Restream with OBS', href: '/streams' },
                { label: 'Read the guide', href: `${live}/docs/go-live-in-your-browser` },
            ],
            note: 'Alpha. RTMP ingest and RTMP/SRT restreaming run here today; browser (WHIP) and JSMPEG ingest are still served by OpenVibe.Live. Channels, discovery and watch pages stay on openvibe.live.',
        }) + showcase.features({
            title: 'What OpenRe does',
            items: [
                { icon: 'ov:stream', title: 'Ingest keys you control', text: 'Create a stream and get its RTMP server and key. The key is shown once, stored only as a hash, and can be rotated any time.' },
                { icon: 'ov:live', title: 'One stream, several channels', text: 'Send a session to several RTMP or SRT destinations at once, each with its own health, logs and retry with backoff.' },
                { icon: 'ov:video', title: 'Recording', text: 'Per stream: record a VOD, keep clips only, or record nothing. OpenVibe.Media keeps the recordings.' },
                { icon: 'ov:check', title: 'Nothing to qualify for', text: 'Any signed-in OpenVibe account can create a stream. There is no follower, subscriber or eligibility threshold.' },
            ],
        }) + showcase.steps({
            title: 'Restream with OBS',
            items: [
                { title: 'Sign in', text: 'With your OpenVibe account.', href: '/auth/login?next=/streams' },
                { title: 'Create a stream', text: 'Copy the RTMP server and the key; the key is shown only once.' },
                { title: 'Add destinations', text: 'The server and key of each channel you also stream to. Test each one before you go live.' },
                { title: 'Go live from OBS', text: 'Each destination shows its health and logs while you stream.' },
            ],
        });
    }

    async function streamTable(list) {
        return `<table><tr><th>Stream</th><th>State</th><th>Now</th><th>Linked to</th></tr>${(await Promise.all(list.map(async (d) => {
            const open = (await store.sessions.openFor(d.id))[0];
            const refs = d.external_refs.map(r => `${r.service}:${r.type}:${r.id}`).join(', ');
            return `<tr><td><a href="/streams/${esc(d.id)}">${esc(d.title)}</a></td><td>${pill(d.state)}</td><td>${open ? pill(open.state) : '<span class="muted">offline</span>'}</td><td class="mono">${esc(refs) || '—'}</td></tr>`;
        }))).join('')}</table>`;
    }

    router.get('/streams', async (req, res) => {
        if (!needUser(req, res)) return;
        const list = await store.definitions.list({ owner_subject: req.caller.subject });
        page(req, res, {
            title: 'Streams', canonicalPath: '/streams',
            body: `<h1>Streams</h1>${list.length ? await streamTable(list) : '<p class="muted">No streams yet.</p>'}
<div class="card"><h2>New stream</h2>${form(req, '/streams', `
<label>Title</label><input type="text" name="title" maxlength="140" required>
<div class="row"><div><label>Recording</label><select name="recording_mode"><option value="vod">Record a VOD</option><option value="clips">Clips only</option><option value="none">Do not record</option></select></div>
<div><label>Recording visibility</label><select name="recording_visibility"><option>public</option><option>unlisted</option><option>private</option></select></div></div>
<button type="submit">Create stream</button><p class="muted">The ingest key is shown once, on the next page.</p>`)}</div>`,
        });
    });

    async function keyPage(req, res, definition, key, heading) {
        const ep = await store.definitions.ingestEndpoints(definition);
        res.set('Cache-Control', 'no-store');
        page(req, res, {
            title: heading, canonicalPath: `/streams/${definition.id}`,
            body: `<h1>${esc(heading)}</h1>
<div class="card"><p><strong>Copy the key now.</strong> OpenRe stores only a hash of it; this page is the only time it is shown.</p>
<label>Server (OBS: Settings → Stream → Custom)</label><code class="secret">${esc(ep.rtmp ? ep.rtmp.url : '')}</code>
<label>Stream key</label><code class="secret">${esc(key.key)}</code></div>
<p><a href="/streams/${esc(definition.id)}">Continue to the stream</a></p>`,
        });
    }

    post('/streams', async (req, res) => {
        const b = req.body || {};
        const { definition, key } = await store.definitions.create({
            owner_subject: req.caller.subject, title: b.title, recording_mode: b.recording_mode,
            recording_visibility: b.recording_visibility, created_by: req.caller.subject,
        });
        await keyPage(req, res, definition, key, 'Stream created');
    });

    router.get('/streams/:id', async (req, res) => {
        if (!needUser(req, res)) return;
        const d = await ownDefinition(req, res, req.params.id);
        if (!d) return;
        const ep = await store.definitions.ingestEndpoints(d);
        const keys = (await store.definitions.keys(d.id)).filter(k => k.status !== 'revoked');
        const dests = await store.outputs.destinations(d.id);
        const sessions = await store.sessions.list({ definition_id: d.id, limit: 15 });
        const open = await sessions.find(s => ['starting', 'live', 'ending'].includes(s.state));
        const outputs = open ? await store.outputs.outputsOfSession(open.id) : [];
        const outFor = async (destId) => await outputs.find(o => o.destination_id === destId);
        page(req, res, {
            title: d.title, canonicalPath: `/streams/${d.id}`,
            body: `<h1>${esc(d.title)} ${pill(d.state)}</h1>
<p class="muted mono">${esc(d.id)}${d.external_refs.length ? ` · linked to ${esc(d.external_refs.map(r => `${r.service}:${r.type}:${r.id}`).join(', '))}` : ''}</p>
<div class="card"><h2>Ingest</h2>
${ep.rtmp ? `<label>RTMP server</label><code class="secret">${esc(ep.rtmp.url)}</code>` : '<p class="muted">RTMP is not enabled for this stream.</p>'}
<table><tr><th>Key</th><th>Status</th><th>Created</th><th>Last used</th></tr>${keys.map(k => `<tr><td class="mono">ork_…${esc(k.hint)}</td><td>${pill(k.status)}${k.grace_until ? ` until ${esc(iso(k.grace_until))}` : ''}</td><td>${esc(iso(k.created_at))}</td><td>${esc(iso(k.last_used_at))}</td></tr>`).join('') || '<tr><td colspan="4">No usable key: rotate to get one.</td></tr>'}</table>
${form(req, `/streams/${d.id}/rotate`, `<div class="row"><div><label>Old key stays valid for (seconds, 0 = revoke now)</label><input type="number" name="grace_seconds" min="0" max="604800" value="0"></div>
<div><label><input type="checkbox" name="end_sessions" value="1"> also disconnect a running session</label></div></div><button type="submit" class="danger">Rotate key</button>`, { confirm: 'Issue a new key and retire the current one?' })}
</div>
<div class="card"><h2>Now</h2>${open ? `<p>${pill(open.state)} since ${esc(iso(open.live_at || open.created_at))} on ${esc(open.worker_kind)} generation ${esc(open.worker_generation)} · <a href="/sessions/${esc(open.id)}">session</a></p>
${form(req, `/sessions/${open.id}/end`, '<button type="submit" class="danger">End session</button>', { cls: 'inline', confirm: 'Disconnect the encoder?' })}` : '<p class="muted">Offline.</p>'}</div>
<div class="card"><h2>Restream destinations</h2>
${dests.length ? `<table><tr><th>Destination</th><th>Output</th><th>Health</th><th>Actions</th></tr>${(await Promise.all(dests.map(async (x) => {
                const o = await outFor(x.id);
                return `<tr><td><strong>${esc(x.name || x.platform)}</strong> <span class="muted">${esc(x.platform)}</span><br><span class="mono">${esc(x.server_url)}</span><br><span class="muted">key ${esc(x.stream_key_hint || 'not set')}${x.enabled ? '' : ' · disabled'}${x.auto_start ? ' · auto-start' : ''}${x.hold_reason ? ` · held: ${esc(x.hold_reason)}` : ''}${x.cooldown_ms ? ` · cooling down until ${esc(x.cooldown_until)}` : ''}</span></td>
<td>${o ? pill(o.state) : '<span class="muted">—</span>'}</td>
<td>${o && o.progress ? `${esc(o.progress.fps ?? '?')} fps · ${esc(o.progress.bitrate_kbps ?? '?')} kbit/s · speed ${esc(o.progress.speed ?? '?')}` : ''}${o && o.last_error ? `<br><span class="muted">${esc(o.last_error)}</span>` : ''}${!o && x.last_error ? `<span class="muted">${esc(x.last_error)}</span>` : ''}</td>
<td>${form(req, `/destinations/${x.id}/test`, '<button type="submit" class="secondary">Test</button>', { cls: 'inline' })}${open ? (o && ['pending', 'starting', 'live', 'error'].includes(o.state) ? form(req, `/destinations/${x.id}/stop`, '<button type="submit" class="secondary">Stop</button>', { cls: 'inline' }) : form(req, `/destinations/${x.id}/start`, '<button type="submit">Start</button>', { cls: 'inline' })) : ''}
<a href="/destinations/${esc(x.id)}">Edit</a>${form(req, `/destinations/${x.id}/delete`, '<button type="submit" class="danger">Delete</button>', { cls: 'inline', confirm: 'Delete this destination?' })}</td></tr>`;
            }))).join('')}</table>` : '<p class="muted">No destinations.</p>'}
<h3>Add a destination</h3>${form(req, `/streams/${d.id}/destinations`, destinationFields({}))}</div>
<div class="card"><h2>Settings</h2>${form(req, `/streams/${d.id}`, `
<label>Title</label><input type="text" name="title" maxlength="140" value="${esc(d.title)}">
<div class="row"><div><label>Recording</label><select name="recording_mode">${['vod', 'clips', 'none'].map(m => `<option value="${m}"${d.recording_mode === m ? ' selected' : ''}>${m}</option>`).join('')}</select></div>
<div><label>Recording visibility</label><select name="recording_visibility">${['public', 'unlisted', 'private'].map(m => `<option${d.recording_visibility === m ? ' selected' : ''}>${m}</option>`).join('')}</select></div>
<div><label>Playback</label><select name="playback_visibility">${['public', 'unlisted', 'private'].map(m => `<option${d.playback_visibility === m ? ' selected' : ''}>${m}</option>`).join('')}</select></div>
<div><label>State</label><select name="state">${['active', 'disabled'].map(m => `<option${d.state === m ? ' selected' : ''}>${m}</option>`).join('')}</select></div></div>
<label><input type="checkbox" name="mirror_to_live" value="1"${d.mirror_to_live ? ' checked' : ''}> Mirror sessions into my OpenVibe.Live channel (consent; Live also has to switch this slot to OpenRe)</label>
<button type="submit">Save</button>`)}</div>
<h2>Sessions</h2>${sessionTable(sessions)}`,
        });
    });

    function destinationFields(x) {
        const sel = (name, opts, cur) => `<select name="${name}">${opts.map(o => `<option${o === cur ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
        return `<div class="row"><div><label>Platform</label>${sel('platform', ['twitch', 'youtube', 'kick', 'custom'], x.platform)}</div>
<div><label>Name</label><input type="text" name="name" maxlength="80" value="${esc(x.name || '')}"></div></div>
<label>Server URL (rtmp://, rtmps:// or srt://)</label><input type="text" name="server_url" maxlength="2048" value="${esc(x.server_url || '')}" required>
<label>Stream key ${x.id ? '(leave empty to keep the stored key)' : ''}</label><input type="password" name="stream_key" autocomplete="off" maxlength="512">
<div class="row"><div><label>Quality (only used when re-encoding)</label>${sel('quality_preset', ['auto', 'low', 'medium', 'high', 'ultra', 'source'], x.quality_preset || 'auto')}</div>
<div><label>SRT latency (ms)</label><input type="number" name="srt_latency_ms" min="20" max="8000" value="${esc(x.srt_latency_ms || '')}"></div>
<div><label>SRT passphrase ${x.id ? '(empty = keep)' : ''}</label><input type="password" name="srt_passphrase" autocomplete="off" maxlength="79"></div></div>
<label><input type="checkbox" name="enabled" value="1"${x.enabled === false ? '' : ' checked'}> enabled</label>
<label><input type="checkbox" name="auto_start" value="1"${x.auto_start === false ? '' : ' checked'}> start automatically when the stream goes live</label>
<button type="submit">${x.id ? 'Save destination' : 'Add destination'}</button>`;
    }

    function destInput(b, { editing }) {
        const out = {
            platform: b.platform, name: b.name, server_url: b.server_url, quality_preset: b.quality_preset,
            enabled: b.enabled === '1', auto_start: b.auto_start === '1',
            srt_latency_ms: b.srt_latency_ms === '' || b.srt_latency_ms == null ? null : b.srt_latency_ms,
        };
        if (!editing || b.stream_key) out.stream_key = b.stream_key || '';
        if (!editing || b.srt_passphrase) out.srt_passphrase = b.srt_passphrase || '';
        return out;
    }

    function sessionTable(list) {
        if (!list.length) return '<p class="muted">No sessions yet.</p>';
        return `<table><tr><th>Session</th><th>State</th><th>Started</th><th>Ended</th><th>Worker</th></tr>${list.map(s => `<tr><td><a class="mono" href="/sessions/${esc(s.id)}">${esc(s.id)}</a></td><td>${pill(s.state)}${s.failure_reason ? ` <span class="muted">${esc(s.failure_reason)}</span>` : ''}</td><td>${esc(iso(s.live_at || s.created_at))}</td><td>${esc(iso(s.ended_at))}</td><td>${esc(s.worker_kind)} #${esc(s.worker_generation)}</td></tr>`).join('')}</table>`;
    }

    post('/streams/:id', async (req, res) => {
        const d = await ownDefinition(req, res, req.params.id);
        if (!d) return;
        const b = req.body || {};
        await store.definitions.update(d.id, { title: b.title, recording_mode: b.recording_mode, recording_visibility: b.recording_visibility, playback_visibility: b.playback_visibility, state: b.state, mirror_to_live: b.mirror_to_live === '1' });
        res.redirect(303, `/streams/${d.id}`);
    });

    post('/streams/:id/rotate', async (req, res) => {
        const d = await ownDefinition(req, res, req.params.id);
        if (!d) return;
        const r = await store.definitions.rotateKey(d.id, { grace_seconds: Number(req.body.grace_seconds) || 0, rotated_by: req.caller.subject });
        if (req.body.end_sessions === '1') for (const s of await store.sessions.openFor(d.id)) await store.sessions.requestEnd(s.id, `key_rotation:${req.caller.subject}`);
        await keyPage(req, res, await store.definitions.get(d.id), r.key, 'New ingest key');
    });

    post('/streams/:id/destinations', async (req, res) => {
        const d = await ownDefinition(req, res, req.params.id);
        if (!d) return;
        await store.outputs.createDestination(d.id, destInput(req.body || {}, { editing: false }));
        res.redirect(303, `/streams/${d.id}`);
    });

    router.get('/destinations/:id', async (req, res) => {
        if (!needUser(req, res)) return;
        const own = await ownDestination(req, res, req.params.id);
        if (!own) return;
        const x = store.outputs.publicDest(own.dest);
        const logs = await store.outputs.logsOfDestination(x.id, 50);
        page(req, res, {
            title: `Destination ${x.name || x.platform}`, canonicalPath: `/destinations/${x.id}`,
            body: `<h1>${esc(x.name || x.platform)}</h1><p><a href="/streams/${esc(own.definition.id)}">← ${esc(own.definition.title)}</a></p>
<div class="card">${form(req, `/destinations/${x.id}`, destinationFields(x))}</div>
<h2>Log</h2>${logs.length ? `<table><tr><th>When</th><th>Level</th><th>Message</th></tr>${logs.map(l => `<tr><td>${esc(iso(l.at))}</td><td>${pill(l.level === 'error' ? 'failed' : l.level === 'warn' ? 'error' : 'ok')}</td><td class="mono">${esc(l.message)}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing logged yet.</p>'}`,
        });
    });

    post('/destinations/:id', async (req, res) => {
        const own = await ownDestination(req, res, req.params.id);
        if (!own) return;
        await store.outputs.updateDestination(own.dest.id, destInput(req.body || {}, { editing: true }));
        res.redirect(303, `/streams/${own.definition.id}`);
    });

    post('/destinations/:id/delete', async (req, res) => {
        const own = await ownDestination(req, res, req.params.id);
        if (!own) return;
        await store.outputs.deleteDestination(own.dest.id);
        res.redirect(303, `/streams/${own.definition.id}`);
    });

    post('/destinations/:id/test', async (req, res) => {
        const own = await ownDestination(req, res, req.params.id);
        if (!own) return;
        const result = await testDestination(own.dest, { allowPrivate: config.outputs.allowPrivateHosts });
        await store.outputs.log(null, own.dest.id, result.ok ? 'info' : 'warn', `test ${result.ok ? 'passed' : 'failed'}: ${result.checks.map(c => `${c.check} ${c.ok ? 'ok' : 'FAIL'} (${c.detail})`).join('; ')}`);
        page(req, res, {
            title: 'Destination test',
            body: `<h1>Test ${result.ok ? pill('ok') : pill('failed')}</h1><table>${result.checks.map(c => `<tr><td>${esc(c.check)}</td><td>${c.ok ? pill('ok') : pill('failed')}</td><td>${esc(c.detail)}</td></tr>`).join('')}</table>
<p class="muted">A passing test means the ingest is reachable. Whether the platform accepts the key shows once an output runs.</p><p><a href="/streams/${esc(own.definition.id)}">Back</a></p>`,
        });
    });

    post('/destinations/:id/start', async (req, res) => {
        const own = await ownDestination(req, res, req.params.id);
        if (!own) return;
        await store.outputs.startDestination(own.dest.id);
        res.redirect(303, `/streams/${own.definition.id}`);
    });

    post('/destinations/:id/stop', async (req, res) => {
        const own = await ownDestination(req, res, req.params.id);
        if (!own) return;
        await store.outputs.stopDestination(own.dest.id);
        res.redirect(303, `/streams/${own.definition.id}`);
    });

    router.get('/sessions', async (req, res) => {
        if (!needUser(req, res)) return;
        const all = req.caller.staff && req.query.all === '1';
        page(req, res, { title: 'Sessions', canonicalPath: '/sessions', body: `<h1>Sessions</h1>${req.caller.staff ? `<p class="muted"><a href="/sessions${all ? '' : '?all=1'}">${all ? 'Only mine' : 'Everyone (staff)'}</a></p>` : ''}${sessionTable(await store.sessions.list({ owner_subject: all ? undefined : req.caller.subject, limit: 100 }))}` });
    });

    router.get('/sessions/:id', async (req, res) => {
        if (!needUser(req, res)) return;
        const s = await store.sessions.get(req.params.id);
        const d = s ? await store.definitions.row(s.definition_id) : null;
        if (!s || !d || !auth.canAccess(req.caller, d.owner_subject)) return page(req, res, { title: 'Not found', body: '<h1>Session not found</h1>' }, 404);
        const outputs = await store.outputs.outputsOfSession(s.id);
        const rec = await store.recordings.bySession(s.id);
        const pb = await store.sessions.playback(s);
        const open = ['starting', 'live', 'ending'].includes(s.state);
        return page(req, res, {
            title: `Session ${s.id}`, canonicalPath: `/sessions/${s.id}`,
            body: `<h1>Session ${pill(s.state)}</h1><p class="mono">${esc(s.id)}</p><p><a href="/streams/${esc(d.id)}">← ${esc(d.title)}</a></p>
<div class="card"><table>
<tr><th>Protocol</th><td>${esc(s.protocol)}</td></tr>
<tr><th>Worker</th><td>${esc(s.worker_kind)} generation ${esc(s.worker_generation)} <span class="mono muted">${esc(s.worker_id)}</span></td></tr>
<tr><th>Live since</th><td>${esc(iso(s.live_at))}</td></tr><tr><th>Ended</th><td>${esc(iso(s.ended_at))} ${esc(s.end_reason || s.failure_reason || '')}</td></tr>
<tr><th>Media</th><td>${s.media_info ? esc(`${s.media_info.video_codec || '?'} ${s.media_info.width || '?'}×${s.media_info.height || '?'} @${s.media_info.fps || '?'} · ${s.media_info.audio_codec || 'no audio'} · ${s.media_info.bitrate_kbps || '?'} kbit/s`) : '—'}</td></tr>
<tr><th>Recording</th><td>${rec ? `${pill(rec.state)} ${rec.media_vod_id ? `Media ${esc(rec.media_app)} VOD ${esc(rec.media_vod_id)}` : ''} ${esc(rec.last_error || '')}` : '<span class="muted">none</span>'}</td></tr>
<tr><th>Playback</th><td>${pb && pb.flv && s.state === 'live' ? `<a class="mono" href="${esc(pb.flv.public_url)}">${esc(pb.flv.public_url)}</a> (HTTP-FLV)` : '—'}</td></tr>
</table>${open ? form(req, `/sessions/${s.id}/end`, '<button type="submit" class="danger">End session</button>', { confirm: 'Disconnect the encoder?' }) : ''}</div>
<h2>Outputs</h2>${outputs.length ? `<table><tr><th>Output</th><th>State</th><th>Health</th><th>Restarts</th></tr>${(await outputs.map(o => `<tr><td class="mono">${esc(o.id)}<br><span class="muted">${esc(o.destination_id)}</span></td><td>${pill(o.state)}</td><td>${o.progress ? `${esc(o.progress.fps ?? '?')} fps · ${esc(o.progress.bitrate_kbps ?? '?')} kbit/s` : ''} ${esc(o.last_error || '')}</td><td>${esc(o.restart_attempts)}/${esc(o.max_restart_attempts)}</td></tr>`)).join('')}</table>` : '<p class="muted">No outputs.</p>'}
<h2>Lifecycle</h2><table>${(await store.sessions.transitions(s.id)).map(t => `<tr><td>${esc(iso(t.at))}</td><td>${esc(t.from_state || '·')} → ${pill(t.to_state)}</td><td>${esc(t.reason || '')}</td><td class="mono muted">${esc(t.actor || '')}</td></tr>`).join('')}</table>`,
        });
    });

    post('/sessions/:id/end', async (req, res) => {
        const s = await store.sessions.get(req.params.id);
        const d = s ? await store.definitions.row(s.definition_id) : null;
        if (!s || !d || !auth.canAccess(req.caller, d.owner_subject)) return page(req, res, { title: 'Not found', body: '<h1>Session not found</h1>' }, 404);
        await store.sessions.requestEnd(s.id, req.caller.subject);
        return res.redirect(303, `/sessions/${s.id}`);
    });

    return router;
}

module.exports = { createUiRouter, csrfFor };
