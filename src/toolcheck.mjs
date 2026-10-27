// @ts-check
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './store.mjs';

// Large tool-output notice (Pro, PostToolUse hook, installed with --alerts). A tool result enters the context once as
// new tokens and is then re-read on every later call, so a very large one is worth knowing about. The notice goes to
// the user (systemMessage), never the model, once per tool per session, with what to ask for next time.

export const BIG_RESULT = 20_000; // estimated tokens of one result worth a notice

/**
 * The name a tool goes by in reports: MCP tools by server ("mcp:claude_ai_HubSpot"), the rest as they are.
 * @param {string} name
 */
export const toolKey = (name) => (name.startsWith('mcp__') ? `mcp:${name.split('__')[1]}` : name);

/**
 * What to ask for next time, or null when there is nothing to suggest (a Skill loads whole).
 * @param {string} key a toolKey
 */
export function tipFor(key) {
  if (key.startsWith('mcp:')) return 'ask for fewer fields and a smaller limit';
  return (
    /** @type {Record<string, string>} */ ({
      Read: 'ask for a line range (offset and limit) instead of the whole file',
      Bash: 'pipe long output through head, tail or grep',
      Grep: 'narrow the pattern, or add a path or glob',
      WebFetch: 'ask for one section of the page, not all of it',
    })[key] ?? null
  );
}

/**
 * Tokens in a tool result, estimated from its size (about 4 characters each). Works on any result shape.
 * @param {unknown} response
 */
export function resultTokens(response) {
  const text = typeof response === 'string' ? response : (JSON.stringify(response) ?? '');
  return Math.round(text.length / 4);
}

/**
 * "limitcast: that HubSpot get_crm_objects result was ≈25k tokens (≈0.17% of a 5-hour window to write, then re-read on
 * every later call). Next time: ask for fewer fields and a smaller limit." Null under the threshold.
 * @param {string} toolName
 * @param {unknown} response
 * @param {{fresh:number}|null|undefined} calib % of the 5-hour window per million new tokens
 * @param {number} [threshold]
 */
export function toolNotice(toolName, response, calib, threshold = BIG_RESULT) {
  const tokens = resultTokens(response);
  if (tokens < threshold) return null;
  const [, server, ...rest] = toolName.startsWith('mcp__') ? toolName.split('__') : ['', toolName];
  const label = toolName.startsWith('mcp__') ? `${server.replace(/^claude_ai_/, '')} ${rest.join('__')}` : toolName;
  const pct = calib ? ` (≈${((tokens / 1e6) * calib.fresh).toFixed(2)}% of a 5-hour window to write, then re-read on every later call)` : '';
  const tip = tipFor(toolKey(toolName));
  return `limitcast: that ${label} result was ≈${Math.round(tokens / 1000)}k tokens${pct}.${tip ? ` Next time: ${tip}.` : ''}`;
}

const stateFile = () => join(stateDir(), 'tool-check.json');

/**
 * True the first time a tool is flagged in a session, false after that.
 * @param {string} sid
 * @param {string} tool
 */
export function firstFlag(sid, tool) {
  /** @type {Record<string, string[]>} */
  let seen = {};
  try {
    seen = JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    /* first flag */
  }
  if (seen[sid]?.includes(tool)) return false;
  const keep = Object.entries(seen)
    .filter(([k]) => k !== sid)
    .slice(-49); // the 49 most recent other sessions
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(Object.fromEntries([...keep, [sid, [...(seen[sid] ?? []), tool]]])));
  return true;
}
