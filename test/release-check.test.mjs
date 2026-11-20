import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateRelease } from '../scripts/release-check.mjs';

test('publication requires successful complete CI on the exact release SHA', () => {
  const names = ['lint', 'security', ...['ubuntu-latest', 'macos-latest'].flatMap((os) => [22, 24, 26].map((n) => `test (${os}, ${n})`))];
  const ci = { headSha: 'release-sha', status: 'completed', conclusion: 'success', jobs: names.map((name) => ({ name, conclusion: 'success' })) };
  assert.doesNotThrow(() => validateRelease(ci, 'release-sha'));
  for (const invalid of [null, { ...ci, headSha: 'older' }, { ...ci, status: 'in_progress' }, { ...ci, conclusion: 'failure' }])
    assert.throws(() => validateRelease(invalid, 'release-sha'), /exact release commit/);
  for (const jobs of [undefined, [], ci.jobs.slice(1), ci.jobs.map((job) => ({ ...job, conclusion: 'cancelled' }))])
    assert.throws(() => validateRelease({ ...ci, jobs }, 'release-sha'), /all six/);
});

test('publication CLI checks a clean tree and current push CI without publishing', () => {
  const root = mkdtempSync(join(tmpdir(), 'lc-release-gate-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const json = join(root, 'ci.json');
  const jobs = ['lint', 'security', ...['ubuntu-latest', 'macos-latest'].flatMap((os) => [22, 24, 26].map((n) => `test (${os}, ${n})`))].map(
    (name) => ({ name, conclusion: 'success' }),
  );
  writeFileSync(json, JSON.stringify({ headSha: 'current', status: 'completed', conclusion: 'success', jobs }));
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}\nconsole.log(process.argv[2] === 'status' ? (process.env.RELEASE_TEST_DIRTY ?? '') : 'current');\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}\nimport fs from 'node:fs'; console.log(process.argv[3] === 'list' ? (process.env.RELEASE_TEST_MISSING ? '[]' : '[{"databaseId":1}]') : fs.readFileSync(process.env.RELEASE_TEST_CI,'utf8'));\n`,
    { mode: 0o755 },
  );
  const script = fileURLToPath(new URL('../scripts/release-check.mjs', import.meta.url));
  const run = (extra = {}) =>
    spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_TEST_CI: json, ...extra },
    });
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /current: all eight CI jobs succeeded/);
  const dirty = run({ RELEASE_TEST_DIRTY: ' M package.json' });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /clean checkout/);
  const missing = run({ RELEASE_TEST_MISSING: '1' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No push CI run/);
  writeFileSync(json, JSON.stringify({ headSha: 'current', status: 'completed', conclusion: 'failure', jobs }));
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /successful push CI/);
});
