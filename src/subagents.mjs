// @ts-check
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from './store.mjs';

// Subagent receipts and budgets (Pro). A SubagentStop hook prices each finished subagent against the 5-hour window
// (from the user's own calibration) and logs it; the guard holds new subagents once a window's budget is spent.

/** @typedef {{t:number, id?:string, sid?:string, type?:string, calls:number, fresh:number, read:number, pct?:number}} SubagentEntry */

const ledger = () => join(stateDir(), 'subagents.jsonl');
const configFile = () => join(stateDir(), 'config.json');
const FIVE_H = 5 * 3600_000;

/**
 * New (input, cache writes, output) and cached tokens a subagent used, and its model calls.
 * A call's usage repeats on every content block it streamed, so calls are counted once by message id.
 * @param {string} path the subagent's transcript
 */
export function subagentUsage(path) {
  const file = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  /** @type {Map<string, any>} */
  const calls = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    try {
      const m = JSON.parse(line)?.message;
      if (m?.usage) calls.set(m.id ?? `line${calls.size}`, m.usage);
    } catch {
      /* a partial line */
    }
  }
  let fresh = 0;
  let read = 0;
  for (const u of calls.values()) {
    fresh += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    read += u.cache_read_input_tokens ?? 0;
  }
  return { fresh, read, calls: calls.size };
}

/**
 * "limitcast: that Explore subagent used ≈2.1% of your 5-hour window (34 calls)."
 * @param {string} type
 * @param {{fresh:number, read:number, calls:number}} u
 * @param {number|null} pct
 */
export function receiptMessage(type, u, pct) {
  const what = type ? `that ${type} subagent` : 'that subagent';
  const calls = `${u.calls} call${u.calls === 1 ? '' : 's'}`;
  if (pct === null) return `limitcast: ${what} used ${k(u.fresh + u.read)} tokens, ${k(u.fresh)} of them new (${calls}).`;
  return `limitcast: ${what} used ≈${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}% of your 5-hour window (${calls}, ${k(u.fresh)} new tokens).`;
}

const k = (/** @type {number} */ n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const pct1 = (/** @type {number} */ p) => (p < 1 ? p.toFixed(2) : p.toFixed(1));

const NOTICE_MIN_RUNS = 3;
const NOTICE_MIN_PCT = 1; // a typical run under 1% of a window is not worth a message

/**
 * Before a subagent starts: what that kind has cost you so far, from the receipts ledger.
 * "limitcast: Explore subagents have cost you a median ≈1.2% (max ≈3.6%) of a 5-hour window over 7 runs; this window is 38% used."
 * Uses the same type when it has at least 3 priced runs, else every subagent. Null with too little history, or when
 * the typical run is under 1% of a window and the window is not NEAR.
 * @param {SubagentEntry[]} entries
 * @param {unknown} type the subagent type about to start
 * @param {{pct:number, verdict:string}|undefined} win the current 5-hour window
 */
export function spawnNotice(entries, type, win) {
  const priced = entries.filter((e) => typeof e.pct === 'number');
  const same = typeof type === 'string' && type ? priced.filter((e) => e.type === type) : [];
  const runs = same.length >= NOTICE_MIN_RUNS ? same : priced;
  if (runs.length < NOTICE_MIN_RUNS) return null;
  const sorted = runs.map((e) => /** @type {number} */ (e.pct)).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  if (median < NOTICE_MIN_PCT && win?.verdict !== 'NEAR') return null;
  const who = runs === same ? `${type} subagents have` : 'Your subagents have';
  const used = win ? `; this window is ${Math.round(win.pct)}% used` : '';
  return `limitcast: ${who} cost you a median ≈${pct1(median)}% (max ≈${pct1(sorted.at(-1) ?? 0)}%) of a 5-hour window over ${runs.length} runs${used}.`;
}

/** @param {SubagentEntry} e */
export function logSubagent(e) {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(ledger(), `${JSON.stringify(e)}\n`);
}

/**
 * Subagents that finished since `since`. A subagent that stops twice (a hook kept it going) counts once, as its last.
 * shortcut: never pruned; one short line per subagent, prune when someone's ledger passes a few MB.
 * @param {number} since epoch ms
 * @returns {SubagentEntry[]}
 */
export function loadSubagents(since) {
  if (!existsSync(ledger())) return [];
  /** @type {Map<string, SubagentEntry>} */
  const out = new Map();
  for (const line of readFileSync(ledger(), 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.t >= since) out.set(e.id ?? `t${e.t}`, e);
    } catch {
      /* blank or partial line */
    }
  }
  return [...out.values()];
}

/** @returns {number|null} % of each 5-hour window subagents may use */
export function getBudget() {
  try {
    const b = JSON.parse(readFileSync(configFile(), 'utf8')).subagentBudget;
    return typeof b === 'number' && b > 0 ? b : null;
  } catch {
    return null;
  }
}

/** @param {number|null} pct */
export function setBudget(pct) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    /* new */
  }
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...cfg, subagentBudget: pct }));
}

/**
 * When the current Claude 5-hour window started: its reset minus 5 hours, or 5 hours ago without a reading.
 * @param {{src:string, win:string, verdict:string, reset:number}[]} forecasts
 * @param {number} now
 */
export function windowStart(forecasts, now) {
  const f = forecasts.find((x) => x.src === 'claude' && x.win === '5h' && x.verdict !== 'RESET');
  return f ? f.reset - FIVE_H : now - FIVE_H;
}

/**
 * % of the window this account's subagents used: those of its sessions, and of sessions no account has readings
 * for yet. Subagents priced before the first calibration count 0.
 * @param {SubagentEntry[]} entries
 * @param {Set<string|undefined>} mine sessions of the account
 * @param {Set<string|undefined>} known sessions of every account
 */
export const budgetSpent = (entries, mine, known) =>
  entries.filter((e) => mine.has(e.sid) || !known.has(e.sid)).reduce((a, e) => a + (e.pct ?? 0), 0);

/**
 * @param {number} spent
 * @param {number} budget
 */
export const budgetMessage = (spent, budget) =>
  `limitcast: subagents have used ≈${spent.toFixed(1)}% of this 5-hour window, over your ${budget}% budget. ` +
  'Finish with the agents already running, raise it with `limitcast budget subagents <percent>`, or set LIMITCAST_ALLOW=1 to spawn anyway.';
