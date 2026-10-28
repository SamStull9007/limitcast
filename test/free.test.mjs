import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));

test('all features remain available with stale billing files, no network and no activation', () => {
  const root = mkdtempSync(join(tmpdir(), 'lc-mit-'));
  const state = join(root, 'state');
  mkdirSync(state);
  const legacy = { 'license.key': 'LC1.expired.invalid', 'polar-license.json': '{"key":"expired","checkedAt":1}', 'trial.json': '{"start":1}' };
  for (const [name, content] of Object.entries(legacy)) writeFileSync(join(state, name), content);
  const net = join(root, 'network-called');
  const preload = join(root, 'no-network.mjs');
  writeFileSync(
    preload,
    `import {writeFileSync} from 'node:fs'; globalThis.fetch = () => { writeFileSync(${JSON.stringify(net)}, 'called'); throw new Error('No network'); };`,
  );
  const env = {
    ...process.env,
    HOME: root,
    LIMITCAST_STATE: state,
    XDG_CONFIG_HOME: join(root, 'config'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    GROK_HOME: join(root, 'grok'),
    LIMITCAST_LICENSE: 'LC1.bad.key',
  };
  const run = (...args) => execFileSync(process.execPath, ['--import', preload, bin, ...args], { env }).toString();
  for (const command of ['license', 'trial', 'activate', 'deactivate']) assert.match(run(command), /All features are available/);
  for (const args of [
    ['plan'],
    ['report'],
    ['report', '--why'],
    ['report', '--jobs'],
    ['saved'],
    ['budget', 'subagents'],
    ['budget', 'today'],
    ['subagent-model'],
    ['notify', 'off'],
    ['results'],
    ['results', '--html', '--no-open', '--out', join(root, 'report.html')],
  ]) {
    assert.doesNotMatch(run(...args), /part of limitcast Pro|Try Pro|activate <license/);
  }
  assert.ok(existsSync(join(root, 'report.html')));
  assert.equal(existsSync(net), false);
  assert.equal(existsSync(join(root, 'config', 'limitcast', 'trial-used')), false);
  for (const [name, content] of Object.entries(legacy)) assert.equal(readFileSync(join(state, name), 'utf8'), content);
});
