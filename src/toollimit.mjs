// @ts-check
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './store.mjs';
import { toolKey } from './toolcheck.mjs';

// PreToolUse: a tool whose recent results are fat, and whose call sets no limit, is denied before it runs.
// Rewriting a limit that is already present but huge keeps the call and caps it. Bash and WebFetch are left
// alone: they have no limit argument, so a missing one is every call. Stats come from `report --why` / `--jobs`.

export const FAT_AVG = 5_000;
export const MIN_CALLS = 3;
const MCP_CAP = 100;
const READ_CAP = 400;
const LIMIT_KEYS = new Set(['limit', 'max_results', 'maxresults', 'page_size', 'pagesize', 'top_k', 'topk', 'first']);

/** @typedef {{avg:number, calls:number}} ToolStat */
/** @typedef {{path:string[], value:number}} LimitField */

/**
 * @param {Map<string, {tokens:number, calls:number}>} tools attribution totals, keyed the way reports key them
 */
export function toolStats(tools) {
  /** @type {Record<string, ToolStat>} */
  const stats = {};
  for (const [key, e] of tools) {
    if (e.calls > 0) stats[key] = { avg: Math.round(e.tokens / e.calls), calls: e.calls };
  }
  return stats;
}

const statsFile = () => join(stateDir(), 'tool-stats.json');

/** @param {Record<string, ToolStat>} stats */
export function saveToolStats(stats) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statsFile(), JSON.stringify(stats));
}

/** @returns {Record<string, ToolStat>} */
export function loadToolStats() {
  try {
    const parsed = JSON.parse(readFileSync(statsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Limit-shaped numbers anywhere in the arguments, a few levels down (MCP tools nest them).
 * @param {unknown} input
 * @returns {LimitField[]}
 */
export function findLimits(input) {
  /** @type {LimitField[]} */
  const found = [];
  const walk = (/** @type {any} */ node, /** @type {string[]} */ path, /** @type {number} */ depth) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    for (const [key, value] of Object.entries(node)) {
      const here = [...path, key];
      if (LIMIT_KEYS.has(key.toLowerCase())) {
        const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
        if (Number.isFinite(n)) found.push({ path: here, value: n });
      } else walk(value, here, depth + 1);
    }
  };
  walk(input, [], 0);
  return found;
}

/**
 * @param {any} input
 * @param {string[]} path
 * @param {number} value
 */
function setAt(input, path, value) {
  const copy = structuredClone(input);
  let node = copy;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
  node[path[path.length - 1]] = value;
  return copy;
}

const k = (/** @type {number} */ n) => `${Math.max(1, Math.round(n / 1000))}k`;

/**
 * What to do with one tool call, or null to leave it alone.
 * Deny reaches the model as the hook reason so it can retry with a limit. A cap rewrites the arguments in place.
 * @param {string} toolName
 * @param {unknown} input
 * @param {Record<string, ToolStat>} stats
 * @returns {{deny:string}|{updatedInput:any, reason:string}|null}
 */
export function toolLimitDecision(toolName, input, stats) {
  const key = toolKey(toolName);
  const stat = stats?.[key];
  if (!stat || stat.calls < MIN_CALLS || stat.avg < FAT_AVG) return null;
  const args = typeof input === 'string' ? tryJson(input) : input;
  const obj = args && typeof args === 'object' ? args : {};
  if (toolName === 'Grep' || key === 'Grep') {
    const path = /** @type {any} */ (obj).path ?? /** @type {any} */ (obj).file_path;
    const glob = /** @type {any} */ (obj).glob;
    if ((typeof path === 'string' && path.trim()) || (typeof glob === 'string' && glob.trim())) return null;
    return {
      deny: `limitcast: Grep results average ≈${k(stat.avg)} tokens a call over ${stat.calls} calls. Add a path or a glob, then retry. Set LIMITCAST_ALLOW=1 to run it as written.`,
    };
  }
  if (toolName !== 'Read' && key !== 'Read' && !toolName.startsWith('mcp__') && !key.startsWith('mcp:')) return null;
  const cap = toolName === 'Read' || key === 'Read' ? READ_CAP : MCP_CAP;
  const limits = findLimits(obj);
  if (limits.some((f) => f.value > 0 && f.value <= cap)) return null;
  const big = limits.find((f) => f.value > cap);
  const label = toolName === 'Read' || key === 'Read' ? 'Read' : key.replace(/^mcp:/, '');
  if (big) {
    return {
      updatedInput: setAt(obj, big.path, cap),
      reason: `limitcast: ${label} results average ≈${k(stat.avg)} tokens a call, so this limit was lowered to ${cap}. Set LIMITCAST_ALLOW=1 to keep ${big.value}.`,
    };
  }
  const what =
    toolName === 'Read' || key === 'Read'
      ? `Pass offset and limit (${cap} lines or fewer)`
      : `Add a limit of ${cap} or fewer, and ask for fewer fields`;
  return {
    deny: `limitcast: ${label} results average ≈${k(stat.avg)} tokens a call over ${stat.calls} calls. This call sets no limit. ${what}, then retry. Set LIMITCAST_ALLOW=1 to run it as written.`,
  };
}

/** @param {string} text */
function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
