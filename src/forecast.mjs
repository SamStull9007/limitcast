// @ts-check

/** @typedef {{t:number, src:string, win:string, pct:number, reset:number, sid?:string}} Sample  t: epoch ms, reset: epoch s, sid: Claude session */

const RESET_JITTER_S = 120; // Codex resets_at drifts by seconds between events
const RECENT_MS = 60 * 60 * 1000;

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
  const pts = recent.length >= 2 ? recent : window;
  const rate = slopePerHour(pts);
  if (rate === null || rate <= 0) return { ...base, rate, verdict: 'OK' };

  const wall = last.t + ((100 - last.pct) / rate) * 3600_000;
  return { ...base, rate, wall, verdict: wall < resetMs ? 'AT_RISK' : 'OK' };
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
 * Keep Claude samples from one session: `sid` if it has any, else the most recently active one. Codex is untouched.
 * Untagged Claude samples (recorded before 0.2) can't be attributed to an account, so they're dropped once tagged ones exist.
 * @param {Sample[]} samples
 * @param {string} [sid]
 */
export function oneClaudeSession(samples, sid) {
  const claude = samples.filter((s) => s.src === 'claude' && s.sid);
  if (!claude.length) return samples;
  const pick = sid && claude.some((s) => s.sid === sid) ? sid : claude.reduce((a, b) => (b.t > a.t ? b : a)).sid;
  return samples.filter((s) => s.src !== 'claude' || s.sid === pick);
}

/** @param {number} minutes */
export function windowName(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '7d';
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
