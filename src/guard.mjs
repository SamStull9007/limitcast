// @ts-check
import { forecastAll, oneClaudeAccount } from './forecast.mjs';
import { logBlock } from './results.mjs';
import { readCodex } from './sources.mjs';
import { KEEP_MS, load } from './store.mjs';

const NAMES = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };

/**
 * Whose limits a subagent-spawning tool call draws on, or null if the call spawns nothing.
 * Claude Code: Task/Agent. Codex: spawn_agent (reported with a namespace prefix). Grok: spawn_subagent.
 * @param {string} tool
 * @returns {'claude'|'codex'|'grok'|null}
 */
export function spawnSource(tool) {
  if (tool === 'Task' || tool === 'Agent') return 'claude';
  if (/spawn_agent$/.test(tool)) return 'codex';
  if (tool === 'spawn_subagent') return 'grok';
  return null;
}

/**
 * Reason to block a new subagent, or null to allow it.
 * Blocks only when the spawning tool's own window is on pace to run out before it resets within `minutes`.
 * A window already at 100% is left to the tool: with extra usage enabled, work continues past it.
 * Grok keeps no limit readings on disk, so its spawns are never blocked.
 * @param {string} tool
 * @param {ReturnType<typeof import('./forecast.mjs').forecastAll>} forecasts
 * @param {number} now epoch ms
 * @param {number} minutes
 */
export function guardDecision(tool, forecasts, now, minutes) {
  const f = blockingForecast(tool, forecasts, now, minutes);
  if (!f || f.wall === null) return null;
  const left = Math.max(0, Math.round((f.wall - now) / 60_000));
  return (
    `limitcast: ${NAMES[/** @type {'claude'} */ (f.src)]} ${f.win} limit is ${f.pct}% used and on pace to run out in ~${left} min, before it resets. ` +
    'Finish with the agents already running, or set LIMITCAST_ALLOW=1 to spawn anyway.'
  );
}

/**
 * The forecast that blocks this spawn, or undefined. See guardDecision.
 * @param {string} tool
 * @param {ReturnType<typeof import('./forecast.mjs').forecastAll>} forecasts
 * @param {number} now epoch ms
 * @param {number} minutes
 */
function blockingForecast(tool, forecasts, now, minutes) {
  const src = spawnSource(tool);
  return forecasts.find((f) => f.src === src && f.verdict === 'AT_RISK' && f.wall !== null && f.wall - now <= minutes * 60_000);
}

/**
 * The PreToolUse hook: load the readings for the spawning tool and decide. Returns the deny reason or null.
 * Claude Code and Codex send snake_case fields; Grok sends camelCase.
 * @param {any} hook parsed hook input
 * @param {number} now epoch ms
 * @param {number} minutes
 */
export async function runGuard(hook, now, minutes) {
  const tool = String(hook?.tool_name ?? hook?.toolName ?? hook?.tool ?? '');
  const src = spawnSource(tool);
  // Codex: only the last two hours of rollouts, so the hook stays fast; Grok has no readings to judge by.
  const samples =
    src === 'claude'
      ? oneClaudeAccount(load(now - KEEP_MS), hook.session_id ?? hook.sessionId)
      : src === 'codex'
        ? await readCodex(now - 2 * 3600_000)
        : [];
  const forecasts = forecastAll(samples, now);
  const reason = guardDecision(tool, forecasts, now, minutes);
  const f = reason ? blockingForecast(tool, forecasts, now, minutes) : undefined;
  if (f?.wall) {
    // Any session of the blocking account identifies it for `results`.
    const sid = f.src === 'claude' ? samples.find((s) => s.src === 'claude' && s.sid)?.sid : undefined;
    try {
      logBlock({ t: now, src: f.src, win: f.win, pct: f.pct, wall: f.wall, reset: f.reset, ...(sid ? { sid } : {}) });
    } catch {
      /* a failed log must not change the decision */
    }
  }
  return reason;
}
