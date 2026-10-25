// @ts-check
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { stateDir } from './store.mjs';
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
  for (const f of jsonlFiles(root, since, (n) => n.startsWith('rollout-'))) {
    const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.includes('"McpToolCall"')) {
        try {
          const item = JSON.parse(line)?.payload?.item;
          if (item?.type === 'McpToolCall' && typeof item.server === 'string') used.add(norm(item.server));
        } catch {
          /* a torn line */
        }
      } else if (line.includes('"namespace":"mcp__')) {
        const ns = /"namespace":"mcp__([^"]+)"/.exec(line)?.[1];
        if (ns) used.add(norm(ns));
      }
    }
  }
  return used;
}

/**
 * Sizes from the newest rollout's head: the AGENTS.md chain Codex loaded and its own base instructions (characters).
 * @returns {Promise<{agentsMd:number, base:number}|null>}
 */
export async function codexStartup(root = join(codexHome(), 'sessions')) {
  const files = jsonlFiles(root, 0, (n) => n.startsWith('rollout-'))
    .map((p) => ({ p, m: statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) return null;
  let agentsMd = 0;
  let base = 0;
  let n = 0;
  const rl = createInterface({ input: createReadStream(files[0].p), crlfDelay: Infinity });
  for await (const line of rl) {
    if (++n > 40) break;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'session_meta') base = String(ev.payload?.base_instructions?.text ?? '').length;
      if (ev.type === 'world_state') agentsMd = String(ev.payload?.state?.agents_md?.text ?? '').length;
    } catch {
      /* skip */
    }
  }
  rl.close();
  return { agentsMd, base };
}

/**
 * @param {{servers:{name:string, enabled:boolean|undefined}[], used:Set<string>, startup:{agentsMd:number, base:number}|null, days:number, pro:boolean}} r
 */
export function codexTrimReport({ servers, used, startup, days, pro }) {
  const on = servers.filter((s) => s.enabled !== false);
  const unused = on.filter((s) => !used.has(norm(s.name)));
  const tok = (/** @type {number} */ c) => `${(c / 4000).toFixed(1)}k`;
  const out = ['# limitcast trim --codex', ''];
  if (startup)
    out.push(
      `Codex sessions start with ~${tok(startup.agentsMd)} tokens of AGENTS.md (your instruction files) and ~${tok(startup.base)} of Codex's own instructions, re-sent on every turn.`,
      '',
    );
  out.push(`## MCP servers: ${on.length} on, ${unused.length} not used in ${days} days`);
  if (!unused.length) out.push('Every server that is on was used.');
  else if (pro)
    out.push(...unused.map((s) => `- ${s.name}`), '', 'Turn them off: `limitcast trim --codex --apply` (backed up; `--undo` reverses it).');
  else out.push(`Pro names them and turns them off for you: https://limitcast.dev/#pricing`);
  out.push(
    '',
    'Each server that is on starts with every Codex session and adds its tool list to the context. AGENTS.md: every 1k tokens you move into files read on demand saves 1k per turn.',
  );
  return { text: out.join('\n'), unused: unused.map((s) => s.name) };
}

/** @param {string} path @param {string} text */
function writeText(path, text) {
  const tmp = `${path}.limitcast-tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** @returns {{at:number, servers:{name:string, prev:boolean|null}[]}[]} */
function loadLedger() {
  try {
    return JSON.parse(readFileSync(ledgerPath(), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Turn the named servers off in config.toml, backing it up and recording each server's previous setting.
 * @param {string[]} names
 */
export function applyCodexTrim(names, { now = Date.now(), path = codexConfigPath() } = {}) {
  if (!names.length || !existsSync(path)) return [];
  const toml = readFileSync(path, 'utf8');
  const before = new Map(codexServers(toml).map((s) => [s.name, s.enabled]));
  copyFileSync(path, `${path}.limitcast-backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
  writeText(path, setEnabled(toml, Object.fromEntries(names.map((n) => [n, false]))));
  const servers = names.map((name) => ({ name, prev: before.get(name) ?? null }));
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(ledgerPath(), JSON.stringify([...loadLedger(), { at: now, servers }], null, 2));
  return servers;
}

/** Reverse the last --apply: each server goes back to its previous setting (or no `enabled` key). */
export function undoCodexTrim({ path = codexConfigPath() } = {}) {
  const ledger = loadLedger();
  const last = ledger.pop();
  if (!last || !existsSync(path)) return null;
  const toml = readFileSync(path, 'utf8');
  copyFileSync(path, `${path}.limitcast-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  // Only servers still off: anything turned back on since is left as the user set it.
  const off = new Set(
    codexServers(toml)
      .filter((s) => s.enabled === false)
      .map((s) => s.name),
  );
  writeText(path, setEnabled(toml, Object.fromEntries(last.servers.filter((s) => off.has(s.name)).map((s) => [s.name, s.prev]))));
  writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 2));
  return last;
}
