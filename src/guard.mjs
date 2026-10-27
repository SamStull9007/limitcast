// @ts-check
import { forecastAll, oneClaudeAccount } from './forecast.mjs';
import { grokSamples } from './grok.mjs';
import { logBlock } from './results.mjs';
import { readCodex } from './sources.mjs';
import { KEEP_MS, load } from './store.mjs';
import { budgetMessage, budgetSpent, getBudget, loadSubagents, spawnNotice, windowStart } from './subagents.mjs';

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
 * Grok keeps no % used on disk; `grokSamples` only exist after `limitcast budget grok`, so without a cap its spawns are never blocked.
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
 * @param {{preview?:boolean}} [opts] preview: a free install; log what Pro would block, never block
 */
export async function runGuard(hook, now, minutes, { preview = false } = {}) {
  const tool = String(hook?.tool_name ?? hook?.toolName ?? hook?.tool ?? '');
  const src = spawnSource(tool);
  // Codex: only the last two hours of rollouts, so the hook stays fast. Grok: spend vs the user's dollar cap.
  const samples =
    src === 'claude'
      ? oneClaudeAccount(load(now - KEEP_MS), hook.session_id ?? hook.sessionId)
      : src === 'codex'
        ? await readCodex(now - 2 * 3600_000)
        : src === 'grok'
          ? grokSamples(now)
          : [];
  const forecasts = forecastAll(samples, now);
  const reason = guardDecision(tool, forecasts, now, minutes);
  const f = reason ? blockingForecast(tool, forecasts, now, minutes) : undefined;
  if (f?.wall) {
    // Any session of the blocking account identifies it for `results`.
    const sid = f.src === 'claude' ? samples.find((s) => s.src === 'claude' && s.sid)?.sid : undefined;
    try {
      logBlock({
        t: now,
        src: f.src,
        win: f.win,
        pct: f.pct,
        wall: f.wall,
        reset: f.reset,
        ...(sid ? { sid } : {}),
        ...(preview ? { shadow: true } : {}),
      });
    } catch {
      /* a failed log must not change the decision */
    }
  }
  if (reason) return preview ? null : reason;
  // Pro: hold new Claude subagents once those of this account have used their budget of the current 5-hour window.
  const budget = src === 'claude' ? getBudget() : null;
  if (budget) {
    const start = windowStart(forecasts, now);
    const sid = hook.session_id ?? hook.sessionId;
    const known = new Set(load(now - KEEP_MS).map((s) => s.sid));
    const spent = budgetSpent(loadSubagents(start), new Set([...samples.map((s) => s.sid), sid]), known);
    if (spent >= budget) {
      try {
        logBlock({
          t: now,
          kind: 'budget',
          src: 'claude',
          win: '5h',
          pct: spent,
          wall: now,
          reset: start + 5 * 3600_000,
          sid,
          ...(preview ? { shadow: true } : {}),
        });
      } catch {
        /* a failed log must not change the decision */
      }
      if (!preview) return budgetMessage(spent, budget);
    }
  }
  // Not blocked, but a window is tight: run a new Claude subagent on Sonnet instead of the main (usually Opus) model.
  const input = hook?.tool_input ?? hook?.toolInput;
  const tight = forecasts.find((x) => x.src === 'claude' && (x.verdict === 'AT_RISK' || x.verdict === 'NEAR'));
  if (src !== 'claude') return null;
  if (!tight || !switchable(input?.model)) {
    // Allowed as is: tell the user (never the model) what this kind of subagent has cost so far.
    if (preview) return null;
    const win = forecasts.find((x) => x.src === 'claude' && x.win === '5h' && x.verdict !== 'RESET');
    const notice = spawnNotice(loadSubagents(now - 30 * 86400_000), input?.subagent_type, win);
    return notice ? { notice } : null;
  }
  try {
    logBlock({
      t: now,
      kind: 'switch',
      src: 'claude',
      win: tight.win,
      pct: tight.pct,
      wall: tight.wall ?? tight.reset,
      reset: tight.reset,
      from: input?.model ?? 'default',
      ...(preview ? { shadow: true } : {}),
    });
  } catch {
    /* a failed log must not change the decision */
  }
  if (preview) return null;
  return {
    updatedInput: { ...input, model: SWITCH_TO },
    reason: `limitcast: Claude ${tight.win} limit is ${Math.round(tight.pct)}% used${tight.verdict === 'AT_RISK' ? ' and on pace to run out before it resets' : ''}; this subagent runs on Sonnet. Set LIMITCAST_ALLOW=1 to keep the main model.`,
  };
}

const SWITCH_TO = 'sonnet';

/**
 * Whether a subagent's model is worth switching: unset or "inherit" (the main model, usually Opus), or Opus/Fable.
 * An explicit Sonnet or Haiku is left alone.
 * @param {unknown} model
 */
export const switchable = (model) => model === undefined || model === null || model === 'inherit' || /opus|fable/i.test(String(model));
