import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockOutcomes, limitHits, resultsReport } from '../src/results.mjs';

const M = 60_000;
const t0 = Date.UTC(2026, 9, 24, 12, 0);
const reset = t0 / 1000 + 5 * 3600;
const s = (min, pct, extra = {}) => ({ t: t0 + min * M, src: 'claude', win: '5h', pct, reset, sid: 'A', ...extra });

test('a window that reached 100% reports how far ahead the forecast warned', () => {
  // +1%/min from 40%: AT_RISK from the second reading on, hits 100% at +60 min.
  const samples = [s(0, 40), s(10, 50), s(20, 60), s(40, 80), s(60, 100)];
  const [hit] = limitHits(samples);
  assert.equal(hit.at, t0 + 60 * M);
  assert.equal(hit.warnedAt, t0 + 10 * M);
});

test('a hit with no rising readings before it gets no warning; the same window seen by two sessions counts once', () => {
  const hits = limitHits([s(0, 100), s(1, 100, { sid: 'B' })]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].warnedAt, null);
  assert.equal(hits[0].unseen, true);
  const flat = limitHits([s(0, 90), s(10, 90), s(20, 100)]); // a jump with no climb before it: watched, not warned
  assert.deepEqual([flat[0].unseen, flat[0].warnedAt], [false, null]);
  const text = resultsReport({ now: t0 + 90 * M, days: 7, samples: [s(0, 100)], blocks: [], saved: null });
  assert.match(text, /limitcast had no readings before any of them/);
  assert.match(text, /already at 100% in the first reading/);
});

test('two accounts sharing a reset time stay separate series', () => {
  // Account B sits at 13% while A climbs: mixing them would break A's slope.
  const samples = [s(0, 40), s(10, 50), s(5, 13, { sid: 'B' }), s(20, 60), s(40, 80), s(60, 100)];
  assert.equal(limitHits(samples)[0].warnedAt, t0 + 10 * M);
});

test('guard blocks are checked against what the window did afterwards', () => {
  const block = (min, sid = 'A') => ({ t: t0 + min * M, src: 'claude', win: '5h', pct: 80, wall: t0 + (min + 20) * M, reset: reset * 1000, sid });
  const samples = [s(40, 80), s(60, 100)];
  const [hit] = blockOutcomes([block(40)], samples, t0 + 90 * M);
  assert.equal(hit.outcome, 'hit');
  const [open] = blockOutcomes([block(40)], [s(40, 80), s(50, 90)], t0 + 90 * M);
  assert.deepEqual([open.outcome, open.peak], ['open', 90]);
  const [under] = blockOutcomes([block(40)], [s(40, 80), s(50, 90)], reset * 1000 + M);
  assert.equal(under.outcome, 'under');
  const [other] = blockOutcomes([block(40, 'B')], samples, t0 + 90 * M); // another account's readings don't count
  assert.equal(other.outcome, 'open');
});

test('report: free shows limits and the Pro line; Pro shows blocks', () => {
  const now = t0 + 90 * M;
  const samples = [s(0, 40), s(10, 50), s(20, 60), s(40, 80), s(60, 100)];
  const free = resultsReport({ now, days: 7, samples, blocks: null, saved: 'PRO LINE' });
  assert.match(free, /1 window reached 100%\. Of the 1 limitcast watched on the way up, it forecast 1 in advance\./);
  assert.match(free, /warned 50 min ahead/);
  assert.match(free, /Not active \(Pro\)/);
  assert.match(free, /PRO LINE/);
  const block = { t: t0 + 40 * M, src: 'claude', win: '5h', pct: 80, wall: t0 + 60 * M, reset: reset * 1000, sid: 'A' };
  const pro = resultsReport({ now, days: 7, samples, blocks: [block], saved: null });
  assert.match(pro, /1 subagent spawn blocked\. Afterwards: 1 window\(s\) reached 100% anyway/);
  assert.match(pro, /forecast out in ~20 min; reached 100% at/);
  assert.match(resultsReport({ now, days: 7, samples: [], blocks: [], saved: null }), /No limit readings/);
});
