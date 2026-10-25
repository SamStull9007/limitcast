import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readUsage } from '../src/usage.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('usage cache: unchanged transcripts are not re-read; changed ones are', async () => {
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = tmp('lc-cache-st-');
  try {
    const root = tmp('lc-cache-');
    mkdirSync(join(root, 'p'));
    const file = join(root, 'p', 's.jsonl');
    const line = (id, input) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { id, model: 'm', usage: { input_tokens: input }, content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'dataviz' } }] },
      });
    writeFileSync(file, `${line('a', 10)}\n`);
    const roots = { claude: root, codex: join(root, 'none'), grok: join(root, 'none') };
    const act = () => ({ skills: new Set(), mcp: new Set() });
    // A whole-second mtime, so it can be restored exactly after the rewrite below.
    const T = Math.floor(Date.now() / 1000);
    utimesSync(file, T, T);
    const a1 = act();
    assert.deepEqual(
      (await readUsage(0, roots, a1)).map((u) => u.input),
      [10],
    );
    // Same size and mtime: served from the cache even though the bytes changed underneath.
    writeFileSync(file, `${line('b', 20)}\n`);
    utimesSync(file, T, T);
    const a2 = act();
    assert.deepEqual(
      (await readUsage(0, roots, a2)).map((u) => u.input),
      [10],
    );
    assert.deepEqual([...a2.skills], [...a1.skills]); // activity comes from the cache too
    // A real change (new line): read again.
    writeFileSync(file, `${line('b', 20)}\n${line('c', 30)}\n`);
    assert.deepEqual(
      (await readUsage(0, roots)).map((u) => u.input),
      [20, 30],
    );
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});
