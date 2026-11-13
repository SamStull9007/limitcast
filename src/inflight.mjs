// @ts-check
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSource } from './guard.mjs';
import { stateDir } from './store.mjs';

// A second spawn of the same type and prompt, in the same session, while the first has not finished.
// SubagentStop clears it on all three hosts (Claude Code, Codex and Grok each send one). A record older than
// 30 minutes is forgotten anyway: a missed stop must not hold the same prompt for the rest of the day.

export const INFLIGHT_MS = 30 * 60_000;

/** @typedef {{sid:string, type:string, hash:string, t:number}} Inflight */

/**
 * Identity of a spawn the duplicate hold can see, or null when the call is not one.
 * An empty prompt or type is not tracked: those retries are how a host re-sends, and they are not the same request.
 * @param {any} hook
 */
export function spawnIdentity(hook) {
  const tool = String(hook?.tool_name ?? hook?.toolName ?? hook?.tool ?? '');
  const src = spawnSource(tool);
  if (!src) return null;
  const input = hook?.tool_input ?? hook?.toolInput ?? {};
  // Grok re-runs a finished subagent with resume_from: the same prompt again is a continuation, not a duplicate.
  if (input?.resume_from || input?.resumeFrom) return null;
  const type = String(input?.subagent_type ?? input?.subagentType ?? input?.agent_type ?? '').trim();
  // Claude and Grok send `prompt`; Codex spawn_agent sends `message` (or `items`, a list of text parts).
  const items = Array.isArray(input?.items) ? input.items.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join(' ') : '';
  const prompt = String(input?.prompt || input?.message || input?.description || input?.task || items || '')
    .replace(/\s+/g, ' ')
    .trim();
  const sid = String(hook?.session_id ?? hook?.sessionId ?? '').trim();
  if (!type || !prompt || !sid) return null;
  const hash = createHash('sha256').update(`${type.toLowerCase()}\0${prompt}`).digest('hex').slice(0, 16);
  return { src, type, prompt, hash, sid };
}

/** @param {Inflight[]} entries @param {number} now @param {number} [maxAge] */
export function pruneInflight(entries, now, maxAge = INFLIGHT_MS) {
  return entries.filter((e) => now - e.t >= 0 && now - e.t < maxAge);
}

/**
 * The still-running spawn with this session, type and prompt, if any.
 * @param {Inflight[]} entries already pruned
 * @param {{sid:string, type:string, hash:string}} id
 */
export function findDuplicate(entries, id) {
  return entries.find((e) => e.sid === id.sid && e.hash === id.hash) ?? null;
}

/**
 * @param {Inflight[]} entries already pruned
 * @param {{sid:string, type:string, hash:string}} id
 * @param {number} now
 */
export function rememberInflight(entries, id, now) {
  return [...entries, { sid: id.sid, type: id.type, hash: id.hash, t: now }];
}

/**
 * Drop the oldest still-running spawn of this type in this session (SubagentStop does not carry the prompt).
 * Clearing the oldest fails open: the spawn that is still running may be a different prompt, and that one is then allowed again.
 * @param {Inflight[]} entries
 * @param {string} sid
 * @param {string} type
 * @param {number} now
 */
export function forgetInflight(entries, sid, type, now) {
  const live = pruneInflight(entries, now);
  if (!sid || !type) return live;
  const same = (/** @type {Inflight} */ e) => e.type.toLowerCase() === type.toLowerCase();
  // Some hosts report the subagent's own session on its stop event. Match the parent session first, else the type alone:
  // clearing the wrong record only lets a duplicate through, which is the safe way to be wrong.
  let i = live.findIndex((e) => e.sid === sid && same(e));
  if (i < 0) i = live.findIndex(same);
  if (i >= 0) live.splice(i, 1);
  return live;
}

/** @param {{type:string}} id */
export function duplicateReason(id) {
  return (
    `limitcast: a ${id.type} subagent with this same prompt is already running in this session. ` +
    'Wait for it to finish, or set LIMITCAST_ALLOW=1 to spawn another.'
  );
}

const file = () => join(stateDir(), 'inflight.json');

/** @returns {Inflight[]} */
export function loadInflight() {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @param {Inflight[]} entries */
export function saveInflight(entries) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(entries.slice(-100)));
}
