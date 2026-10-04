'use strict';
/**
 * deploy/nginx/openre.stream.conf must carry a live (not ##-commented) server block for
 * ingest.openre.stream: the WHIP ingest a robot's camera publishes to (OpenVibe.Bot
 * whip_url = https://ingest.openre.stream/whip/<key>) is TLS + a proxy to the webrtc worker on 9936.
 *   - it proxies to 127.0.0.1:9936 and passes Host (the worker builds the WHIP Location from it);
 *   - it upgrades WebSockets (/b/<key>, /w/<id>) through a $connection_upgrade map defined once;
 *   - the section docs/cutover.md extracts with sed (the ## >>> / ## <<< markers) is self-contained;
 *   - ingest keys are in the path, so the vhost keeps no access log.
 * File parsing only; no nginx binary.
 */
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'openre.stream.conf'), 'utf8');
// What nginx reads: drop comments (## banners and # notes) and blank lines.
const live = (text) => text.split('\n').map((l) => l.replace(/#.*$/, '').trimEnd()).filter(Boolean).join('\n');

/** The top-level server { … } blocks of a config, by brace depth. */
function serverBlocks(text) {
    const blocks = [];
    const re = /^server\s*\{/gm;
    let m;
    while ((m = re.exec(text))) {
        let depth = 0;
        for (let i = m.index; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}' && --depth === 0) { blocks.push(text.slice(m.index, i + 1)); re.lastIndex = i + 1; break; }
        }
    }
    return blocks;
}

const ingestOf = (text) => serverBlocks(live(text)).filter((b) => /^\s*server_name\s+ingest\.openre\.stream\s*;/m.test(b));
const has = (block, directive) => new RegExp(`^\\s*${directive.replace(/[$.*()[\]]/g, '\\$&').replace(/ /g, '\\s+')}\\s*;`, 'm').test(block);

test('the ingest.openre.stream server block is live, TLS on 443, proxied to the webrtc worker on 9936', () => {
    const blocks = ingestOf(conf);
    assert.strictEqual(blocks.length, 1, 'exactly one uncommented ingest.openre.stream server block');
    const [b] = blocks;
    assert.ok(has(b, 'listen 443 ssl'), 'listens on 443 with TLS');
    assert.ok(/^\s*ssl_certificate\s+\/etc\/letsencrypt\/live\/[^/]+\/fullchain\.pem\s*;/m.test(b), 'has a certificate');
    assert.ok(/^\s*ssl_certificate_key\s+\/etc\/letsencrypt\/live\/[^/]+\/privkey\.pem\s*;/m.test(b), 'has a key');
    assert.ok(has(b, 'proxy_pass http://127.0.0.1:9936'), 'proxies to OPENRE_WEBRTC_PORT on loopback');
    assert.ok(has(b, 'proxy_set_header Host $host'), 'passes Host: the WHIP Location is built from it');
    assert.ok(has(b, 'access_log off'), 'no access log: the ingest key is in the request path');
});

test('WebSocket upgrade headers for /b/* and /w/*, with $connection_upgrade mapped exactly once', () => {
    const [b] = ingestOf(conf);
    assert.ok(has(b, 'proxy_http_version 1.1'));
    assert.ok(has(b, 'proxy_set_header Upgrade $http_upgrade'));
    assert.ok(has(b, 'proxy_set_header Connection $connection_upgrade'));
    const maps = live(conf).match(/^map\s+\$http_upgrade\s+\$connection_upgrade\s*\{/gm) || [];
    assert.strictEqual(maps.length, 1, '$connection_upgrade is defined once, at the top (http{}) level');
    assert.ok(/^map\s+\$http_upgrade\s+\$connection_upgrade\s*\{\s*default\s+upgrade;\s*''\s+close;\s*\}/m.test(live(conf)));
});

test('the marked section installs on its own: map + ingest server block, nothing else', () => {
    const start = conf.search(/^## >>> ingest\.openre\.stream/m);
    const endMatch = /^## <<< ingest\.openre\.stream.*$/m.exec(conf);
    assert.ok(start >= 0 && endMatch && endMatch.index > start, 'both markers, in order');
    const section = conf.slice(start, endMatch.index + endMatch[0].length);
    assert.strictEqual(ingestOf(section).length, 1);
    assert.strictEqual(serverBlocks(live(section)).length, 1, 'only the ingest server block');
    assert.match(live(section), /^map\s+\$http_upgrade\s+\$connection_upgrade/m, 'the map travels with the block');
    assert.doesNotMatch(live(section), /limit_(req|conn)_zone/, 'the openre.stream zones stay out of it');
});
