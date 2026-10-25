// @ts-check
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './store.mjs';

/** @typedef {import('./startup.mjs').Piece} Piece */
/** @typedef {{at:number, chars:number, items:Record<string, number>}} Snapshot  sizes in characters, keyed "group|name" */

const ALERT_CHARS = 4000; // ~1k tokens: smaller changes aren't worth interrupting for
const ITEM_CHARS = 2000; // ~500 tokens: smallest single item worth naming

/** @param {{pieces:Piece[], at:number}} b */
export function snapshot(b) {
  /** @type {Record<string, number>} */
  const items = {};
  for (const p of b.pieces) items[`${p.group}|${p.name}`] = (items[`${p.group}|${p.name}`] ?? 0) + p.chars;
  return { at: b.at, chars: Object.values(items).reduce((a, c) => a + c, 0), items };
}

/**
 * What grew between two snapshots: new or bigger items of at least ~500 tokens, and the total change.
 * @param {Snapshot} prev
 * @param {Snapshot} cur
 */
export function drift(prev, cur) {
  const grew = Object.entries(cur.items)
    .map(([key, chars]) => ({ key, chars, delta: chars - (prev.items[key] ?? 0), isNew: !(key in prev.items) }))
    .filter((x) => x.delta >= ITEM_CHARS)
    .sort((a, b) => b.delta - a.delta);
  return { delta: cur.chars - prev.chars, grew, alert: cur.chars - prev.chars >= ALERT_CHARS || grew.length > 0 };
}

const file = () => join(stateDir(), 'overhead.json');

/** @returns {{first:Snapshot, last:Snapshot}|null} */
export function loadOverhead() {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {{first:Snapshot, last:Snapshot}} s */
export function saveOverhead(s) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(s));
}

/**
 * Record `cur` and return what changed since the last recorded session (null the first time).
 * A snapshot of the same session as last time changes nothing.
 * @param {Snapshot} cur
 */
export function recordOverhead(cur) {
  const s = existsSync(file()) ? loadOverhead() : null;
  if (!s) {
    saveOverhead({ first: cur, last: cur });
    return null;
  }
  if (cur.at === s.last.at) return { delta: 0, grew: [], alert: false };
  const d = drift(s.last, cur);
  saveOverhead({ first: s.first, last: cur });
  return d;
}

const tok = (/** @type {number} */ chars) => Math.round(chars / 4);
const label = (/** @type {string} */ key) => key.replace('|', ': ').replace(/\/Users\/[^/]+/, '~');

/**
 * One-line alert for the user (never the model) when starting context grew.
 * @param {ReturnType<typeof drift>} d
 */
export function driftMessage(d) {
  const items = d.grew
    .slice(0, 3)
    .map((g) => `${label(g.key)} ${g.isNew ? 'new' : '+'}~${(tok(g.delta) / 1000).toFixed(1)}k`)
    .join(', ');
  return `limitcast: your Claude Code starting context grew ~${(tok(d.delta) / 1000).toFixed(1)}k tokens since your last session${items ? ` (${items})` : ''}. Run \`limitcast trim\` for details.`;
}

/**
 * "Tokens saved" since limitcast first measured you: the drop in starting context times the sessions since.
 * Conservative: counts each session's start once, though that context is re-sent every turn.
 * @param {{first:Snapshot, last:Snapshot}} s
 * @param {number} sessions interactive sessions since s.first.at
 */
export function savedSummary(s, sessions) {
  const perSession = savedPerSession(s);
  const since = new Date(s.first.at).toLocaleDateString();
  if (perSession <= 0) {
    return `Since ${since}, the part of your starting context you control (hooks, MCP servers, skills, agents, instruction files) went from ~${fmtK(tok(s.first.chars))} to ~${fmtK(tok(s.last.chars))} tokens (${perSession === 0 ? 'no change' : `+${fmtK(-perSession)}`}). Run \`limitcast trim\` to find cuts.`;
  }
  return [
    `Since ${since}, the part of your starting context you control (hooks, MCP servers, skills, agents, instruction files) dropped from ~${fmtK(tok(s.first.chars))} to ~${fmtK(tok(s.last.chars))} tokens: ${fmtK(perSession)} less per session.`,
    `Across ${sessions} interactive sessions that's ~${fmtK(perSession * sessions)} tokens not loaded, counting each session's start once (the real figure is higher: that context is re-sent every turn).`,
  ].join('\n');
}

/**
 * Tokens per session the controllable starting context dropped since limitcast first measured it (negative: it grew).
 * @param {{first:Snapshot, last:Snapshot}} s
 */
export const savedPerSession = (s) => tok(s.first.chars - s.last.chars);

/** @param {number} n */
const fmtK = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
