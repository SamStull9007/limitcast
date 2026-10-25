#!/usr/bin/env node
// @ts-check
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyTrim,
  claudeJsonPath,
  installedPlugins,
  localSkillFolders,
  planTrim,
  projectMcpServers,
  stillLoading,
  transcriptCwd,
  undoTrim,
} from '../src/apply.mjs';
import { forecastAll, oneClaudeAccount } from '../src/forecast.mjs';
import { formatChecks } from '../src/formats.mjs';
import { runGuard } from '../src/guard.mjs';
import { doctor, install, readSettings, settingsPath, uninstall } from '../src/install.mjs';
import { activate, currentLicense, isPro, UPGRADE_URL } from '../src/license.mjs';
import { driftMessage, loadOverhead, recordOverhead, savedPerSession, savedSummary, snapshot } from '../src/overhead.mjs';
import { activatePolar, deactivatePolar, refreshDue, refreshPolar } from '../src/polar.mjs';
import { burnReport } from '../src/report.mjs';
import { loadBlocks, resultsReport, resultsShare, resultsStats, weeklyDue, weeklyLine } from '../src/results.mjs';
import { claudeSamples, readCodex } from '../src/sources.mjs';
import { countInteractiveSince, latestInteractiveTranscript } from '../src/startup.mjs';
import { KEEP_MS, load, record, stateDir } from '../src/store.mjs';
import { baseline, contributors, measuredSavings, shareSummary, startupReport, trimReport } from '../src/trim.mjs';
import { claudeRoot, grokRoot, readUsage } from '../src/usage.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const HELP = `limitcast ${VERSION}: stretch your Claude Code and Codex plans

  limitcast install [--guard]        wire limitcast into Claude Code (and, with --guard, Codex); backs up settings
                                     (without Pro the guard is a preview: it records what it would block, never blocks)
  limitcast uninstall                remove it and restore your original status line
  limitcast doctor                   check the setup
  limitcast status [--json]          used, burn rate, runout time and reset per limit window
  limitcast trim [--share]           tokens every session loads before you type, and how much you never use
  limitcast results [--days N]       limits you reached, how far ahead limitcast warned, what the guard blocked
                    [--share]        totals only, safe to post
  limitcast license                  show the license and re-check it with Polar

  Pro (${UPGRADE_URL})
  limitcast trim [--days N] [--share]        names what to cut and what each costs
                                             (--share: totals only, no names, safe to post)
  limitcast trim --apply / --undo            hide those skills and turn off those MCP servers (backed up, reversible)
  limitcast saved                            tokens saved since limitcast first measured you
  limitcast install --guard                  block new subagents when a window is on pace to run out
  limitcast install --alerts                 tell you when your starting context grows, plus a weekly summary
  limitcast report [--days N] [--out FILE]   tokens by tool, day, project, model and session
  limitcast activate <license-key>           unlock Pro on this computer (online once; then a weekly check, offline up to 30 days)
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
if (['report', 'trim', 'saved', 'results', 'drift', 'doctor', 'license'].includes(cmd) && !args.includes('--hook')) {
  await refreshPolar({ force: cmd === 'license' }).catch(() => null);
}

if (cmd === 'status') {
  const rows = forecastAll(oneClaudeAccount([...load(now - KEEP_MS), ...(await readCodex(now - KEEP_MS))]), now);
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
    // Hook-only Pro users never run an interactive command, so the weekly Polar check starts here, detached.
    if (refreshDue(now)) spawn(process.execPath, [fileURLToPath(import.meta.url), 'license'], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* never break the status line */
  }
  const sep = args.indexOf('--');
  const wrapped = sep >= 0 ? args.slice(sep + 1) : [];
  if (wrapped.length) {
    const r = spawnSync(wrapped[0], wrapped.slice(1), { input, stdio: ['pipe', 'inherit', 'inherit'] });
    process.exit(r.status ?? 1);
  }
  console.log(oneLine(forecastAll(oneClaudeAccount(load(now - KEEP_MS), sid), now)));
} else if (cmd === 'guard') {
  // Blocking is Pro; without a valid license the guard only previews (logs what Pro would block) and allows everything.
  if (process.env.LIMITCAST_ALLOW === '1') process.exit(0);
  try {
    const reason = await runGuard(JSON.parse(readStdin()), now, Number(process.env.LIMITCAST_GUARD_MINUTES ?? 30), { preview: !isPro() });
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
  if (wantGuard && !isPro()) {
    console.log(
      `Without Pro the subagent guard runs as a preview: it never blocks, it records what Pro would have blocked (see \`limitcast results\`). Pro: ${UPGRADE_URL}`,
    );
  }
  if (wantAlerts && !isPro()) console.log(`Alerts and the weekly summary are part of limitcast Pro (${UPGRADE_URL}). Skipping them.`);
  for (const c of install({ guard: wantGuard, alerts: wantAlerts && isPro() })) console.log(`✓ ${c}`);
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
  const pro = isPro();
  if (!pro && cmd === 'report') {
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
    // Free: the measured totals without names (the --share view); Pro names what to cut.
    if (!pro && !latest) {
      console.log(`\`limitcast trim\` needs one Claude Code session first. Naming what to cut is Pro: ${UPGRADE_URL}`);
      process.exit(2);
    }
    if (args.includes('--apply') || args.includes('--undo')) {
      if (!pro) {
        console.log(`\`limitcast trim --apply\` is part of limitcast Pro: ${UPGRADE_URL}\nAlready bought it? limitcast activate <license-key>`);
        process.exit(2);
      }
      console.log(args.includes('--undo') ? undoMessage(undoTrim()) : applyMessage(latest, used));
      process.exit(0);
    }
    if (latest && (args.includes('--share') || !pro)) text = shareSummary(baseline(usage), latest, used, days());
    else text = latest ? startupReport(baseline(usage), latest, used, days()) : trimReport(baseline(usage), contributors(), used, days());
    if (!pro)
      text += `\n\nPro names each item and what it costs, so you can cut it: ${UPGRADE_URL}\nAlready bought it? limitcast activate <license-key>`;
    else if (latest && !args.includes('--share')) {
      const still = stillLoading(latest);
      text += still.length
        ? `\n\nStill loading after \`trim --apply\`: ${still.join(', ')}. A Claude Code session that was running may have rewritten ~/.claude.json; quit Claude Code and run \`limitcast trim --apply\` again.`
        : measuredSavings(latest.pieces, used).tokens > 0
          ? '\n\nApply these cuts: `limitcast trim --apply` (backed up; `limitcast trim --undo` reverses it).'
          : '';
    }
  }
  const out = flag('--out');
  if (out) {
    writeFileSync(out, `${text}\n`);
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
      const lines = d?.alert ? [driftMessage(d)] : [];
      // Once a week, what limitcast did: shown to the user at session start, never to the model.
      if (weeklyDue(now)) {
        const since = now - 7 * 86400_000;
        const samples = [...load(since), ...(await readCodex(since))];
        const s = loadOverhead();
        lines.push(weeklyLine(resultsStats({ now, days: 7, samples, blocks: loadBlocks(since), pro: true }), s ? savedPerSession(s) : null));
      }
      if (lines.length) console.log(JSON.stringify({ systemMessage: lines.join('\n') }));
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
} else if (cmd === 'results') {
  // Free shows limits reached, how far ahead limitcast warned, and the guard preview; Pro adds real blocks and savings.
  const pro = isPro();
  const since = now - days() * 86400_000;
  let saved = `Pro tracks how much your starting context shrinks and what that saves: ${UPGRADE_URL}`;
  let perSession = null;
  if (pro) {
    const latest = await latestInteractiveTranscript(claudeRoot());
    if (latest) recordOverhead(snapshot(latest));
    const s = loadOverhead();
    perSession = s ? savedPerSession(s) : null;
    saved =
      s && !args.includes('--share')
        ? savedSummary(s, await countInteractiveSince(claudeRoot(), s.first.at))
        : 'Run `limitcast trim` once to record your starting context, then check back here.';
  }
  const samples = [...load(since), ...(await readCodex(since))];
  const blocks = loadBlocks(since);
  if (args.includes('--share'))
    console.log(resultsShare(resultsStats({ now, days: days(), samples, blocks, pro }), { days: days(), pro, savedPerSession: perSession }));
  else console.log(resultsReport({ now, days: days(), samples, blocks, pro, saved }));
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
 * `trim --apply`: hide unused skills and turn off unused MCP servers for the project of the measured session.
 * @param {Awaited<ReturnType<typeof latestInteractiveTranscript>>} latest
 * @param {import('../src/trim.mjs').Activity} used
 */
function applyMessage(latest, used) {
  if (!latest) return '`limitcast trim --apply` needs one Claude Code session first.';
  const s = measuredSavings(latest.pieces, used);
  const cwd = transcriptCwd(latest.file) ?? process.cwd();
  const plan = planTrim({
    skills: s.unusedSkills.map((k) => k.name),
    mcp: s.unusedMcp.map((m) => m.name),
    cwd,
    settings: readSettings(settingsPath()),
    claudeJson: readSettings(claudeJsonPath()),
    plugins: installedPlugins(),
    projectMcpJson: projectMcpServers(cwd),
    localSkills: localSkillFolders(cwd),
  });
  const e = applyTrim(plan, { cwd, now });
  const lines = [];
  if (e.skills.length)
    lines.push(`✓ Hid ${e.skills.length} skills from the model (\`/name\` still works): ${e.skills.map((k) => k.name).join(', ')}`);
  if (e.mcp.length) lines.push(`✓ Turned off ${e.mcp.length} MCP servers for ${cwd}: ${e.mcp.join(', ')}`);
  if (plan.pluginSkills.length) lines.push(`- Plugin skills can only be turned off with their plugin (\`/plugin\`): ${plan.pluginSkills.join(', ')}`);
  if (plan.manualMcp.length) lines.push(`- Turn these off in \`/mcp\` (limitcast couldn't confirm their exact names): ${plan.manualMcp.join(', ')}`);
  if (!e.skills.length && !e.mcp.length) lines.unshift('Nothing to change automatically.');
  else
    lines.push(
      "Takes effect in your next Claude Code session; quit running sessions first so they don't write over ~/.claude.json. Undo: `limitcast trim --undo`",
    );
  return lines.join('\n');
}

/** @param {ReturnType<typeof undoTrim>} e */
function undoMessage(e) {
  if (!e) return 'Nothing to undo.';
  return [
    e.skills.length ? `✓ Skills visible to the model again: ${e.skills.map((k) => k.name).join(', ')}` : '',
    e.mcp.length ? `✓ MCP servers back on for ${e.cwd}: ${e.mcp.join(', ')}` : '',
    'Takes effect in your next Claude Code session.',
  ]
    .filter(Boolean)
    .join('\n');
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
      .map(
        (f) =>
          `${f.win} ${Math.round(f.pct)}%${f.verdict === 'AT_RISK' ? ` ⚠ out ${clock(f.wall)}` : f.verdict === 'NEAR' ? ' ⚠ near limit' : f.verdict === 'HIT' ? ' ⛔' : ''}`,
      )
      .join(' · ') || 'limitcast: waiting for data'
  );
}
