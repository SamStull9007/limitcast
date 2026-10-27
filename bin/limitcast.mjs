#!/usr/bin/env node
// @ts-check
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyTrim,
  claudeJsonPath,
  installedPlugins,
  localSkillFolders,
  planTrim,
  projectMcpServers,
  reapplyTrim,
  stillLoading,
  transcriptCwd,
  undoTrim,
} from '../src/apply.mjs';
import { calibrate, limitChange, limitChangeMessage, windowPct } from '../src/calibrate.mjs';
import { applyCodexTrim, codexConfigPath, codexServers, codexStartup, codexTrimReport, codexUsedServers, undoCodexTrim } from '../src/codex.mjs';
import { coldCost, coldMessage, firstWarning } from '../src/cold.mjs';
import { forecastAll, oneClaudeAccount, resetTarget } from '../src/forecast.mjs';
import { formatChecks } from '../src/formats.mjs';
import { runGuard } from '../src/guard.mjs';
import { accountForecasts, compactHint, headroom, lastCall, lastCallTokens } from '../src/hints.mjs';
import { htmlPage } from '../src/html.mjs';
import { doctor, install, installedFeatures, readSettings, settingsPath, uninstall } from '../src/install.mjs';
import { activate, currentLicense, isPro, startTrial, trialStatus, UPGRADE_URL } from '../src/license.mjs';
import { buildNotifierApp, loadChannels, notifierApp, notifyChanges, notifyEnabled, send, setChannel, setNotify } from '../src/notify.mjs';
import { driftMessage, loadOverhead, recordOverhead, savedPerSession, savedSummary, snapshot } from '../src/overhead.mjs';
import { activatePolar, deactivatePolar, refreshDue, refreshPolar } from '../src/polar.mjs';
import { burnReport } from '../src/report.mjs';
import { loadBlocks, logBlock, resultsReport, resultsShare, resultsStats, weeklyDue, weeklyLine } from '../src/results.mjs';
import { claudeSamples, readCodex } from '../src/sources.mjs';
import { countInteractiveSince, latestInteractiveTranscript } from '../src/startup.mjs';
import { KEEP_MS, load, record, stateDir } from '../src/store.mjs';
import { budgetSpent, getBudget, loadSubagents, logSubagent, receiptMessage, setBudget, subagentUsage, windowStart } from '../src/subagents.mjs';
import { forTerminal } from '../src/term.mjs';
import { firstFlag, toolKey, toolNotice } from '../src/toolcheck.mjs';
import { baseline, contributors, measuredSavings, shareSummary, startupReport, trimReport } from '../src/trim.mjs';
import { claudeRoot, grokRoot, readUsage } from '../src/usage.mjs';
import { dailyDue, foldEvents, loadValue, saveValue, scanSessions, valueSection, valueTotals } from '../src/value.mjs';
import { attribute, jobsReport, whyReport, whySessions } from '../src/where.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const HELP = `limitcast ${VERSION}: stretch your Claude Code and Codex plans

  limitcast install [--guard]        wire limitcast into Claude Code (and, with --guard, Codex); backs up settings
                                     (without Pro the guard is a preview: it records what it would block, never blocks)
  limitcast uninstall                remove it and restore your original status line
  limitcast doctor [--fix]           check the setup (--fix: re-install with this Node, e.g. after a Node upgrade)
  limitcast trial                    Pro free for 7 days on this computer, no card
  limitcast status [--json]         used, burn rate, runout time, reset, and today's share of each weekly window
  limitcast trim [--share]           tokens every session loads before you type, and how much you never use
  limitcast trim --codex             the same for Codex: AGENTS.md size and MCP servers you haven't used
  limitcast results [--days N]       limits you reached, how far ahead limitcast warned, what the guard blocked
                    [--share]        totals only, safe to post
  limitcast license                  show the license and re-check it with Polar

  Pro (${UPGRADE_URL})
  limitcast trim [--days N] [--share]        names what to cut and what each costs
                                             (--share: totals only, no names, safe to post)
  limitcast trim --apply / --undo            hide those skills and turn off those MCP servers (backed up, reversible)
  limitcast trim --codex --apply / --undo    turn off unused Codex MCP servers (enabled = false; reversible)
  limitcast saved                            tokens saved since limitcast first measured you
  limitcast install --guard                  block new subagents when a window is on pace to run out, and run
                                             them on Sonnet while a window is tight (NEAR or AT_RISK); show what
                                             each finished subagent cost, and what that kind has cost before a new
                                             one starts; hold the first message after the prompt
                                             cache expired (idle over 60 min, LIMITCAST_CACHE_MINUTES) and say what it costs
  limitcast budget subagents <percent>|off   hold new subagents once they used that much of the 5-hour window
  limitcast install --alerts                 tell you when your starting context grows, plus a weekly summary, and
                                             when one tool result is very large (about 20k tokens), with what to ask for instead
  limitcast notify on|off|test               desktop notification when a window turns NEAR, AT_RISK or HIT, or resets,
                                             and when your Claude limit itself changes
  limitcast notify ntfy <topic|url>|off      also send them to your phone (ntfy.sh)
  limitcast notify webhook <url>|off         also send them to a Slack or Discord webhook
  limitcast after-reset [--src claude|codex] [--window 5h|7d] [--detach] -- <command>
                                             run a heavy job once the window has reset
  limitcast results --html [--out FILE]      results, current windows and the burn report as one page
  limitcast report [--days N] [--out FILE]   tokens by tool, day, project, model and session
  limitcast report --why [--days N]          where the new tokens went: subagents, session starts, cache rebuilds, tool results
  limitcast report --jobs [--days N]         the scheduled (headless) jobs that spend the most tokens just starting
  (status line, Pro: points to another account with room, and suggests /compact past ~150k tokens a call)
  limitcast activate <license-key>           unlock Pro on this computer (online once; then a weekly check, offline up to 30 days)
  limitcast deactivate                       free this computer's activation to use the key elsewhere

  Used by Claude Code and Codex (set up by install)
  limitcast statusline [-- <cmd...>]  record limit readings, then run your status-line command
  limitcast guard                     PreToolUse hook (Pro)
  limitcast prompt-check              UserPromptSubmit hook: the cold-cache warning (Pro)
  limitcast subagent-receipt          SubagentStop hook: what the subagent cost (Pro)
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
    // Pro: the other Claude accounts limitcast has current readings for (the table shows the latest one).
    if (isPro())
      for (const a of accountForecasts(load(now - KEEP_MS), now).slice(1))
        console.log(
          `other Claude account (last used ${clock(a.lastSeen)}): ${a.rows.map((f) => `${f.win} ${f.verdict === 'RESET' ? 0 : Math.round(f.pct)}%${f.verdict === 'OK' || f.verdict === 'RESET' ? '' : ` ${f.verdict}`}`).join(' · ')}`,
        );
    if (existsSync(grokRoot())) console.log('grok: no limit readings (Grok keeps none on disk); its token use is in `limitcast report`');
  }
} else if (cmd === 'statusline') {
  const input = readStdin();
  let sid;
  /** @type {string[]} */
  const hints = [];
  try {
    const feed = JSON.parse(input);
    sid = feed?.session_id;
    record(claudeSamples(feed, now));
    saveFeedShape(feed);
    // Hook-only Pro users never run an interactive command, so the weekly Polar check starts here, detached.
    if (refreshDue(now)) spawn(process.execPath, [fileURLToPath(import.meta.url), 'license'], { detached: true, stdio: 'ignore' }).unref();
    // Readings are kept 8 days; the daily rollup folds what they showed into the long-term value record.
    if (dailyDue(now)) spawn(process.execPath, [fileURLToPath(import.meta.url), 'rollup'], { detached: true, stdio: 'ignore' }).unref();
    const health = healthHint();
    if (health) hints.push(health);
    if (isPro()) {
      const samples = load(now - KEEP_MS);
      if (notifyEnabled()) notifyChanges(forecastAll(oneClaudeAccount(samples, sid), now), clock);
      const room = headroom(samples, sid, now);
      if (room) hints.push(room);
      const ctx = typeof feed?.transcript_path === 'string' ? compactHint(lastCallTokens(feed.transcript_path)) : null;
      if (ctx) hints.push(ctx);
    } else {
      const week = freeWeeklyHint(now);
      if (week) hints.push(week);
    }
  } catch {
    /* never break the status line */
  }
  const sep = args.indexOf('--');
  const wrapped = sep >= 0 ? args.slice(sep + 1) : [];
  if (wrapped.length) {
    const r = spawnSync(wrapped[0], wrapped.slice(1), { input, stdio: ['pipe', 'pipe', 'inherit'] });
    // Your status line stays as it was; limitcast adds its own line under it (status scripts often printf without a newline).
    const yours = r.stdout?.toString() ?? '';
    process.stdout.write(yours && !yours.endsWith('\n') ? `${yours}\n` : yours);
    let line = 'waiting for data';
    try {
      line = oneLine(forecastAll(oneClaudeAccount(load(now - KEEP_MS), sid), now)).replace(/^limitcast: /, '');
    } catch {
      /* never break the status line */
    }
    console.log(`limitcast: ${[line, ...hints].join(' · ')}`);
    process.exit(r.status ?? 1);
  }
  console.log([oneLine(forecastAll(oneClaudeAccount(load(now - KEEP_MS), sid), now)), ...hints].join(' · '));
} else if (cmd === 'guard') {
  // Blocking is Pro; without a valid license the guard only previews (logs what Pro would block) and allows everything.
  if (process.env.LIMITCAST_ALLOW === '1') process.exit(0);
  try {
    const d = await runGuard(JSON.parse(readStdin()), now, Number(process.env.LIMITCAST_GUARD_MINUTES ?? 30), { preview: !isPro() });
    if (typeof d === 'string') {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d } }));
    } else if (d && 'notice' in d) {
      // Allowed as is, with what this kind of subagent has cost so far (shown to the user, never the model).
      console.log(JSON.stringify({ systemMessage: d.notice }));
    } else if (d) {
      // Model switch: allow the spawn with the same input and model "sonnet" (updatedInput replaces the whole input).
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: d.reason,
            updatedInput: d.updatedInput,
          },
        }),
      );
    }
  } catch (e) {
    // Fail open: a broken governor must not stop the agent.
    console.error(`limitcast guard skipped: ${e instanceof Error ? e.message : e}`);
  }
} else if (cmd === 'prompt-check') {
  // UserPromptSubmit hook: hold the first message after the prompt cache expired, once, with its cost.
  // Pro blocks; free only records what Pro would have held. Fails open.
  try {
    const hook = JSON.parse(readStdin());
    const path = hook?.transcript_path;
    const last = process.env.LIMITCAST_ALLOW !== '1' && typeof path === 'string' && existsSync(path) ? lastCall(path) : null;
    const c = coldCost(hook?.prompt, last, now, { minutes: Number(process.env.LIMITCAST_CACHE_MINUTES ?? 60), calib: loadValue().calib });
    if (c && last && firstWarning(String(hook.session_id), last.t)) {
      const pro = isPro();
      logBlock({
        t: now,
        kind: 'cold',
        src: 'claude',
        win: '5h',
        pct: c.pct ?? 0,
        wall: now,
        reset: now,
        tokens: c.tokens,
        sid: hook.session_id,
        ...(pro ? {} : { shadow: true }),
      });
      if (pro) console.log(JSON.stringify({ decision: 'block', reason: coldMessage(c) }));
    }
  } catch {
    /* a hook must never stop a prompt by failing */
  }
} else if (cmd === 'tool-check') {
  // PostToolUse hook (Pro, installed with --alerts): tell the user, once per tool per session, about a very large tool
  // result and what to ask for next time. Never reaches the model.
  try {
    if (isPro()) {
      const hook = JSON.parse(readStdin());
      const name = String(hook?.tool_name ?? '');
      const notice = name ? toolNotice(name, hook?.tool_response, loadValue().calib, Number(process.env.LIMITCAST_TOOL_TOKENS) || undefined) : null;
      if (notice && firstFlag(String(hook.session_id), toolKey(name))) console.log(JSON.stringify({ systemMessage: notice }));
    }
  } catch {
    /* a hook must never break the session */
  }
} else if (cmd === 'subagent-receipt') {
  // SubagentStop hook: price the finished subagent against the 5-hour window and log it (for budgets and results).
  // Pro shows the receipt to the user (systemMessage, never the model). Internal agents (empty type) are skipped.
  try {
    const hook = JSON.parse(readStdin());
    const path = hook?.agent_transcript_path;
    if (hook?.agent_type && typeof path === 'string') {
      const u = subagentUsage(path);
      const calib = loadValue().calib;
      const pct = calib ? windowPct(calib, { writes: u.fresh, reads: u.read }) : null;
      if (u.calls) {
        logSubagent({
          t: now,
          id: hook.agent_id,
          sid: hook.session_id,
          type: hook.agent_type,
          calls: u.calls,
          fresh: u.fresh,
          read: u.read,
          ...(pct === null ? {} : { pct }),
        });
        if (isPro()) console.log(JSON.stringify({ systemMessage: receiptMessage(hook.agent_type, u, pct) }));
      }
    }
  } catch {
    /* a hook must never break the session */
  }
} else if (cmd === 'budget') {
  if (!isPro()) {
    console.log(`Subagent budgets are part of limitcast Pro: ${UPGRADE_URL}`);
    process.exit(2);
  }
  const value = args[1];
  if (args[0] !== 'subagents' || (value !== undefined && value !== 'off' && !(Number(value) > 0 && Number(value) <= 100))) {
    console.log('Usage: limitcast budget subagents <percent of the 5-hour window, 1-100>|off');
    process.exit(1);
  }
  if (value !== undefined) setBudget(value === 'off' ? null : Number(value));
  const budget = getBudget();
  const samples = oneClaudeAccount(load(now - KEEP_MS));
  const start = windowStart(forecastAll(samples, now), now);
  const spent = budgetSpent(loadSubagents(start), new Set(samples.map((s) => s.sid)), new Set(load(now - KEEP_MS).map((s) => s.sid)));
  console.log(
    budget
      ? `Subagent budget: ${budget}% of each 5-hour window. Used this window so far: ≈${spent.toFixed(1)}%. Once it's spent, the guard holds new subagents until the window resets.`
      : `No subagent budget. Subagents used ≈${spent.toFixed(1)}% of this 5-hour window so far. Set one: limitcast budget subagents 15`,
  );
  if (budget && !installedFeatures().guard) console.log('The budget is enforced by the guard: limitcast install --guard');
  if (budget && !loadValue().calib)
    console.log(
      'limitcast prices subagents from your own limit readings, which takes about a day of use; until then nothing counts against the budget.',
    );
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
  // First run: show the number that matters right away, and what comes next.
  try {
    const latest = await latestInteractiveTranscript(claudeRoot());
    if (latest) {
      recordOverhead(snapshot(latest));
      /** @type {Map<string, number>} */
      const groups = new Map();
      for (const p of latest.pieces) groups.set(p.group, (groups.get(p.group) ?? 0) + p.chars);
      const k = (/** @type {number} */ c) => `${(c / 4000).toFixed(1)}k`;
      const total = [...groups.values()].reduce((a, c) => a + c, 0);
      const top = [...groups].sort((a, b) => b[1] - a[1]).slice(0, 3);
      console.log(
        [
          '',
          `Your last Claude Code session loaded ~${k(total)} tokens of hooks, MCP servers, skills and instruction files before you typed`,
          `(biggest: ${top.map(([g, c]) => `${g} ${k(c)}`).join(', ')}). It's re-sent on every turn and to every subagent.`,
          'See what you never use: limitcast trim',
        ].join('\n'),
      );
    }
  } catch {
    /* no transcripts yet */
  }
  console.log(
    `In a week, \`limitcast results\` shows every limit you hit and how far ahead limitcast warned you.${isPro() ? '' : ' Try Pro free for 7 days, no card: limitcast trial'}`,
  );
} else if (cmd === 'uninstall') {
  const changes = uninstall();
  console.log(changes.length ? changes.map((c) => `✓ ${c}`).join('\n') : 'Nothing to remove.');
} else if (cmd === 'doctor') {
  if (args.includes('--fix')) {
    // Re-install what is installed, with this Node and this copy of limitcast (after a Node upgrade, say).
    const f = installedFeatures();
    if (!f.statusLine) console.log('limitcast is not installed. Run `limitcast install` first.');
    else {
      for (const c of install({ guard: f.guard && isPro(), alerts: f.alerts && isPro() })) console.log(`✓ ${c}`);
      console.log('Restart Claude Code to load it. Codex asks you to approve the guard again: start Codex and accept it.');
    }
  }
  const checks = await healthChecks();
  saveHealth(checks);
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.line}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
} else if (cmd === 'report' || cmd === 'trim') {
  const pro = isPro();
  if (!pro && cmd === 'report') {
    console.log(
      `\`limitcast ${cmd}\` is part of limitcast Pro: ${UPGRADE_URL}\nTry it free for 7 days: limitcast trial. Already bought it? limitcast activate <license-key>`,
    );
    process.exit(2);
  }
  const since = now - days() * 86400_000;
  if (cmd === 'trim' && args.includes('--codex')) {
    // Codex: AGENTS.md and the MCP servers in ~/.codex/config.toml. Free counts them; Pro names them and turns them off.
    if ((args.includes('--apply') || args.includes('--undo')) && !pro) {
      console.log(`\`limitcast trim --codex --apply\` is part of limitcast Pro: ${UPGRADE_URL}`);
      process.exit(2);
    }
    if (args.includes('--undo')) {
      const e = undoCodexTrim();
      console.log(
        e ? `✓ Back to how they were: ${e.servers.map((s) => s.name).join(', ')}. Takes effect in your next Codex session.` : 'Nothing to undo.',
      );
      process.exit(0);
    }
    if (!existsSync(codexConfigPath())) {
      console.log(`No Codex setup found (${codexConfigPath()}). Set CODEX_HOME if Codex keeps it elsewhere.`);
      process.exit(0);
    }
    const servers = codexServers(readFileSync(codexConfigPath(), 'utf8'));
    const r = codexTrimReport({ servers, used: await codexUsedServers(since), startup: await codexStartup(), days: days(), pro });
    if (args.includes('--apply')) {
      const changed = applyCodexTrim(r.unused);
      console.log(
        changed.length
          ? `✓ Turned off ${changed.length} Codex MCP servers (enabled = false in ${codexConfigPath()}): ${changed.map((s) => s.name).join(', ')}\nTakes effect in your next Codex session. Undo: limitcast trim --codex --undo`
          : 'Nothing to turn off: every server that is on was used.',
      );
    } else console.log(forTerminal(r.text));
    process.exit(0);
  }
  /** @type {import('../src/trim.mjs').Activity} */
  const used = { skills: new Set(), mcp: new Set() };
  const jobs = cmd === 'report' && args.includes('--jobs');
  const why = cmd === 'report' && args.includes('--why');
  const usage = why || jobs ? [] : await readUsage(since, {}, cmd === 'trim' ? used : undefined);
  let text;
  if (why || jobs) {
    const r = attribute(await whySessions(claudeRoot(), since), since);
    text = jobs ? jobsReport(r, { since, now }) : whyReport(r, { since, now, calib: loadValue().calib });
  } else if (cmd === 'report') text = burnReport(usage, { since, now });
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
        console.log(
          `\`limitcast trim --apply\` is part of limitcast Pro: ${UPGRADE_URL}\nTry it free for 7 days: limitcast trial. Already bought it? limitcast activate <license-key>`,
        );
        process.exit(2);
      }
      console.log(args.includes('--undo') ? undoMessage(undoTrim()) : applyMessage(latest, used));
      process.exit(0);
    }
    if (latest && (args.includes('--share') || !pro)) text = shareSummary(baseline(usage), latest, used, days());
    else text = latest ? startupReport(baseline(usage), latest, used, days()) : trimReport(baseline(usage), contributors(), used, days());
    if (!pro)
      text += `\n\nPro names each item and what it costs, so you can cut it: ${UPGRADE_URL}\nTry it free for 7 days: limitcast trial. Already bought it? limitcast activate <license-key>`;
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
  } else console.log(forTerminal(text));
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
      // Claude Code may have rewritten the files `trim --apply` changed: put the cuts back for the next session.
      const re = reapplyTrim();
      if (re.reapplied.length)
        lines.push(
          `limitcast: Claude Code had undone ${re.reapplied.length} of your trim cuts; they're back from your next session. (limitcast trim --undo to drop them)`,
        );
      // Once a week, what limitcast did: shown to the user at session start, never to the model.
      if (weeklyDue(now)) {
        const since = now - 7 * 86400_000;
        const samples = [...load(since), ...(await readCodex(since))];
        const s = loadOverhead();
        // The daily rollup keeps the value record current; a session-start hook must not scan transcripts itself.
        const week = Object.values(loadValue().sessions).filter((x) => x.at >= since);
        lines.push(
          weeklyLine(
            resultsStats({ now, days: 7, samples, blocks: loadBlocks(since), pro: true }),
            s ? savedPerSession(s) : null,
            week.reduce((a, x) => a + x.turns * x.savedPerTurn, 0),
          ),
        );
      }
      if (lines.length) console.log(JSON.stringify({ systemMessage: lines.join('\n') }));
    } else if (!latest) console.log('No interactive Claude Code session found yet.');
    else if (!d) console.log('Starting context recorded. limitcast will tell you when it grows.');
    else console.log(d.alert ? forTerminal(driftMessage(d)) : 'No meaningful change in your starting context since the last session.');
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
  console.log(
    forTerminal(s ? savedSummary(s, await countInteractiveSince(claudeRoot(), s.first.at)) : 'Nothing measured yet. Run `limitcast trim` first.'),
  );
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
        ? savedSummary(s, 0).split('\n')[0] // the per-session drop; the value section above has the totals
        : 'Run `limitcast trim` once to record your starting context, then check back here.';
  }
  const samples = [...load(since), ...(await readCodex(since))];
  const blocks = loadBlocks(since);
  const totals = valueTotals(await refreshValue());
  if (args.includes('--share'))
    console.log(
      resultsShare(resultsStats({ now, days: days(), samples, blocks, pro }), {
        days: days(),
        pro,
        savedPerSession: perSession,
        notResent: totals.tokens,
      }),
    );
  else if (args.includes('--html')) {
    // Pro: results, the current windows and the burn report on one page, opened in the browser.
    if (!pro) {
      console.log(`The HTML dashboard is part of limitcast Pro: ${UPGRADE_URL}`);
      process.exit(2);
    }
    const rows = forecastAll(oneClaudeAccount([...load(now - KEEP_MS), ...(await readCodex(now - KEEP_MS))]), now);
    const burn = burnReport(await readUsage(since, {}), { since, now }).replace(/^(#{1,2}) /gm, '#$1 ');
    const md = [
      resultsReport({ now, days: days(), samples, blocks, pro, saved, value: valueSection(totals, { now, pro }), subagents: loadSubagents(since) }),
      '## Right now',
      '```',
      rows.length ? table(rows) : 'No readings yet.',
      '```',
      burn,
    ].join('\n\n');
    const out = flag('--out') ?? join(stateDir(), 'dashboard.html');
    writeFileSync(out, htmlPage(md, { title: 'limitcast dashboard', generated: new Date(now).toLocaleString() }));
    console.log(`Wrote ${out}`);
    if (!args.includes('--no-open')) {
      const opener = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [out], { detached: true, stdio: 'ignore' });
      opener.on('error', () => {});
      opener.unref();
    }
  } else
    console.log(
      forTerminal(
        resultsReport({ now, days: days(), samples, blocks, pro, saved, value: valueSection(totals, { now, pro }), subagents: loadSubagents(since) }),
      ),
    );
} else if (cmd === 'notify') {
  // Desktop notifications from the status line (Pro, opt-in).
  if (!isPro()) {
    console.log(`Desktop notifications are part of limitcast Pro: ${UPGRADE_URL}`);
    process.exit(2);
  }
  const what = args[0];
  if (what === 'ntfy' || what === 'webhook') {
    // Phone (ntfy) or Slack/Discord: every notification also goes there; setting one turns notifications on.
    const err = args[1] ? setChannel(what, args[1]) : 'Usage: limitcast notify ntfy <topic|https-url>|off, or notify webhook <https-url>|off';
    if (err) {
      console.log(err);
      process.exit(1);
    }
    if (args[1] !== 'off') {
      setNotify(true);
      send('limitcast notifications work.');
    }
    const ch = loadChannels();
    console.log(
      args[1] === 'off'
        ? `Stopped sending to ${what === 'ntfy' ? 'ntfy' : 'the webhook'}.`
        : `Sent a test to ${what === 'ntfy' ? `${ch.ntfy} (subscribe to that topic in the ntfy app)` : 'the webhook'}. Notifications are on. limitcast sends only the notification text there.`,
    );
    process.exit(0);
  }
  if (what === 'on' || what === 'off') setNotify(what === 'on');
  // macOS: limitcast's own notifier app, so it shows up as "limitcast" in System Settings → Notifications.
  const mac = process.platform === 'darwin';
  const app = mac && (what === 'on' || what === 'test') && !existsSync(notifierApp()) ? buildNotifierApp() : mac && existsSync(notifierApp());
  if (mac && (what === 'on' || what === 'test') && !app) console.log('Could not build the notifier app; falling back to osascript.');
  if (what === 'on' || what === 'test') send('limitcast notifications work.');
  console.log(
    what === 'test' || what === 'on'
      ? mac
        ? 'Sent a test notification. The first one asks to allow notifications from "limitcast"; if you missed it, turn it on in System Settings → Notifications → limitcast.'
        : 'Sent a test notification. Nothing showed up? Install notify-send.'
      : '',
  );
  if (what !== 'test')
    console.log(
      `Notifications are ${notifyEnabled() ? 'on: you get one when a Claude window turns NEAR, AT_RISK or HIT, and when it resets after a HIT' : 'off'}. (limitcast notify on|off|test)`,
    );
} else if (cmd === 'after-reset') {
  // Run a command once a window has reset: queue the heavy job instead of watching the clock.
  if (!isPro()) {
    console.log(`\`limitcast after-reset\` is part of limitcast Pro: ${UPGRADE_URL}`);
    process.exit(2);
  }
  const sep = args.indexOf('--');
  const command = sep >= 0 ? args.slice(sep + 1) : [];
  const src = flag('--src') ?? 'claude';
  const win = flag('--window') ?? '5h';
  if (!command.length) {
    console.log('Usage: limitcast after-reset [--src claude|codex] [--window 5h|7d] [--detach] -- <command...>');
    process.exit(1);
  }
  const samples = src === 'codex' ? await readCodex(now - KEEP_MS) : oneClaudeAccount(load(now - KEEP_MS));
  const f = forecastAll(samples, now).find((x) => x.src === src && x.win === win);
  if (!f) {
    console.log(`No ${src} ${win} readings yet, so the reset time is unknown.`);
    process.exit(1);
  }
  const at = resetTarget(f, now);
  if (args.includes('--detach')) {
    mkdirSync(stateDir(), { recursive: true });
    const log = join(stateDir(), `after-reset-${now}.log`);
    const out = openSync(log, 'a');
    const rest = args.filter((a) => a !== '--detach');
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'after-reset', ...rest], { detached: true, stdio: ['ignore', out, out] }).unref();
    console.log(`Will run at ${clock(at)} (after the ${src} ${win} reset), in the background. Output: ${log}`);
    process.exit(0);
  }
  if (at > now) console.log(`Waiting for the ${src} ${win} reset at ${clock(at)}…`);
  // Short sleeps against the wall clock, so a laptop that sleeps through the reset still wakes on time.
  while (Date.now() < at) await new Promise((r) => setTimeout(r, Math.min(60_000, at - Date.now())));
  const r = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
  process.exit(r.status ?? 1);
} else if (cmd === 'rollup') {
  // Started daily in the background by the status line: keeps the value record current and checks the setup.
  // Never prints.
  try {
    saveHealth(await healthChecks());
  } catch {
    /* next time */
  }
  try {
    await refreshValue();
  } catch {
    /* next time */
  }
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
  console.log(l === null ? trialLine() : l.ok ? `Pro: ${l.claims.e}` : `License problem: ${l.reason}`);
} else if (cmd === 'trial') {
  // Pro for 7 days on this machine, no card, once.
  if (currentLicense()?.ok) {
    console.log('You already have Pro.');
    process.exit(0);
  }
  const t = startTrial(now);
  if (!t.ok) {
    console.log(t.active ? `Your Pro trial is already running, until ${clock(t.ends)}.` : trialLine());
    process.exit(t.active ? 0 : 2);
  }
  console.log(
    [
      `✓ Pro trial on: 7 days, until ${new Date(t.ends).toLocaleDateString()}. No card, nothing to cancel.`,
      'Try it:',
      '  limitcast install --guard --alerts   block runaway subagents, move them to Sonnet when a window is tight',
      '  limitcast trim --apply               cut the context you never use (limitcast trim --undo reverses it)',
      '  limitcast notify on                  a desktop notification before you hit a limit',
      '  limitcast results                    what it did for you, any time',
      `Keep Pro after the trial: ${UPGRADE_URL}`,
    ].join('\n'),
  );
} else if (cmd === '--version' || cmd === '-v') {
  console.log(VERSION);
} else {
  console.log(HELP);
  process.exit(cmd && !['help', '--help', '-h'].includes(cmd) ? 1 : 0);
}

/** Everything `doctor` checks: setup, data freshness, license, and whether each tool's logs still parse. */
async function healthChecks() {
  // Readings are only stored when they change, so freshness comes from the last feed the status line saw.
  let latest = 0;
  try {
    latest = JSON.parse(readFileSync(join(stateDir(), 'last-feed.json'), 'utf8')).at ?? 0;
  } catch {
    /* never fed */
  }
  const license = currentLicense();
  const checks = doctor({ samplesAgeMs: latest ? now - latest : null, license });
  if (license === null && trialStatus(now)) checks.push({ ok: true, line: trialLine() });
  return [...checks, ...(await formatChecks())];
}

/**
 * Remember the failing checks that need the user (not just "no reading yet": that fixes itself), for the
 * status-line hint, and notify once when a new one appears.
 * @param {{ok:boolean, line:string}[]} checks
 */
function saveHealth(checks) {
  const file = join(stateDir(), 'health.json');
  const failed = checks.filter((c) => !c.ok && !/^(No Claude limit readings|Last Claude reading)/.test(c.line)).map((c) => c.line);
  let before = [];
  try {
    before = JSON.parse(readFileSync(file, 'utf8')).failed ?? [];
  } catch {
    /* first check */
  }
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file, JSON.stringify({ at: now, failed }));
  const fresh = failed.filter((l) => !before.includes(l));
  if (fresh.length && isPro() && notifyEnabled()) send(`limitcast needs a fix: ${fresh[0]} Run: limitcast doctor`);
  return failed;
}

/**
 * Free installs: for one day a week, what the guard preview saw Pro would have done, e.g.
 * "this week Pro would have stopped 2 subagents and moved 5 to Sonnet · limitcast trial". Silent when it's nothing.
 * @param {number} t epoch ms
 */
function freeWeeklyHint(t) {
  const file = join(stateDir(), 'free-weekly.json');
  let from = 0;
  try {
    from = JSON.parse(readFileSync(file, 'utf8')).from ?? 0;
  } catch {
    /* first run: start the clock */
  }
  const WEEK = 7 * 86400_000;
  if (!from || t >= from + 86400_000) {
    // First run starts a week out; afterwards the next day-long showing is a week after this one.
    from = from ? from + Math.ceil((t - from - 86400_000 + 1) / WEEK) * WEEK : t + WEEK;
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(file, JSON.stringify({ from }));
  }
  if (t < from) return null;
  const preview = loadBlocks(t - WEEK).filter((b) => b.shadow);
  const stopped = preview.filter((b) => !b.kind || b.kind === 'budget').length;
  const moved = preview.filter((b) => b.kind === 'switch').length;
  const cold = preview.filter((b) => b.kind === 'cold').length;
  if (!stopped && !moved && !cold) return null;
  const parts = [
    stopped ? `stopped ${stopped} subagent${stopped === 1 ? '' : 's'}` : '',
    moved ? `moved ${moved} to Sonnet` : '',
    cold ? `caught ${cold} cold-cache message${cold === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `this week Pro would have ${parts.join(' and ')} · limitcast trial`;
}

/** Free tier, a running trial, or an ended one, in one line. */
function trialLine() {
  const t = trialStatus(now);
  if (!t) return `Free tier. Try Pro free for 7 days, no card: limitcast trial. Buy: ${UPGRADE_URL}`;
  if (t.active)
    return `Pro trial: ${Math.ceil((t.ends - now) / 86400_000)} days left (until ${new Date(t.ends).toLocaleDateString()}). Keep Pro: ${UPGRADE_URL}`;
  return `Pro trial ended ${new Date(t.ends).toLocaleDateString()}. Keep Pro: ${UPGRADE_URL}`;
}

/** The status-line hint while the last health check found something to fix. */
function healthHint() {
  try {
    const { failed } = JSON.parse(readFileSync(join(stateDir(), 'health.json'), 'utf8'));
    return failed?.length ? '⚠ run limitcast doctor' : null;
  } catch {
    return null;
  }
}

/** Fold the last 8 days of readings and blocks, and any new sessions, into the long-term value record. */
async function refreshValue() {
  const since = now - KEEP_MS;
  const claude = load(since);
  const o = loadOverhead();
  // limitcast started watching at its first status-line reading (or first measurement), not when Codex's logs begin.
  const start = Math.min(now, o?.first.at ?? now, ...claude.map((s) => s.t));
  const v = foldEvents(loadValue(), { now, samples: [...claude, ...(await readCodex(since))], blocks: loadBlocks(since), start });
  await scanSessions(v, { root: claudeRoot(), baseline: o ? { at: o.first.at, chars: o.first.chars } : null, now });
  // Recalibrate from the last 8 days when there is enough data; keep the last good calibration otherwise.
  const usage = await readUsage(since, {});
  const c = calibrate(claude, usage);
  if (c) v.calib = { ...c, at: now };
  // Once a day, the last 3 days on their own: a lasting shift against earlier days means the limit itself changed.
  const cut = now - 3 * 86400_000;
  const history = v.calibHistory ?? [];
  if (!history.length || now - /** @type {number} */ (history.at(-1)?.at) >= 20 * 3600_000) {
    const recent = calibrate(
      claude.filter((s) => s.t >= cut),
      usage.filter((u) => u.t >= cut),
    );
    if (recent) v.calibHistory = [...history, { ...recent, at: now }].slice(-60);
  }
  const change = limitChange(v.calibHistory ?? []);
  if (change && (!v.limitChange || now - v.limitChange.at > 7 * 86400_000)) {
    v.limitChange = { ...change, at: now };
    if (isPro() && notifyEnabled()) send(limitChangeMessage(change));
  }
  saveValue(v);
  return v;
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
    f.today ? todayLabel(f.today) : '-',
    f.verdict,
  ]);
  const head = ['window', 'used', 'burn', 'runs out', 'resets', 'today', 'status'];
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
          `${f.win} ${Math.round(f.pct)}%${f.verdict === 'AT_RISK' ? ` ⚠ out ${clock(f.wall)}` : f.verdict === 'NEAR' ? ' ⚠ near limit' : f.verdict === 'HIT' ? ' ⛔' : ''}` +
          (f.today && f.verdict !== 'HIT' ? ` · today ${todayLabel(f.today)}` : ''),
      )
      .join(' · ') || 'limitcast: waiting for data'
  );
}

/**
 * "6% left" / "3% over" of today's even share of a weekly window.
 * @param {{left:number}} t
 */
function todayLabel(t) {
  const n = Math.round(Math.abs(t.left));
  return t.left >= 0 ? `${n}% left` : `${n}% over`;
}
