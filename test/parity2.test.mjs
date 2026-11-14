import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callCost, costOf } from '../src/prices.mjs';
import { foldEvents } from '../src/value.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
process.env.LIMITCAST_STATE = tmp('lc-parity2-state-');

test('value record: old Grok "under" outcomes are judged again, or say unknown when the block is gone', () => {
  const now = Date.now();
  const hour = 3600_000;
  const t1 = now - 6 * hour;
  const t2 = now - 40 * hour;
  const v = {
    since: now - 10 * 86400_000,
    scanned: 0,
    sessions: {},
    hits: {},
    blocks: {
      [t1]: { t: t1, src: 'grok', win: '5h', shadow: false, outcome: 'under' },
      [t2]: { t: t2, src: 'grok', win: '5h', shadow: false, outcome: 'under' },
      99: { t: 99, src: 'codex', win: '7d', shadow: false, outcome: 'hit' },
    },
  };
  const reset = now - hour;
  const blocks = [{ t: t1, src: 'grok', win: '5h', pct: 80, wall: t1, reset }];
  const samples = [{ t: t1 + hour, src: 'grok', win: '5h', pct: 100, reset: reset / 1000 }];
  foldEvents(v, { now, samples, blocks });
  assert.equal(v.outcomesVersion, 2);
  assert.equal(v.blocks[t1].outcome, 'hit', 'judged again from the rebuilt Grok readings');
  assert.equal(v.blocks[t2].outcome, 'unknown', 'no block log entry: kept as a block, outcome not guessed');
  assert.equal(v.blocks[99].outcome, 'hit', 'other hosts are untouched');
  v.blocks[t1].outcome = 'under';
  foldEvents(v, { now, samples, blocks });
  assert.equal(v.blocks[t1].outcome, 'under', 'the migration runs once');
});

test('Codex models are priced at OpenAI list prices, with the long-context tier above 272k prompt tokens', () => {
  const call = (model, input, cacheRead, output) => ({ model, input, cacheWrite: 0, cacheRead, output });
  // 100k new + 100k cached + 10k output at $2 / $0.10 / $10 per million.
  assert.ok(Math.abs(callCost(call('gpt-6.1-sol', 100_000, 100_000, 10_000)) - 0.31) < 1e-9);
  // 300k prompt tokens: the whole request bills $4 in, $15 out.
  assert.ok(Math.abs(callCost(call('gpt-6.1-sol', 300_000, 0, 10_000)) - 1.35) < 1e-9);
  assert.ok(Math.abs(callCost(call('gpt-5.6-sol', 100_000, 100_000, 10_000)) - (0.4 + 0.04 + 0.2)) < 1e-9);
  assert.equal(callCost(call('codex-auto-review', 1000, 0, 10)), null, 'a routing alias with no list price stays unpriced');
  const c = costOf([call('gpt-6.1-sol', 100_000, 0, 0), call('codex-auto-review', 5, 5, 5)]);
  assert.equal(c.unpriced, 15);
  assert.equal(c.priced, 100_000);
});
