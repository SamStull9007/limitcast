import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callCost, costOf, fmtUsd, PRICES, priceFor, priceTable } from '../src/prices.mjs';
import { burnReport } from '../src/report.mjs';
import { claudeUsage } from '../src/usage.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
process.env.LIMITCAST_STATE = tmp('lc-prices-state-'); // prices.json overrides live here, never in the real state dir
const M = 1e6;
const call = (o) => ({ model: 'claude-sonnet-5-5', input: 0, cacheWrite: 0, cacheRead: 0, output: 0, ...o });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);

test('callCost prices input, 5-minute and 1-hour cache writes, cache reads and output', () => {
  // Sonnet 5.5: input $2, output $10, cache read 0.05x input, 5-minute write 1.25x, 1-hour write 2x.
  close(callCost(call({ input: M })), 2);
  close(callCost(call({ output: M })), 10);
  close(callCost(call({ cacheRead: M })), 0.1);
  close(callCost(call({ cacheWrite: M })), 2.5);
  close(callCost(call({ cacheWrite: M, cacheWrite1h: M })), 4);
  close(callCost(call({ cacheWrite: M, cacheWrite1h: M / 2 })), 3.25); // half and half
  close(callCost(call({ input: M, cacheWrite: M, cacheRead: M, output: M })), 14.6);
  close(callCost({ ...call({ cacheRead: M }), model: 'claude-opus-5-5' }), 0.2); // Opus 5.5 read: $0.20
  close(callCost({ ...call({ cacheRead: M }), model: 'claude-fable-5-1' }), 0.25); // Fable 5.1 read: $0.25
});

test('Haiku is priced higher for a call whose whole prompt is over 100k tokens', () => {
  const h = (o) => ({ ...call(o), model: 'claude-haiku-5-5' });
  close(callCost(h({ input: 50_000, output: 10_000 })), 0.01); // 50k x $0.10 + 10k x $0.50
  close(callCost(h({ input: 200_000, output: 10_000 })), 0.125); // 200k x $0.50 + 10k x $2.50
  close(callCost(h({ input: 10_000, cacheRead: 100_000 })), 0.01); // a 110k prompt: 10k x $0.50 + 100k x $0.05
});

test('every listed price keeps the 5x output-to-input ratio (a typo in the table would break it)', () => {
  for (const [id, p] of Object.entries(PRICES)) {
    if (id.startsWith('grok-')) continue;
    close(p.output / p.input, 5);
    if (p.over) close(p.over.output / p.over.input, 5);
    assert.ok(p.readX > 0 && p.readX <= 0.1, id);
  }
});

test('Grok list prices: cache writes at input, long-context at 200k, grok-4.6-build matches grok-4.6', () => {
  const k = 100_000; // under the 200k long-context threshold
  const g = (o) => ({ model: 'grok-4.6', input: 0, cacheWrite: 0, cacheRead: 0, output: 0, ...o });
  close(callCost(g({ input: k })), 0.2);
  close(callCost(g({ output: k })), 0.6);
  close(callCost(g({ cacheRead: k })), 0.05);
  close(callCost(g({ cacheWrite: k })), 0.2); // writeX 1, not Claude's 1.25x
  close(callCost(g({ input: 250_000, output: 10_000 })), 1.12); // 250k x $4 + 10k x $12
  close(callCost(g({ input: M })), 4); // 1M is long-context
  close(callCost({ ...g({ input: k }), model: 'grok-4.6-build' }), 0.2);
  close(callCost({ ...g({ input: k }), model: 'grok-4.20-0309-reasoning' }), 0.125);
  assert.equal(callCost({ ...g({ input: k }), model: 'grok-unknown' }), null);
});

test('an unknown model has no price; a dated id uses the longest matching key', () => {
  assert.equal(callCost(call({ model: 'gpt-5', input: M })), null);
  assert.equal(callCost(call({ model: undefined, input: M })), null);
  assert.equal(priceFor('claude-opus-5-5-20261001', PRICES), PRICES['claude-opus-5-5']);
  assert.equal(priceFor('claude-opus-5-50', PRICES), null); // not a dated suffix of the same model
});

test('prices.json adds or overrides a model; a bad file or entry changes nothing', () => {
  const dir = process.env.LIMITCAST_STATE;
  assert.equal(priceTable(), PRICES);
  writeFileSync(
    join(dir, 'prices.json'),
    JSON.stringify({
      models: { 'claude-opus-4-1': { input: 15, output: 75 }, 'claude-sonnet-5-5': { input: 3, output: 15 }, bad: { input: 0 }, worse: 7 },
    }),
  );
  const t = priceTable();
  assert.deepEqual(t['claude-opus-4-1'], { readX: 0.1, input: 15, output: 75 });
  assert.equal(t['claude-sonnet-5-5'].input, 3);
  assert.equal('bad' in t, false);
  assert.equal('worse' in t, false);
  close(callCost(call({ model: 'claude-opus-4-1', cacheRead: M })), 1.5);
  writeFileSync(join(dir, 'prices.json'), 'not json');
  assert.equal(priceTable(), PRICES);
  writeFileSync(join(dir, 'prices.json'), '{}');
  assert.equal(priceTable(), PRICES);
});

test('costOf totals priced calls, counts the rest as unpriced, and splits by model', () => {
  const c = costOf([call({ input: M }), call({ model: 'claude-opus-5-5', output: M }), call({ model: 'gpt-5', input: 5 * M })]);
  close(c.total, 2 + 20);
  assert.equal(c.priced, 2 * M);
  assert.equal(c.unpriced, 5 * M);
  assert.deepEqual(
    [...c.byModel],
    [
      ['claude-sonnet-5-5', 2],
      ['claude-opus-5-5', 20],
    ],
  );
});

test('fmtUsd', () => {
  assert.deepEqual([0.4, 12.345, 99.99, 100.4, 1234.5, 2660000].map(fmtUsd), ['$0.40', '$12.35', '$99.99', '$100', '$1,235', '$2,660,000']);
});

test('claudeUsage keeps the 1-hour part of the cache write', () => {
  const line = (cc) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      requestId: 'r',
      message: {
        id: 'm',
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 1, cache_creation_input_tokens: 100, output_tokens: 1, ...(cc ? { cache_creation: cc } : {}) },
      },
    });
  assert.equal(claudeUsage(line({ ephemeral_1h_input_tokens: 60, ephemeral_5m_input_tokens: 40 }), new Set(), 's').cacheWrite1h, 60);
  assert.equal(claudeUsage(line(null), new Set(), 's').cacheWrite1h, 0); // an older log: no split, priced as 5-minute writes
});

test('the burn report shows API-equivalent dollars for Claude, a dash for tools it cannot price', () => {
  const u = (src, model, input) => ({
    t: 1,
    src,
    session: 's',
    project: '/p',
    model,
    sidechain: false,
    input,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
  });
  const md = burnReport([u('claude', 'claude-sonnet-5-5', M), u('codex', 'gpt-5', 4 * M), u('grok', 'grok-4.6-build', M)], { since: 0, now: 1 });
  assert.match(md, /\| tool \| tokens \| output \| cache reads \| share \| API-equivalent \|/);
  assert.match(md, /\| claude \| 1\.0M \| 0 \| 0 \| 17% \| \$2\.00 \|/);
  assert.match(md, /\| grok \| 1\.0M \| 0 \| 0 \| 17% \| \$4\.00 \|/); // 1M prompt is Grok long-context
  assert.match(md, /\| codex \| 4\.0M \| 0 \| 0 \| 67% \| - \|/);
  assert.match(
    md,
    /\*\*API-equivalent cost: \$6\.00\*\* at list prices for Claude and Grok models, not what a subscription charges\. 4\.0M tokens on other models are not counted\./,
  );
  assert.match(md, /## By model[\s\S]*\| claude-sonnet-5-5 \| 1\.0M \| 17% \| \$2\.00 \|/);
  assert.match(md, /\| grok-4\.6-build \| 1\.0M \| 17% \| \$4\.00 \|/);
  assert.match(md, /\| gpt-5 \| 4\.0M \| 67% \| - \|/);
  assert.doesNotMatch(burnReport([u('codex', 'gpt-5', M)], { since: 0, now: 1 }), /API-equivalent cost/);
});
