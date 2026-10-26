// @ts-check
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAccounts, forecast } from './forecast.mjs';
import { stateDir } from './store.mjs';

/** @typedef {import('./forecast.mjs').Sample} Sample */
/** @typedef {{t:number, src:string, win:string, pct:number, wall:number, reset:number, sid?:string, shadow?:boolean, kind?:string, from?:string, tokens?:number}} Block  t, wall, reset: epoch ms; shadow: a free install's preview, not acted on; kind "switch": a subagent moved to Sonnet instead of blocked, "budget": a subagent held over the budget, "cold": a message held after the prompt cache expired (pct: its cost, tokens: context re-sent); no kind: a forecast block */

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
 * The readings that belong together: each Claude account, then everything else (Codex), as `status` sees them.
 * @param {Sample[]} samples
 */
function pools(samples) {
  const accounts = claudeAccounts(samples);
  const rest = samples.filter((s) => s.src !== 'claude' || (!accounts.length && !s.sid));
  return [...accounts, rest];
}

/**
 * Samples of one limit window (same pool, tool, window and reset time).
 * @param {Sample[]} samples
 */
function windows(samples) {
  /** @type {Sample[][]} */
  const groups = [];
  for (const pool of pools(samples)) {
    /** @type {Sample[][]} */
    const local = [];
    for (const s of [...pool].sort((a, b) => a.t - b.t)) {
      const g = local.find(([f]) => f.src === s.src && f.win === s.win && Math.abs(f.reset - s.reset) * 1000 <= JITTER_MS);
      if (g) g.push(s);
      else local.push([s]);
    }
    groups.push(...local);
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
    // Earliest moment the forecast warned (AT_RISK or NEAR), counting only warnings it kept until the hit.
    let warnedAt = null;
    for (let i = hitIdx - 1; i >= 0; i--) {
      const f = forecast(g.slice(0, i + 1), g[i].t);
      if (f?.verdict !== 'AT_RISK' && f?.verdict !== 'NEAR') break;
      warnedAt = g[i].t;
    }
    // unseen: already at 100% in its first reading, so there was nothing to forecast from.
    hits.push({ src: g[0].src, win: g[0].win, at, reset: g[0].reset * 1000, warnedAt, unseen: hitIdx === 0 });
  }
  return hits.sort((a, b) => a.at - b.at);
}

/**
 * What happened to the window after each guard block.
 * @param {Block[]} blocks
 * @param {Sample[]} samples
 * @param {number} now epoch ms
 */
export function blockOutcomes(blocks, samples, now) {
  const accounts = claudeAccounts(samples);
  return blocks.map((b) => {
    // A Claude block is judged by the readings of the account its session belongs to.
    const pool = b.src === 'claude' && b.sid ? (accounts.find((a) => a.some((s) => s.sid === b.sid)) ?? []) : samples;
    const after = pool.filter((s) => s.src === b.src && s.win === b.win && s.t >= b.t && Math.abs(s.reset * 1000 - b.reset) <= JITTER_MS);
    const peak = Math.max(b.pct, ...after.map((s) => s.pct));
    const hit = after.find((s) => s.pct >= 100);
    const outcome = hit ? 'hit' : b.reset > now ? 'open' : 'under';
    return { ...b, peak, hitAt: hit?.t ?? null, outcome };
  });
}

/**
 * The numbers behind `results`, its --share summary and the weekly line.
 * Pro sees the blocks the guard made; free sees the preview: what Pro would have blocked (shadow blocks).
 * @param {{now:number, days:number, samples:Sample[], blocks:Block[], pro:boolean}} r
 */
export function resultsStats({ now, days, samples, blocks, pro }) {
  const since = now - days * 86400_000;
  const readings = samples.filter((s) => s.t >= since).length;
  const hits = limitHits(samples.filter((s) => s.t >= since));
  const watched = hits.filter((h) => !h.unseen);
  const leads = hits.flatMap((h) => (h.warnedAt === null ? [] : [Math.round((h.at - h.warnedAt) / 60_000)]));
  const mine = blocks.filter((b) => b.t >= since && Boolean(b.shadow) === !pro);
  const outcomes = blockOutcomes(
    mine.filter((b) => !b.kind),
    samples,
    now,
  );
  const switches = mine.filter((b) => b.kind === 'switch').length;
  const colds = mine.filter((b) => b.kind === 'cold');
  const budgets = mine.filter((b) => b.kind === 'budget').length;
  return {
    readings,
    hits,
    watched: watched.length,
    leads,
    outcomes,
    switches,
    colds: colds.length,
    coldPct: colds.reduce((a, b) => a + b.pct, 0),
    budgets,
  };
}

/**
 * Totals only, no project, file or session names: safe to post.
 * @param {ReturnType<typeof resultsStats>} st
 * @param {{days:number, pro:boolean, savedPerSession:number|null, notResent?:number}} o
 *   notResent: tokens not re-sent since install (the value record)
 */
export function resultsShare(st, { days, pro, savedPerSession, notResent = 0 }) {
  const parts = [`limitcast, last ${days} days:`, `${st.hits.length} usage limit${st.hits.length === 1 ? '' : 's'} reached`];
  if (st.watched)
    parts.push(`forecast ${st.leads.length} of the ${st.watched} it watched in advance${st.leads.length ? ` (avg ${avg(st.leads)} min ahead)` : ''}`);
  if (st.outcomes.length)
    parts.push(`${pro ? 'blocked' : 'would have blocked'} ${st.outcomes.length} runaway subagent${st.outcomes.length === 1 ? '' : 's'}`);
  if (st.switches) parts.push(`${pro ? 'moved' : 'would have moved'} ${st.switches} subagent${st.switches === 1 ? '' : 's'} to Sonnet`);
  if (savedPerSession && savedPerSession > 0) parts.push(`starting context ${fmtK(savedPerSession)} tokens smaller per session`);
  if (notResent > 0) parts.push(`${fmtK(notResent)} tokens not re-sent since install`);
  return `${parts[0]} ${parts.slice(1).join('; ')}. https://limitcast.dev`;
}

/**
 * One line for the weekly SessionStart summary (shown to the user, never the model).
 * @param {ReturnType<typeof resultsStats>} st
 * @param {number|null} savedPerSession
 * @param {number} [notResent] tokens not re-sent this week
 */
export function weeklyLine(st, savedPerSession, notResent = 0) {
  const parts = [`${st.hits.length} limit${st.hits.length === 1 ? '' : 's'} reached`];
  if (st.leads.length) parts.push(`warned ahead on ${st.leads.length} (avg ${avg(st.leads)} min)`);
  parts.push(`guard blocked ${st.outcomes.length} subagent${st.outcomes.length === 1 ? '' : 's'}`);
  if (st.switches) parts.push(`moved ${st.switches} to Sonnet`);
  if (st.budgets) parts.push(`held ${st.budgets} over budget`);
  if (st.colds) parts.push(`caught ${st.colds} cold-cache message${st.colds === 1 ? '' : 's'}`);
  if (savedPerSession && savedPerSession > 0) parts.push(`starting context ${fmtK(savedPerSession)} tokens smaller`);
  if (notResent > 0) parts.push(`${fmtK(notResent)} tokens not re-sent`);
  return `limitcast this week: ${parts.join(', ')}. Details: limitcast results`;
}

/**
 * True once every 7 days. The first call only starts the clock, so the first summary covers a full week.
 * @param {number} now epoch ms
 */
export function weeklyDue(now) {
  const mark = join(stateDir(), 'weekly.at');
  let last = null;
  try {
    last = Number(readFileSync(mark, 'utf8'));
  } catch {
    /* never shown */
  }
  if (last !== null && now - last < 7 * 86400_000) return false;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(mark, String(now));
  return last !== null;
}

const pctText = (/** @type {number} */ x) => `${x < 1 ? x.toFixed(2) : x.toFixed(1)}%`;
const avg = (/** @type {number[]} */ xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
const fmtK = (/** @type {number} */ n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/**
 * @param {{now:number, days:number, samples:Sample[], blocks:Block[], pro:boolean, saved:string|null, value?:string, subagents?:import('./subagents.mjs').SubagentEntry[]}} r
 *   blocks: every logged block (Pro blocks and free previews); saved: the starting-context text, if any;
 *   value: the "since you installed" section, shown first; subagents: the finished-subagent ledger
 */
export function resultsReport({ now, days, samples, blocks, pro, saved, value = '', subagents = [] }) {
  const when = (/** @type {number} */ ms) =>
    new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const name = (/** @type {{src:string, win:string}} */ x) => `${NAMES[/** @type {'claude'} */ (x.src)] ?? x.src} ${x.win}`;
  const out = value
    ? ['# limitcast results', '', value, '', `# Last ${days} day${days === 1 ? '' : 's'} in detail`]
    : [`# limitcast results, last ${days} day${days === 1 ? '' : 's'}`];

  const st = resultsStats({ now, days, samples, blocks, pro });
  const { hits } = st;
  out.push('', '## Limits reached');
  if (!st.readings) out.push('No limit readings in this period. Is the status-line recorder installed? Run `limitcast doctor`.');
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

  out.push('', pro ? '## Subagent guard' : '## Subagent guard (preview)');
  const { outcomes } = st;
  if (!outcomes.length)
    out.push(
      pro
        ? 'No subagents blocked in this period.'
        : 'Nothing Pro would have blocked in this period. (`limitcast install --guard` records it; without Pro the guard never blocks.)',
    );
  else {
    const n = (/** @type {string} */ o) => outcomes.filter((x) => x.outcome === o).length;
    const count = `${outcomes.length} subagent spawn${outcomes.length === 1 ? '' : 's'}`;
    out.push(
      `${pro ? `${count} blocked` : `Pro would have blocked ${count} (your free install let them run)`}. Afterwards: ${n('hit')} window(s) reached 100% (the forecast was right), ` +
        `${n('under')} reset without reaching 100% (${pro ? 'the block may have saved them, or' : 'here'} the forecast ran high), ${n('open')} still open.`,
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
  if (st.switches)
    out.push(
      `${pro ? 'Ran' : 'Pro would have run'} ${st.switches} subagent${st.switches === 1 ? '' : 's'} on Sonnet instead of your main model while a window was tight.`,
    );
  if (st.budgets) out.push(`Held ${st.budgets} subagent${st.budgets === 1 ? '' : 's'} once subagents had used their budget of the 5-hour window.`);

  const recent = subagents.filter((e) => e.t >= now - days * 86400_000);
  if (recent.length || st.colds) {
    out.push('', '## Subagents and cold caches');
    const priced = recent.filter((e) => e.pct !== undefined).map((e) => /** @type {number} */ (e.pct));
    if (recent.length)
      out.push(
        `${recent.length} subagent${recent.length === 1 ? '' : 's'} finished` +
          (priced.length
            ? `, ≈${pctText(priced.reduce((a, b) => a + b, 0))} of a 5-hour window in all; the biggest ≈${pctText(Math.max(...priced))}.${pro ? '' : " Pro shows each one's cost when it finishes and can cap them per window."}`
            : '.'),
      );
    if (st.colds)
      out.push(
        `${pro ? 'Held' : 'Pro would have held'} ${st.colds} message${st.colds === 1 ? '' : 's'} sent after the prompt cache had expired` +
          (st.coldPct ? `, each re-sending the whole context (≈${pctText(st.coldPct)} of a 5-hour window in all).` : '.'),
      );
  }

  out.push('', '## Starting context');
  out.push(saved ?? 'Run `limitcast trim` once to record your starting context, then check back here.');
  if (!pro && outcomes.length) out.push('', `Pro blocks those subagents before they use up your window: https://limitcast.dev/#pricing`);
  if (days > 8) out.push('', 'Limit readings are kept for 8 days, so the first two sections cover at most the last 8 days.');
  return out.join('\n');
}
