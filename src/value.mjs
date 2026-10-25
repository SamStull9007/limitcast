// @ts-check
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { blockOutcomes, limitHits } from './results.mjs';
import { startupBreakdown } from './startup.mjs';
import { stateDir } from './store.mjs';
import { claudeUsage } from './usage.mjs';

// The value record: what limitcast did for you since you installed it, kept beyond the 8 days of raw readings.
// `results` shows it; a daily background rollup (started by the status line) keeps it current.

/** @typedef {import('./forecast.mjs').Sample} Sample */
/** @typedef {import('./results.mjs').Block} Block */
/** @typedef {{at:number, turns:number, savedPerTurn:number}} SessionValue  savedPerTurn: tokens below the first measured start */
/** @typedef {{src:string, win:string, at:number, lead:number|null, unseen:boolean}} HitValue  lead: minutes of warning */
/** @typedef {{t:number, src:string, win:string, shadow:boolean, outcome:string}} BlockValue */
/** @typedef {{since:number, scanned:number, sessions:Record<string, SessionValue>, hits:Record<string, HitValue>, blocks:Record<string, BlockValue>, switches?:Record<string, {shadow:boolean}>}} Value */

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
    blocks.filter((x) => x.kind !== 'switch'),
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
  let turns = 0;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const u = claudeUsage(line, seen, '');
    if (u && !u.sidechain) turns++;
  }
  return { at: b.at, turns, savedPerTurn: Math.max(0, tok(baselineChars - chars)) };
}

/**
 * Add sessions whose transcripts changed since the last scan (a session still running is re-read next time).
 * @param {Value} v
 * @param {{root:string, baseline:{at:number, chars:number}|null, now:number}} r
 */
export async function scanSessions(v, { root, baseline, now }) {
  if (!baseline) return v;
  try {
    for (const proj of readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      for (const f of readdirSync(join(root, proj.name), { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const p = join(root, proj.name, f.name);
        const st = statSync(p);
        if (st.mtimeMs < Math.max(baseline.at, v.scanned) || (st.birthtimeMs || st.mtimeMs) < baseline.at - 86400_000) continue;
        const s = await sessionValue(p, baseline.chars);
        if (s && s.at >= baseline.at) v.sessions[f.name.replace(/\.jsonl$/, '')] = s;
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
  };
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
  if (t.tokens > 0) {
    out.push(
      `- **${fmtBig(t.tokens)} tokens not re-sent.** Your sessions now start smaller than the first one limitcast measured, and Claude Code re-sends the starting context on every model call: ${t.turns.toLocaleString()} calls across ${t.sessions} sessions. (Most of it would have been cached input.)`,
    );
  } else if (t.sessions) {
    out.push(`- Starting context: no smaller than when limitcast first measured it. \`limitcast trim\` shows what to cut.`);
  }
  if (t.hits) {
    const avg = t.leads.length ? `, on average ${fmtMin(t.leads.reduce((a, b) => a + b, 0) / t.leads.length)} ahead` : '';
    out.push(
      `- **Warned you before ${t.leads.length} of the ${t.watched} limits it watched you approach**${avg}. (${t.hits} limits reached in all.)`,
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
