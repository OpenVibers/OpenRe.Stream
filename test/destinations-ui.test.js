'use strict';
// Destination URL rules (SSRF), ffmpeg argument parity with Live's restream manager, and the
// standalone UI (server-rendered, CSRF-protected, key shown once).
const assert = require('assert');
const { validateDestinationUrl, checkResolvedHost, isPrivateAddress } = require('../server/destination-url');
const ff = require('../workers/restream/ffmpeg-args');
const { bootApi, request, userToken, suite, OWNER, OTHER } = require('./helpers');
const { csrfFor } = require('../server/ui/routes');

const t = suite('destinations-ui');

t('destination URLs: live-streaming schemes with public hosts only', async () => {
    const ok = (u) => validateDestinationUrl(u).ok;
    assert.ok(ok('rtmp://a.rtmp.youtube.com/live2'));
    assert.ok(ok('rtmps://live.twitch.tv/app'));
    assert.ok(ok('srt://ingest.example.com:9000?latency=200'));
    for (const bad of ['file:///etc/passwd', 'http://example.com/x', '/tmp/out.flv', 'rtmp://user:pass@host/app', 'rtmp://127.0.0.1/app',
        'rtmp://10.0.0.5/app', 'rtmp://169.254.169.254/latest', 'rtmp://[::1]/app', 'rtmp://localhost/app', 'rtmp://nas.local/app', 'rtmp://host/app x']) {
        assert.ok(!ok(bad), bad);
    }
    assert.ok(validateDestinationUrl('rtmp://127.0.0.1/app', { allowPrivate: true }).ok);
    assert.ok(isPrivateAddress('100.64.1.1') && isPrivateAddress('::ffff:192.168.1.1') && !isPrivateAddress('8.8.8.8'));
    const rebinding = await checkResolvedHost('evil.example', { lookup: async () => [{ address: '8.8.8.8' }, { address: '10.1.2.3' }] });
    assert.strictEqual(rebinding.ok, false, 'any private answer refuses the host');
    assert.ok((await checkResolvedHost('good.example', { lookup: async () => [{ address: '8.8.8.8' }] })).ok);
});

t('ffmpeg arguments match Live: codec copy from HTTP-FLV, platform URL fixes, SRT options, redaction', () => {
    assert.strictEqual(ff.buildDestUrl({ platform: 'twitch', server_url: 'rtmp://live.twitch.tv/app/', stream_key: 'live_1' }), 'rtmps://live.twitch.tv/app/live_1');
    assert.strictEqual(ff.buildDestUrl({ platform: 'kick', server_url: 'rtmps://x.global-contribute.live-video.net', stream_key: 'sk' }), 'rtmps://x.global-contribute.live-video.net/app/sk');
    const srt = new URL(ff.buildDestUrl({ platform: 'custom', server_url: 'srt://srt.example:9000', stream_key: 'sid', srt_latency_ms: 200, srt_passphrase: 'passphrase123' }));
    assert.strictEqual(srt.searchParams.get('streamid'), 'sid');
    assert.strictEqual(srt.searchParams.get('latency'), '200000');
    assert.strictEqual(srt.searchParams.get('mode'), 'caller');
    assert.strictEqual(srt.searchParams.get('pkt_size'), '1316');
    const args = ff.withProgress(ff.rtmpCopyArgs('http://127.0.0.1:1/live/ses_x.flv', 'rtmp://dest/app/key'));
    assert.deepStrictEqual(args, ['-hide_banner', '-progress', 'pipe:1', '-stats_period', '1', '-loglevel', 'warning', '-rw_timeout', '10000000',
        '-i', 'http://127.0.0.1:1/live/ses_x.flv', '-c', 'copy', '-fflags', '+nobuffer+discardcorrupt', '-muxdelay', '0', '-muxpreload', '0',
        '-flush_packets', '1', '-max_muxing_queue_size', '4096', '-rtmp_live', 'live', '-f', 'flv', '-flvflags', 'no_duration_filesize', 'rtmp://dest/app/key']);
    assert.deepStrictEqual(ff.outputArgs('srt://h:1?streamid=a').slice(-5), ['-f', 'mpegts', '-mpegts_flags', '+resend_headers', 'srt://h:1?streamid=a']);
    assert.strictEqual(ff.redactUrl('rtmps://live.twitch.tv/app/live_123456789'), 'rtmps://live.twitch.tv/app/****6789');
    assert.ok(!ff.redactUrl('srt://h:1?streamid=secret&passphrase=pw12345678').includes('secret'));
    assert.match(ff.friendlyError('Connection refused', 'twitch'), /Twitch's ingest server/);
    assert.match(ff.friendlyError('NetStream.Publish.BadName', 'youtube'), /Youtube rejected the stream key/);
});

let api;
const cookie = `ov_token=${userToken({ subjectId: OWNER })}`;

t('the UI works without JavaScript: landing, sign-in prompt, streams', async () => {
    api = await bootApi();
    const home = await request(api.base, 'GET', '/');
    assert.strictEqual(home.status, 200);
    assert.match(home.text, /OpenRe\.Stream/);
    assert.match(home.text, /theme-loader\.js/);
    assert.match(home.text, /<noscript><nav/);
    const signin = await request(api.base, 'GET', '/streams');
    assert.strictEqual(signin.status, 401);
    assert.match(signin.text, /Sign in with OpenVibe/);
    const mine = await request(api.base, 'GET', '/streams', { cookie });
    assert.strictEqual(mine.status, 200);
    assert.match(mine.text, /New stream/);
});

t('forms need the CSRF token; creating a stream shows the key once', async () => {
    const noCsrf = await request(api.base, 'POST', '/streams', { cookie, form: { title: 'Nope' } });
    assert.strictEqual(noCsrf.status, 403);
    const token = cookie.slice('ov_token='.length);
    const created = await request(api.base, 'POST', '/streams', { cookie, form: { title: 'Form stream', recording_mode: 'none', recording_visibility: 'public', _csrf: csrfFor(token) } });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.headers.get('cache-control'), 'no-store');
    const key = /(ork_[A-Za-z0-9_-]{43})/.exec(created.text)[1];
    const def = api.rt.store.definitions.list({ owner_subject: OWNER })[0];
    assert.strictEqual(api.rt.store.definitions.resolveIngestKey(key, 'rtmp').definition.id, def.id);
    const page = await request(api.base, 'GET', `/streams/${def.id}`, { cookie });
    assert.strictEqual(page.status, 200);
    assert.ok(!page.text.includes(key), 'the stream page never shows the key again');
    assert.match(page.text, new RegExp(`ork_…${key.slice(-4)}`));
    // Destination add through the form; the key is write-only.
    const add = await request(api.base, 'POST', `/streams/${def.id}/destinations`, { cookie, form: { platform: 'twitch', name: 'T', server_url: 'rtmps://live.twitch.tv/app', stream_key: 'live_abcdef_9876', enabled: '1', auto_start: '1', _csrf: csrfFor(token) } });
    assert.strictEqual(add.status, 303);
    const after = await request(api.base, 'GET', `/streams/${def.id}`, { cookie });
    assert.ok(!after.text.includes('live_abcdef_9876'));
    assert.match(after.text, /\*\*\*\*9876/);
    // Someone else cannot open it.
    const other = await request(api.base, 'GET', `/streams/${def.id}`, { cookie: `ov_token=${userToken({ subjectId: OTHER })}` });
    assert.strictEqual(other.status, 404);
    // Rotation through the form shows the new key once.
    const rotated = await request(api.base, 'POST', `/streams/${def.id}/rotate`, { cookie, form: { grace_seconds: '0', _csrf: csrfFor(token) } });
    const key2 = /(ork_[A-Za-z0-9_-]{43})/.exec(rotated.text)[1];
    assert.notStrictEqual(key2, key);
    assert.strictEqual(api.rt.store.definitions.resolveIngestKey(key, 'rtmp').error, 'revoked_key');
    await api.close();
});

t.run();
