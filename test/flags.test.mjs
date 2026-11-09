import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KNOWN_FLAGS, unknownFlag } from '../src/flags.mjs';
import { writeAtomic } from '../src/store.mjs';

const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));

const run = (args) => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-flags-'));
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, LIMITCAST_STATE: dir, CLAUDE_CONFIG_DIR: dir },
  });
};

test('a mistyped option fails instead of running the plain command', () => {
  for (const args of [
    ['install', '--gaurd'],
    ['trim', '--aply'],
    ['status', '--jsno'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, /Unknown option --\w+/);
  }
});

test('known options and the -- separator still pass', () => {
  assert.equal(unknownFlag(['--days', '3', '--share']), undefined);
  assert.equal(unknownFlag(['--window', '5h', '--', 'node', '--eval', '1']), undefined);
  assert.equal(unknownFlag(['--bogus']), '--bogus');
  assert.equal(run(['status', '--json']).status, 0);
});

test('every option the CLI reads is in KNOWN_FLAGS', () => {
  const src = readFileSync(bin, 'utf8');
  const read = [...src.matchAll(/(?:args\.includes|flag)\('(--[a-z-]+)'\)/g)].map((m) => m[1]);
  assert.ok(read.length > 10);
  assert.deepEqual(
    read.filter((f) => !KNOWN_FLAGS.includes(f)),
    [],
  );
});

test('writeAtomic replaces the file and leaves no temp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-atomic-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, '{"old":true}');
  chmodSync(file, 0o600);
  writeAtomic(file, '{"new":true}');
  assert.equal(readFileSync(file, 'utf8'), '{"new":true}');
  assert.deepEqual(readdirSync(dir), ['config.json']);
  assert.ok(statSync(file).isFile());
  assert.equal(statSync(file).mode & 0o777, 0o600, 'atomic replacement must preserve private configuration permissions');
});
