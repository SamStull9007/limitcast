// @ts-check

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
  const src = spawnSource(tool);
  if (!src) return null;
  for (const f of forecasts) {
    if (f.src !== src) continue;
    if (f.verdict === 'AT_RISK' && f.wall !== null && f.wall - now <= minutes * 60_000) {
      const left = Math.max(0, Math.round((f.wall - now) / 60_000));
      return (
        `limitcast: ${NAMES[src]} ${f.win} limit is ${f.pct}% used and on pace to run out in ~${left} min, before it resets. ` +
        'Finish with the agents already running, or set LIMITCAST_ALLOW=1 to spawn anyway.'
      );
    }
  }
  return null;
}
