import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { whySessions } from '../src/where.mjs';

test('report --why announces a big first read once, and leaves its cache alone when nothing changed', async () => {
  const prev = process.env.LIMITCAST_STATE;
  const state = mkdtempSync(join(tmpdir(), 'lc-why-st-'));
  process.env.LIMITCAST_STATE = state;
  const notices = [];
  const original = console.error;
  console.error = (m) => notices.push(String(m));
  try {
    const root = mkdtempSync(join(tmpdir(), 'lc-why-'));
    mkdirSync(join(root, 'p'));
    for (let i = 0; i < 101; i++) writeFileSync(join(root, 'p', `s${i}.jsonl`), '');
    await whySessions(root, 0);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /reading 101 transcripts for the first time/);
    const cacheFile = join(state, 'where-cache.json');
    utimesSync(cacheFile, 1_000_000_000, 1_000_000_000); // a marker: a rewrite would move it to now
    await whySessions(root, 0);
    assert.equal(notices.length, 1);
    assert.equal(statSync(cacheFile).mtimeMs, 1_000_000_000_000);
  } finally {
    console.error = original;
    process.env.LIMITCAST_STATE = prev;
  }
});
