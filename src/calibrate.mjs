// @ts-check
import { claudeAccounts } from './forecast.mjs';

// How many tokens move this user's Claude 5-hour meter by 1%, from their own readings and transcripts.
// Each pair of consecutive readings of one account's window where usage rose is one observation: the rise
// against the tokens that account's sessions used in between, split into new tokens (input, cache writes,
// output) and cache reads, which count far less. Least squares with no intercept gives % per token of each.

/** @typedef {import('./forecast.mjs').Sample} Sample */
/** @typedef {import('./usage.mjs').Usage} Usage */

const MIN_OBS = 30;

/**
 * @param {Sample[]} samples
 * @param {Usage[]} usage
 * @returns {{fresh:number, read:number, n:number}|null} % of the 5h window per million new / cached tokens
 */
export function calibrate(samples, usage) {
  const obs = [];
  const claude = usage.filter((u) => u.src === 'claude').sort((a, b) => a.t - b.t);
  for (const acct of claudeAccounts(samples)) {
    const sids = new Set(acct.map((s) => s.sid));
    const mine = claude.filter((u) => sids.has(u.session));
    const w5 = acct.filter((s) => s.win === '5h').sort((a, b) => a.t - b.t);
    for (let i = 1; i < w5.length; i++) {
      const p = w5[i - 1];
      const c = w5[i];
      if (Math.abs(c.reset - p.reset) > 120 || c.pct <= p.pct) continue;
      let f = 0;
      let r = 0;
      for (const u of mine) {
        if (u.t <= p.t) continue;
        if (u.t > c.t) break;
        f += u.input + u.cacheWrite + u.output;
        r += u.cacheRead;
      }
      if (f + r > 0) obs.push({ d: c.pct - p.pct, f: f / 1e6, r: r / 1e6 });
    }
  }
  if (obs.length < MIN_OBS) return null;
  let ff = 0;
  let rr = 0;
  let fr = 0;
  let fd = 0;
  let rd = 0;
  for (const o of obs) {
    ff += o.f * o.f;
    rr += o.r * o.r;
    fr += o.f * o.r;
    fd += o.f * o.d;
    rd += o.r * o.d;
  }
  const det = ff * rr - fr * fr;
  if (!det) return null;
  const fresh = (fd * rr - rd * fr) / det;
  const read = (rd * ff - fd * fr) / det;
  // Both must count, and new tokens must count more than cached ones; anything else is noise, not a calibration.
  if (!(fresh > 0 && read > 0 && fresh > read)) return null;
  return { fresh, read, n: obs.length };
}

const DAY = 86400_000;

/**
 * Has the limit itself changed? Compares the newest 3-day calibration with the median of those from 3 to 30 days
 * before it. Returns new tokens per 1% of the 5-hour window then and now, when they differ by 15% or more.
 * @param {{fresh:number, at:number}[]} history one calibration of the last 3 days per day, oldest first
 * @returns {{from:number, to:number}|null}
 */
export function limitChange(history) {
  const last = history.at(-1);
  if (!last) return null;
  const before = history
    .filter((h) => h.at <= last.at - 3 * DAY && h.at >= last.at - 30 * DAY)
    .map((h) => h.fresh)
    .sort((a, b) => a - b);
  if (before.length < 3) return null;
  const from = Math.round(1e6 / before[Math.floor(before.length / 2)]);
  const to = Math.round(1e6 / last.fresh);
  return Math.abs(to / from - 1) >= 0.15 ? { from, to } : null;
}

/** @param {{from:number, to:number}} c */
export const limitChangeMessage = (c) =>
  `Your Claude limit looks ${c.to < c.from ? 'smaller' : 'bigger'}: 1% of the 5-hour window now takes ~${Math.round(c.to / 1000)}k new tokens, ${c.to < c.from ? 'down' : 'up'} from ~${Math.round(c.from / 1000)}k.`;

/**
 * What a smaller starting context was worth against the 5-hour limit, in % of one window: each session writes its
 * starting context once (new tokens) and re-reads it on every call (cached tokens).
 * @param {{fresh:number, read:number}} c
 * @param {{writes:number, reads:number}} saved tokens not written / not re-read
 */
export const windowPct = (c, saved) => (saved.writes / 1e6) * c.fresh + (saved.reads / 1e6) * c.read;
