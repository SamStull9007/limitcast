import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'lc-capacity-cli-'));
  const env = {
    ...process.env,
    LIMITCAST_STATE: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    GROK_HOME: join(root, 'grok'),
  };
  return { root, env, run: (...args) => execFileSync(process.execPath, [bin, ...args], { env }).toString() };
};

test('onboard on a clean machine is read-only and offers a useful first step', () => {
  const { root, run, env } = setup();
  const text = run('onboard');
  assert.match(text, /limitcast install/);
  assert.match(text, /Free — protection records previews/);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(existsSync(join(env.XDG_CONFIG_HOME, 'limitcast', 'trial-used')), false);
});

test('results integrates usage, previews and legacy state without free savings claims or private sharing', () => {
  const { env, run } = setup();
  mkdirSync(env.LIMITCAST_STATE, { recursive: true });
  writeFileSync(
    join(env.LIMITCAST_STATE, 'value.json'),
    JSON.stringify({
      since: Date.now() - 20 * 86400_000,
      scanned: 0,
      sessions: { private: { at: Date.now() - 86400_000, turns: 10, savedPerTurn: 100 } },
      hits: {},
      blocks: {},
    }),
  );
  writeFileSync(
    join(env.LIMITCAST_STATE, 'guard.jsonl'),
    `${JSON.stringify({ t: Date.now() - 1000, src: 'claude', win: '5h', pct: 90, wall: Date.now(), reset: Date.now() + 100000, shadow: true, sid: 'private-secret' })}\n`,
  );
  const text = run('results');
  assert.match(text, /Your capacity report/);
  assert.match(text, /Pro would have acted/);
  assert.doesNotMatch(text, /Estimated 1\.0k|context reduction: \*\*estimated/);
  const share = run('results', '--share');
  assert.match(share, /Voluntary capacity check-in/);
  assert.doesNotMatch(share, /private-secret|context tokens not re-sent/);
  run('trial');
  const pro = run('results');
  assert.match(pro, /legacy session record/);
  assert.match(pro, /Codex\/Grok context savings: unavailable/);
});

test('results rejects invalid periods instead of constructing invalid report dates', () => {
  const { env } = setup();
  for (const days of ['Infinity', 'NaN', '0', '1e300']) {
    const r = spawnSync(process.execPath, [bin, 'results', '--days', days], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--days must be a finite positive number/);
    assert.doesNotMatch(r.stderr, /RangeError/);
  }
});
