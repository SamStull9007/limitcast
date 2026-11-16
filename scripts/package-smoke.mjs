import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'limitcast-package-'));
try {
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf8' }));
  const pack = Array.isArray(result) ? result[0] : Object.values(result)[0];
  assert.ok(pack.filename.endsWith('.tgz'));
  execFileSync('tar', ['-xzf', join(dir, pack.filename), '-C', dir]);
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = { ...process.env, HOME: home };
  for (const name of [
    'LIMITCAST_STATE',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'GROK_HOME',
    'COPILOT_HOME',
    'PI_CODING_AGENT_DIR',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
  ])
    env[name] = join(home, name);
  delete env.LIMITCAST_ALLOW;
  const bin = join(dir, 'package/bin/limitcast.mjs');
  const run = (...args) => execFileSync(process.execPath, [bin, ...args], { cwd: home, env, encoding: 'utf8', timeout: 20000 });
  const pkg = JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8'));
  assert.ok(run('--version').includes(pkg.version));
  assert.deepEqual(JSON.parse(run('status', '--json')), []);
  assert.match(run('onboard'), /limitcast/i);
  assert.match(run('trim', '--codex', '--share'), /unavailable/i);
  console.log(`Packed ${pkg.name}@${pkg.version}: isolated version, status, onboarding and trim checks passed (${pack.integrity})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
