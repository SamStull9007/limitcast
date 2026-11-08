import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readUsage } from '../src/usage.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('usage cache: an unchanged scan leaves the cache file alone; a changed transcript rewrites it', async () => {
  const prev = process.env.LIMITCAST_STATE;
  const state = tmp('lc-dirty-st-');
  process.env.LIMITCAST_STATE = state;
  try {
    const root = tmp('lc-dirty-');
    mkdirSync(join(root, 'p'));
    const file = join(root, 'p', 's.jsonl');
    const line = (id) =>
      JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: 'm', usage: { input_tokens: 1 } } });
    writeFileSync(file, `${line('a')}\n`);
    const roots = { claude: root, codex: join(root, 'none'), grok: join(root, 'none') };
    const cacheFile = join(state, 'usage-cache.json');
    await readUsage(0, roots);
    utimesSync(cacheFile, 1_000_000_000, 1_000_000_000); // a marker: a rewrite would move it to now
    await readUsage(0, roots);
    assert.equal(statSync(cacheFile).mtimeMs, 1_000_000_000_000);
    writeFileSync(file, `${line('a')}\n${line('b')}\n`);
    await readUsage(0, roots);
    assert.ok(statSync(cacheFile).mtimeMs > 1_000_000_000_000);
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});
