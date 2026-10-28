import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { memoryCheck, memoryDir, memoryReport, scanMemory } from '../src/memory.mjs';

const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;

/** A memory folder: index links a.md and, by [[wiki]] link, b-note.md; a.md links c.md; d.md is linked by nothing. */
function fixture(index = '# Memory\n- [A](a.md) topic a\n- [[b-note]]\n- [Gone](gone.md)\n') {
  const dir = tmp('lc-mem-');
  writeFileSync(join(dir, 'MEMORY.md'), index);
  writeFileSync(join(dir, 'a.md'), 'see [C](c.md)\n');
  writeFileSync(join(dir, 'b_note.md'), 'b\n');
  writeFileSync(join(dir, 'c.md'), 'c\n');
  writeFileSync(join(dir, 'd.md'), 'nobody links here\n');
  writeFileSync(join(dir, 'big.md'), `${'line\n'.repeat(200)}`);
  return dir;
}

test('scanMemory follows links from the index and finds broken, unlinked and big files', () => {
  const s = scanMemory(fixture());
  assert.equal(s.files, 5);
  assert.deepEqual(s.broken, [{ from: 'MEMORY.md', target: 'gone.md' }]);
  assert.deepEqual(s.orphans.sort(), ['big.md', 'd.md']);
  assert.deepEqual(
    s.big.map((b) => b.name),
    ['big.md'],
  );
  assert.equal(scanMemory(tmp('lc-empty-')), null);
});

test('memoryCheck fails only when the index is past what Claude Code loads', () => {
  assert.equal(memoryCheck(null), null);
  const fine = memoryCheck(scanMemory(fixture()));
  assert.equal(fine.ok, true);
  assert.match(
    fine.line,
    /2 not linked from the local index \(may be externally indexed\), 1 broken link, 1 file over 150 lines\. Run \/limitcast:memory-audit, then \/limitcast:memory-split/,
  );
  const over = memoryCheck(scanMemory(fixture(`${'- [A](a.md)\n'.repeat(201)}`)));
  assert.equal(over.ok, false);
  assert.match(over.line, /index 201\/200 lines/);
  const bytes = memoryCheck(scanMemory(fixture(`- ${'x'.repeat(26_000)}\n`)));
  assert.equal(bytes.ok, false);
  assert.match(memoryReport(scanMemory(fixture())), /Broken links \(1\): MEMORY\.md -> gone\.md/);
});

test('scanMemory follows plain filename citations and excludes agent policy files', () => {
  const dir = fixture('# Memory\nSee `a.md` and b_note.md.\n');
  writeFileSync(join(dir, 'a.md'), 'Next: c.md. External: https://example.com/d.md\n');
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'CODEX.md']) writeFileSync(join(dir, name), 'Agent policy\n'.repeat(200));
  const s = scanMemory(dir);
  assert.equal(s.files, 5);
  assert.deepEqual(s.orphans.sort(), ['big.md', 'd.md']);
  assert.deepEqual(s.broken, []);
  assert.deepEqual(
    s.big.map((f) => f.name),
    ['big.md'],
  );
  assert.match(memoryReport(s), /check external catalogs before treating these as orphans/);
});

test('CLI: memory prints the sweep, and doctor shows the memory line for this project', () => {
  const home = tmp('lc-home-');
  const cwd = tmp('lc-proj-');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: tmp('lc-xdg-'), LIMITCAST_STATE: tmp('lc-state-'), CLAUDE_CONFIG_DIR: tmp('lc-cc-') };
  delete env.LIMITCAST_LICENSE;
  const run = (...a) => spawnSync('node', [bin, ...a], { env, cwd, encoding: 'utf8' });
  assert.match(run('memory').stdout, /No auto-memory index/);
  assert.doesNotMatch(run('doctor').stdout, /Memory/);

  const dir = memoryDir({ home, cwd });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), `${'- note\n'.repeat(201)}`);
  assert.match(run('memory').stdout, /Index: MEMORY\.md 201 \/ 200 lines.*OVER/);
  const doctor = run('doctor');
  assert.match(doctor.stdout, /✗ Memory index 201\/200 lines/);
  assert.equal(doctor.status, 1);
});
