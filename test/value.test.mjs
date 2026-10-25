import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dailyDue, foldEvents, loadValue, scanSessions, sessionValue, valueSection, valueTotals } from '../src/value.mjs';

const M = 60_000;
const t0 = Date.UTC(2026, 9, 24, 12, 0);
const reset = t0 / 1000 + 5 * 3600;
const s = (min, pct) => ({ t: t0 + min * M, src: 'claude', win: '5h', pct, reset, sid: 'A' });
const climb = [s(0, 40), s(10, 50), s(20, 60), s(40, 80), s(60, 100)];
const empty = () => ({ since: 0, scanned: 0, sessions: {}, hits: {}, blocks: {} });

test('fold: hits and block outcomes are kept after their readings age out', () => {
  const block = { t: t0 + 40 * M, src: 'claude', win: '5h', pct: 80, wall: t0 + 60 * M, reset: reset * 1000, sid: 'A' };
  const v = foldEvents(empty(), { now: t0 + 90 * M, samples: climb, blocks: [block] });
  assert.deepEqual(
    Object.values(v.hits).map((h) => [h.lead, h.unseen]),
    [[50, false]],
  );
  assert.equal(v.blocks[String(block.t)].outcome, 'hit');
  // 9 days later the readings are gone: the recorded outcome stays.
  foldEvents(v, { now: t0 + 9 * 86400_000, samples: [], blocks: [block] });
  assert.equal(v.blocks[String(block.t)].outcome, 'hit');
  // Only the 100% reading is left: the hit keeps the warning recorded while the climb was visible.
  foldEvents(v, { now: t0 + 9 * 86400_000, samples: [s(60, 100)], blocks: [] });
  assert.deepEqual(
    Object.values(v.hits).map((h) => [h.lead, h.unseen]),
    [[50, false]],
  );
  assert.equal(v.since, t0);
});

const line = (o) => JSON.stringify(o);
const transcript = (dir, name, { skills, calls, side = 0 }) => {
  const rows = [
    line({ type: 'attachment', attachment: { type: 'skill_listing', content: '- x: '.padEnd(skills, 'y') } }),
    line({ type: 'user', cwd: '/w' }),
  ];
  for (let i = 0; i < calls; i++) {
    const ev = {
      type: 'assistant',
      entrypoint: 'cli',
      timestamp: new Date(t0 + i * M).toISOString(),
      message: { id: `m${i}`, usage: { input_tokens: 1 } },
    };
    rows.push(line(ev), line(ev)); // a message repeats per content block: counted once
  }
  for (let i = 0; i < side; i++) {
    rows.push(
      line({ type: 'assistant', isSidechain: true, timestamp: new Date(t0).toISOString(), message: { id: `s${i}`, usage: { input_tokens: 1 } } }),
    );
  }
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, `${rows.join('\n')}\n`);
  return p;
};

test('limits from before limitcast was watching are not counted as warnings you got', () => {
  const v = foldEvents(empty(), { now: t0 + 90 * M, samples: climb, blocks: [], start: t0 + 70 * M });
  assert.deepEqual(Object.keys(v.hits), []); // hit at +60 min, watching from +70
  assert.equal(v.since, t0 + 70 * M);
});

test('a session saves its smaller start on every main-thread model call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-val-'));
  const p = transcript(dir, 'a', { skills: 4000, calls: 3, side: 5 });
  const v = await sessionValue(p, 8000);
  assert.deepEqual(v, { at: t0, turns: 3, savedPerTurn: 1000 }); // (8000 - 4000 chars) / 4; subagent calls not counted
});

test('scan adds new sessions only, and the section reads clearly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lc-root-'));
  mkdirSync(join(root, 'p'));
  transcript(join(root, 'p'), 'a', { skills: 4000, calls: 10 });
  const v = empty();
  await scanSessions(v, { root, baseline: { at: t0 - M, chars: 8000 }, now: Date.now() });
  assert.equal(Object.keys(v.sessions).length, 1);
  // An older transcript untouched since the last scan is not re-read.
  const old = transcript(join(root, 'p'), 'b', { skills: 4000, calls: 10 });
  utimesSync(old, new Date(t0), new Date(t0));
  await scanSessions(v, { root, baseline: { at: t0 - M, chars: 8000 }, now: Date.now() });
  assert.equal(Object.keys(v.sessions).length, 1);

  foldEvents(v, { now: t0 + 90 * M, samples: climb, blocks: [] });
  const t = valueTotals(v);
  assert.deepEqual([t.sessions, t.turns, t.tokens], [1, 10, 10_000]);
  const text = valueSection(t, { now: t0 + 2 * 86400_000, pro: true });
  assert.match(text, /Since limitcast started watching \(.*, 2 days\)/);
  assert.match(text, /\*\*10\.0k tokens not re-sent\.\*\*/);
  assert.match(text, /10 calls across 1 sessions/);
  assert.match(text, /Warned you before 1 of the 1 limits it watched you approach\*\*, on average 50 min ahead/);
  assert.match(text, /hasn't needed to stop a subagent yet/);
});

test('the rollup is due once a day; an empty record loads', () => {
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = mkdtempSync(join(tmpdir(), 'lc-daily-'));
  try {
    assert.deepEqual(loadValue().sessions, {});
    assert.equal(dailyDue(t0), true);
    assert.equal(dailyDue(t0 + 3600_000), false);
    assert.equal(dailyDue(t0 + 86400_000), true);
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});
