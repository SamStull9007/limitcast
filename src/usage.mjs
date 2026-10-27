// @ts-check
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { stateDir } from './store.mjs';

/**
 * One model response's token usage.
 * @typedef {{t:number, src:'claude'|'codex'|'grok', session:string, project:string, model:string, sidechain:boolean,
 *   input:number, cacheWrite:number, cacheWrite1h?:number, cacheRead:number, output:number, entry?:string}} Usage
 *   entry: how Claude Code was launched (cli, sdk-py, ...); cacheWrite1h: the part of cacheWrite that used the 1-hour cache
 */

export const claudeRoot = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
export const codexRoot = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
export const grokRoot = () => join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'sessions');

/**
 * Claude Code transcript lines → usage, one per API message.
 * Transcripts repeat the same usage on every content block of a message, so count each message id once.
 * @param {string} line
 * @param {Set<string>} seen message ids already counted
 * @param {string} session
 * @returns {Usage|null}
 */
export function claudeUsage(line, seen, session) {
  if (!line.includes('"usage"')) return null;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  const u = ev?.message?.usage;
  const t = Date.parse(ev?.timestamp);
  if (ev?.type !== 'assistant' || !u || !Number.isFinite(t)) return null;
  const id = `${ev.message.id ?? ''}:${ev.requestId ?? ''}`;
  if (id !== ':' && seen.has(id)) return null;
  seen.add(id);
  return {
    t,
    src: 'claude',
    session,
    project: ev.cwd ?? '',
    model: ev.message.model ?? '',
    sidechain: !!ev.isSidechain,
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    ...(ev.entrypoint ? { entry: String(ev.entrypoint) } : {}),
  };
}

/**
 * Record which skills and MCP servers a Claude Code transcript line used: Skill tool calls, /slash commands, mcp__server__tool calls.
 * @param {string} line
 * @param {import('./trim.mjs').Activity} act
 */
export function claudeActivity(line, act) {
  if (line.includes('<command-name>')) {
    for (const m of line.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) act.skills.add(m[1]);
  }
  if (!line.includes('"name":"Skill"') && !line.includes('"name":"mcp__')) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  const content = ev?.message?.content;
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (c?.type !== 'tool_use' || typeof c.name !== 'string') continue;
    if (c.name === 'Skill' && c.input?.skill) act.skills.add(String(c.input.skill));
    else if (c.name.startsWith('mcp__')) act.mcp.add(c.name.split('__')[1] ?? '');
  }
}

/**
 * Codex rollout lines → usage. token_count events carry a running total, so emit the increase since the last one.
 * @param {string} line
 * @param {{prev:any, cwd:string, model:string}} st per-file state
 * @param {string} session
 * @returns {Usage|null}
 */
export function codexUsage(line, st, session) {
  let ev;
  if (line.includes('"session_meta"') || line.includes('"turn_context"')) {
    try {
      ev = JSON.parse(line);
    } catch {
      return null;
    }
    st.cwd = ev?.payload?.cwd ?? st.cwd;
    st.model = ev?.payload?.model ?? st.model;
    return null;
  }
  if (!line.includes('"total_token_usage"')) return null;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  const tot = ev?.payload?.info?.total_token_usage;
  const t = Date.parse(ev?.timestamp);
  if (!tot || !Number.isFinite(t)) return null;
  const p = st.prev ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  st.prev = tot;
  const cached = (tot.cached_input_tokens ?? 0) - (p.cached_input_tokens ?? 0);
  const input = (tot.input_tokens ?? 0) - (p.input_tokens ?? 0) - cached;
  const output = (tot.output_tokens ?? 0) - (p.output_tokens ?? 0);
  if (input + cached + output <= 0) return null;
  return { t, src: 'codex', session, project: st.cwd, model: st.model, sidechain: false, input, cacheWrite: 0, cacheRead: cached, output };
}

/**
 * A Grok session's usage.json ledger → usage, one record per turn (each turn's own tokens, stamped when it ended).
 * @param {any} ledger parsed usage.json
 * @param {string} session
 * @param {string} project
 * @returns {Usage[]}
 */
export function grokUsage(ledger, session, project) {
  /** @type {Usage[]} */
  const out = [];
  for (const turn of Array.isArray(ledger?.turns) ? ledger.turns : []) {
    const t = Date.parse(turn?.endedAt);
    if (!Number.isFinite(t)) continue;
    const cacheRead = turn.cachedReadTokens ?? 0;
    const cacheWrite = turn.cacheCreationTokens ?? 0;
    const input = Math.max(0, (turn.inputTokens ?? 0) - cacheRead - cacheWrite);
    const output = turn.outputTokens ?? 0;
    const model = turn.primaryModelId ?? Object.keys(turn.modelUsage ?? {})[0] ?? '';
    out.push({ t, src: 'grok', session, project, model, sidechain: false, input, cacheWrite, cacheRead, output });
  }
  return out;
}

/**
 * Grok session ledgers modified since `since`: <root>/<url-encoded project dir>/<session id>/usage.json.
 * @param {string} root
 * @param {number} since
 */
function grokLedgers(root, since) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const proj of readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const sess of readdirSync(join(root, proj.name), { withFileTypes: true })) {
      const file = join(root, proj.name, sess.name, 'usage.json');
      if (sess.isDirectory() && existsSync(file) && statSync(file).mtimeMs >= since) {
        out.push({ file, session: sess.name, project: safeDecode(proj.name) });
      }
    }
  }
  return out;
}

/**
 * All usage since `since` from Claude Code, Codex and Grok.
 * @param {number} since epoch ms
 * @param {{claude?:string, codex?:string, grok?:string}} [roots]
 * @param {import('./trim.mjs').Activity} [activity] if given, filled with the skills and MCP servers Claude Code used
 * @returns {Promise<Usage[]>}
 */
export async function readUsage(since, roots = {}, activity) {
  /** @type {Usage[]} */
  const out = [];
  // Parsed transcripts are cached by size and mtime: only new or changed ones are read again.
  const cache = loadUsageCache();
  /** @type {typeof cache} */
  const next = {};
  /**
   * @param {string} file
   * @param {(file:string)=>Promise<{u:Usage[], a?:{skills:string[], mcp:string[]}}>} parse
   */
  const cached = async (file, parse) => {
    const st = statSync(file);
    const hit = cache[file];
    const entry = hit && hit.s === st.size && hit.m === st.mtimeMs ? hit : { s: st.size, m: st.mtimeMs, ...(await parse(file)) };
    next[file] = entry;
    return entry;
  };
  for (const file of jsonlFiles(roots.claude ?? claudeRoot(), since, () => true)) {
    const e = await cached(file, async (f) => {
      const seen = new Set();
      const session = basename(f, '.jsonl');
      /** @type {import('./trim.mjs').Activity} */
      const act = { skills: new Set(), mcp: new Set() };
      const u = [];
      for await (const line of lines(f)) {
        claudeActivity(line, act);
        const x = claudeUsage(line, seen, session);
        if (x) u.push(x);
      }
      return { u, a: { skills: [...act.skills], mcp: [...act.mcp] } };
    });
    for (const u of e.u) if (u.t >= since) out.push(u);
    if (activity && e.a) {
      for (const s of e.a.skills) activity.skills.add(s);
      for (const m of e.a.mcp) activity.mcp.add(m);
    }
  }
  for (const file of jsonlFiles(roots.codex ?? codexRoot(), since, (n) => n.startsWith('rollout-'))) {
    const e = await cached(file, async (f) => {
      const st = { prev: null, cwd: '', model: '' };
      // rollout-2026-10-23T18-39-41-<session uuid>.jsonl → the uuid
      const session = basename(f, '.jsonl').replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');
      const u = [];
      for await (const line of lines(f)) {
        const x = codexUsage(line, st, session);
        if (x) u.push(x);
      }
      return { u };
    });
    for (const u of e.u) if (u.t >= since) out.push(u);
  }
  // Keep entries for files this run didn't need (another period) while they are recent; drop the rest.
  for (const [f, e] of Object.entries(cache)) if (!next[f] && e.m >= Date.now() - CACHE_KEEP_MS && existsSync(f)) next[f] = e;
  saveUsageCache(next);
  for (const { file, session, project } of grokLedgers(roots.grok ?? grokRoot(), since)) {
    let ledger;
    try {
      ledger = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // being written right now; picked up next run
    }
    for (const u of grokUsage(ledger, session, project)) if (u.t >= since) out.push(u);
  }
  return out;
}

const CACHE_KEEP_MS = 35 * 86400_000;
const USAGE_CACHE_VERSION = 2; // 2: records carry cacheWrite1h; an older cache is read again
const usageCacheFile = () => join(stateDir(), 'usage-cache.json');

/** @returns {Record<string, {s:number, m:number, u:Usage[], a?:{skills:string[], mcp:string[]}}>} */
function loadUsageCache() {
  try {
    const d = JSON.parse(readFileSync(usageCacheFile(), 'utf8'));
    return d.v === USAGE_CACHE_VERSION ? d.files : {};
  } catch {
    return {};
  }
}

/** @param {ReturnType<typeof loadUsageCache>} c */
function saveUsageCache(c) {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(usageCacheFile(), JSON.stringify({ v: USAGE_CACHE_VERSION, files: c }));
  } catch {
    /* a cache: the next run just reads the transcripts */
  }
}

/** @param {string} s */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** @param {string} file */
function lines(file) {
  return createInterface({ input: createReadStream(file), crlfDelay: Infinity });
}

/**
 * .jsonl files under `dir` modified since `since`.
 * @param {string} dir
 * @param {number} since
 * @param {(name:string)=>boolean} keep
 * @returns {string[]}
 */
export function jsonlFiles(dir, since, keep) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(p, since, keep));
    else if (e.name.endsWith('.jsonl') && keep(e.name) && statSync(p).mtimeMs >= since) out.push(p);
  }
  return out;
}

/** @param {Usage} u */
export const total = (u) => u.input + u.cacheWrite + u.cacheRead + u.output;
