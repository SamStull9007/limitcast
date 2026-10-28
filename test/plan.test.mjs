import './helpers/environment.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { advise, foldPeaks, getPlan, loadPeaks, PLANS, planPrices, planStats, recordPeaks, setPlan } from '../src/plan.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const fresh = () => {
  process.env.LIMITCAST_STATE = tmp('lc-plan-state-'); // the record and config live here, never in the real state dir
};
fresh();
const DAY = 86400;
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const NOW_S = NOW / 1000;
const USD = { pro: 20, max5: 100, max20: 200 };
/** A record with one 5-hour cycle every 5 hours for `days` days: pct 20 each, `hits` of them at 100%; weekly cycles peaking at `week`. */
const record = ({ days = 14, hits = 0, peak = 20, week = 30 } = {}) => {
  const cycles = {};
  const n = Math.floor((days * 24) / 5);
  for (let i = 0; i < n; i++) cycles[`5h:${i}`] = { w: '5h', reset: NOW_S - i * 5 * 3600, pct: i < hits ? 100 : peak };
  for (let i = 0; i < Math.floor(days / 7); i++) cycles[`7d:${i}`] = { w: '7d', reset: NOW_S - i * 7 * DAY, pct: week };
  return cycles;
};
const sample = (o) => ({ t: NOW, src: 'claude', win: '5h', pct: 10, reset: NOW_S + 3600, sid: 's1', ...o });

test('foldPeaks keeps the highest reading of each cycle, whatever jitter the reset has, and drops old cycles', () => {
  let c = foldPeaks(
    {},
    [
      sample({ pct: 10, reset: NOW_S + 3600 }),
      sample({ t: NOW + 1, pct: 40, reset: NOW_S + 3601 }),
      sample({ t: NOW + 2, pct: 60, reset: NOW_S + 3599 }),
    ],
    NOW,
  );
  assert.deepEqual(
    Object.values(c).map((x) => [x.w, x.pct]),
    [['5h', 60]],
  );
  c = foldPeaks(c, [sample({ win: '7d', pct: 33, reset: NOW_S + 3 * DAY }), sample({ src: 'codex', pct: 99 }), sample({ win: '1h', pct: 99 })], NOW);
  assert.deepEqual(
    Object.values(c)
      .map((x) => [x.w, x.pct])
      .sort(),
    [
      ['5h', 60],
      ['7d', 33],
    ],
  ); // other tools and windows are not recorded
  const old = foldPeaks(c, [], NOW + 130 * DAY * 1000); // 130 days on: both cycles are older than the record keeps
  assert.deepEqual(old, {});
});

test('recordPeaks accumulates across runs and survives a missing or corrupt record', () => {
  fresh();
  assert.deepEqual(loadPeaks(), {});
  recordPeaks([sample({ pct: 50 })], NOW);
  recordPeaks([sample({ pct: 70, reset: NOW_S + 5 * 3600 }), sample({ pct: 80 })], NOW);
  assert.deepEqual(
    Object.values(loadPeaks())
      .map((x) => x.pct)
      .sort(),
    [70, 80],
  );
  writeFileSync(join(process.env.LIMITCAST_STATE, 'plan-peaks.json'), 'not json');
  assert.deepEqual(loadPeaks(), {});
});

test('planStats counts windows with use, the ones that reached the limit, the busiest, and the days covered', () => {
  const st = planStats(record({ days: 14, hits: 3, peak: 20, week: 55 }), NOW, 28);
  assert.deepEqual([st.five.n, st.five.hits, st.five.peak], [67, 3, 100]);
  assert.deepEqual([st.week.n, st.week.hits, st.week.peak], [2, 0, 55]);
  assert.ok(st.spanDays > 13 && st.spanDays < 14.1);
  const week = planStats(record({ days: 14 }), NOW, 7); // only the last 7 days
  assert.ok(week.five.n < 40 && week.five.n > 30);
  assert.deepEqual(planStats({}, NOW, 28), { five: { n: 0, hits: 0, peak: 0 }, week: { n: 0, hits: 0, peak: 0 }, spanDays: 0 });
});

test('advise: no plan set, and too little history', () => {
  const st = (o) => planStats(record(o), NOW, 28);
  assert.equal(advise(null, st({}), USD).kind, 'unknown');
  assert.match(advise(null, st({}), USD).lines.join('\n'), /limitcast plan set <pro\|max5\|max20>/);
  const thin = advise('max5', st({ days: 3 }), USD);
  assert.equal(thin.kind, 'thin');
  assert.match(thin.lines[1], /needs 7\+ days and 10\+ windows/);
});

test('advise: reaching the limit often, or the weekly limit once, points to the next plan and its price', () => {
  const up = advise('pro', planStats(record({ days: 14, hits: 3 }), NOW, 28), USD);
  assert.equal(up.kind, 'upgrade');
  assert.match(up.lines.join('\n'), /Max 5x is worth a look: 5x the usage per 5-hour session for \$80\.00 more a month \(\$100 vs \$20\.00\)/);
  assert.match(up.lines.join('\n'), /extra usage may cost less/);
  assert.equal(advise('max5', planStats(record({ days: 14, hits: 1, week: 100 }), NOW, 28), USD).kind, 'upgrade'); // the weekly limit
  assert.match(
    advise('max5', planStats(record({ days: 14, hits: 3 }), NOW, 28), USD).lines.join('\n'),
    /Max 20x is worth a look: 4x .* \$100 more a month/,
  );
  assert.equal(advise('max20', planStats(record({ days: 14, hits: 5 }), NOW, 28), USD).kind, 'fits'); // nothing bigger to recommend
  assert.equal(advise('pro', planStats(record({ days: 14, hits: 2 }), NOW, 28), USD).kind, 'fits'); // two is not often
});

test('advise: a smaller plan only when the busiest window would still fit with room to spare', () => {
  // Max 20x to Max 5x multiplies use by 4: a busiest window of 20% becomes 80%, a busiest week of 15% becomes 60%.
  const down = advise('max20', planStats(record({ days: 16, peak: 20, week: 15 }), NOW, 28), USD);
  assert.equal(down.kind, 'downgrade');
  assert.match(
    down.lines.join('\n'),
    /Max 5x would have fit: it has 1\/4 of the usage per session, so your busiest 5-hour window \(20%\) would have been about 80% and your busiest week about 60%\. That saves \$100 a month \(\$100 vs \$200\)/,
  );
  assert.match(down.lines.join('\n'), /assumes weekly limits scale/);
  const tight = advise('max20', planStats(record({ days: 16, peak: 24, week: 15 }), NOW, 28), USD); // 96%: fits, but with no room
  assert.equal(tight.kind, 'fits');
  assert.match(tight.lines.join('\n'), /Max 5x would have been tight/);
  assert.equal(advise('max20', planStats(record({ days: 16, peak: 20, week: 30 }), NOW, 28), USD).kind, 'fits'); // the week would be 120%
  assert.equal(advise('max20', planStats(record({ days: 10, peak: 5, week: 5 }), NOW, 28), USD).kind, 'fits'); // under 14 days: too early to say
  assert.equal(advise('pro', planStats(record({ days: 16, peak: 1, week: 1 }), NOW, 28), USD).kind, 'fits'); // nothing smaller
});

test('the plan you set and the prices you override', () => {
  fresh();
  assert.equal(getPlan(), null);
  setPlan('max5');
  assert.equal(getPlan(), 'max5');
  writeFileSync(join(process.env.LIMITCAST_STATE, 'config.json'), JSON.stringify({ plan: 'platinum', subagentBudget: 5 }));
  assert.equal(getPlan(), null); // an unknown plan is ignored
  setPlan('pro');
  assert.equal(JSON.parse(readFileSync(join(process.env.LIMITCAST_STATE, 'config.json'), 'utf8')).subagentBudget, 5); // the other settings stay
  assert.deepEqual(planPrices(), { pro: 20, max5: 100, max20: 200 });
  writeFileSync(join(process.env.LIMITCAST_STATE, 'prices.json'), JSON.stringify({ plans: { max20: 180, pro: -1, max5: 'x' } }));
  assert.deepEqual(planPrices(), { pro: 20, max5: 100, max20: 180 });
  assert.equal(PLANS.max20.mult, 20);
});

test('CLI: plan is free; set validates; with readings it recommends the next plan and shows the API-equivalent value', () => {
  const state = tmp('lc-plan-cli-state-');
  const claudeDir = tmp('lc-plan-cli-claude-');
  // XDG_CONFIG_HOME too: starting a trial also writes a marker there, which must not land in the real ~/.config.
  const env = { ...process.env, LIMITCAST_STATE: state, XDG_CONFIG_HOME: tmp('lc-plan-cli-xdg-'), CLAUDE_CONFIG_DIR: claudeDir };
  delete env.LIMITCAST_LICENSE;
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const run = (...a) => spawnSync('node', [bin, ...a], { env });
  assert.equal(run('plan').status, 0);
  assert.equal(run('trial').status, 0);
  assert.equal(run('plan', 'set', 'platinum').status, 1);
  assert.match(run('plan', 'set', 'max5').stdout.toString(), /Plan set to Claude Max 5x/);
  // 7.5 days of readings, one 5-hour window every 5 hours at 30%, five of them at 100%.
  const now = Date.now();
  const lines = [];
  for (let i = 35; i >= 0; i--) {
    const reset = Math.floor((now - i * 5 * 3600_000) / 1000) + 3600;
    lines.push(JSON.stringify({ t: now - i * 5 * 3600_000, src: 'claude', win: '5h', pct: i < 5 ? 100 : 30, reset, sid: 's1' }));
  }
  writeFileSync(join(state, 'samples.jsonl'), `${lines.join('\n')}\n`);
  const r = run('plan');
  assert.equal(r.status, 0, r.stderr.toString());
  const out = r.stdout.toString();
  assert.match(out, /Claude plan: Max 5x, \$100 a month/);
  assert.doesNotMatch(out, /API list prices/); // no transcripts here: nothing to price
  assert.match(out, /36 five-hour windows with use \(5 reached the limit, busiest 100%\)/);
  assert.match(out, /Max 20x is worth a look: 4x the usage per 5-hour session for \$100 more a month/);
});
