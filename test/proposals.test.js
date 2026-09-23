'use strict';
// The capability and service manifest proposals are valid contracts documents, and they match what
// the code enforces and emits (so the contracts release that adopts them is exact).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contracts = require('openvibe-contracts');
const { TYPES } = require('../server/events');
const { suite, ROOT } = require('./helpers');

const t = suite('proposals');
const dir = path.join(ROOT, 'docs', 'capabilities-proposal');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'service-manifest-proposal.json'), 'utf8'));

t('every capability proposal validates against capabilities.capability@1 and has three segments', () => {
    for (const f of fs.readdirSync(dir)) {
        const cap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const v = contracts.validate('capabilities.capability@1', cap);
        assert.ok(v.valid, `${f}: ${JSON.stringify(v.errors)}`);
        assert.strictEqual(`${cap.id}.json`, f);
        assert.strictEqual(cap.id.split('.').length, 3);
        assert.strictEqual(cap.owner, 'openre');
    }
});

t('the service manifest proposal validates and lists exactly the guarded capabilities and emitted events', () => {
    const v = contracts.validate('registry.service-manifest@1', manifest);
    assert.ok(v.valid, JSON.stringify(v.errors));
    const code = fs.readFileSync(path.join(ROOT, 'server', 'api', 'v1.js'), 'utf8');
    const guarded = [...new Set([...code.matchAll(/guard\('([a-z.]+)'\)/g)].map(m => m[1]))].sort();
    assert.deepStrictEqual(guarded, [...manifest.capabilities].sort());
    assert.deepStrictEqual(fs.readdirSync(dir).map(f => f.replace(/\.json$/, '')).sort(), guarded);
    assert.deepStrictEqual([...manifest.eventsProduced].sort(), Object.values(TYPES).sort());
});

t.run();
