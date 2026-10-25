// @ts-check
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * One model response's token usage.
 * @typedef {{t:number, src:'claude'|'codex', session:string, project:string, model:string, sidechain:boolean,
 *   input:number, cacheWrite:number, cacheRead:number, output:number, entry?:string}} Usage  entry: how Claude Code was launched (cli, sdk-py, ...)
 */

export const claudeRoot = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
export const codexRoot = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');

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
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    ...(ev.entrypoint ? { entry: String(ev.entrypoint) } : {}),
  };
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
 * All usage since `since` from both tools.
 * @param {number} since epoch ms
 * @param {{claude?:string, codex?:string}} [roots]
 * @returns {Promise<Usage[]>}
 */
export async function readUsage(since, roots = {}) {
  /** @type {Usage[]} */
  const out = [];
  for (const file of jsonlFiles(roots.claude ?? claudeRoot(), since, () => true)) {
    const seen = new Set();
    const session = basename(file, '.jsonl');
    for await (const line of lines(file)) {
      const u = claudeUsage(line, seen, session);
      if (u && u.t >= since) out.push(u);
    }
  }
  for (const file of jsonlFiles(roots.codex ?? codexRoot(), since, (n) => n.startsWith('rollout-'))) {
    const st = { prev: null, cwd: '', model: '' };
    const session = basename(file, '.jsonl');
    for await (const line of lines(file)) {
      const u = codexUsage(line, st, session);
      if (u && u.t >= since) out.push(u);
    }
  }
  return out;
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
