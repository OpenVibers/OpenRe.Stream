'use strict';
/**
 * Pre-launch review fixes (2026-10-09):
 *   - a restream output connects to the address its host was checked against (DNS rebinding): rtmp:// and srt:// carry
 *     the address, RTMP keeps the name in -rtmp_tcurl; rtmps:// keeps the name (TLS needs it);
 *   - a destination test connects to the checked address, never the name again;
 *   - sign-in's next refuses control characters and backslashes (browsers drop tabs and read \ as /).
 */
const assert = require('assert');
const { pinDestUrl } = require('../workers/restream/ffmpeg-args');
const { testDestination } = require('../server/destination-test');
const { sanitizeNext } = require('../server/auth/sso');

(async () => {
    assert.deepStrictEqual(pinDestUrl('rtmp://live.example.com/app/KEY123', '93.184.216.34'),
        { url: 'rtmp://93.184.216.34/app/KEY123', extra: ['-rtmp_tcurl', 'rtmp://live.example.com:1935/app'] });
    assert.deepStrictEqual(pinDestUrl('rtmp://live.example.com:1940/live2/k', '2606:2800:220:1::1'),
        { url: 'rtmp://[2606:2800:220:1::1]:1940/live2/k', extra: ['-rtmp_tcurl', 'rtmp://live.example.com:1940/live2'] });
    assert.deepStrictEqual(pinDestUrl('srt://srt.example.com:9000?streamid=k&mode=caller', '93.184.216.34'),
        { url: 'srt://93.184.216.34:9000?streamid=k&mode=caller', extra: [] });
    assert.deepStrictEqual(pinDestUrl('rtmps://live.twitch.tv/app/k', '93.184.216.34'), { url: 'rtmps://live.twitch.tv/app/k', extra: [] }, 'rtmps keeps its name');
    assert.deepStrictEqual(pinDestUrl('rtmp://live.example.com/app/k', undefined), { url: 'rtmp://live.example.com/app/k', extra: [] }, 'nothing to pin (private hosts allowed)');

    // The test probe gets the address the lookup answered, not the name a second lookup could rebind.
    const probed = [];
    const r = await testDestination({ server_url: 'rtmp://rebind.example.com/app', has_stream_key: true }, {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        probe: async (host, port) => { probed.push(`${host}:${port}`); return { ok: true, ms: 1 }; },
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(probed, ['93.184.216.34:1935']);

    assert.strictEqual(sanitizeNext('/streams/std_1'), '/streams/std_1');
    for (const bad of ['/\t/evil.com', '/\n/evil.com', '/\\evil.com', '/a\\b', '//evil.com', 'https://evil.com', '', null]) {
        assert.strictEqual(sanitizeNext(bad), '/', `${JSON.stringify(bad)} stays on the site`);
    }
    console.log('launch hardening: outputs and tests pinned to the checked address; next stays on the site');
})().catch((err) => { console.error(err); process.exit(1); });
