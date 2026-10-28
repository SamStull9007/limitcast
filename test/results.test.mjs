import './helpers/environment.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blockOutcomes, limitHits, resultsReport, resultsShare, resultsStats, weeklyDue, weeklyLine } from '../src/results.mjs';

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
  const text = resultsReport({ now: t0 + 90 * M, days: 7, samples: [s(0, 100)], blocks: [], pro: false, saved: null });
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

const now = t0 + 90 * M;
const climb = [s(0, 40), s(10, 50), s(20, 60), s(40, 80), s(60, 100)];
const block = { t: t0 + 40 * M, src: 'claude', win: '5h', pct: 80, wall: t0 + 60 * M, reset: reset * 1000, sid: 'A' };

test('report: free shows limits and the guard preview; Pro shows real blocks only', () => {
  const free = resultsReport({ now, days: 7, samples: climb, blocks: [{ ...block, shadow: true }], pro: false, saved: 'PRO LINE' });
  assert.match(free, /1 window reached 100%\. Of the 1 limitcast watched on the way up, it forecast 1 in advance\./);
  assert.match(free, /warned 50 min ahead/);
  assert.match(free, /## Subagent guard \(preview\)/);
  assert.match(free, /Pro would have blocked 1 subagent spawn \(your free install let them run\)\. Afterwards: 1 window\(s\) reached 100%/);
  assert.match(free, /PRO LINE/);
  assert.match(free, /Pro blocks those subagents/);
  const pro = resultsReport({ now, days: 7, samples: climb, blocks: [block, { ...block, shadow: true }], pro: true, saved: null });
  assert.match(pro, /1 subagent spawn blocked\. Afterwards: 1 window\(s\) reached 100%/);
  assert.match(pro, /forecast out in ~20 min; reached 100% at/);
  assert.doesNotMatch(pro, /Pro blocks those/);
  assert.match(resultsReport({ now, days: 7, samples: [], blocks: [], pro: false, saved: null }), /No limit readings/);
});

test('--share and the weekly line are totals only, with no session or project names', () => {
  const st = resultsStats({ now, days: 7, samples: climb, blocks: [block], pro: true });
  const share = resultsShare(st, { days: 7, pro: true, savedPerSession: 4000 });
  assert.equal(
    share,
    'limitcast, last 7 days: 1 usage limit reached; forecast 1 of the 1 it watched in advance (avg 50 min ahead); blocked 1 runaway subagent; starting context 4.0k tokens smaller per session. https://limitcast.dev',
  );
  assert.doesNotMatch(share, /\bA\b/); // no session id
  const free = resultsShare(resultsStats({ now, days: 7, samples: climb, blocks: [{ ...block, shadow: true }], pro: false }), {
    days: 7,
    pro: false,
    savedPerSession: null,
  });
  assert.match(free, /would have blocked 1 runaway subagent\. https/);
  assert.equal(
    weeklyLine(st, 4000),
    'limitcast this week: 1 limit reached, forecast risk on 1 (avg 50 min), guard blocked 1 subagent, starting context 4.0k tokens smaller. Details: limitcast results',
  );
});

test('the weekly summary is due once a week, starting a week after the first check', () => {
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = mkdtempSync(join(tmpdir(), 'lc-weekly-'));
  try {
    const D = 86400_000;
    assert.equal(weeklyDue(t0), false); // starts the clock
    assert.equal(weeklyDue(t0 + 6 * D), false);
    assert.equal(weeklyDue(t0 + 7 * D), true);
    assert.equal(weeklyDue(t0 + 8 * D), false);
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});
