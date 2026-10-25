// @ts-check
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/**
 * One piece of the context Claude Code loads before your first message, measured from the transcript.
 * @typedef {{group:string, name:string, chars:number}} Piece
 */

/**
 * Break a session's starting context into pieces: SessionStart hook output, MCP server instructions and
 * tool names, the agent list, the skill listing (per skill), instruction files and the output style.
 * Reads the transcript only up to the first model response.
 * @param {string} file transcript .jsonl
 * @returns {Promise<{pieces:Piece[], at:number, entry:string}>}
 */
export async function startupBreakdown(file) {
  /** @type {Piece[]} */
  const pieces = [];
  let at = 0;
  let entry = '';
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.includes('"type":"assistant"')) {
      try {
        const ev = JSON.parse(line);
        at = Date.parse(ev.timestamp) || 0;
        entry = ev.entrypoint ?? '';
      } catch {
        /* torn line: keep what we have */
      }
      break;
    }
    if (!line.includes('"type":"attachment"')) continue;
    let a;
    try {
      a = JSON.parse(line).attachment;
    } catch {
      continue;
    }
    pieces.push(...attachmentPieces(a));
  }
  rl.close();
  return { pieces, at, entry };
}

/**
 * @param {any} a transcript attachment
 * @returns {Piece[]}
 */
export function attachmentPieces(a) {
  switch (a?.type) {
    case 'hook_success': {
      if (a.hookEvent !== 'SessionStart') return [];
      // Plain-text output arrives as `content`; JSON output's additionalContext is inside `stdout`.
      let chars = typeof a.content === 'string' ? a.content.length : 0;
      if (!chars && typeof a.stdout === 'string') {
        try {
          chars = String(JSON.parse(a.stdout)?.hookSpecificOutput?.additionalContext ?? '').length;
        } catch {
          chars = 0;
        }
      }
      return chars ? [{ group: 'SessionStart hooks', name: hookLabel(String(a.command ?? '')), chars }] : [];
    }
    case 'mcp_instructions_delta':
      return (a.addedNames ?? []).map((/** @type {string} */ n, /** @type {number} */ i) => ({
        group: 'MCP server instructions',
        name: n,
        chars: text(a.addedBlocks?.[i]).length,
      }));
    case 'deferred_tools_delta': {
      // One line per tool name; group MCP tools by server.
      /** @type {Map<string, number>} */
      const by = new Map();
      (a.addedLines ?? []).forEach((/** @type {string} */ l, /** @type {number} */ i) => {
        const name = String(a.addedNames?.[i] ?? l);
        const key = name.startsWith('mcp__') ? name.split('__')[1] : '(built-in)';
        by.set(key, (by.get(key) ?? 0) + String(l).length + 1);
      });
      return [...by].map(([name, chars]) => ({ group: 'Tool names', name, chars }));
    }
    case 'agent_listing_delta':
      return [{ group: 'Agent list', name: `${(a.addedLines ?? []).length} agents`, chars: (a.addedLines ?? []).join('\n').length }];
    case 'skill_listing':
      return skillPieces(String(a.content ?? ''));
    case 'instructions':
      return (a.files ?? []).map((/** @type {any} */ f) => ({
        group: 'Instruction files',
        name: String(f.path ?? ''),
        chars: String(f.content ?? '').length,
      }));
    case 'output_style_instructions':
      return [{ group: 'Output style', name: 'output style', chars: text(a.style).length }];
    default:
      return [];
  }
}

/**
 * The skill listing is "- name: description" entries; size each one.
 * @param {string} content
 * @returns {Piece[]}
 */
export function skillPieces(content) {
  return content
    .split(/\n(?=- )/)
    .filter((e) => e.startsWith('- '))
    .map((e) => {
      // Names can contain ':' (plugin:skill); the description starts after the first ': '.
      const body = e.slice(2);
      const i = body.indexOf(': ');
      return { group: 'Skill listing', name: (i >= 0 ? body.slice(0, i) : body).split('\n')[0].trim(), chars: e.length };
    });
}

/** @param {unknown} v */
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/**
 * A readable label for a hook command: the plugin or script name rather than the whole command line.
 * @param {string} cmd
 */
export function hookLabel(cmd) {
  const plugin = cmd.match(/plugins\/(?:cache\/)?[^/]+\/([^/]+)/)?.[1];
  if (plugin) return plugin;
  // Plugin hooks often hide behind ${CLAUDE_PLUGIN_ROOT}; the file they run or print is the best name.
  const script = cmd.match(/([\w.-]+\.(?:md|txt|py|sh|js|mjs|cjs|cmd|ts|rb))\b/)?.[1];
  return script ?? cmd.slice(0, 50);
}

/**
 * The most recently active interactive (launched from the CLI, not a subagent or SDK run) transcript.
 * @param {string} root ~/.claude/projects
 * @param {number} [scan] how many recent transcripts to check
 */
export async function latestInteractiveTranscript(root, scan = 40) {
  /** @type {{p:string, m:number}[]} */
  const files = [];
  try {
    for (const proj of readdirSync(root, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      for (const f of readdirSync(join(root, proj.name), { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          const p = join(root, proj.name, f.name);
          files.push({ p, m: statSync(p).mtimeMs });
        }
      }
    }
  } catch {
    return null;
  }
  for (const { p } of files.sort((a, b) => b.m - a.m).slice(0, scan)) {
    const b = await startupBreakdown(p);
    if (b.entry === 'cli' && b.pieces.length) return { file: p, ...b };
  }
  return null;
}
