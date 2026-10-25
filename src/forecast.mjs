// @ts-check

/** @typedef {{t:number, src:string, win:string, pct:number, reset:number, sid?:string}} Sample  t: epoch ms, reset: epoch s, sid: Claude session */

const RESET_JITTER_S = 120; // Codex resets_at drifts by seconds between events
const RECENT_MS = 60 * 60 * 1000;
const NEAR_PCT = 95;
const DAY_MS = 24 * 3600_000;
const IMMINENT_MS = 60 * 60_000;

/**
 * Burn rate and limit forecast for one (src, win) series.
 * @param {Sample[]} samples
 * @param {number} now epoch ms
 */
export function forecast(samples, now) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const last = sorted[sorted.length - 1];
  const resetMs = last.reset * 1000;
  const base = { src: last.src, win: last.win, pct: last.pct, reset: resetMs, rate: null, wall: null };
  if (resetMs <= now) return { ...base, pct: 0, verdict: 'RESET' };
  if (last.pct >= 100) return { ...base, verdict: 'HIT' };

  const window = sorted.filter((s) => Math.abs(s.reset - last.reset) <= RESET_JITTER_S);
  const recent = window.filter((s) => s.t >= now - RECENT_MS);
  const short = slopePerHour(recent.length >= 2 ? recent : window);
  // NEAR: so close to the limit that one heavy turn can finish it, even with no burn rate to go on yet.
  const calm = last.pct >= NEAR_PCT ? 'NEAR' : 'OK';
  const runout = (/** @type {number|null} */ r) => (r === null || r <= 0 ? null : last.t + ((100 - last.pct) / r) * 3600_000);

  let rate = short;
  let wall = runout(short);
  // A multi-day window spans nights and idle days: one busy hour projected across them predicts a runout days
  // early. Use the average pace over the last full day, idle time included, unless the last hour's pace runs
  // the window out within the hour (a burst near the end of the week must still be caught).
  const len = windowMs(last.win);
  if (len >= DAY_MS && !(wall !== null && wall - now <= IMMINENT_MS)) {
    const from = now - DAY_MS;
    // Usage a day ago: 0% if the window began since then, else the last reading before then (or the first one).
    const before = window.filter((s) => s.t <= from);
    const then = resetMs - len >= from ? 0 : (before.at(-1) ?? window[0]).pct;
    rate = (last.pct - then) / 24;
    wall = runout(rate);
  }
  if (wall === null) return { ...base, rate, verdict: calm };
  return { ...base, rate, wall, verdict: wall < resetMs ? 'AT_RISK' : calm };
}

/**
 * Length of a window from its name ("5h", "7d", "90m"), in ms; 0 if unknown.
 * @param {string} win
 */
export function windowMs(win) {
  const m = /^(\d+)([mhd])$/.exec(win);
  return m ? Number(m[1]) * { m: 60_000, h: 3600_000, d: DAY_MS }[/** @type {'m'|'h'|'d'} */ (m[2])] : 0;
}

/**
 * Least-squares slope of pct over time, in % per hour.
 * Needs 2+ distinct timestamps spanning at least 5 minutes, or the coarse integer percents are noise.
 * @param {Sample[]} pts
 */
export function slopePerHour(pts) {
  if (pts.length < 2) return null;
  const t0 = pts[0].t;
  const xs = pts.map((p) => (p.t - t0) / 3600_000);
  if (xs[xs.length - 1] - xs[0] < 5 / 60) return null;
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = pts.reduce((a, p) => a + p.pct, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (pts[i].pct - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

/**
 * Group samples by src+win and forecast each.
 * @param {Sample[]} samples
 * @param {number} now
 */
export function forecastAll(samples, now) {
  /** @type {Map<string, Sample[]>} */
  const groups = new Map();
  for (const s of samples) {
    const k = `${s.src}:${s.win}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)?.push(s);
  }
  return [...groups.values()].map((g) => forecast(g, now)).filter((f) => f !== null);
}

/**
 * Claude sessions can belong to different accounts with different limits, and the feed has no account id.
 * Keep the Claude samples of one account: the one `sid` belongs to if it has readings, else the most recently active one.
 * Codex is untouched. Untagged Claude samples (recorded before 0.2) can't be attributed, so they're dropped once tagged ones exist.
 * @param {Sample[]} samples
 * @param {string} [sid]
 */
export function oneClaudeAccount(samples, sid) {
  const accounts = claudeAccounts(samples);
  if (!accounts.length) return samples;
  const pick = accounts.find((a) => a.some((s) => s.sid === sid)) ?? accounts[0];
  return [...samples.filter((s) => s.src !== 'claude'), ...pick];
}

/**
 * Tagged Claude samples grouped by account, most recently active account first.
 * Each session reports the same account windows, and a session only records when a reading changes, so one
 * session alone often holds too few readings to forecast from. Sessions are the same account when they share
 * at least one window (same reset time) and their readings of every shared window never go down when merged:
 * usage within a window only rises, so a second account's lower readings break the merge.
 * shortcut: two accounts with identical reset times and near-identical usage could merge; split on a feed account id if Claude Code adds one.
 * @param {Sample[]} samples
 * @returns {Sample[][]}
 */
export function claudeAccounts(samples) {
  /** @type {Map<string, Sample[]>} */
  const sessions = new Map();
  for (const s of samples) {
    if (s.src !== 'claude' || !s.sid) continue;
    sessions.set(s.sid, [...(sessions.get(s.sid) ?? []), s]);
  }
  const latest = (/** @type {Sample[]} */ g) => Math.max(...g.map((s) => s.t));
  /** @type {Sample[][]} */
  const accounts = [];
  for (const g of [...sessions.values()].sort((a, b) => latest(b) - latest(a))) {
    const a = accounts.find((acc) => sameAccount(acc, g));
    if (a) a.push(...g);
    else accounts.push([...g]);
  }
  return accounts;
}

/**
 * @param {Sample[]} a
 * @param {Sample[]} b
 */
function sameAccount(a, b) {
  let shared = false;
  const same = (/** @type {Sample} */ x, /** @type {Sample} */ s) => x.win === s.win && Math.abs(x.reset - s.reset) <= RESET_JITTER_S;
  // One representative reading per window of b; the status line runs this, so keep it to a few passes.
  const windows = b.filter((s, i) => b.findIndex((x) => same(x, s)) === i);
  for (const s of windows) {
    const series = a.filter((x) => same(x, s));
    if (!series.length) continue;
    shared = true;
    const merged = [...series, ...b.filter((x) => same(x, s))].sort((x, y) => x.t - y.t);
    let top = Number.NEGATIVE_INFINITY;
    for (const x of merged) {
      if (x.pct < top - 0.5) return false;
      top = Math.max(top, x.pct);
    }
  }
  return shared;
}

/** @param {number} minutes */
export function windowName(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '7d';
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
