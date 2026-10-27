import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attribute, jobsReport, readCalls, whyReport } from '../src/where.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const T0 = Date.parse('2026-10-24T12:00:00.000Z');
const call = (o) => ({
  t: T0,
  input: 1,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  tools: [],
  side: false,
  entry: 'cli',
  project: '/p',
  model: 'sonnet',
  ...o,
});

test('attribute splits subagent tokens by type and model, one run per transcript, and every token has a model', () => {
  const explore = [
    call({ side: true, cacheWrite: 1000, model: 'haiku', agentType: 'Explore' }),
    call({ side: true, t: T0 + 1, cacheWrite: 500, model: 'haiku' }),
    call({ side: true, t: T0 + 2, cacheWrite: 200, model: 'sonnet' }), // swapped mid-run: its own row
  ];
  const plan = [call({ side: true, cacheWrite: 2000, model: 'opus', agentType: 'Plan' })];
  const noType = [call({ side: true, cacheWrite: 100, model: 'opus' })];
  const main = [call({ cacheWrite: 50, model: 'opus' }), call({ t: T0 + 1, cacheWrite: 30, model: 'sonnet' })];
  const r = attribute([explore, plan, noType, main]);
  const rows = Object.fromEntries([...r.subagentsBy.values()].map((e) => [`${e.type}/${e.model}`, [e.tokens, e.runs]]));
  assert.deepEqual(rows, { 'Explore/haiku': [1502, 1], 'Explore/sonnet': [201, 1], 'Plan/opus': [2001, 1], '(unknown)/opus': [101, 1] });
  assert.equal(r.subagents, 1502 + 201 + 2001 + 101);
  assert.equal(
    [...r.byModel.values()].reduce((a, n) => a + n, 0),
    r.total,
  ); // every new token has a model
  assert.equal(r.byModel.get('opus'), 2001 + 101 + 51);
});

test('a call with no model is counted as (unknown)', () => {
  const r = attribute([[call({ cacheWrite: 10, model: undefined })]]);
  assert.equal(r.byModel.get('(unknown)'), 11);
});

test("readCalls keeps the model and reads a subagent transcript's type from the file next to it", async () => {
  const dir = join(tmp('lc-sub-'), 'subagents');
  mkdirSync(dir);
  const line = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(T0).toISOString(),
    requestId: 'r',
    isSidechain: true,
    message: { id: 'm', model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  });
  writeFileSync(join(dir, 'agent-a1.jsonl'), line);
  writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', isBuiltIn: true }));
  writeFileSync(join(dir, 'agent-a2.jsonl'), line); // no meta file
  const [a1] = await readCalls(join(dir, 'agent-a1.jsonl'));
  assert.deepEqual([a1.model, a1.agentType, a1.side], ['claude-haiku-5-5', 'Explore', true]);
  assert.equal((await readCalls(join(dir, 'agent-a2.jsonl')))[0].agentType, undefined);
});

test('whyReport shows subagents by type and model and new tokens by model', () => {
  const r = attribute([
    [call({ side: true, cacheWrite: 4000, model: 'opus', agentType: 'general-purpose' })],
    [call({ cacheWrite: 1000, model: 'sonnet' })],
  ]);
  const md = whyReport(r, { since: 0, now: T0 + 1, calib: null });
  assert.match(md, /## Subagents by type and model/);
  assert.match(md, /\| general-purpose \| opus \| 1 \| 4\.0k \| 100% \| 4\.0k \|/);
  assert.match(md, /## New tokens by model/);
  assert.match(md, /\| opus \| 4\.0k \| 80% \|/);
  assert.match(md, /not window shares/);
  assert.doesNotMatch(
    whyReport(attribute([[call({ cacheWrite: 10 })]]), { since: 0, now: T0 + 1, calib: null }),
    /## (Subagents by type|New tokens by model)/,
  );
});

const MIN = 60_000;
const start = (t, tokens, size) => ({ t, tokens, size, calls: 2, prompt: 'job', project: '/p', entry: 'sdk-cli' });
const jobs = (starts) => {
  const r = attribute([]);
  r.total = 1_000_000;
  r.startHeadless = starts.reduce((a, s) => a + s.tokens, 0);
  r.starts = starts;
  return jobsReport(r, { since: T0 - 86400_000, now: T0 + 86400_000 });
};

test('jobsReport: cold starts, their extra cost over warm runs of the same job, and the gap table', () => {
  // Same job, 5 runs: the first has no earlier run, the rest follow gaps of 2, 3, 30 and 120 minutes.
  const md = jobs([
    start(T0, 30_000, 40_000), // cold: 30k of 40k new
    start(T0 + 2 * MIN, 2_000, 40_000), // warm, within 5 min
    start(T0 + 5 * MIN, 2_000, 40_000), // warm, within 5 min
    start(T0 + 35 * MIN, 30_000, 40_000), // cold, 5 to 60 min
    start(T0 + 155 * MIN, 30_000, 40_000), // cold, over 60 min
  ]);
  assert.match(md, /\| job \| 5 \| 18\.8k \| 40\.0k \| 94\.0k \| 9% \| 60% \| 2\.0 \|/);
  assert.match(
    md,
    /3 of 5 runs \(60%\) started cold: more than half of their starting prompt was new tokens, not served from the prompt cache\. On average 53% of a starting prompt came from the cache\./,
  );
  assert.match(md, /the cold ones cost about 84\.0k more new tokens\./); // 3 cold runs x (30k - 2k)
  assert.match(md, /\| within 5 min \| 2 \| 0% \|/);
  assert.match(md, /\| 5 to 60 min \| 1 \| 100% \|/);
  assert.match(md, /\| over 60 min \| 1 \| 100% \|/);
  assert.doesNotMatch(md, /unlikely to help|in batches/); // fewer than 5 runs close behind another: no advice yet
});

test('jobsReport: advice follows the data, and a job with no warm run claims no extra cost', () => {
  // 7 runs a minute apart, all cold: closer scheduling cannot help.
  const allCold = jobs(Array.from({ length: 7 }, (_, i) => start(T0 + i * MIN, 30_000, 40_000)));
  assert.match(allCold, /\| within 5 min \| 6 \| 100% \|/);
  assert.match(allCold, /closer together is unlikely to help/);
  assert.doesNotMatch(allCold, /more new tokens\./);
  // 7 runs a minute apart, all warm after the first: batching works.
  const batched = jobs(Array.from({ length: 7 }, (_, i) => start(T0 + i * MIN, i ? 1_000 : 30_000, 40_000)));
  assert.match(batched, /\| within 5 min \| 6 \| 0% \|/);
  assert.match(batched, /in batches/);
});
