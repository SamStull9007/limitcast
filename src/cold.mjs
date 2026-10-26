// @ts-check
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './store.mjs';

// Cold-cache warning (Pro, UserPromptSubmit hook). After a long pause the prompt cache has expired, so the next
// message re-sends the whole context as new tokens, which count against the limit far more than cached ones.
// The first message after such a pause is held once with its cost; sending it again goes through.

const MIN_TOKENS = 100_000;
const stateFile = () => join(stateDir(), 'cold.json');

/**
 * What the next message will cost because the cache went cold, or null when it isn't worth a warning.
 * @param {unknown} prompt
 * @param {{tokens:number, t:number}|null} last the session's latest model call
 * @param {number} now epoch ms
 * @param {{minutes:number, calib?:{fresh:number, read:number}|null}} o minutes: the cache lifetime
 * @returns {{tokens:number, idle:number, pct:number|null, warm:number|null}|null} pct/warm: % of the 5h window cold/warm
 */
export function coldCost(prompt, last, now, { minutes, calib }) {
  if (!last?.t || last.tokens < MIN_TOKENS) return null;
  const p = String(prompt ?? '').trimStart();
  // Background agents and other sessions report back as prompts; /compact and /clear are what the warning suggests.
  if (p.startsWith('<') || /^\/(compact|clear)\b/.test(p)) return null;
  const idle = Math.round((now - last.t) / 60_000);
  if (idle < minutes) return null;
  const m = last.tokens / 1e6;
  return { tokens: last.tokens, idle, pct: calib ? m * calib.fresh : null, warm: calib ? m * calib.read : null };
}

/** @param {NonNullable<ReturnType<typeof coldCost>>} c */
export function coldMessage(c) {
  const idle = c.idle >= 120 ? `${Math.round(c.idle / 60)} hours` : `${c.idle} minutes`;
  const cost =
    c.pct !== null && c.warm !== null
      ? `≈${pct(c.pct)} of your 5-hour window (≈${pct(c.warm)} if the cache were still warm)`
      : 'all at the new-token rate instead of the much cheaper cached one';
  return (
    `limitcast: this session sat idle for ${idle}, so its prompt cache has expired. Your message re-sends ${Math.round(c.tokens / 1000)}k tokens of context: ${cost}. ` +
    'Send it again to go ahead, or run /compact first to shrink it.'
  );
}

const pct = (/** @type {number} */ x) => `${x < 1 ? x.toFixed(2) : x.toFixed(1)}%`;

/**
 * True the first time a session is warned about this pause, false when the user re-sends.
 * A held message never reaches the model, so the latest call stays the same until it goes through.
 * @param {string} sid
 * @param {number} lastT the latest model call's time
 */
export function firstWarning(sid, lastT) {
  /** @type {Record<string, number>} */
  let seen = {};
  try {
    seen = JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    /* first warning */
  }
  if (seen[sid] === lastT) return false;
  const keep = Object.entries(seen).slice(-49); // the 49 most recent other sessions
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(Object.fromEntries([...keep.filter(([k]) => k !== sid), [sid, lastT]])));
  return true;
}
