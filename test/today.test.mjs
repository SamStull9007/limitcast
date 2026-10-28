import './helpers/environment.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGuard } from '../src/guard.mjs';
import { transitions } from '../src/notify.mjs';
import { loadBlocks, resultsStats } from '../src/results.mjs';
import { setTodayHold } from '../src/subagents.mjs';

const H = 3600_000;
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
process.env.GROK_HOME = tmp('lc-today-grok-');

const now = new Date(2026, 9, 27, 15, 0).getTime(); // Tue 15:00 local
const midnight = new Date(2026, 9, 27).getTime();
const reset = (midnight + 4 * 24 * H) / 1000;
// 40% at midnight, 60% now: 60% left over 4 days is 15% a day, and today has used 20%.
const week = (pct) =>
  [
    [midnight - 2 * H, 40],
    [now - H, pct - 5],
    [now, pct],
  ]
    .map(([t, p]) => JSON.stringify({ t, src: 'claude', win: '7d', pct: p, reset, sid: 's' }))
    .join('\n');
const hook = { tool_name: 'Agent', session_id: 's', tool_input: { prompt: 'p', description: 'd' } };

async function withState(pct, fn) {
  const state = tmp('lc-today-');
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = state;
  try {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'samples.jsonl'), week(pct));
    await fn();
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
}

test('daily hold: off by default, held when opted in, previewed for free, never at 100%', async () => {
  await withState(60, async () => {
    // This 7d window is also on pace to run out, so a spawn moves to Sonnet: it is the hold that must not fire by default.
    assert.notEqual(typeof (await runGuard(hook, now, 30)), 'string'); // default: notify only, nothing held
    assert.equal(await runGuard(hook, now, 30, { preview: true }), null); // free: records, never holds
    setTodayHold(true);
    const held = await runGuard(hook, now, 30);
    assert.match(held, /today's share of your Claude 7d limit is used up \(20% of 15%\)/);
    assert.match(held, /limitcast budget today off/);
    const blocks = loadBlocks(0);
    assert.deepEqual(
      blocks.filter((b) => b.kind === 'today').map((b) => Boolean(b.shadow)),
      [true, false],
    );
    assert.equal(resultsStats({ now, days: 7, samples: [], blocks, pro: true }).todays, 1);
    assert.equal(resultsStats({ now, days: 7, samples: [], blocks, pro: false }).todays, 1); // the free preview
  });
  await withState(100, async () => {
    setTodayHold(true);
    assert.equal(await runGuard(hook, now, 30), null); // a window at 100% is left to Claude Code (extra usage)
  });
  await withState(50, async () => {
    setTodayHold(true);
    assert.equal(await runGuard(hook, now, 30), null); // under today's share: nothing held
  });
});

test('daily share notifies once a day at 80% of it, and not before', () => {
  const clock = () => '14:00';
  const row = (used) => ({ src: 'claude', win: '7d', pct: 53, reset: 99, wall: null, verdict: 'OK', today: { budget: 15, used, left: 15 - used } });
  assert.deepEqual(transitions([row(11)], {}, clock, now).messages, []);
  const r = transitions([row(13)], {}, clock, now);
  assert.deepEqual(r.messages, ["Claude 7d: 87% of today's share used, 2% left today."]);
  assert.deepEqual(transitions([row(14)], r.next, clock, now + H).messages, []); // once today
  assert.equal(transitions([row(13)], r.next, clock, now + 24 * H).messages.length, 1); // again tomorrow
});
