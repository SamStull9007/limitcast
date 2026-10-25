// @ts-check
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSettings, settingsPath } from './install.mjs';
import { stateDir } from './store.mjs';

// `trim --apply`: hide unused skills and turn off unused MCP servers through Claude Code's own settings.
// Skills: `skillOverrides` in ~/.claude/settings.json ("user-invocable-only": the model stops seeing it, /name still works).
//   Plugin skills ignore skillOverrides, so they are listed for /plugin instead.
// MCP servers: the per-project `disabledMcpServers` list in ~/.claude.json, the same list the /mcp toggle writes.
//   Only names that match a server Claude Code knows exactly are written; the rest are listed for /mcp.

const configDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
export const claudeJsonPath = () => (process.env.CLAUDE_CONFIG_DIR ? join(configDir(), '.claude.json') : join(homedir(), '.claude.json'));
const ledgerPath = () => join(stateDir(), 'trim-applied.json');

/** MCP tool names keep the server name but normalize punctuation. @param {string} s */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '_');

/**
 * Installed plugins and the MCP servers they register ("plugin:<plugin>:<server>").
 * @returns {{names:Set<string>, servers:string[]}}
 */
export function installedPlugins(dir = configDir()) {
  const names = new Set();
  const servers = [];
  try {
    const reg = JSON.parse(readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, installs] of Object.entries(reg.plugins ?? {})) {
      const name = key.split('@')[0];
      names.add(name);
      for (const i of /** @type {any[]} */ (installs)) {
        for (const f of ['.mcp.json', join('.claude-plugin', 'plugin.json')]) {
          try {
            const j = JSON.parse(readFileSync(join(i.installPath, f), 'utf8'));
            const defs = f === '.mcp.json' ? (j.mcpServers ?? j) : j.mcpServers;
            if (defs && typeof defs === 'object') for (const s of Object.keys(defs)) servers.push(`plugin:${name}:${s}`);
          } catch {
            /* no MCP servers in this file */
          }
        }
      }
    }
  } catch {
    /* no plugins */
  }
  return { names, servers };
}

/**
 * What `--apply` would change, from the unused items `trim` measured.
 * @param {{skills:string[], mcp:string[], cwd:string, settings:any, claudeJson:any, plugins:{names:Set<string>, servers:string[]}, projectMcpJson:string[], localSkills:Set<string>}} r
 *   localSkills: folder names of personal and project skills
 */
export function planTrim({ skills, mcp, cwd, settings, claudeJson, plugins, projectMcpJson, localSkills }) {
  // "x:y" is a plugin skill (namespaced by its plugin) unless x is one of your own skill folders with nested skills.
  // Plugins can load from places installed_plugins.json doesn't list, so the namespace alone decides.
  const isPluginSkill = (/** @type {string} */ n) => n.includes(':') && !localSkills.has(n.split(':')[0]);
  const overrides = settings.skillOverrides ?? {};
  const hide = skills.filter((n) => !isPluginSkill(n) && (overrides[n] === undefined || overrides[n] === 'on'));
  const pluginSkills = skills.filter(isPluginSkill);

  // Exact server names Claude Code uses: configured servers, plugin servers, and names already toggled in /mcp anywhere.
  const exact = new Set([
    ...Object.keys(claudeJson.mcpServers ?? {}),
    ...Object.keys(claudeJson.projects?.[cwd]?.mcpServers ?? {}),
    ...Object.keys(settings.mcpServers ?? {}),
    ...plugins.servers,
    ...Object.values(claudeJson.projects ?? {}).flatMap((p) => /** @type {any} */ (p).disabledMcpServers ?? []),
  ]);
  const byNorm = new Map([...exact].map((n) => [norm(n), n]));
  const already = new Set(claudeJson.projects?.[cwd]?.disabledMcpServers ?? []);
  const projectServers = new Set(projectMcpJson.map(norm));
  /** @type {string[]} */
  const disable = [];
  /** @type {string[]} */
  const manualMcp = [];
  for (const m of mcp) {
    // .mcp.json servers are approved per project in settings, not toggled in disabledMcpServers.
    const name = projectServers.has(norm(m)) ? null : (byNorm.get(norm(m)) ?? (m.startsWith('claude.ai ') ? m : null));
    if (!name) manualMcp.push(m);
    else if (!already.has(name)) disable.push(name);
  }
  return { hide, pluginSkills, disable, manualMcp };
}

/** @param {string} path */
function backup(path) {
  if (existsSync(path)) copyFileSync(path, `${path}.limitcast-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

/**
 * Write JSON through a temp file and rename, so a crash or a concurrent reader never sees half a file.
 * @param {string} path @param {any} value
 */
function writeJson(path, value) {
  const tmp = `${path}.limitcast-tmp`;
  // ~/.claude.json can hold credentials: keep the file's own permissions (owner-only for a new file).
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(tmp, mode); // a leftover tmp from a crash keeps its old mode otherwise
  renameSync(tmp, path);
}

/** @returns {{at:number, cwd:string, skills:{name:string, prev?:string}[], mcp:string[]}[]} */
export function loadLedger() {
  try {
    return JSON.parse(readFileSync(ledgerPath(), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Apply a plan: back up both files, write the changes, and record exactly what changed so `--undo` can reverse it.
 * @param {ReturnType<typeof planTrim>} plan
 * @param {{cwd:string, now:number, settings?:string, claudeJson?:string}} o
 */
export function applyTrim(plan, { cwd, now, settings = settingsPath(), claudeJson = claudeJsonPath() }) {
  const entry = { at: now, cwd, skills: /** @type {{name:string, prev?:string}[]} */ ([]), mcp: /** @type {string[]} */ ([]) };
  if (plan.hide.length) {
    const cfg = readSettings(settings);
    backup(settings);
    cfg.skillOverrides ??= {};
    for (const name of plan.hide) {
      entry.skills.push(name in cfg.skillOverrides ? { name, prev: cfg.skillOverrides[name] } : { name });
      cfg.skillOverrides[name] = 'user-invocable-only';
    }
    writeJson(settings, cfg);
  }
  if (plan.disable.length) {
    const cj = readSettings(claudeJson);
    backup(claudeJson);
    cj.projects ??= {};
    cj.projects[cwd] ??= {};
    const list = (cj.projects[cwd].disabledMcpServers ??= []);
    for (const name of plan.disable) if (!list.includes(name)) list.push(name);
    entry.mcp = [...plan.disable];
    writeJson(claudeJson, cj);
  }
  if (entry.skills.length || entry.mcp.length) {
    mkdirSync(stateDir(), { recursive: true });
    writeJson(ledgerPath(), [...loadLedger(), entry]);
  }
  return entry;
}

/**
 * Reverse the last `--apply`: put back each skill's previous setting and re-enable the servers it turned off.
 * Settings the user changed since are left alone.
 * @param {{settings?:string, claudeJson?:string}} [o]
 */
export function undoTrim({ settings = settingsPath(), claudeJson = claudeJsonPath() } = {}) {
  const ledger = loadLedger();
  const last = ledger.pop();
  if (!last) return null;
  if (last.skills.length) {
    const cfg = readSettings(settings);
    backup(settings);
    for (const s of last.skills) {
      if (cfg.skillOverrides?.[s.name] !== 'user-invocable-only') continue;
      if (s.prev === undefined) delete cfg.skillOverrides[s.name];
      else cfg.skillOverrides[s.name] = s.prev;
    }
    writeJson(settings, cfg);
  }
  if (last.mcp.length) {
    const cj = readSettings(claudeJson);
    backup(claudeJson);
    const p = cj.projects?.[last.cwd];
    if (p?.disabledMcpServers) p.disabledMcpServers = p.disabledMcpServers.filter((/** @type {string} */ n) => !last.mcp.includes(n));
    writeJson(claudeJson, cj);
  }
  writeJson(ledgerPath(), ledger);
  return last;
}

/**
 * Items an earlier --apply turned off that still loaded in a session started after it
 * (for example, a running Claude Code session rewrote ~/.claude.json).
 * @param {{pieces:{group:string, name:string}[], at:number}} b latest measured session
 */
export function stillLoading(b) {
  const loaded = new Set(b.pieces.map((p) => norm(p.name)));
  return loadLedger()
    .filter((e) => b.at > e.at)
    .flatMap((e) => [...e.skills.map((s) => s.name), ...e.mcp])
    .filter((n) => loaded.has(norm(n)));
}

/**
 * The working directory a transcript was recorded in (where its MCP toggles live).
 * @param {string} file
 */
export function transcriptCwd(file) {
  // The cwd is on the first entries; read only the head of what can be a multi-megabyte transcript.
  const buf = Buffer.alloc(256 * 1024);
  const fd = openSync(file, 'r');
  const n = readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
    try {
      const cwd = JSON.parse(line).cwd;
      if (typeof cwd === 'string') return cwd;
    } catch {
      /* skip */
    }
  }
  return null;
}

/**
 * Folder names of personal (~/.claude/skills) and project (<cwd>/.claude/skills) skills.
 * @param {string} cwd
 */
export function localSkillFolders(cwd, dir = configDir()) {
  const out = new Set();
  for (const root of [join(dir, 'skills'), join(cwd, '.claude', 'skills')]) {
    try {
      for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory() || d.isSymbolicLink()) out.add(d.name);
    } catch {
      /* none */
    }
  }
  return out;
}

/** Server names in the project's .mcp.json. @param {string} cwd */
export function projectMcpServers(cwd) {
  try {
    return Object.keys(JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')).mcpServers ?? {});
  } catch {
    return [];
  }
}
