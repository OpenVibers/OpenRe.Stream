'use strict';
/**
 * deploy/scripts/deploy.sh is a thin wrapper around `ovhost deploy openre` (OpenVibe.Host, strategy
 * release-layout; roadmap WS-N task 11). A fake ovhost records what the wrapper asks for.
 *   - deploy → ovhost deploy openre; release [<ref>] → --prepare-only, and the sha12 alone on stdout;
 *     api [<sha>] → deploy --to <sha>; rollback → ovhost rollback; plan / DRY_RUN=1 → ovhost plan;
 *   - a missing ovhost fails with a clear error;
 *   - workers|status|prune go to deploy/scripts/workers.sh, never to ovhost.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const WRAPPER = path.join(__dirname, '..', 'deploy', 'scripts', 'deploy.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openre-deploy-wrapper-'));
const log = path.join(tmp, 'calls.log');
const sh = (cmd) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The clone the release sha is read from (as deploy.sh release printed it before).
const root = path.join(tmp, 'opt');
sh(`git init -q -b main "${root}/repo" && cd "${root}/repo" && git config user.email t@t && git config user.name t && echo x > a && git add a && git commit -qm one && git update-ref refs/remotes/origin/main HEAD`);
const sha12 = sh(`git -C "${root}/repo" rev-parse --short=12 HEAD`).trim();

const ovhost = path.join(tmp, 'ovhost');
fs.writeFileSync(ovhost, `#!/usr/bin/env bash
echo "ovhost $*" >> "${log}"
echo "[ovhost] progress output"
exit "\${FAKE_EXIT:-0}"
`, { mode: 0o755 });
function run(args = [], env = {}) {
    fs.rmSync(log, { force: true });
    const r = spawnSync('bash', [WRAPPER, ...args], { env: { PATH: process.env.PATH, HOME: tmp, OVHOST: ovhost, OVHOST_SUDO: '', OPENRE_ROOT: root, ...env }, encoding: 'utf8' });
    let calls = [];
    try { calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
    return { code: r.status, stdout: r.stdout, out: r.stdout + r.stderr, calls };
}

assert.deepStrictEqual(run().calls, ['ovhost deploy openre']);
assert.deepStrictEqual(run(['deploy', 'origin/main']).calls, ['ovhost deploy openre --to origin/main']);
let r = run(['release']);
assert.strictEqual(r.code, 0, r.out);
assert.deepStrictEqual(r.calls, ['ovhost deploy openre --prepare-only']);
assert.strictEqual(r.stdout, `${sha12}\n`, 'the sha12 alone on stdout; ovhost progress goes to stderr');
assert.deepStrictEqual(run(['api', sha12]).calls, [`ovhost deploy openre --to ${sha12}`]);
assert.deepStrictEqual(run(['api', sha12, '--wait-idle']).calls, [`ovhost deploy openre --to ${sha12} --wait-idle`]);
assert.deepStrictEqual(run(['rollback']).calls, ['ovhost rollback openre']);
assert.deepStrictEqual(run(['rollback', sha12]).calls, [`ovhost rollback openre --to ${sha12}`]);
assert.deepStrictEqual(run(['plan']).calls, ['ovhost plan openre']);
assert.deepStrictEqual(run([], { DRY_RUN: '1' }).calls, ['ovhost plan openre']);
assert.strictEqual(run(['api'], { FAKE_EXIT: '5' }).code, 5, "ovhost's exit code is the wrapper's (5: ingest sessions)");
// Worker generations are rolled by deploy/scripts/workers.sh (ovhost never touches a transport worker): the
// wrapper hands workers|status|prune to it and never calls ovhost for them.
r = run(['workers', 'nosuch']);
assert.strictEqual(r.code, 1);
assert.deepStrictEqual(r.calls, [], 'workers is not an ovhost command');
assert.match(r.out, /\[openre-workers\] ERROR: no release nosuch/, 'workers.sh answered');
assert.match(fs.readFileSync(WRAPPER, 'utf8'), /workers\|status\|prune\) exec bash .*workers\.sh/);
const workersSource = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'scripts', 'workers.sh'), 'utf8');
assert.match(workersSource, /systemctl enable --now/, 'workers.sh starts the new generation');
assert.match(workersSource, /systemctl disable "\$unit"/, 'and disables (never stops) older ones');
assert.strictEqual(run(['nope']).code, 1);
assert.strictEqual(run(['api', '--bogus']).code, 1);

r = run(['api', sha12], { OVHOST: path.join(tmp, 'missing') });
assert.strictEqual(r.code, 1);
assert.deepStrictEqual(r.calls, []);
assert.match(r.out, /ovhost not found/);
assert.deepStrictEqual(run([], { FAKE_EXIT: '7' }).calls, ['ovhost deploy openre']);
const wrapperSource = fs.readFileSync(WRAPPER, 'utf8');
assert.match(wrapperSource, /^set -euo pipefail$/m);
assert.doesNotMatch(wrapperSource, /deploy-legacy|DEPLOY_LEGACY|OVHOST_LEGACY|capabilities/);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('deploy wrapper: all checks passed');
