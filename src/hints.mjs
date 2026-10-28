// @ts-check
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { claudeAccounts, forecastAll } from './forecast.mjs';

// Status-line hints: another account with room, and when a long session is worth compacting.

/** @typedef {import('./forecast.mjs').Sample} Sample */

const TROUBLE = new Set(['NEAR', 'AT_RISK', 'HIT']);

/**
 * Every Claude account limitcast has current readings for, with its forecasts. An account whose windows have
 * all reset since it was last seen is left out: its usage now is unknown, not zero.
 * @param {Sample[]} samples
 * @param {number} now
 */
export function accountForecasts(samples, now) {
  return claudeAccounts(samples)
    .map((acct) => ({
      sids: new Set(acct.map((s) => s.sid)),
      lastSeen: Math.max(...acct.map((s) => s.t)),
      rows: forecastAll(acct, now),
    }))
    .filter((a) => a.rows.some((f) => f.verdict !== 'RESET'));
}

/**
 * When the current account is near or at a limit, the other account with the most room, e.g. "⇄ other account 5h 12% · 7d 30%".
 * @param {Sample[]} samples
 * @param {string|undefined} sid current session
 * @param {number} now
 */
export function headroom(samples, sid, now) {
  const accounts = accountForecasts(samples, now);
  if (accounts.length < 2) return null;
  const current = accounts.find((a) => sid && a.sids.has(sid)) ?? accounts[0];
  if (!current.rows.some((f) => TROUBLE.has(f.verdict))) return null;
  const used = (/** @type {typeof accounts[0]} */ a) => Math.max(...a.rows.map((f) => (f.verdict === 'RESET' ? 0 : f.pct)));
  const best = accounts
    .filter((a) => a !== current && !a.rows.some((f) => TROUBLE.has(f.verdict) || f.verdict === 'STALE'))
    .sort((a, b) => used(a) - used(b))[0];
  if (!best) return null;
  const parts = best.rows.map((f) => `${f.win} ${f.verdict === 'RESET' ? 0 : Math.round(f.pct)}%`);
  return `⇄ other account ${parts.join(' · ')}`;
}

const NAMES = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };

/**
 * One sentence naming the window that runs out first at the current pace, and where else there is room:
 * "You'll hit Claude 7d first (Thu 14:00). Grok 5h still has $38." Null when no window is on pace to run out.
 * @param {ReturnType<typeof forecastAll>} rows
 * @param {{'5h'?:number, '7d'?:number}|null} grokCap the Grok dollar caps; a Grok row holds a % of its cap
 * @param {(ms:number)=>string} clock
 */
export function bindingLine(rows, grokCap, clock) {
  const first = rows.filter((f) => f.verdict === 'AT_RISK' && f.wall !== null).sort((a, b) => (a.wall ?? 0) - (b.wall ?? 0))[0];
  if (!first) return null;
  const name = (/** @type {{src:string, win:string}} */ f) => `${NAMES[/** @type {'claude'} */ (f.src)] ?? f.src} ${f.win}`;
  // Room: the least-used window of another tool that is not itself in trouble.
  const room = rows.filter((f) => f.src !== first.src && f.verdict === 'OK').sort((a, b) => a.pct - b.pct)[0];
  const cap = room?.src === 'grok' ? grokCap?.[/** @type {'5h'} */ (room.win)] : undefined;
  const left = !room
    ? ''
    : cap
      ? ` ${name(room)} still has $${Math.round((cap * (100 - room.pct)) / 100)}.`
      : ` ${name(room)} has ${Math.round(100 - room.pct)}% left.`;
  return `You'll hit ${name(first)} first (${clock(first.wall ?? first.reset)}).${left}`;
}

const COMPACT_AT = 150_000; // tokens re-sent per model call worth a /compact

/**
 * Tokens the latest main-thread model call of a session sent (input + cache), from the transcript's tail.
 * @param {string} path
 */
export const lastCallTokens = (path) => lastCall(path)?.tokens ?? null;

/**
 * The latest main-thread model call of a session: tokens it sent (input + cache) and when (epoch ms; 0 if unknown).
 * Reads at most the last 256 KB, so it stays cheap on multi-megabyte transcripts.
 * @param {string} path
 * @returns {{tokens:number, t:number}|null}
 */
export function lastCall(path) {
  const size = statSync(path).size;
  const len = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  readSync(fd, buf, 0, len, size - len);
  closeSync(fd);
  const lines = buf.toString('utf8').split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"usage"') || line.includes('"isSidechain":true')) continue;
    try {
      const e = JSON.parse(line);
      const u = e?.message?.usage;
      if (u)
        return {
          tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          t: Date.parse(e.timestamp) || 0,
        };
    } catch {
      /* a torn first line of the tail */
    }
  }
  return null;
}

/**
 * "ctx 162k · /compact" when a session re-sends more than ~150k tokens on every call.
 * @param {number|null} tokens per call
 */
export function compactHint(tokens) {
  if (!tokens || tokens < COMPACT_AT) return null;
  return `ctx ${Math.round(tokens / 1000)}k · /compact`;
}
