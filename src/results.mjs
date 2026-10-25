// @ts-check
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecast } from './forecast.mjs';
import { stateDir } from './store.mjs';

/** @typedef {import('./forecast.mjs').Sample} Sample */
/** @typedef {{t:number, src:string, win:string, pct:number, wall:number, reset:number, sid?:string}} Block  t, wall, reset: epoch ms */

const JITTER_MS = 120_000; // Codex resets_at drifts by seconds between events
const NAMES = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };

const blockFile = () => join(stateDir(), 'guard.jsonl');

/**
 * Remember a guard block so `limitcast results` can check it later against what the window actually did.
 * shortcut: never pruned; one short line per block, so it stays small for years of normal use.
 * @param {Block} b
 */
export function logBlock(b) {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(blockFile(), `${JSON.stringify(b)}\n`);
}

/** @param {number} since epoch ms @returns {Block[]} */
export function loadBlocks(since) {
  if (!existsSync(blockFile())) return [];
  return readFileSync(blockFile(), 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const b = JSON.parse(line);
        return b.t >= since ? [b] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Samples of one limit window (same tool, window, Claude session and reset time).
 * @param {Sample[]} samples
 */
function windows(samples) {
  /** @type {Sample[][]} */
  const groups = [];
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    const g = groups.find(([f]) => f.src === s.src && f.win === s.win && f.sid === s.sid && Math.abs(f.reset - s.reset) * 1000 <= JITTER_MS);
    if (g) g.push(s);
    else groups.push([s]);
  }
  return groups;
}

/**
 * Each window that reached 100%, and how far ahead limitcast's forecast first said AT_RISK.
 * The forecast is replayed with only the readings known at each moment, exactly as `status` would have shown it.
 * @param {Sample[]} samples
 */
export function limitHits(samples) {
  const hits = [];
  for (const g of windows(samples)) {
    const hitIdx = g.findIndex((s) => s.pct >= 100);
    if (hitIdx < 0) continue;
    const at = g[hitIdx].t;
    // Earliest moment the forecast said AT_RISK, counting only warnings it kept until the hit.
    let warnedAt = null;
    for (let i = hitIdx - 1; i >= 0; i--) {
      const f = forecast(g.slice(0, i + 1), g[i].t);
      if (f?.verdict !== 'AT_RISK') break;
      warnedAt = g[i].t;
    }
    // unseen: already at 100% in its first reading, so there was nothing to forecast from.
    hits.push({ src: g[0].src, win: g[0].win, at, reset: g[0].reset * 1000, warnedAt, unseen: hitIdx === 0 });
  }
  // The same account seen from two Claude sessions reports the same window twice.
  // shortcut: two accounts with the same window and reset time would merge into one hit; rare, split by sid if it shows up.
  const seen = new Set();
  return hits
    .sort((a, b) => a.at - b.at)
    .filter((h) => {
      const k = `${h.src}|${h.win}|${Math.round(h.reset / JITTER_MS)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/**
 * What happened to the window after each guard block.
 * @param {Block[]} blocks
 * @param {Sample[]} samples
 * @param {number} now epoch ms
 */
export function blockOutcomes(blocks, samples, now) {
  return blocks.map((b) => {
    const after = samples.filter(
      (s) =>
        s.src === b.src &&
        s.win === b.win &&
        (b.sid === undefined || s.sid === b.sid) &&
        s.t >= b.t &&
        Math.abs(s.reset * 1000 - b.reset) <= JITTER_MS,
    );
    const peak = Math.max(b.pct, ...after.map((s) => s.pct));
    const hit = after.find((s) => s.pct >= 100);
    const outcome = hit ? 'hit' : b.reset > now ? 'open' : 'under';
    return { ...b, peak, hitAt: hit?.t ?? null, outcome };
  });
}

/**
 * @param {{now:number, days:number, samples:Sample[], blocks:Block[]|null, saved:string|null}} r
 *   blocks: null when the guard isn't available (no Pro license); saved: the `limitcast saved` text, if any
 */
export function resultsReport({ now, days, samples, blocks, saved }) {
  const since = now - days * 86400_000;
  const when = (/** @type {number} */ ms) =>
    new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const name = (/** @type {{src:string, win:string}} */ x) => `${NAMES[/** @type {'claude'} */ (x.src)] ?? x.src} ${x.win}`;
  const out = [`# limitcast results, last ${days} day${days === 1 ? '' : 's'}`];

  const inPeriod = samples.filter((s) => s.t >= since);
  const hits = limitHits(inPeriod);
  out.push('', '## Limits reached');
  if (!inPeriod.length) out.push('No limit readings in this period. Is the status-line recorder installed? Run `limitcast doctor`.');
  else if (!hits.length) out.push('None: no window reached 100%.');
  else {
    const watched = hits.filter((h) => !h.unseen);
    const warned = hits.filter((h) => h.warnedAt !== null);
    out.push(
      `${hits.length} window${hits.length === 1 ? '' : 's'} reached 100%. ` +
        (watched.length
          ? `Of the ${watched.length} limitcast watched on the way up, it forecast ${warned.length} in advance.`
          : 'limitcast had no readings before any of them.'),
    );
    for (const h of hits) {
      const lead = h.unseen
        ? 'already at 100% in the first reading limitcast saw'
        : h.warnedAt === null
          ? 'no advance warning'
          : `warned ${Math.round((h.at - h.warnedAt) / 60_000)} min ahead`;
      out.push(`- ${name(h)}: hit ${when(h.at)}, ${lead}`);
    }
  }

  out.push('', '## Subagent guard');
  if (blocks === null) out.push('Not active (Pro). It blocks new subagents when a window is on pace to run out before it resets.');
  else {
    const outcomes = blockOutcomes(
      blocks.filter((b) => b.t >= since),
      samples,
      now,
    );
    if (!outcomes.length) out.push('No subagents blocked in this period.');
    else {
      const n = (/** @type {string} */ o) => outcomes.filter((x) => x.outcome === o).length;
      out.push(
        `${outcomes.length} subagent spawn${outcomes.length === 1 ? '' : 's'} blocked. Afterwards: ${n('hit')} window(s) reached 100% anyway (the forecast was right), ` +
          `${n('under')} reset without reaching 100% (the block may have saved them, or the forecast ran high), ${n('open')} still open.`,
      );
      for (const o of outcomes) {
        const what =
          o.outcome === 'hit'
            ? `reached 100% at ${when(/** @type {number} */ (o.hitAt))}`
            : o.outcome === 'under'
              ? `reset at ${o.peak}%`
              : `now at ${o.peak}%, resets ${when(o.reset)}`;
        out.push(`- ${when(o.t)}: ${name(o)} at ${o.pct}%, forecast out in ~${Math.max(0, Math.round((o.wall - o.t) / 60_000))} min; ${what}`);
      }
    }
  }

  out.push('', '## Starting context');
  out.push(saved ?? 'Run `limitcast trim` once to record your starting context, then check back here.');
  if (days > 8) out.push('', 'Limit readings are kept for 8 days, so the first two sections cover at most the last 8 days.');
  return out.join('\n');
}
