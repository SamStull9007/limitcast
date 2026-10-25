#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecastAll, oneClaudeSession } from '../src/forecast.mjs';
import { claudeSamples, readCodex } from '../src/sources.mjs';
import { KEEP_MS, load, record, stateDir } from '../src/store.mjs';
import { guardDecision } from '../src/guard.mjs';

const HELP = `limitcast: forecast when Claude Code and Codex hit their usage limits

  limitcast status [--json]              burn rate, limit time and reset per window
  limitcast statusline [-- <cmd...>]     record Claude limits from the status-line feed,
                                         then run your existing status-line command
  limitcast guard                        PreToolUse hook: block new subagents when on
                                         pace to hit a Claude limit before it resets
`;

const [cmd, ...args] = process.argv.slice(2);
const now = Date.now();

if (cmd === 'status') {
  const rows = forecastAll(oneClaudeSession([...load(now - KEEP_MS), ...(await readCodex(now - KEEP_MS))]), now);
  if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else console.log(rows.length ? table(rows) : 'No data yet. Add `limitcast statusline` to Claude Code, or run Codex once.');
} else if (cmd === 'statusline') {
  const input = readStdin();
  try {
    const feed = JSON.parse(input);
    record(claudeSamples(feed, now));
    saveFeedShape(feed);
  } catch { /* never break the status line */ }
  const sep = args.indexOf('--');
  const wrapped = sep >= 0 ? args.slice(sep + 1) : [];
  if (wrapped.length) {
    const r = spawnSync(wrapped[0], wrapped.slice(1), { input, stdio: ['pipe', 'inherit', 'inherit'] });
    process.exit(r.status ?? 1);
  }
  let sid;
  try { sid = JSON.parse(input).session_id; } catch { /* no session: use the latest */ }
  console.log(oneLine(forecastAll(oneClaudeSession(load(now - KEEP_MS), sid), now)));
} else if (cmd === 'guard') {
  if (process.env.LIMITCAST_ALLOW === '1') process.exit(0);
  try {
    const hook = JSON.parse(readStdin());
    const minutes = Number(process.env.LIMITCAST_GUARD_MINUTES ?? 30);
    const samples = oneClaudeSession(load(now - KEEP_MS), hook.session_id);
    const reason = guardDecision(hook.tool_name, forecastAll(samples, now), now, minutes);
    if (reason) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    }
  } catch (e) {
    // Fail open: a broken governor must not stop the agent.
    console.error(`limitcast guard skipped: ${e instanceof Error ? e.message : e}`);
  }
} else {
  console.log(HELP);
  process.exit(cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0);
}

/**
 * Keep the latest feed's structure (key names and rate_limits only, no prompt or path content) for diagnosing parsing.
 * @param {any} feed
 */
function saveFeedShape(feed) {
  const shape = { at: now, keys: Object.keys(feed ?? {}), session_id: feed?.session_id, rate_limits: feed?.rate_limits };
  writeFileSync(join(stateDir(), 'last-feed.json'), JSON.stringify(shape, null, 2));
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/** @param {number|null} ms */
function clock(ms) {
  if (ms === null) return '-';
  const d = new Date(ms);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
}

/** @param {ReturnType<typeof forecastAll>} rows */
function table(rows) {
  const lines = rows.map((f) => [
    `${f.src} ${f.win}`,
    `${Math.round(f.pct)}%`,
    f.rate === null ? '-' : `${f.rate >= 0 ? '+' : ''}${f.rate.toFixed(1)}%/h`,
    f.verdict === 'AT_RISK' ? clock(f.wall) : '-',
    clock(f.reset),
    f.verdict,
  ]);
  const head = ['window', 'used', 'burn', 'runs out', 'resets', 'status'];
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  return [head, ...lines].map((l) => l.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd()).join('\n');
}

/** @param {ReturnType<typeof forecastAll>} rows */
function oneLine(rows) {
  return rows.filter((f) => f.src === 'claude').map((f) =>
    `${f.win} ${Math.round(f.pct)}%${f.verdict === 'AT_RISK' ? ` ⚠ out ${clock(f.wall)}` : f.verdict === 'HIT' ? ' ⛔' : ''}`,
  ).join(' · ') || 'limitcast: waiting for data';
}
