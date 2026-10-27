// @ts-check
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fmt } from './report.mjs';

/** @typedef {import('./usage.mjs').Usage} Usage */
/** @typedef {{skills:Set<string>, mcp:Set<string>}} Activity  skills and MCP servers used in the period */

const DESC_CAP = 1536; // Claude Code's default skillListingMaxDescChars

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
 * What loads into every session: instruction files (~4 bytes per token), each user skill's listing entry
 * (name + description, honoring skillOverrides), and configured MCP servers.
 * @param {{home?:string, cwd?:string}} [where]
 */
export function contributors({ home = homedir(), cwd = process.cwd() } = {}) {
  const claudeDir = join(home, '.claude');
  /** @type {{what:string, tokens:number, path:string}[]} */
  const files = [];
  const file = (/** @type {string} */ p, /** @type {string} */ what) => {
    if (existsSync(p)) files.push({ what, tokens: Math.round(statSync(p).size / 4), path: p.replace(home, '~') });
  };
  file(join(claudeDir, 'CLAUDE.md'), 'Global CLAUDE.md');
  if (cwd !== home) file(join(cwd, 'CLAUDE.md'), 'Project CLAUDE.md');
  file(join(home, 'CLAUDE.md'), 'Home CLAUDE.md');
  file(join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), 'memory', 'MEMORY.md'), 'Auto-memory index');
  files.sort((a, b) => b.tokens - a.tokens);

  const overrides = readJson(join(claudeDir, 'settings.json'))?.skillOverrides ?? {};
  /** @type {{name:string, tokens:number, hidden:boolean}[]} */
  const skills = [];
  const skillsDir = join(claudeDir, 'skills');
  if (existsSync(skillsDir)) {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      const md = join(skillsDir, e.name, 'SKILL.md');
      if (!e.isDirectory() || !existsSync(md)) continue;
      const { name, desc } = skillListing(readFileSync(md, 'utf8'), e.name);
      const mode = overrides[name] ?? overrides[e.name];
      const hidden = mode === 'off' || mode === 'user-invocable-only';
      const text = mode === 'name-only' ? name : `${name}: ${desc}`;
      skills.push({ name, tokens: hidden ? 0 : Math.ceil((text.length + 4) / 4), hidden });
    }
  }

  const cfg = readJson(join(home, '.claude.json'));
  const mcp = [...new Set([...Object.keys(cfg?.mcpServers ?? {}), ...Object.keys(cfg?.projects?.[cwd]?.mcpServers ?? {})])];
  return { files, skills, mcp };
}

/**
 * A skill's name and listing description from its SKILL.md frontmatter.
 * @param {string} md
 * @param {string} fallbackName
 */
export function skillListing(md, fallbackName) {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const unquote = (/** @type {string} */ s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
  const name = unquote(fm.match(/^name:\s*(.+)$/m)?.[1] ?? '') || fallbackName;
  let desc = '';
  const m = fm.match(/^description:[ \t]*(.*)$/m);
  if (m) {
    if (/^[>|][-+]?$/.test(m[1].trim())) {
      // YAML block scalar: the indented lines that follow
      const rest = fm
        .slice((m.index ?? 0) + m[0].length)
        .split(/\r?\n/)
        .slice(1);
      const block = [];
      for (const l of rest) {
        if (/^\s+\S/.test(l) || l.trim() === '') block.push(l.trim());
        else break;
      }
      desc = block.join(' ').trim();
    } else desc = unquote(m[1]);
  }
  return { name, desc: desc.slice(0, DESC_CAP) };
}

/** @param {string} p */
function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Was this skill used? Usage names can be plugin-qualified ("plugin:skill").
 * @param {string} name
 * @param {Set<string>} used
 */
const skillUsed = (name, used) => used.has(name) || [...used].some((u) => u.endsWith(`:${name}`));
/** MCP tool names keep the server name but may normalize punctuation. @param {string} s */
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '_');

/**
 * Measured savings: unused visible skills (exact listing size), unused MCP servers (named; their size
 * isn't visible offline), and the instruction files that load every time.
 * @param {ReturnType<typeof contributors>} c
 * @param {Activity} used
 */
export function savings(c, used) {
  const unusedSkills = c.skills.filter((s) => !s.hidden && !skillUsed(s.name, used.skills)).sort((a, b) => b.tokens - a.tokens);
  const usedMcp = new Set([...used.mcp].map(norm));
  const unusedMcp = c.mcp.filter((s) => !usedMcp.has(norm(s)));
  return { unusedSkills, skillTokens: unusedSkills.reduce((a, s) => a + s.tokens, 0), unusedMcp };
}

/**
 * @param {ReturnType<typeof baseline>} base
 * @param {ReturnType<typeof contributors>} c
 * @param {Activity} used
 * @param {number} days
 */
export function trimReport(base, c, used, days) {
  const s = savings(c, used);
  const fileTokens = c.files.reduce((a, f) => a + f.tokens, 0);
  const visible = c.skills.filter((k) => !k.hidden);
  const listing = visible.reduce((a, k) => a + k.tokens, 0);
  const lines = ['# limitcast trim', ''];
  if (base) {
    lines.push(
      `Your recorded Claude Code sessions start at **${fmt(base.median)} tokens** before your first message (median of ${base.sessions} interactive sessions, max ${fmt(base.max)}).`,
      'That context is re-sent on every turn and to every subagent, so every token you cut stretches your limit windows.',
      '',
    );
  } else lines.push('No interactive Claude Code sessions in the period yet.', '');

  const pct = base && s.skillTokens ? ` (${Math.round((s.skillTokens / base.median) * 100)}% of your fixed overhead)` : '';
  lines.push(`## Estimated removable context: ~${fmt(s.skillTokens)} tokens per session${pct}`, '');
  if (s.unusedSkills.length) {
    const names = s.unusedSkills.slice(0, 12).map((k) => k.name);
    lines.push(
      `- **Hide ${s.unusedSkills.length} skills you haven't used in ${days} days** (~${fmt(s.skillTokens)} tokens): ${names.join(', ')}${s.unusedSkills.length > 12 ? ', ...' : ''}.`,
      '  In `~/.claude/settings.json`, set each to `"user-invocable-only"` under `skillOverrides`: `/name` still works, the model just stops seeing it.',
    );
  } else if (visible.length) lines.push(`- Every visible skill was used in the last ${days} days.`);
  if (s.unusedMcp.length) {
    lines.push(
      `- **Disable ${s.unusedMcp.length} MCP servers you haven't used in ${days} days**: ${s.unusedMcp.join(', ')}.`,
      "  Each loads its tool definitions into every session; the size isn't visible offline, so check `/context` before and after.",
    );
  }
  if (c.files.length) {
    lines.push(
      `- **Instruction files load in full every time** (~${fmt(fileTokens)} tokens): ${c.files.map((f) => `${f.what} ~${fmt(f.tokens)}`).join(', ')}.`,
      '  Every 1k tokens you move into files read on demand saves 1k per session.',
    );
  }
  lines.push('', '## Where the fixed overhead comes from', '', '| | est. tokens |', '|---|---:|');
  for (const f of c.files) lines.push(`| ${f.what} (${f.path}) | ${fmt(f.tokens)} |`);
  lines.push(`| Skill listing: ${visible.length} visible of ${c.skills.length} skills | ${fmt(listing)} |`);
  if (c.mcp.length) lines.push(`| ${c.mcp.length} MCP servers | not measurable offline |`);
  if (base) {
    const rest = Math.max(0, base.median - fileTokens - listing);
    lines.push(`| Everything else: Claude Code's own prompt, built-in tools, MCP and plugin tool definitions | ~${fmt(rest)} |`);
  }
  lines.push(
    '',
    '_Estimates: files at ~4 bytes per token; skill entries from their SKILL.md (Claude Code may shorten the listing to fit its budget, so real savings can be lower)._',
  );
  return lines.join('\n');
}

const tok = (/** @type {number} */ chars) => Math.round(chars / 4);

/**
 * From a measured startup breakdown: MCP servers and listed skills unused in the period, with their exact size.
 * @param {import('./startup.mjs').Piece[]} pieces
 * @param {Activity} used
 * @param {string[]} [keep] the `trim keep` list: unused, but never counted as a cut; named in `kept`
 */
export function measuredSavings(pieces, used, keep = []) {
  const usedMcp = new Set([...used.mcp].map(norm));
  // Instructions and tool names spell a server differently ("claude.ai Postman" / "claude_ai_Postman"): merge by normalized name.
  /** @type {Map<string, {name:string, chars:number}>} */
  const mcp = new Map();
  for (const p of pieces) {
    if ((p.group === 'MCP server instructions' || p.group === 'Tool names') && p.name !== '(built-in)' && !usedMcp.has(norm(p.name))) {
      const k = norm(p.name);
      const m = mcp.get(k) ?? { name: p.name, chars: 0 };
      m.chars += p.chars;
      if (p.group === 'MCP server instructions') m.name = p.name; // the human spelling
      mcp.set(k, m);
    }
  }
  const skills = pieces.filter((p) => p.group === 'Skill listing' && !skillUsed(p.name, used.skills)).sort((a, b) => b.chars - a.chars);
  const kept = [...mcp.values(), ...skills].filter((x) => keep.some((k) => norm(k) === norm(x.name))).map((x) => x.name);
  const isKept = (/** @type {{name:string}} */ x) => kept.includes(x.name);
  const unusedMcp = [...mcp.values()].filter((m) => !isKept(m)).sort((a, b) => b.chars - a.chars);
  const unusedSkills = skills.filter((s) => !isKept(s));
  const chars = unusedMcp.reduce((a, m) => a + m.chars, 0) + unusedSkills.reduce((a, s) => a + s.chars, 0);
  return { unusedMcp, unusedSkills, tokens: tok(chars), kept };
}

/**
 * Trim report built on the measured starting context of your latest interactive session.
 * @param {ReturnType<typeof baseline>} base
 * @param {{pieces:import('./startup.mjs').Piece[], at:number}} b
 * @param {Activity} used
 * @param {number} days
 * @param {string[]} [keep] the `trim keep` list
 */
export function startupReport(base, b, used, days, keep = []) {
  const s = measuredSavings(b.pieces, used, keep);
  const median = base?.median ?? 0;
  const lines = ['# limitcast trim', ''];
  if (base) {
    lines.push(
      `Your recorded Claude Code sessions start at **${fmt(median)} tokens** before your first message (median of ${base.sessions} interactive sessions).`,
      'That context is re-sent on every turn and to every subagent, so every token you cut stretches your limit windows.',
      '',
    );
  }
  const pct = median ? ` (${Math.round((s.tokens / median) * 100)}% of your starting context)` : '';
  lines.push(
    `## Estimated removable context: ~${fmt(s.tokens)} tokens per session${pct}`,
    '',
    `From things you haven't used in the last ${days} days:`,
    '',
  );
  if (s.unusedMcp.length) {
    const total = s.unusedMcp.reduce((a, m) => a + m.chars, 0);
    lines.push(
      `- **Disable ${s.unusedMcp.length} MCP servers** (~${fmt(tok(total))}): ${s.unusedMcp
        .slice(0, 10)
        .map((m) => `${m.name} ~${fmt(tok(m.chars))}`)
        .join(', ')}${s.unusedMcp.length > 10 ? ', ...' : ''}.`,
      '  Their instructions and tool names load into every session. Remove them in `/mcp`, or move them to the projects that use them.',
    );
  }
  if (s.unusedSkills.length) {
    const total = s.unusedSkills.reduce((a, k) => a + k.chars, 0);
    lines.push(
      `- **Hide ${s.unusedSkills.length} skills from the model** (~${fmt(tok(total))}): ${s.unusedSkills
        .slice(0, 10)
        .map((k) => k.name)
        .join(', ')}${s.unusedSkills.length > 10 ? ', ...' : ''}.`,
      '  Set each to `"user-invocable-only"` under `skillOverrides` in `~/.claude/settings.json`: `/name` still works.',
    );
  }
  if (s.kept.length) lines.push(`- **Would keep ${s.kept.length} on your keep-list** (\`trim --apply\` never touches them): ${s.kept.join(', ')}.`);
  else if (!s.unusedMcp.length && !s.unusedSkills.length) lines.push('- Nothing unused. Everything that loads was used in the period.');

  /** @type {Map<string, number>} */
  const groups = new Map();
  for (const p of b.pieces) groups.set(p.group, (groups.get(p.group) ?? 0) + p.chars);
  const measured = tok([...groups.values()].reduce((a, c) => a + c, 0));
  lines.push('', `## Where your starting context comes from`, '', `Measured from your latest session (${new Date(b.at).toLocaleString()}).`, '');
  lines.push('| | ~tokens | biggest items |', '|---|---:|---|');
  for (const [g, chars] of [...groups].sort((x, y) => y[1] - x[1])) {
    const top = b.pieces
      .filter((p) => p.group === g)
      .sort((x, y) => y.chars - x.chars)
      .slice(0, 3)
      .map((p) => `${p.name.replace(/^\/Users\/[^/]+/, '~')} ${fmt(tok(p.chars))}`)
      .join(', ');
    lines.push(`| ${g} | ${fmt(tok(chars))} | ${top} |`);
  }
  if (median)
    lines.push(`| Claude Code's own prompt and built-in tool definitions (not in transcripts) | ~${fmt(Math.max(0, median - measured))} | |`);
  const hooks = b.pieces.filter((p) => p.group === 'SessionStart hooks').sort((x, y) => y.chars - x.chars);
  if (hooks.length) {
    lines.push(
      '',
      `**SessionStart hooks inject ~${fmt(tok(hooks.reduce((a, p) => a + p.chars, 0)))} tokens into every session.** If a hook's output isn't needed every time, shorten it or have it print only when relevant.`,
    );
  }
  lines.push('', '_Token counts are estimated at ~4 characters per token._');
  return lines.join('\n');
}

/**
 * A summary safe to post publicly: totals and counts only, no project, file, skill, server or hook names.
 * @param {ReturnType<typeof baseline>} base
 * @param {{pieces:import('./startup.mjs').Piece[]}} b
 * @param {Activity} used
 * @param {number} days
 * @param {string[]} [keep] the `trim keep` list; only its count is shown
 */
export function shareSummary(base, b, used, days, keep = []) {
  const s = measuredSavings(b.pieces, used, keep);
  /** @type {Map<string, number>} */
  const groups = new Map();
  for (const p of b.pieces) groups.set(p.group, (groups.get(p.group) ?? 0) + p.chars);
  const median = base?.median ?? 0;
  const lines = [
    `My Claude Code sessions start at ${fmt(median)} tokens before I type.`,
    `limitcast found ~${fmt(s.tokens)} per session${median ? ` (${Math.round((s.tokens / median) * 100)}%)` : ''} I haven't used in ${days} days: ${s.unusedMcp.length} MCP servers, ${s.unusedSkills.length} skills${s.kept.length ? ` (${s.kept.length} more kept on my keep-list)` : ''}.`,
    'Where it comes from:',
    ...[...groups].sort((x, y) => y[1] - x[1]).map(([g, c]) => `  ${g}: ${fmt(tok(c))}`),
  ];
  if (median) lines.push(`  Claude Code's own prompt and tools: ${fmt(Math.max(0, median - tok([...groups.values()].reduce((a, c) => a + c, 0))))}`);
  lines.push('Measured with limitcast (https://limitcast.dev)');
  return lines.join('\n');
}
