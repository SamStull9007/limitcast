// @ts-check
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { limitChangeMessage, windowPct } from './calibrate.mjs';
import { blockOutcomes, limitHits } from './results.mjs';
import { startupBreakdown } from './startup.mjs';
import { stateDir } from './store.mjs';
import { claudeUsage } from './usage.mjs';

// The value record: what limitcast did for you since you installed it, kept beyond the 8 days of raw readings.
// `results` shows it; a daily background rollup (started by the status line) keeps it current.

/** @typedef {import('./forecast.mjs').Sample} Sample */
/** @typedef {import('./results.mjs').Block} Block */
/** @typedef {{at:number, turns:number, savedPerTurn:number, calls?:number[]}} SessionValue  calls: main-thread timestamps; absent in legacy records */
/** @typedef {{src:string, win:string, at:number, lead:number|null, unseen:boolean}} HitValue  lead: minutes of warning */
/** @typedef {{t:number, src:string, win:string, shadow:boolean, outcome:string}} BlockValue */
/** @typedef {{since:number, contextSince?:number, scanned:number, sessions:Record<string, SessionValue>, hits:Record<string, HitValue>, blocks:Record<string, BlockValue>, switches?:Record<string, {shadow:boolean}>, calib?:{fresh:number, read:number, n:number, at:number}, calibHistory?:{fresh:number, read:number, n:number, at:number}[], limitChange?:{from:number, to:number, at:number}}} Value
 *   calibHistory: one calibration of the last 3 days per day, to notice limit changes */

const file = () => join(stateDir(), 'value.json');
const tok = (/** @type {number} */ chars) => Math.round(chars / 4);

/** @returns {Value} */
export function loadValue() {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return { since: 0, scanned: 0, sessions: {}, hits: {}, blocks: {} };
  }
}

/**
 * True at most once a day (the status line uses it to start the rollup in the background).
 * @param {number} now epoch ms
 */
export function dailyDue(now) {
  const mark = join(stateDir(), 'value.at');
  try {
    if (now - Number(readFileSync(mark, 'utf8')) < 86400_000) return false;
  } catch {
    /* never rolled up */
  }
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(mark, String(now));
  return true;
}

/** @param {Value} v */
export function saveValue(v) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(v));
}

/**
 * Fold what the recent readings show into the record. Recent entries overwrite older ones: a block's
 * outcome is "open" until its window resets, and a hit's warning only gets more complete.
 * @param {Value} v
 * @param {{now:number, samples:Sample[], blocks:Block[], start?:number}} r
 *   start: when limitcast started watching (the first status-line reading); defaults to the earliest sample
 */
export function foldEvents(v, { now, samples, blocks, start }) {
  v.since ||= start ?? Math.min(now, ...samples.map((s) => s.t));
  // As readings age out (8 days), a later look sees less: keep what was recorded while they all existed.
  // Limits before limitcast was watching (Codex logs reach back further) are replays, not warnings you got.
  for (const h of limitHits(samples).filter((x) => x.at >= v.since)) {
    const key = `${h.src}|${h.win}|${Math.round(h.reset / 120_000)}`;
    const prev = v.hits[key];
    const lead = h.warnedAt === null ? null : Math.round((h.at - h.warnedAt) / 60_000);
    v.hits[key] = {
      src: h.src,
      win: h.win,
      at: prev?.at ?? h.at,
      lead: prev && prev.lead !== null && (lead === null || prev.lead > lead) ? prev.lead : lead,
      unseen: prev ? prev.unseen && h.unseen : h.unseen,
    };
  }
  v.switches ??= {};
  for (const b of blocks.filter((x) => x.kind === 'switch')) v.switches[String(b.t)] = { shadow: Boolean(b.shadow) };
  for (const o of blockOutcomes(
    blocks.filter((x) => !x.kind),
    samples,
    now,
  )) {
    const prev = v.blocks[String(o.t)];
    if (prev && prev.outcome !== 'open') continue; // final once the window reset
    v.blocks[String(o.t)] = { t: o.t, src: o.src, win: o.win, shadow: Boolean(o.shadow), outcome: o.outcome };
  }
  return v;
}

/**
 * One interactive session's value: how many model calls it made on the main thread (each re-sends the whole
 * starting context) and how much smaller its starting context was than the first one limitcast measured.
 * @param {string} path transcript
 * @param {number} baselineChars
 * @returns {Promise<SessionValue|null>}
 */
export async function sessionValue(path, baselineChars) {
  const b = await startupBreakdown(path);
  if (b.entry !== 'cli' || !b.pieces.length) return null;
  const chars = b.pieces.reduce((a, p) => a + p.chars, 0);
  const seen = new Set();
  const calls = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const u = claudeUsage(line, seen, '');
    if (u && !u.sidechain) calls.push(u.t);
  }
  return { at: b.at, turns: calls.length, savedPerTurn: Math.max(0, tok(baselineChars - chars)), calls };
}

/**
 * Add sessions whose transcripts changed since the last scan (a session still running is re-read next time).
 * @param {Value} v
 * @param {{root:string, baseline:{at:number, chars:number}|null, now:number}} r
 */
export async function scanSessions(v, { root, baseline, now }) {
  if (!baseline) return v;
  v.contextSince ??= baseline.at;
  try {
    for (const proj of readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      for (const f of readdirSync(join(root, proj.name), { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const p = join(root, proj.name, f.name);
        const st = statSync(p);
        const id = f.name.replace(/\.jsonl$/, '');
        const legacy = v.sessions[id] && !Array.isArray(v.sessions[id].calls);
        if ((!legacy && st.mtimeMs < Math.max(baseline.at, v.scanned)) || (st.birthtimeMs || st.mtimeMs) < baseline.at - 86400_000) continue;
        const s = await sessionValue(p, baseline.chars);
        if (s && s.at >= baseline.at) v.sessions[id] = s;
      }
    }
  } catch {
    /* unreadable root: keep what we have */
  }
  v.scanned = now;
  return v;
}

/** @param {Value} v */
export function valueTotals(v) {
  const sessions = Object.values(v.sessions);
  const hits = Object.values(v.hits);
  const leads = hits.flatMap((h) => (h.lead === null ? [] : [h.lead]));
  const blocks = Object.values(v.blocks);
  return {
    since: v.since,
    sessions: sessions.length,
    turns: sessions.reduce((a, s) => a + s.turns, 0),
    tokens: sessions.reduce((a, s) => a + s.turns * s.savedPerTurn, 0),
    hits: hits.length,
    watched: hits.filter((h) => !h.unseen).length,
    leads,
    blocked: blocks.filter((b) => !b.shadow).length,
    previewed: blocks.filter((b) => b.shadow).length,
    confirmed: blocks.filter((b) => b.outcome === 'hit').length,
    switched: Object.values(v.switches ?? {}).filter((s) => !s.shadow).length,
    switchPreviewed: Object.values(v.switches ?? {}).filter((s) => s.shadow).length,
    calib: v.calib ?? null,
    limitChange: v.limitChange ?? null,
    // Against the 5-hour limit: each session wrote its smaller start once and re-read it on every call.
    windowPct: v.calib
      ? windowPct(v.calib, {
          writes: sessions.reduce((a, s) => a + s.savedPerTurn, 0),
          reads: sessions.reduce((a, s) => a + s.turns * s.savedPerTurn, 0),
        })
      : null,
  };
}

/** Activity in an exact half-open period; never assign an entire session to its start week.
 * @param {Value} v
 * @param {number} since
 * @param {number} until
 */
export function valuePeriod(v, since, until) {
  let calls = 0;
  let tokens = 0;
  let sessions = 0;
  let legacy = 0;
  for (const s of Object.values(v.sessions)) {
    if (!Array.isArray(s.calls)) {
      if (s.at < until) legacy++;
      continue;
    }
    const n = s.calls.filter((t) => t >= since && t < until).length;
    if (n) sessions++;
    calls += n;
    tokens += n * s.savedPerTurn;
  }
  return { calls, tokens, sessions, legacy };
}

/**
 * The "since you installed" section at the top of `limitcast results`.
 * @param {ReturnType<typeof valueTotals>} t
 * @param {{now:number, pro:boolean}} o
 */
export function valueSection(t, { now, pro }) {
  if (!t.since) return '';
  const days = Math.max(1, Math.round((now - t.since) / 86400_000));
  const out = [`## Since limitcast started watching (${new Date(t.since).toLocaleDateString()}, ${days} day${days === 1 ? '' : 's'})`];
  if (pro && t.tokens > 0) {
    out.push(
      `- **Estimated ${fmtBig(t.tokens)} context tokens not re-sent.** Compared with your first recorded Claude Code starting context: ${t.turns.toLocaleString()} calls across ${t.sessions} sessions. Estimated from characters / 4; most would have been cached input. Project or manual configuration changes can also change this baseline; this is not a causal savings measurement.`,
    );
    if (t.windowPct !== null && t.calib)
      out.push(
        `  Against your limit: **≈ ${t.windowPct < 1 ? t.windowPct.toFixed(2) : t.windowPct.toFixed(1)}% of a 5-hour window.** From your own readings, 1% of it is about ${fmtBig(Math.round(1e6 / t.calib.fresh))} new tokens or ${fmtBig(Math.round(1e6 / t.calib.read))} cached ones, so cached context is cheap and new tokens (long sessions, subagents) are what run you out.`,
      );
  } else if (pro && t.sessions) {
    out.push(`- Starting context: no smaller than when limitcast first measured it. \`limitcast trim\` shows what to cut.`);
  }
  if (t.hits) {
    const avg = t.leads.length ? `, on average ${fmtMin(t.leads.reduce((a, b) => a + b, 0) / t.leads.length)} ahead` : '';
    out.push(
      `- **Forecast risk before ${t.leads.length} of the ${t.watched} limits it watched you approach**${avg}. (${t.hits} limits reached in all; replayed from recorded readings, not proof a notification was delivered.)`,
    );
  } else out.push('- No limit reached yet.');
  if (pro) {
    out.push(
      t.blocked
        ? `- **Stopped ${t.blocked} subagent${t.blocked === 1 ? '' : 's'}** while a window was about to run out${t.confirmed ? ` (${t.confirmed} of those windows hit 100% anyway, so the forecast was right)` : ''}.`
        : "- The guard hasn't needed to stop a subagent yet.",
    );
  } else if (t.previewed) {
    out.push(`- **Pro would have stopped ${t.previewed} subagent${t.previewed === 1 ? '' : 's'}** while a window was about to run out.`);
  }
  if (t.limitChange && now - t.limitChange.at < 14 * 86400_000)
    out.push(`- **${limitChangeMessage(t.limitChange)}** (noticed ${new Date(t.limitChange.at).toLocaleDateString()}, from your own readings)`);
  const moved = pro ? t.switched : t.switchPreviewed;
  if (moved)
    out.push(
      `- **${pro ? 'Ran' : 'Pro would have run'} ${moved} subagent${moved === 1 ? '' : 's'} on Sonnet** instead of your main model while a window was tight.`,
    );
  return out.join('\n');
}

/** @param {number} n */
export const fmtBig = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
/** @param {number} m minutes */
const fmtMin = (m) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
