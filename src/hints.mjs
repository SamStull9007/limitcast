// @ts-check
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { claudeAccounts, forecastAll } from './forecast.mjs';

// Pro hints for the status line: another account with room, and when a long session is worth compacting.

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
  const best = accounts.filter((a) => a !== current && !a.rows.some((f) => TROUBLE.has(f.verdict))).sort((a, b) => used(a) - used(b))[0];
  if (!best) return null;
  const parts = best.rows.map((f) => `${f.win} ${f.verdict === 'RESET' ? 0 : Math.round(f.pct)}%`);
  return `⇄ other account ${parts.join(' · ')}`;
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
