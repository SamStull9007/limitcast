// @ts-check

const SPAWN_TOOLS = new Set(['Task', 'Agent']);

/**
 * Reason to block a new subagent, or null to allow it.
 * Blocks only when a Claude window is on pace to run out before it resets within `minutes`.
 * A window already at 100% is left to Claude Code: with extra usage enabled, work continues past it.
 * @param {string} tool
 * @param {ReturnType<typeof import('./forecast.mjs').forecastAll>} forecasts
 * @param {number} now epoch ms
 * @param {number} minutes
 */
export function guardDecision(tool, forecasts, now, minutes) {
  if (!SPAWN_TOOLS.has(tool)) return null;
  for (const f of forecasts) {
    if (f.src !== 'claude') continue;
    if (f.verdict === 'AT_RISK' && f.wall !== null && f.wall - now <= minutes * 60_000) {
      const left = Math.max(0, Math.round((f.wall - now) / 60_000));
      return `limitcast: Claude ${f.win} limit is ${f.pct}% used and on pace to run out in ~${left} min, before it resets. ` +
        'Finish with the agents already running, or set LIMITCAST_ALLOW=1 to spawn anyway.';
    }
  }
  return null;
}
