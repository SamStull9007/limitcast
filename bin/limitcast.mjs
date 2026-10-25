#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecastAll, oneClaudeSession } from '../src/forecast.mjs';
import { claudeSamples, readCodex } from '../src/sources.mjs';
import { KEEP_MS, load, record, stateDir } from '../src/store.mjs';
import { runGuard } from '../src/guard.mjs';
import { claudeRoot, grokRoot, readUsage } from '../src/usage.mjs';
import { burnReport } from '../src/report.mjs';
import { baseline, contributors, shareSummary, startupReport, trimReport } from '../src/trim.mjs';
import { countInteractiveSince, latestInteractiveTranscript } from '../src/startup.mjs';
import { driftMessage, loadOverhead, recordOverhead, savedSummary, snapshot } from '../src/overhead.mjs';
import { formatChecks } from '../src/formats.mjs';
import { activate, currentLicense, isPro, UPGRADE_URL } from '../src/license.mjs';
import { activatePolar, deactivatePolar, refreshPolar } from '../src/polar.mjs';
import { doctor, install, uninstall } from '../src/install.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const HELP = `limitcast ${VERSION}: stretch your Claude Code and Codex plans

  limitcast install [--guard]        wire limitcast into Claude Code (and, with --guard, Codex); backs up settings
  limitcast uninstall                remove it and restore your original status line
  limitcast doctor                   check the setup
  limitcast status [--json]          used, burn rate, runout time and reset per limit window

  Pro (${UPGRADE_URL})
  limitcast trim [--days N] [--share]        tokens every session loads before you type, and what to cut
                                             (--share: totals only, no names, safe to post)
  limitcast saved                            tokens saved since limitcast first measured you
  limitcast install --guard                  block new subagents when a window is on pace to run out
  limitcast install --alerts                 tell you when your starting context grows
  limitcast report [--days N] [--out FILE]   tokens by tool, day, project, model and session
  limitcast activate <license-key>           unlock Pro on this computer (once online, then works offline)
  limitcast deactivate                       free this computer's activation to use the key elsewhere

  Used by Claude Code and Codex (set up by install)
  limitcast statusline [-- <cmd...>]  record limit readings, then run your status-line command
  limitcast guard                     PreToolUse hook (Pro)
  limitcast drift [--hook]            SessionStart hook: compare starting context with the last session (Pro)
`;

const [cmd, ...args] = process.argv.slice(2);
const now = Date.now();
const flag = (/** @type {string} */ name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const days = () => Math.max(1, Number(flag('--days') ?? 7));

// Interactive commands re-check a Polar license weekly; hooks (statusline, guard, drift --hook) never touch the network.
if (['report', 'trim', 'saved', 'drift', 'doctor', 'license'].includes(cmd) && !args.includes('--hook')) {
  await refreshPolar({ force: cmd === 'license' }).catch(() => null);
}

if (cmd === 'status') {
  const rows = forecastAll(oneClaudeSession([...load(now - KEEP_MS), ...(await readCodex(now - KEEP_MS))]), now);
  if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(rows.length ? table(rows) : 'No data yet. Run `limitcast install`, then send a message in Claude Code, or run Codex once.');
    if (existsSync(grokRoot())) console.log('grok: no limit readings (Grok keeps none on disk); its token use is in `limitcast report`');
  }
} else if (cmd === 'statusline') {
  const input = readStdin();
  let sid;
  try {
    const feed = JSON.parse(input);
    sid = feed?.session_id;
    record(claudeSamples(feed, now));
    saveFeedShape(feed);
  } catch {
    /* never break the status line */
  }
  const sep = args.indexOf('--');
  const wrapped = sep >= 0 ? args.slice(sep + 1) : [];
  if (wrapped.length) {
    const r = spawnSync(wrapped[0], wrapped.slice(1), { input, stdio: ['pipe', 'inherit', 'inherit'] });
    process.exit(r.status ?? 1);
  }
  console.log(oneLine(forecastAll(oneClaudeSession(load(now - KEEP_MS), sid), now)));
} else if (cmd === 'guard') {
  // The guard is Pro; without a valid license it allows everything (an expired license must never block work).
  if (process.env.LIMITCAST_ALLOW === '1' || !isPro()) process.exit(0);
  try {
    const reason = await runGuard(JSON.parse(readStdin()), now, Number(process.env.LIMITCAST_GUARD_MINUTES ?? 30));
    if (reason) {
      console.log(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
      );
    }
  } catch (e) {
    // Fail open: a broken governor must not stop the agent.
    console.error(`limitcast guard skipped: ${e instanceof Error ? e.message : e}`);
  }
} else if (cmd === 'install') {
  const wantGuard = args.includes('--guard');
  const wantAlerts = args.includes('--alerts');
  if ((wantGuard || wantAlerts) && !isPro()) {
    console.log(`The subagent guard and alerts are part of limitcast Pro (${UPGRADE_URL}). Installing the free features.`);
  }
  for (const c of install({ guard: wantGuard && isPro(), alerts: wantAlerts && isPro() })) console.log(`✓ ${c}`);
  console.log('Restart Claude Code and Codex to load it. Then: limitcast doctor');
} else if (cmd === 'uninstall') {
  const changes = uninstall();
  console.log(changes.length ? changes.map((c) => `✓ ${c}`).join('\n') : 'Nothing to remove.');
} else if (cmd === 'doctor') {
  // Readings are only stored when they change, so freshness comes from the last feed the status line saw.
  let latest = 0;
  try {
    latest = JSON.parse(readFileSync(join(stateDir(), 'last-feed.json'), 'utf8')).at ?? 0;
  } catch {
    /* never fed */
  }
  const checks = [...doctor({ samplesAgeMs: latest ? now - latest : null, license: currentLicense() }), ...(await formatChecks())];
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.line}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
} else if (cmd === 'report' || cmd === 'trim') {
  if (!isPro()) {
    console.log(`\`limitcast ${cmd}\` is part of limitcast Pro: ${UPGRADE_URL}\nAlready bought it? limitcast activate <license-key>`);
    process.exit(2);
  }
  const since = now - days() * 86400_000;
  /** @type {import('../src/trim.mjs').Activity} */
  const used = { skills: new Set(), mcp: new Set() };
  const usage = await readUsage(since, {}, cmd === 'trim' ? used : undefined);
  let text;
  if (cmd === 'report') text = burnReport(usage, { since, now });
  else {
    // Prefer the measured starting context of the latest interactive session; older Claude Code logs fall back to estimates.
    const latest = await latestInteractiveTranscript(claudeRoot());
    if (latest) recordOverhead(snapshot(latest));
    if (latest && args.includes('--share')) text = shareSummary(baseline(usage), latest, used, days());
    else text = latest ? startupReport(baseline(usage), latest, used, days()) : trimReport(baseline(usage), contributors(), used, days());
  }
  const out = flag('--out');
  if (out) {
    writeFileSync(out, text + '\n');
    console.log(`Wrote ${out}`);
  } else console.log(text);
} else if (cmd === 'drift') {
  // SessionStart hook: tells the user (systemMessage, never the model's context) when starting context grew.
  const hook = args.includes('--hook');
  if (!isPro()) {
    if (!hook) console.log(`\`limitcast drift\` is part of limitcast Pro: ${UPGRADE_URL}`);
    process.exit(hook ? 0 : 2);
  }
  try {
    const latest = await latestInteractiveTranscript(claudeRoot());
    const d = latest ? recordOverhead(snapshot(latest)) : null;
    if (hook) {
      if (d?.alert) console.log(JSON.stringify({ systemMessage: driftMessage(d) }));
    } else if (!latest) console.log('No interactive Claude Code session found yet.');
    else if (!d) console.log('Starting context recorded. limitcast will tell you when it grows.');
    else console.log(d.alert ? driftMessage(d) : 'No meaningful change in your starting context since the last session.');
  } catch (e) {
    if (!hook) throw e; // a hook must never break session start
  }
} else if (cmd === 'saved') {
  if (!isPro()) {
    console.log(`\`limitcast saved\` is part of limitcast Pro: ${UPGRADE_URL}`);
    process.exit(2);
  }
  const latest = await latestInteractiveTranscript(claudeRoot());
  if (latest) recordOverhead(snapshot(latest));
  const s = loadOverhead();
  console.log(s ? savedSummary(s, await countInteractiveSince(claudeRoot(), s.first.at)) : 'Nothing measured yet. Run `limitcast trim` first.');
} else if (cmd === 'activate') {
  // Signed offline keys start with LC1.; anything else is a Polar license key.
  const key = args[0] ?? '';
  const res = key.startsWith('LC1.') ? activate(key) : await activatePolar(key);
  console.log(res.ok ? `✓ limitcast Pro activated${res.claims.e ? ` for ${res.claims.e}` : ''}` : `✗ ${res.reason}`);
  process.exit(res.ok ? 0 : 1);
} else if (cmd === 'deactivate') {
  const res = await deactivatePolar();
  console.log(res.ok ? '✓ This machine is deactivated; the key can be used on another computer.' : `✗ ${res.reason}`);
  process.exit(res.ok ? 0 : 1);
} else if (cmd === 'license') {
  const l = currentLicense();
  console.log(l === null ? `Free tier. Pro: ${UPGRADE_URL}` : l.ok ? `Pro: ${l.claims.e}` : `License problem: ${l.reason}`);
} else if (cmd === '--version' || cmd === '-v') {
  console.log(VERSION);
} else {
  console.log(HELP);
  process.exit(cmd && !['help', '--help', '-h'].includes(cmd) ? 1 : 0);
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
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
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
  return [head, ...lines]
    .map((l) =>
      l
        .map((c, i) => c.padEnd(w[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** @param {ReturnType<typeof forecastAll>} rows */
function oneLine(rows) {
  return (
    rows
      .filter((f) => f.src === 'claude')
      .map((f) => `${f.win} ${Math.round(f.pct)}%${f.verdict === 'AT_RISK' ? ` ⚠ out ${clock(f.wall)}` : f.verdict === 'HIT' ? ' ⛔' : ''}`)
      .join(' · ') || 'limitcast: waiting for data'
  );
}
