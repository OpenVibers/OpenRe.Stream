'use strict';
/**
 * deploy/scripts/deploy.sh is a thin wrapper around `ovhost deploy openre` (OpenVibe.Host, strategy
 * release-layout; roadmap WS-N task 11) with deploy-legacy.sh (the previous script, unchanged) as its
 * fallback. A fake ovhost records what the wrapper asks for; a fake legacy script records the fallback.
 *   - deploy → ovhost deploy openre; release [<ref>] → --prepare-only, and the sha12 alone on stdout;
 *     api [<sha>] → deploy --to <sha>; rollback → ovhost rollback; plan / DRY_RUN=1 → ovhost plan;
 *   - workers, status and prune always run the legacy script (ovhost never touches a worker unit);
 *   - the fallback: deploy is release then api, rollback <sha> is api <sha>.
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
if [ "$1" = capabilities ]; then
  [ -n "$FAKE_OLD" ] && exit 1
  printf '%b\\n' "\${FAKE_CAPS:-ovhost=0.3.0\\ndeploy-api=1\\nservice=openre\\nstrategy=release-layout\\nmanaged=yes\\nlayout=release}"
  exit 0
fi
echo "ovhost $*" >> "${log}"
echo "[ovhost] progress output"
exit "\${FAKE_EXIT:-0}"
`, { mode: 0o755 });
const legacy = path.join(tmp, 'legacy.sh');
fs.writeFileSync(legacy, `#!/usr/bin/env bash\necho "legacy $*" >> "${log}"\n[ "$1" = release ] && echo "${sha12}"\nexit 0\n`, { mode: 0o755 });

function run(args = [], env = {}) {
    fs.rmSync(log, { force: true });
    const r = spawnSync('bash', [WRAPPER, ...args], { env: { PATH: process.env.PATH, HOME: tmp, OVHOST: ovhost, OVHOST_SUDO: '', DEPLOY_LEGACY: legacy, OPENRE_ROOT: root, ...env }, encoding: 'utf8' });
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
for (const sub of ['workers', 'status', 'prune']) assert.deepStrictEqual(run([sub]).calls, [`legacy ${sub}`], `${sub}: always the legacy script`);
assert.deepStrictEqual(run(['workers', sha12]).calls, [`legacy workers ${sha12}`]);
assert.strictEqual(run(['nope']).code, 1);
assert.strictEqual(run(['api', '--bogus']).code, 1);

// Fallback.
r = run([], { FAKE_OLD: '1' });
assert.deepStrictEqual(r.calls, ['legacy release', 'legacy api'], 'deploy is release then api');
assert.match(r.out, /too old/);
assert.deepStrictEqual(run(['release', 'origin/main'], { OVHOST_LEGACY: '1' }).calls, ['legacy release origin/main']);
assert.deepStrictEqual(run(['api', sha12], { OVHOST: path.join(tmp, 'missing') }).calls, [`legacy api ${sha12}`]);
assert.deepStrictEqual(run(['rollback', sha12], { FAKE_CAPS: 'deploy-api=1\\nstrategy=none\\nmanaged=no' }).calls, [`legacy api ${sha12}`]);
assert.strictEqual(run(['rollback'], { OVHOST_LEGACY: '1' }).code, 1, 'the legacy script needs the release to go back to');
assert.match(fs.readFileSync(WRAPPER, 'utf8'), /^set -euo pipefail$/m);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('deploy wrapper: all checks passed');
