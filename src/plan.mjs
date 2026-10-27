// @ts-check
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAccounts } from './forecast.mjs';
import { fmtUsd } from './prices.mjs';
import { stateDir } from './store.mjs';

// `limitcast plan` (Pro): does your Claude plan fit how much you use? From a long-lived record of the peak of every
// 5-hour and weekly window (the samples themselves are only kept for 8 days), it says whether you hit your limits often
// enough to justify the next plan, or use so little that a smaller one would do, with the monthly price difference.

/** Individual plans. mult: usage per 5-hour session relative to Pro (Anthropic: Max is "5x or 20x the usage of Pro").
 * usd: monthly price, platform claude.com/pricing read 2026-10-26: Pro $20 ($17 a month billed yearly), Max from $100.
 * The Max 20x price ($200) was not on that page: change any price in ~/.local/state/limitcast/prices.json
 * ({"plans": {"max20": 200}}). */
export const PLANS = {
  pro: { name: 'Pro', mult: 1, usd: 20 },
  max5: { name: 'Max 5x', mult: 5, usd: 100 },
  max20: { name: 'Max 20x', mult: 20, usd: 200 },
};
/** @typedef {keyof typeof PLANS} PlanId */
const ORDER = /** @type {PlanId[]} */ (['pro', 'max5', 'max20']);

const configFile = () => join(stateDir(), 'config.json');
const peaksFile = () => join(stateDir(), 'plan-peaks.json');
const KEEP_DAYS = 120;
const HIT = 99; // % from which a window counts as reached
const FIT = 85; // a smaller plan must keep your busiest window at or under this % of its limit
const MIN_DAYS_UP = 7;
const MIN_DAYS_DOWN = 14;
const MIN_WINDOWS = 10;

/** @returns {PlanId|null} the plan you told limitcast you are on */
export function getPlan() {
  try {
    const p = JSON.parse(readFileSync(configFile(), 'utf8')).plan;
    return p in PLANS ? p : null;
  } catch {
    return null;
  }
}

/** @param {PlanId|null} plan */
export function setPlan(plan) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    /* new */
  }
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...cfg, plan }));
}

/**
 * Monthly prices with your overrides from prices.json ({"plans": {"max20": 200}}).
 * @returns {Record<PlanId, number>}
 */
export function planPrices() {
  const base = { pro: PLANS.pro.usd, max5: PLANS.max5.usd, max20: PLANS.max20.usd };
  try {
    const o = JSON.parse(readFileSync(join(stateDir(), 'prices.json'), 'utf8')).plans ?? {};
    for (const id of ORDER) if (Number(o[id]) > 0) base[id] = Number(o[id]);
  } catch {
    /* defaults */
  }
  return base;
}

/** @typedef {{w:string, reset:number, pct:number}} Cycle  one window cycle: its length ('5h' or '7d'), reset (epoch s), peak % */

/** Readings of one cycle differ in `reset` by a little: bucket them (cycles are hours apart). @param {number} reset */
const bucket = (reset) => Math.round(reset / 1200);

/**
 * Fold the readings of the Claude account you used last into the record of cycle peaks. Pure: returns the new record.
 * @param {Record<string, Cycle>} cycles
 * @param {import('./forecast.mjs').Sample[]} samples
 * @param {number} now epoch ms
 * @returns {Record<string, Cycle>}
 */
export function foldPeaks(cycles, samples, now) {
  const accounts = claudeAccounts(samples.filter((s) => s.src === 'claude'));
  const latest = accounts.sort((a, b) => Math.max(...b.map((s) => s.t)) - Math.max(...a.map((s) => s.t)))[0] ?? [];
  const out = { ...cycles };
  for (const s of latest) {
    if (s.win !== '5h' && s.win !== '7d') continue;
    const k = `${s.win}:${bucket(s.reset)}`;
    const prev = out[k];
    out[k] = { w: s.win, reset: Math.max(prev?.reset ?? 0, s.reset), pct: Math.max(prev?.pct ?? 0, s.pct) };
  }
  const floor = now / 1000 - KEEP_DAYS * 86400;
  return Object.fromEntries(Object.entries(out).filter(([, c]) => c.reset >= floor));
}

/** @returns {Record<string, Cycle>} */
export function loadPeaks() {
  try {
    const d = JSON.parse(readFileSync(peaksFile(), 'utf8'));
    return d.v === 1 ? d.cycles : {};
  } catch {
    return {};
  }
}

/**
 * Add the current readings to the record on disk.
 * @param {import('./forecast.mjs').Sample[]} samples
 * @param {number} now
 */
export function recordPeaks(samples, now) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(peaksFile(), JSON.stringify({ v: 1, cycles: foldPeaks(loadPeaks(), samples, now) }));
  } catch {
    /* a record: the next run adds the readings again */
  }
}

/**
 * What the record says over the last `days`: for each window length, the windows with use, how many reached the limit,
 * and the busiest one; and how many days the record covers.
 * @param {Record<string, Cycle>} cycles
 * @param {number} now epoch ms
 * @param {number} days
 */
export function planStats(cycles, now, days) {
  const since = now / 1000 - days * 86400;
  const mine = Object.values(cycles).filter((c) => c.reset >= since);
  const of = (/** @type {string} */ w) => {
    const cs = mine.filter((c) => c.w === w && c.pct > 0);
    return { n: cs.length, hits: cs.filter((c) => c.pct >= HIT).length, peak: Math.max(0, ...cs.map((c) => c.pct)) };
  };
  const five = mine.filter((c) => c.w === '5h').map((c) => c.reset);
  const spanDays = five.length ? (Math.max(...five) - Math.min(...five)) / 86400 : 0;
  return { five: of('5h'), week: of('7d'), spanDays };
}

const pct = (/** @type {number} */ n) => `${Math.round(n)}%`;

/**
 * The advice, as lines of text, and its kind.
 * @param {PlanId|null} plan the plan you set
 * @param {ReturnType<typeof planStats>} st
 * @param {Record<PlanId, number>} usd monthly prices
 * @returns {{kind:'unknown'|'thin'|'upgrade'|'downgrade'|'fits', lines:string[]}}
 */
export function advise(plan, st, usd) {
  const evidence = `Over ${Math.round(st.spanDays)} days: ${st.five.n} five-hour windows with use (${st.five.hits} reached the limit, busiest ${pct(st.five.peak)}), ${st.week.n} weekly windows (${st.week.hits} reached the limit, busiest ${pct(st.week.peak)}).`;
  if (!plan) return { kind: 'unknown', lines: [evidence, 'Tell limitcast your plan to get a recommendation: limitcast plan set <pro|max5|max20>'] };
  const i = ORDER.indexOf(plan);
  const next = ORDER[i + 1];
  const lower = ORDER[i - 1];
  const hits = st.five.hits;
  const need = (/** @type {number} */ days) => st.spanDays < days || st.five.n < MIN_WINDOWS;
  if (need(MIN_DAYS_UP)) {
    return {
      kind: 'thin',
      lines: [
        evidence,
        `Not enough history yet for a recommendation (it needs ${MIN_DAYS_UP}+ days and ${MIN_WINDOWS}+ windows with use). limitcast keeps this record from now on: ask again later.`,
      ],
    };
  }
  if (next && (hits >= 3 || st.week.hits >= 1)) {
    const x = PLANS[next].mult / PLANS[plan].mult;
    return {
      kind: 'upgrade',
      lines: [
        evidence,
        `You reached a limit often enough that ${PLANS[next].name} is worth a look: ${x}x the usage per 5-hour session for ${fmtUsd(usd[next] - usd[plan])} more a month (${fmtUsd(usd[next])} vs ${fmtUsd(usd[plan])}).`,
        'If this is rare, paid extra usage may cost less than a bigger plan. limitcast cannot see that spend.',
      ],
    };
  }
  if (lower && !need(MIN_DAYS_DOWN) && hits === 0 && st.week.hits === 0) {
    const r = PLANS[plan].mult / PLANS[lower].mult;
    const five = st.five.peak * r;
    const week = st.week.peak * r;
    if (five <= FIT && week <= FIT) {
      return {
        kind: 'downgrade',
        lines: [
          evidence,
          `${PLANS[lower].name} would have fit: it has 1/${r} of the usage per session, so your busiest 5-hour window (${pct(st.five.peak)}) would have been about ${pct(five)} and your busiest week about ${pct(week)}. That saves ${fmtUsd(usd[plan] - usd[lower])} a month (${fmtUsd(usd[lower])} vs ${fmtUsd(usd[plan])}).`,
          'Anthropic states the multiplier for the 5-hour session; this assumes weekly limits scale the same way.',
        ],
      };
    }
  }
  const tight = lower && hits === 0 && st.five.peak * (PLANS[plan].mult / PLANS[lower].mult) <= 100;
  return {
    kind: 'fits',
    lines: [evidence, `${PLANS[plan].name} fits how you use it.${tight ? ` ${PLANS[lower].name} would have been tight.` : ''}`],
  };
}
