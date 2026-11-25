// @ts-check
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSource } from './guard.mjs';
import { logBlock } from './results.mjs';
import { stateDir, withStateLock, writeAtomic } from './store.mjs';
import { getTypeCaps, loadSubagents, typeCapReason } from './subagents.mjs';

// A second spawn of the same type and prompt, in the same session, while the first has not finished.
// SubagentStop clears it on all three hosts (Claude Code, Codex and Grok each send one). A record older than
// 30 minutes is forgotten anyway: a missed stop must not hold the same prompt for the rest of the day.

export const INFLIGHT_MS = 30 * 60_000;
const ENCRYPTED = /^gAAAA[A-Za-z0-9_=-]{40,}$/; // a Fernet token, the shape Codex gave an encrypted spawn_agent message

/** @typedef {{sid:string, type:string, hash:string, t:number, src?:'claude'|'codex'|'grok'}} Inflight */
/** @typedef {{last:number, count:number, operations:string[]}} StartCount */

/**
 * Identify a new spawn for admission tracking. An empty prompt only skips duplicate detection.
 * @param {any} hook
 */
function spawnRequest(hook) {
  const tool = String(hook?.tool_name ?? hook?.toolName ?? hook?.tool ?? '');
  const src = spawnSource(tool);
  if (!src) return null;
  const input = hook?.tool_input ?? hook?.toolInput ?? {};
  // Grok re-runs a finished subagent with resume_from: the same prompt again is a continuation, not a duplicate.
  if (input?.resume_from || input?.resumeFrom) return null;
  // Codex names no type when the model leaves it out, and reports such a subagent as "default" when it stops.
  const type = String(input?.subagent_type ?? input?.subagentType ?? input?.agent_type ?? (src === 'codex' ? 'default' : '')).trim();
  // Claude and Grok send `prompt`; Codex spawn_agent sends `message` (or `items`, a list of text parts).
  const items = Array.isArray(input?.items) ? input.items.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join(' ') : '';
  let prompt = String(input?.prompt || input?.message || input?.description || input?.task || items || '')
    .replace(/\s+/g, ' ')
    .trim();
  // Codex encrypts spawn_agent arguments (a live call carried a `gAAAA…` token as its message), and the same prompt encrypts
  // differently each time, so identical prompts cannot be told apart by content. The task name the model gave it still can.
  if (src === 'codex' && (!prompt || ENCRYPTED.test(prompt)) && input?.task_name) prompt = `task ${String(input.task_name).trim()}`;
  const sid = String(hook?.session_id ?? hook?.sessionId ?? '').trim();
  if (!type || !sid) return null;
  const hash = prompt ? createHash('sha256').update(`${type.toLowerCase()}\0${prompt}`).digest('hex').slice(0, 16) : '';
  const operation = hook?.tool_use_id ?? hook?.toolUseId ?? hook?.call_id;
  return { src, type, prompt, hash, sid, operation: typeof operation === 'string' ? operation : '' };
}

/** @param {any} hook */
export function spawnIdentity(hook) {
  const request = spawnRequest(hook);
  return request?.hash ? request : null;
}

/** @param {Inflight[]} entries @param {number} now @param {number} [maxAge] */
export function pruneInflight(entries, now, maxAge = INFLIGHT_MS) {
  return entries.filter((e) => now - e.t >= 0 && now - e.t < maxAge);
}

/**
 * The still-running spawn with this session, type and prompt, if any.
 * @param {Inflight[]} entries already pruned
 * @param {{sid:string, type:string, hash:string, src?:Inflight['src']}} id
 */
export function findDuplicate(entries, id) {
  return entries.find((e) => e.sid === id.sid && e.hash === id.hash && (!e.src || !id.src || e.src === id.src)) ?? null;
}

/**
 * @param {Inflight[]} entries already pruned
 * @param {{sid:string, type:string, hash:string, src?:Inflight['src']}} id
 * @param {number} now
 */
export function rememberInflight(entries, id, now) {
  return [...entries, { sid: id.sid, type: id.type, hash: id.hash, t: now, ...(id.src ? { src: id.src } : {}) }];
}

/**
 * Drop the oldest still-running spawn of this type in this session (SubagentStop does not carry the prompt).
 * Clearing the oldest fails open: the spawn that is still running may be a different prompt, and that one is then allowed again.
 * @param {Inflight[]} entries
 * @param {string} sid
 * @param {string} type
 * @param {number} now
 * @param {Inflight['src']} [src]
 */
export function forgetInflight(entries, sid, type, now, src) {
  const live = pruneInflight(entries, now);
  if (!sid || !type) return live;
  const same = (/** @type {Inflight} */ e) => (!e.src || !src || e.src === src) && e.type.toLowerCase() === type.toLowerCase();
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

const inflightFile = () => join(stateDir(), 'inflight.json');
const startsFile = () => join(stateDir(), 'subagent-starts.json');
const LOCK = 'subagent-starts.lock';
// shortcut: retain counts for 35 days after the most recent admission, matching the former receipt lookback.
const STARTS_KEEP_MS = 35 * 86400_000;

/** @returns {Inflight[]} */
function loadInflight() {
  try {
    const parsed = JSON.parse(readFileSync(inflightFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @param {Inflight[]} entries */
function saveInflight(entries) {
  writeAtomic(inflightFile(), JSON.stringify(entries.slice(-100)));
}

/** @returns {Record<string, StartCount>} */
function loadStarts() {
  try {
    const starts = JSON.parse(readFileSync(startsFile(), 'utf8'));
    if (!starts || typeof starts !== 'object' || Array.isArray(starts)) throw new Error('invalid subagent start counts');
    return starts;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/** Record an approved start exactly once when the host supplies an operation ID. @param {any} hook */
export function admitSpawn(hook) {
  const id = spawnRequest(hook);
  if (!id) return null;
  const { src, sid, type, operation } = id;
  const keyType = type.toLowerCase();
  const key = JSON.stringify([src, sid, keyType]);
  const hold = withStateLock(() => {
    const now = Date.now();
    const live = pruneInflight(loadInflight(), now);
    const starts = loadStarts();
    const cutoff = now - STARTS_KEEP_MS;
    const previous = starts[key];
    const entry = previous?.last >= cutoff ? previous : undefined;
    if (id.hash && findDuplicate(live, id)) return { kind: 'duplicate', reason: duplicateReason(id) };
    if (operation && entry?.operations.includes(operation)) return null;
    // Bootstrap each session and type once from pre-upgrade state. Later stops and receipts never change the count.
    const count =
      entry?.count ??
      live.filter((e) => (!e.src || e.src === src) && e.sid === sid && e.type.toLowerCase() === keyType).length +
        loadSubagents(cutoff).filter((e) => (e.src ?? 'claude') === src && e.sid === sid && String(e.type ?? '').toLowerCase() === keyType).length;
    const reason = typeCapReason(type, getTypeCaps().get(keyType), count);
    if (reason && entry) return { kind: 'type', reason };
    const retained = Object.fromEntries(Object.entries(starts).filter(([, item]) => item.last >= cutoff));
    const operations = entry?.operations ?? [];
    retained[key] = { last: now, count: reason ? count : count + 1, operations: !reason && operation ? [...operations, operation] : operations };
    writeAtomic(startsFile(), JSON.stringify(retained));
    if (reason) return { kind: 'type', reason };
    if (id.hash) saveInflight(rememberInflight(live, id, now));
    return null;
  }, LOCK);
  if (!hold) return null;
  try {
    const now = Date.now();
    logBlock({ t: now, kind: hold.kind, src, win: '5h', pct: 0, wall: now, reset: now, type, sid, ...(operation ? { operation } : {}) });
  } catch {
    /* A failed log does not change the admission decision. */
  }
  return hold.reason;
}

/**
 * Clear duplicate detection only. A state error must not discard the usage receipt.
 * @param {any} hook
 * @param {Inflight['src']} src
 */
export function clearSpawn(hook, src) {
  const sid = String(hook?.session_id ?? hook?.sessionId ?? '');
  const type = String(hook?.agent_type ?? hook?.subagentType ?? hook?.agentType ?? '');
  try {
    withStateLock(() => {
      const entries = loadInflight();
      const remaining = forgetInflight(entries, sid, type, Date.now(), src);
      if (remaining.length !== entries.length) saveInflight(remaining);
    }, LOCK);
  } catch {
    /* The old entry expires even when cleanup fails. */
  }
}
