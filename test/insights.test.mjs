import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insightsReport, insightsShare, periodInsights } from '../src/insights.mjs';
import { valuePeriod } from '../src/value.mjs';

const DAY = 86400_000;
const start = Date.UTC(2026, 9, 20);
const empty = () => ({ since: start - 14 * DAY, contextSince: start - 14 * DAY, scanned: 0, sessions: {}, hits: {}, blocks: {} });
const event = (extra = {}) => ({ t: start + 1, src: 'claude', win: '5h', pct: 90, reset: start + DAY, wall: start + DAY, ...extra });

test('a session crossing the week boundary attributes calls to the exact period', () => {
  const v = empty();
  v.sessions.s = { at: start - DAY, turns: 4, savedPerTurn: 100, calls: [start - 1, start, start + 1, start + DAY] };
  assert.deepEqual(valuePeriod(v, start, start + DAY), { calls: 2, tokens: 200, sessions: 1, legacy: 0 });
  v.sessions.old = { at: start - DAY, turns: 100, savedPerTurn: 100 };
  assert.equal(valuePeriod(v, start, start + DAY).tokens, 200);
  assert.equal(valuePeriod(v, start, start + DAY).legacy, 1);
});

test('operation IDs deduplicate retries; previews, applied actions and providers stay distinct', () => {
  const v = empty();
  const blocks = [
    event({ operation: 'a' }),
    event({ operation: 'a', kind: 'budget' }),
    event({ operation: 'a', shadow: true }),
    event({ src: 'codex', operation: 'a' }),
    event(),
    event(),
  ];
  const r = periodInsights({ value: v, usage: [], blocks, since: start, until: start + DAY });
  assert.deepEqual(r.actions.hold, { actual: 4, preview: 1 });
  assert.equal(r.actions.budget.actual, 0);
  assert.equal(r.attempts, 2);
  assert.equal(r.previousContext, 0);
  v.contextSince = start;
  assert.equal(periodInsights({ value: v, usage: [], blocks, since: start, until: start + DAY }).previousContext, null);
});

test('shared output contains totals only and free does not claim paid savings', () => {
  const usage = [
    {
      t: start,
      src: 'codex',
      project: '/private/acme',
      session: 'secret-id',
      model: 'private-model',
      input: 20,
      cacheWrite: 0,
      cacheRead: 100,
      output: 4,
    },
  ];
  const r = periodInsights({ value: empty(), usage, blocks: [event({ shadow: true })], since: start, until: start + DAY });
  assert.equal(r.providers[1].activeDays, 1);
  const share = insightsShare(r, false);
  assert.doesNotMatch(share, /acme|private|secret-id|context tokens not re-sent/);
  assert.match(share, /1 free-preview/);
  assert.match(insightsReport(r, true), /Codex\/Grok context savings: unavailable/);
  assert.match(insightsReport(r, false), /Pro would have acted/);
});

test('missing context baseline is unavailable rather than zero saved tokens', () => {
  const value = empty();
  delete value.contextSince;
  const r = periodInsights({ value, usage: [], blocks: [], since: start, until: start + DAY });
  assert.match(insightsReport(r, true), /Claude context reduction: unavailable/);
  assert.match(insightsShare(r, true), /Claude context estimate unavailable/);
  assert.doesNotMatch(insightsShare(r, true), /estimated 0 Claude/);
});
