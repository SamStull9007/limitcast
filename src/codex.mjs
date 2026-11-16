// @ts-check
import { copyFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { stateDir, withStateLock } from './store.mjs';
import { commitTransaction, editText, readLedger, recoverTransaction } from './transaction.mjs';
import { jsonlFiles } from './usage.mjs';

// `limitcast trim --codex`: what Codex loads before you type (AGENTS.md, MCP servers) and which servers you never use.
// --apply turns unused servers off with `enabled = false` in ~/.codex/config.toml; --undo puts back exactly what it changed.

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');
export const codexConfigPath = () => join(codexHome(), 'config.toml');
const ledgerPath = () => join(stateDir(), 'codex-trim-applied.json');
const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]/g, '_');
const HEADER = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*(#.*)?$/;

/**
 * The MCP servers in a config.toml, with their `enabled` setting (undefined when the key is absent: on).
 * @param {string} toml
 */
export function codexServers(toml) {
  const lines = toml.split('\n');
  return lines.flatMap((line, i) => {
    const m = HEADER.exec(line.trim());
    if (!m) return [];
    const body = tableBody(lines, i);
    const at = body.find((j) => /^\s*enabled\s*=/.test(lines[j]));
    const enabled = at === undefined ? undefined : /=\s*true\b/.test(lines[at]);
    return [{ name: m[1] ?? m[2], enabled }];
  });
}

/** Line indexes of a table's own keys: after its header, up to the next table header. */
function tableBody(/** @type {string[]} */ lines, /** @type {number} */ header) {
  const out = [];
  for (let j = header + 1; j < lines.length && !lines[j].trim().startsWith('['); j++) out.push(j);
  return out;
}

/** @param {string[]} lines @param {string} name */
const headerOf = (lines, name) =>
  lines.findIndex((l) => {
    const m = HEADER.exec(l.trim());
    return m && (m[1] ?? m[2]) === name;
  });

/**
 * Set `enabled` on the named servers. value null removes the key (back to the default: on).
 * @param {string} toml
 * @param {Record<string, boolean|null>} changes
 */
export function setEnabled(toml, changes) {
  const lines = toml.split('\n');
  for (const [name, value] of Object.entries(changes)) {
    const h = headerOf(lines, name);
    if (h < 0) continue;
    const at = tableBody(lines, h).find((j) => /^\s*enabled\s*=/.test(lines[j]));
    if (value === null) {
      if (at !== undefined) lines.splice(at, 1);
    } else if (at !== undefined) lines[at] = `enabled = ${value}`;
    else lines.splice(h + 1, 0, `enabled = ${value}`);
  }
  return lines.join('\n');
}

/**
 * MCP servers Codex sessions called since `since`, by normalized name. Codex records each call as an
 * `McpToolCall` item with the server's config key, and the model's call with namespace `mcp__<server>`.
 * @param {number} since
 */
export async function codexUsedServers(since, root = join(codexHome(), 'sessions')) {
  const used = new Set();
  used.observed = false;
  used.complete = true;
  for (const f of jsonlFiles(root, since, (n) => n.startsWith('rollout-'))) {
    const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const p = row.payload;
        const item = p?.item;
        if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(p?.type)) {
          used.observed = true;
          const server = /^mcp__(.+?)(?:__|$)/.exec(p.namespace ?? '')?.[1] ?? /^mcp__(.+?)__/.exec(p.name ?? '')?.[1];
          if (server) used.add(norm(server));
          if (typeof p.name !== 'string') used.complete = false;
          if ([p.name, p.namespace].some((n) => typeof n === 'string' && n.startsWith('mcp__')) && !server) used.complete = false;
        } else if (item?.type === 'McpToolCall') {
          used.observed = true;
          if (typeof item.server === 'string') used.add(norm(item.server));
          else used.complete = false;
        } else if (item?.type === 'CommandExecution') used.observed = true;
        else if (/ToolCall$/.test(item?.type ?? '')) used.complete = false;
      } catch {
        used.complete = false;
      }
    }
  }
  return used;
}

/**
 * What a rollout's head shows of how the session started. A subagent's rollout is its own thread (forked, with its own
 * instructions), so it says nothing about what your interactive sessions load.
 * @param {string} file
 * @returns {Promise<{subagent:boolean, agentsMd:number, base:number, first?:number, at?:number}>}
 */
async function rolloutHead(file) {
  let agentsMd = 0;
  let base = 0;
  let subagent = false;
  /** @type {number|undefined} */
  let first;
  /** @type {number|undefined} */
  let at;
  let n = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (++n > 400) break;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'session_meta') {
        base = String(ev.payload?.base_instructions?.text ?? '').length;
        subagent = ev.payload?.thread_source === 'subagent' || Boolean(ev.payload?.source?.subagent);
        const started = Date.parse(ev.payload?.timestamp ?? ev.timestamp);
        if (Number.isFinite(started)) at = started;
      }
      if (ev.type === 'world_state') agentsMd = String(ev.payload?.state?.agents_md?.text ?? '').length;
      const total = ev?.payload?.info?.total_token_usage;
      if (total?.input_tokens) {
        first = total.input_tokens; // the first model call's whole prompt: what a session starts with, measured
        break;
      }
    } catch {
      /* skip */
    }
  }
  rl.close();
  return { subagent, agentsMd, base, ...(first ? { first } : {}), ...(at ? { at } : {}) };
}

/**
 * Sizes from the newest interactive rollout's head: the AGENTS.md chain Codex loaded and its own base instructions
 * (characters), `first`, the tokens of its first model call when the log reaches one, and `at`, when it started.
 * @returns {Promise<{agentsMd:number, base:number, first?:number, at?:number}|null>}
 */
export async function codexStartup(root = join(codexHome(), 'sessions')) {
  const files = jsonlFiles(root, 0, (n) => n.startsWith('rollout-'))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 40);
  for (const f of files) {
    const { subagent, ...sizes } = await rolloutHead(f.p);
    if (!subagent) return sizes;
  }
  return null;
}

/**
 * @param {{servers:{name:string, enabled:boolean|undefined}[], used:Set<string>, usedMonth?:Set<string>|null, startup:{agentsMd:number, base:number, first?:number}|null, days:number, pro:boolean, keep?:string[]}} r
 *   keep: the `trim keep` list; unused servers on it are reported as kept and left out of `unused`.
 *   usedMonth: normalized names used in 30 days. Servers in it stay out of `unused`.
 */
export function codexTrimReport({ servers, used, usedMonth = null, startup, days, pro, keep = [] }) {
  const on = servers.filter((s) => s.enabled !== false);
  const idle = on.filter((s) => !used.has(norm(s.name)));
  const kept = idle.filter((s) => keep.some((k) => norm(k) === norm(s.name)));
  const history = usedMonth ?? used;
  const unknown = history.complete === false || history.observed === false ? idle.filter((s) => !kept.includes(s)) : [];
  const standing = usedMonth ? idle.filter((s) => !kept.includes(s) && usedMonth.has(norm(s.name))) : [];
  const unused = idle.filter((s) => !kept.includes(s) && !standing.includes(s) && !unknown.includes(s));
  const tok = (/** @type {number} */ c) => `${(c / 4000).toFixed(1)}k`;
  const out = ['# limitcast trim --codex', ''];
  if (startup)
    out.push(
      startup.first
        ? `Your latest Codex session started with ${(startup.first / 1000).toFixed(1)}k tokens on its first call (measured): ~${tok(startup.agentsMd)} of AGENTS.md (your instruction files), ~${tok(startup.base)} of Codex's own instructions, and the rest tool definitions and environment context, all re-sent on every turn.`
        : `Codex sessions start with ~${tok(startup.agentsMd)} tokens of AGENTS.md (your instruction files) and ~${tok(startup.base)} of Codex's own instructions, re-sent on every turn.`,
      '',
    );
  out.push(`## MCP servers: ${on.length} on, ${unused.length + standing.length} not used in ${days} days`);
  if (unknown.length)
    out.push(
      '',
      `Usage history is missing or incomplete; leaving ${unknown.length} unverified servers on. No pruning is authorized by missing telemetry.`,
    );
  if (standing.length)
    out.push('', `${standing.length} used in the last 30 days, so \`trim --apply\` leaves them on:`, ...standing.map((s) => `- ${s.name}`));
  if (!unused.length) out.push(kept.length || standing.length || unknown.length ? 'Nothing else to turn off.' : 'Every server that is on was used.');
  else if (pro)
    out.push(
      ...unused.map((s) => `- ${s.name}`),
      '',
      `${usedMonth ? 'Turn the servers that have been quiet for 30 days off' : 'Turn them off'}: \`limitcast trim --codex --apply\` (backed up; \`--undo\` reverses it).`,
    );
  else out.push(`Pro names them and turns them off for you: https://limitcast.dev/#pricing`);
  if (kept.length) out.push('', `Would keep (your keep-list): ${kept.map((s) => s.name).join(', ')}.`);
  out.push(
    '',
    'Each server that is on starts with every Codex session and adds its tool list to the context. AGENTS.md: every 1k tokens you move into files read on demand saves 1k per turn.',
  );
  return {
    text: out.join('\n'),
    unused: unused.map((s) => s.name),
    standing: standing.map((s) => s.name),
    kept: kept.map((s) => s.name),
    unknown: unknown.map((s) => s.name),
  };
}

/** @returns {{at:number, servers:{name:string, prev:boolean|null}[]}[]} */
function loadLedger() {
  const entries = readLedger(ledgerPath());
  if (entries.some((e) => !Array.isArray(e.servers))) throw new Error('invalid Codex trim ledger');
  return entries;
}

/**
 * Turn the named servers off in config.toml, backing it up and recording each server's previous setting.
 * @param {string[]} names
 */
export function applyCodexTrim(names, { now = Date.now(), path = codexConfigPath() } = {}) {
  return withStateLock(() => {
    recoverTransaction(ledgerPath());
    const ledger = loadLedger();
    if (!names.length || !existsSync(path)) return [];
    let toml;
    const update = editText(path, (text) => {
      toml = text;
      return setEnabled(text, Object.fromEntries(names.map((n) => [n, false])));
    });
    const before = new Map(codexServers(toml).map((s) => [s.name, s.enabled]));
    copyFileSync(path, `${path}.limitcast-backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
    const servers = names.map((name) => ({ name, prev: before.get(name) ?? null }));
    commitTransaction(ledgerPath(), [...ledger, { at: now, servers }], [update]);
    return servers;
  });
}

/** Reverse the last --apply: each server goes back to its previous setting (or no `enabled` key). */
export function undoCodexTrim({ path = codexConfigPath() } = {}) {
  return withStateLock(() => {
    recoverTransaction(ledgerPath());
    const ledger = loadLedger();
    const last = ledger.pop();
    if (!last || !existsSync(path)) return null;
    const update = editText(path, (toml) => {
      // Only servers still off: anything turned back on since is left as the user set it.
      const off = new Set(
        codexServers(toml)
          .filter((s) => s.enabled === false)
          .map((s) => s.name),
      );
      return setEnabled(toml, Object.fromEntries(last.servers.filter((s) => off.has(s.name)).map((s) => [s.name, s.prev])));
    });
    copyFileSync(path, `${path}.limitcast-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    commitTransaction(ledgerPath(), ledger, [update]);
    return last;
  });
}
