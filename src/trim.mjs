// @ts-check
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fmt } from './report.mjs';

/** @typedef {import('./usage.mjs').Usage} Usage */

/**
 * Fixed overhead: tokens every Claude Code session pays before you type anything,
 * measured from the first response of each main (non-subagent) session.
 * Counts interactive sessions so headless SDK/`claude -p` runs don't drag the median down:
 * launched from the CLI where the transcript says so, else 5+ responses.
 * @param {Usage[]} usage
 */
export function baseline(usage) {
  /** @type {Map<string, {first:Usage, n:number}>} */
  const sessions = new Map();
  for (const u of usage) {
    if (u.src !== 'claude' || u.sidechain) continue;
    const s = sessions.get(u.session);
    if (!s) sessions.set(u.session, { first: u, n: 1 });
    else {
      s.n++;
      if (u.t < s.first.t) s.first = u;
    }
  }
  const interactive = [...sessions.values()].filter((s) => (s.first.entry ? s.first.entry === 'cli' : s.n >= 5));
  const picked = interactive.length ? interactive : [...sessions.values()];
  const sizes = picked.map(({ first: u }) => u.input + u.cacheWrite + u.cacheRead).sort((a, b) => a - b);
  if (!sizes.length) return null;
  return { sessions: sizes.length, median: sizes[Math.floor(sizes.length / 2)], max: sizes[sizes.length - 1] };
}

/**
 * What loads into every session, largest first. File sizes are estimated at ~4 bytes per token.
 * @param {{home?:string, cwd?:string}} [where]
 */
export function contributors({ home = homedir(), cwd = process.cwd() } = {}) {
  const claudeDir = join(home, '.claude');
  /** @type {{what:string, tokens:number|null, note:string}[]} */
  const out = [];
  const file = (/** @type {string} */ p, /** @type {string} */ what) => {
    if (existsSync(p)) out.push({ what, tokens: Math.round(statSync(p).size / 4), note: p.replace(home, '~') });
  };
  file(join(claudeDir, 'CLAUDE.md'), 'Global CLAUDE.md');
  if (cwd !== home) file(join(cwd, 'CLAUDE.md'), 'Project CLAUDE.md');
  file(join(home, 'CLAUDE.md'), 'Home CLAUDE.md');
  const memDir = join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), 'memory', 'MEMORY.md');
  file(memDir, 'Auto-memory index');

  const mcp = mcpServers(join(home, '.claude.json'), cwd);
  if (mcp.length)
    out.push({
      what: `${mcp.length} MCP servers`,
      tokens: null,
      note: `each adds its tool definitions: ${mcp.slice(0, 6).join(', ')}${mcp.length > 6 ? ', ...' : ''}`,
    });

  const skillsDir = join(claudeDir, 'skills');
  if (existsSync(skillsDir)) {
    const n = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    if (n) out.push({ what: `${n} skills`, tokens: null, note: 'each adds its name and description to the listing' });
  }
  return out.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1));
}

/**
 * MCP server names configured globally and for this project in ~/.claude.json.
 * @param {string} path
 * @param {string} cwd
 */
function mcpServers(path, cwd) {
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    return [...new Set([...Object.keys(cfg.mcpServers ?? {}), ...Object.keys(cfg.projects?.[cwd]?.mcpServers ?? {})])];
  } catch {
    return [];
  }
}

/**
 * @param {ReturnType<typeof baseline>} base
 * @param {ReturnType<typeof contributors>} parts
 */
export function trimReport(base, parts) {
  const lines = ['# limitcast trim', ''];
  if (base) {
    lines.push(
      `Every Claude Code session starts at **${fmt(base.median)} tokens** before your first message (median of ${base.sessions} sessions, max ${fmt(base.max)}).`,
      'That is re-sent on every turn and every subagent, so cutting it stretches every limit window.',
      '',
    );
  } else {
    lines.push('No Claude Code sessions in the period yet.', '');
  }
  lines.push('## What loads every time', '', '| | est. tokens | |', '|---|---:|---|');
  for (const p of parts) lines.push(`| ${p.what} | ${p.tokens === null ? '-' : fmt(p.tokens)} | ${p.note} |`);
  lines.push('', '## Biggest wins', '');
  const big = parts.filter((p) => (p.tokens ?? 0) >= 2000);
  for (const p of big) lines.push(`- **${p.what}** (~${fmt(p.tokens ?? 0)}): move rarely-used sections into files read on demand.`);
  const mcp = parts.find((p) => p.what.endsWith('MCP servers'));
  if (mcp) lines.push(`- **${mcp.what}**: disable servers you don't use in most projects (\`/mcp\`), or move them to project-level config.`);
  const skills = parts.find((p) => p.what.endsWith('skills'));
  if (skills) lines.push(`- **${skills.what}**: hide rarely-used skills from the model (\`skillOverrides\` in settings).`);
  if (!big.length && !mcp && !skills) lines.push('- Nothing large found. Your fixed overhead is already lean.');
  return lines.join('\n');
}
