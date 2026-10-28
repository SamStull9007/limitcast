#!/usr/bin/env node
// @ts-check
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyTrim,
  claudeJsonPath,
  getKeep,
  installedPlugins,
  isKept,
  localSkillFolders,
  planTrim,
  projectMcpServers,
  reapplyTrim,
  setKeep,
  stillLoading,
  transcriptCwd,
  undoTrim,
} from '../src/apply.mjs';
import { calibrate, limitChange, limitChangeMessage, windowPct } from '../src/calibrate.mjs';
import { applyCodexTrim, codexConfigPath, codexServers, codexStartup, codexTrimReport, codexUsedServers, undoCodexTrim } from '../src/codex.mjs';
import { coldCost, coldMessage, firstWarning } from '../src/cold.mjs';
import { forecastAll, oneClaudeAccount, resetTarget } from '../src/forecast.mjs';
import { formatChecks } from '../src/formats.mjs';
import {
  applyGrokSubagentModel,
  applyGrokTrim,
  getGrokBudget,
  grokConfigPath,
  grokHooksFile,
  grokPresent,
  grokQuotaDue,
  grokQuotaEnabled,
  grokQuotaSamples,
  grokSamples,
  grokServers,
  grokSessionLine,
  grokSpend,
  grokStartup,
  grokTrimReport,
  grokUsedServers,
  readGrokQuota,
  refreshGrokQuota,
  setGrokBudget,
  setGrokQuota,
  touchGrokQuota,
  undoGrokTrim,
} from '../src/grok.mjs';
import { runGuard } from '../src/guard.mjs';
import { accountForecasts, bindingLine, compactHint, headroom, lastCall, lastCallTokens } from '../src/hints.mjs';
import { htmlPage } from '../src/html.mjs';
import { insightsReport, insightsShare, periodInsights } from '../src/insights.mjs';
import { codexHooksPath, detectedHosts, doctor, install, installedFeatures, readSettings, settingsPath, uninstall } from '../src/install.mjs';
import { memoryCheck, memoryDir, memoryReport, scanMemory } from '../src/memory.mjs';
import { buildNotifierApp, loadChannels, notifierApp, notifyChanges, notifyEnabled, send, setChannel, setNotify } from '../src/notify.mjs';
import { onboardingReport } from '../src/onboarding.mjs';
import { driftMessage, loadOverhead, recordOverhead, savedPerSession, savedSummary, snapshot } from '../src/overhead.mjs';
import { advise, getPlan, loadPeaks, PLANS, planPrices, planStats, recordPeaks, setPlan } from '../src/plan.mjs';
import { costOf, fmtUsd } from '../src/prices.mjs';
import { burnReport } from '../src/report.mjs';
import { loadBlocks, logBlock, resultsReport, resultsShare, resultsStats, weeklyDue, weeklyLine } from '../src/results.mjs';
import { claudeSamples, readCodex } from '../src/sources.mjs';
import { countInteractiveSince, latestInteractiveTranscript } from '../src/startup.mjs';
import { KEEP_MS, load, record, stateDir } from '../src/store.mjs';
import {
  budgetSpent,
  getBudget,
  getSubagentModels,
  getTodayHold,
  loadSubagents,
  logSubagent,
  receiptMessage,
  setBudget,
  setSubagentModel,
  setTodayHold,
  subagentUsage,
  validModel,
  windowStart,
} from '../src/subagents.mjs';
import { forTerminal } from '../src/term.mjs';
import { firstFlag, toolKey, toolNotice } from '../src/toolcheck.mjs';
import { baseline, contributors, measuredSavings, shareSummary, startupReport, trimReport } from '../src/trim.mjs';
import { claudeRoot, grokRoot, readUsage } from '../src/usage.mjs';
import { dailyDue, foldEvents, loadValue, saveValue, scanSessions, valuePeriod, valueSection, valueTotals } from '../src/value.mjs';
import { attribute, jobsReport, whyReport, whySessions } from '../src/where.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const HELP = `limitcast ${VERSION}: stretch your Claude Code, Codex and Grok plans

  limitcast onboard                 read-only setup checks and a guided first useful result
  limitcast install [--host claude|codex|grok] [--guard]  wire limitcast into Claude Code (and, with --guard, Codex and Grok); backs up settings
  limitcast uninstall                remove it and restore your original status line
  limitcast doctor [--fix]           check the setup (--fix: re-install with this Node, e.g. after a Node upgrade)
  limitcast status [--json]         used, burn rate, runout time, reset, and today's share of each weekly window
  limitcast trim [--share]           tokens every session loads before you type, and how much you never use
  limitcast trim --codex             the same for Codex: AGENTS.md size and MCP servers you haven't used
  limitcast trim --grok              the same for Grok: system prompt size and MCP servers you haven't used
  limitcast grok-usage [on|off]      Grok's weekly % used, from grok.com with the login Grok holds (off by default)
  limitcast memory [dir]             check this project's auto-memory: load cap, broken links, unlinked and oversized files
  limitcast results [--days N]       limits you reached, how far ahead limitcast warned, what the guard blocked
                    [--share]        totals only, safe to post
  limitcast license                  show the MIT license status

  All features are free (MIT License)
  limitcast trim [--days N] [--share]        names what to cut and what each costs
                                             (--share: totals only, no names, safe to post)
  limitcast trim --apply / --undo            hide those skills and turn off those MCP servers (backed up, reversible)
  limitcast trim --codex --apply / --undo    turn off unused Codex MCP servers (enabled = false; reversible)
  limitcast trim --grok --apply / --undo     turn off unused Grok MCP servers (enabled = false; reversible)
  limitcast trim keep <name>[,<name>…]       never hide or turn off these (any --apply); --remove <name> drops one, no name lists them
  limitcast saved                            tokens saved since limitcast first measured you
  limitcast install --guard                  block new subagents when a window is on pace to run out, and run
                                             them on Sonnet while a window is tight (NEAR or AT_RISK); show what
                                             each finished subagent cost, and what that kind has cost before a new
                                             one starts; hold the first message after the prompt
                                             cache expired (idle over 60 min, LIMITCAST_CACHE_MINUTES) and say what it costs
  limitcast budget subagents <percent>|off   hold new subagents once they used that much of the 5-hour window
  limitcast subagent-model <type> <model>|off  run new subagents of that type on sonnet, opus, haiku, grok-… or a model id
  limitcast plan [--days N]                  does your Claude plan fit your use? Hit-limit and headroom evidence, and the monthly price difference
  limitcast plan set <pro|max5|max20>|off    tell limitcast which Claude plan you are on
  limitcast budget grok <usd>|off            Grok 5-hour dollar cap (Grok stores spend, not a % used; the guard
                                             needs this cap to block spawn_subagent). Optional: budget grok 7d <usd>
  limitcast budget today on|off              hold new subagents once today's share of a weekly window is used up, until
                                             midnight (off: you only get a notification at 80% of the share; notify on)
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
  (status line: points to another account with room, and suggests /compact past ~150k tokens a call)

  Used by Claude Code, Codex and Grok (set up by install)
  limitcast statusline [-- <cmd...>]  record limit readings, then run your status-line command
  limitcast guard                     PreToolUse hook
  limitcast prompt-check              UserPromptSubmit hook: the cold-cache warning
  limitcast subagent-receipt          SubagentStop hook: what the subagent cost
  limitcast drift [--hook]            SessionStart hook: compare starting context with the last session
`;

const [cmd, ...args] = process.argv.slice(2);
const now = Date.now();
const flag = (/** @type {string} */ name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const days = () => {
  const n = Number(flag('--days') ?? 7);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(new Date(now - n * 86400_000).getTime())) {
    console.error('--days must be a finite positive number.');
    process.exit(1);
  }
  return Math.max(1, n);
};

if (cmd === 'status') {
  if (grokQuotaEnabled() && grokPresent()) await refreshGrokQuota(now);
  const rows = forecastAll(oneClaudeAccount(await readSamples(now - KEEP_MS)), now);
  if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(rows.length ? table(rows) : 'No data yet. Run `limitcast install`, then send a message in Claude Code, Codex or Grok.');
    const binds = bindingLine(rows, getGrokBudget(), clock);
    if (binds) console.log(`\n${binds}`);
    // the other Claude accounts limitcast has current readings for (the table shows the latest one).
    for (const a of accountForecasts(load(now - KEEP_MS), now).slice(1))
      console.log(
        `other Claude account (last used ${clock(a.lastSeen)}): ${a.rows.map((f) => `${f.win} ${f.verdict === 'RESET' ? 0 : Math.round(f.pct)}%${f.verdict === 'OK' || f.verdict === 'RESET' ? '' : ` ${f.verdict}`}`).join(' · ')}`,
      );
    const gq = grokQuotaEnabled() ? readGrokQuota() : null;
    if (gq && !gq.ok) console.log(`grok: weekly usage unavailable (${gq.error ?? 'no reading yet'})`);
    else if (gq?.label && gq.label !== 'Weekly')
      console.log(`grok: your plan reports ${gq.label.toLowerCase()} usage (${Math.round(gq.pct ?? 0)}% used), which limitcast does not forecast`);
    const spend = grokSpendLine(now);
    if (spend) console.log(spend);
    else if (existsSync(grokRoot()) && !rows.some((f) => f.src === 'grok'))
      console.log('grok: spent $0 in the current windows. Set a cap to forecast runout: limitcast budget grok <usd>');
  }
} else if (cmd === 'statusline') {
  const input = readStdin();
  let sid;
  /** @type {any} */
  let feed;
  /** @type {string[]} */
  const hints = [];
  try {
    feed = JSON.parse(input);
    sid = feed?.session_id;
    record(claudeSamples(feed, now));
    saveFeedShape(feed);
    // Readings are kept 8 days; the daily rollup folds what they showed into the long-term value record.
    if (dailyDue(now)) spawn(process.execPath, [fileURLToPath(import.meta.url), 'rollup'], { detached: true, stdio: 'ignore' }).unref();
    const health = healthHint();
    if (health) hints.push(health);
    {
      const samples = load(now - KEEP_MS);
      if (notifyEnabled()) notifyChanges(forecastAll(oneClaudeAccount([...samples, ...grokSamples(now)], sid), now), clock);
      const room = headroom(samples, sid, now);
      if (room) hints.push(room);
      const ctxPct = Number(feed?.context_window?.used_percentage);
      if (Number.isFinite(ctxPct) && ctxPct >= 80) hints.push(`${ctxPct}% ctx`);
      else if (typeof feed?.transcript_path === 'string') {
        const ctx = compactHint(lastCallTokens(feed.transcript_path));
        if (ctx) hints.push(ctx);
      }
    }
  } catch {
    /* never break the status line */
  }
  try {
    // Grok's weekly % comes from grok.com (opt-in); refresh it in the background so no status line waits on the network.
    if (grokQuotaDue(now)) {
      touchGrokQuota(now);
      spawn(process.execPath, [fileURLToPath(import.meta.url), 'grok-usage', '--refresh'], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* never break the status line */
  }
  const sep = args.indexOf('--');
  const wrapped = sep >= 0 ? args.slice(sep + 1) : [];
  const grokOwn = grokSessionLine(feed);
  let line = 'waiting for data';
  try {
    // Grok spend/forecast stays on the Grok status line. Claude's feed has rate_limits; mixing the two
    // would print grok $ on Claude Code and break "waiting for data" when there are no Claude readings.
    const grokExtra = grokOwn ? grokSamples(now) : [];
    line = statusBits(forecastAll(oneClaudeAccount([...load(now - KEEP_MS), ...grokExtra], sid), now), grokOwn ? grokSpendLine(now) : '', hints);
  } catch {
    /* never break the status line */
  }
  if (wrapped.length) {
    const r = spawnSync(wrapped[0], wrapped.slice(1), { input, stdio: ['pipe', 'pipe', 'inherit'] });
    // Your status line stays as it was; limitcast adds its own line under it (status scripts often printf without a newline).
    const yours = r.stdout?.toString() ?? '';
    process.stdout.write(yours && !yours.endsWith('\n') ? `${yours}\n` : yours);
    console.log(`limitcast: ${line}`);
    process.exit(r.status ?? 1);
  }
  if (grokOwn) console.log(grokOwn);
  console.log(`limitcast: ${line}`);
} else if (cmd === 'guard') {
  // The installed guard protects all users; LIMITCAST_ALLOW=1 remains the explicit override.
  if (process.env.LIMITCAST_ALLOW === '1') process.exit(0);
  try {
    const d = await runGuard(JSON.parse(readStdin()), now, Number(process.env.LIMITCAST_GUARD_MINUTES ?? 30), { preview: false });
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
  // The opt-in hook warns once and fails open on errors.
  try {
    const hook = JSON.parse(readStdin());
    const path = hook?.transcript_path;
    const last = process.env.LIMITCAST_ALLOW !== '1' && typeof path === 'string' && existsSync(path) ? lastCall(path) : null;
    const c = coldCost(hook?.prompt, last, now, { minutes: Number(process.env.LIMITCAST_CACHE_MINUTES ?? 60), calib: loadValue().calib });
    if (c && last && firstWarning(String(hook.session_id), last.t)) {
      const pro = true;
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
  // PostToolUse hook (installed with --alerts): tell the user, once per tool per session, about a very large tool
  // result and what to ask for next time. Never reaches the model.
  try {
    {
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
        console.log(JSON.stringify({ systemMessage: receiptMessage(hook.agent_type, u, pct) }));
      }
    }
  } catch {
    /* a hook must never break the session */
  }
} else if (cmd === 'plan') {
  if (args[0] === 'set') {
    const id = args[1];
    if (id !== 'off' && !(id in PLANS)) {
      console.log('Usage: limitcast plan set <pro|max5|max20>|off');
      process.exit(1);
    }
    setPlan(id === 'off' ? null : /** @type {keyof typeof PLANS} */ (id));
    console.log(id === 'off' ? 'Plan forgotten.' : `Plan set to Claude ${PLANS[/** @type {keyof typeof PLANS} */ (id)].name}. Run: limitcast plan`);
    process.exit(0);
  }
  const planDays = Math.max(1, Number(flag('--days') ?? 28));
  recordPeaks(load(now - KEEP_MS), now);
  const plan = getPlan();
  const prices = planPrices();
  const advice = advise(plan, planStats(loadPeaks(), now, planDays), prices);
  const out = [
    '# limitcast plan',
    '',
    `Claude plan: ${plan ? `${PLANS[plan].name}, ${fmtUsd(prices[plan])} a month` : 'not set'}`,
    '',
    ...advice.lines,
  ];
  const used = (await readUsage(now - planDays * 86400_000, {})).filter((u) => u.src === 'claude');
  const cost = costOf(used);
  if (plan && cost.priced) {
    const span = Math.min(planDays, Math.max(1, (now - Math.min(...used.map((u) => u.t))) / 86400_000));
    out.push(
      '',
      `At API list prices your Claude Code tokens of the last ${Math.round(span)} days would have cost ${fmtUsd(cost.total)} (about ${fmtUsd((cost.total * 30) / span)} a month at this pace), against ${fmtUsd(prices[plan])} for your plan.`,
    );
  }
  out.push(
    '',
    '_From the peak of every 5-hour and weekly window limitcast has seen; plan prices and multipliers from claude.com/pricing, 2026-10-26._',
  );
  console.log(forTerminal(out.join('\n')));
  process.exit(0);
} else if (cmd === 'subagent-model') {
  const [type, model] = args;
  if (type && (model === undefined || (model !== 'off' && !validModel(model)))) {
    console.log(
      'Usage: limitcast subagent-model <type> <sonnet|opus|haiku|claude-id|grok-id>|off\n       limitcast subagent-model            list them',
    );
    process.exit(1);
  }
  if (type) {
    const next = model === 'off' ? null : model;
    setSubagentModel(type, next);
    applyGrokSubagentModel(type, next);
  }
  const pinned = Object.entries(getSubagentModels());
  console.log(pinned.length ? pinned.map(([t, m]) => `${t}: ${m}`).join('\n') : 'No subagent type is pinned to a model.');
  const ran = new Map();
  for (const e of loadSubagents(now - 30 * 86400_000)) if (e.type) ran.set(e.type, (ran.get(e.type) ?? 0) + 1);
  if (ran.size)
    console.log(
      `\nTypes you ran in the last 30 days: ${[...ran]
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t} (${n})`)
        .join(', ')}`,
    );
  if (pinned.length) {
    console.log(
      '\nNew subagents of these types run on that model unless the spawn names one itself. Needs the guard: limitcast install --guard, then restart Claude Code.',
    );
    if (pinned.some(([, m]) => /^grok-/i.test(m))) console.log('Grok also writes [subagents.models] in ~/.grok/config.toml; restart Grok.');
  } else console.log('\nExample: limitcast subagent-model Explore haiku');
  process.exit(0);
} else if (cmd === 'budget') {
  if (args[0] === 'grok') {
    const win = args[1] === '7d' || args[1] === '5h' ? args[1] : '5h';
    const value = args[1] === '7d' || args[1] === '5h' ? args[2] : args[1];
    if (value !== undefined && value !== 'off' && !(Number(value) > 0)) {
      console.log('Usage: limitcast budget grok <usd>|off    (5-hour dollar cap)\n       limitcast budget grok 7d <usd>|off');
      process.exit(1);
    }
    if (value !== undefined) setGrokBudget(value === 'off' ? null : Number(value), win);
    const budget = getGrokBudget();
    const spend = grokSpend(now);
    const cap = budget?.[win];
    const used = spend?.[win];
    console.log(
      cap
        ? `Grok ${win} budget: $${cap}. Spent this window: $${(used ?? 0).toFixed(2)} (${Math.min(100, ((used ?? 0) / cap) * 100).toFixed(0)}%). The guard holds new spawn_subagent calls when this window is on pace to run out.`
        : `No Grok ${win} dollar cap. Spent this window: $${(used ?? 0).toFixed(2)}. Grok stores spend, not a % used; set a cap so the guard can block: limitcast budget grok 5`,
    );
    if (getGrokBudget() && !installedFeatures(grokHooksFile()).guard && grokPresent())
      console.log('The budget is enforced by the guard: limitcast install --guard (then restart Grok).');
    process.exit(0);
  }
  if (args[0] === 'today') {
    if (args[1] !== undefined && args[1] !== 'on' && args[1] !== 'off') {
      console.log('Usage: limitcast budget today on|off');
      process.exit(1);
    }
    if (args[1]) setTodayHold(args[1] === 'on');
    console.log(
      getTodayHold()
        ? "Daily hold is on: the guard holds new subagents once today's share of a weekly window is used up, until midnight. Turn it off: limitcast budget today off"
        : "Daily hold is off: you get a notification at 80% of today's share (limitcast notify on), nothing is held. Hold new subagents past it: limitcast budget today on",
    );
    if (getTodayHold() && !installedFeatures().guard) console.log('The hold is enforced by the guard: limitcast install --guard');
    process.exit(0);
  }
  const value = args[1];
  if (args[0] !== 'subagents' || (value !== undefined && value !== 'off' && !(Number(value) > 0 && Number(value) <= 100))) {
    console.log(
      'Usage: limitcast budget subagents <percent of the 5-hour window, 1-100>|off\n       limitcast budget grok <usd>|off\n       limitcast budget today on|off',
    );
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
  const host = flag('--host');
  if (args.includes('--host') && !['claude', 'codex', 'grok'].includes(host)) {
    console.error('--host must be claude, codex or grok.');
    process.exit(1);
  }
  const wantGuard = args.includes('--guard');
  const wantAlerts = args.includes('--alerts');
  for (const c of install({ guard: wantGuard, alerts: wantAlerts, hosts: host ? [host] : undefined })) console.log(`✓ ${c}`);
  console.log('Restart the configured coding tools to load changes. Then: limitcast doctor');
  if (wantGuard && (!host || host === 'claude') && detectedHosts().includes('claude'))
    console.log(
      'Claude protection also installs subagent receipts, Sonnet switching while capacity is tight, and a one-time cold-cache prompt hold. LIMITCAST_ALLOW=1 overrides a hold or model change.',
    );
  if (wantGuard && (!host || host === 'grok') && grokPresent() && !getGrokBudget() && !grokQuotaEnabled())
    console.log(
      'For Grok protection, enable weekly quota readings with limitcast grok-usage on, or set a spending cap with limitcast budget grok <usd>.',
    );
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
  console.log(`In a week, \`limitcast results\` shows every limit you hit and how far ahead limitcast warned you.`);
} else if (cmd === 'uninstall') {
  const changes = uninstall();
  console.log(changes.length ? changes.map((c) => `✓ ${c}`).join('\n') : 'Nothing to remove.');
} else if (cmd === 'onboard') {
  const checks = await healthChecks();
  let features = { statusLine: false, guard: false, alerts: false };
  try {
    features = installedFeatures();
  } catch {
    /* invalid settings are explained by doctor */
  }
  const latest = await latestInteractiveTranscript(claudeRoot());
  const names = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };
  const providers = detectedHosts().map((h) => names[h]);
  console.log(
    forTerminal(
      onboardingReport({
        checks,
        features,
        providers,
        contextTokens: latest ? latest.pieces.reduce((n, p) => n + p.chars, 0) / 4 : null,
      }),
    ),
  );
} else if (cmd === 'doctor') {
  if (args.includes('--fix')) {
    // Re-install what is installed, with this Node and this copy of limitcast (after a Node upgrade, say).
    for (const host of detectedHosts()) {
      const f = installedFeatures(host === 'codex' ? codexHooksPath() : host === 'grok' ? grokHooksFile() : settingsPath());
      if (host === 'claude' && !f.statusLine) console.log('Claude recorder is not installed. Run limitcast install --host claude first.');
      else if (host === 'codex' && !f.guard) console.log('Codex needs no recorder. Optional protection: limitcast install --host codex --guard');
      else for (const c of install({ guard: f.guard, alerts: f.alerts, hosts: [host] })) console.log(`✓ ${c}`);
    }
    console.log('Restart tools whose configuration changed. Codex may ask you to approve its updated hook.');
  }
  const checks = await healthChecks();
  saveHealth(checks);
  // Memory is per project: shown here, but kept out of the saved health that the daily background check overwrites.
  const mem = memoryCheck(scanMemory(memoryDir()));
  if (mem) checks.push(mem);
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.line}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
} else if (cmd === 'grok-usage') {
  const arg = args.find((a) => !a.startsWith('-'));
  if (args.includes('--refresh')) {
    await refreshGrokQuota(now, { force: true }); // the background refresh the status line starts
  } else if (arg && arg !== 'on' && arg !== 'off') {
    console.log('usage: limitcast grok-usage [on|off]');
    process.exit(2);
  } else if (arg === 'on' && !grokPresent()) {
    console.log('Grok is not installed here (no ~/.grok), so there is no usage to read.');
    process.exit(1);
  } else {
    if (arg) setGrokQuota(arg === 'on');
    if (arg === 'on')
      console.log(
        'Grok weekly usage is on. About every 5 minutes limitcast reads the login Grok keeps in ~/.grok/auth.json and asks grok.com for your usage. The login goes only to grok.com and is never stored or logged. Turn it off: limitcast grok-usage off',
      );
    if (arg === 'off') console.log('Grok weekly usage is off. limitcast no longer reads your Grok login or contacts grok.com.');
    else if (grokQuotaEnabled()) {
      const q = await refreshGrokQuota(now, { force: arg === 'on' });
      console.log(
        q.ok
          ? `Grok ${q.label?.toLowerCase()}: ${Math.round(q.pct ?? 0)}% used${q.reset ? `, resets ${new Date(q.reset * 1000).toLocaleString()}` : ''}`
          : `Grok usage unavailable: ${q.error ?? 'no reading yet'}`,
      );
      if (!q.ok) process.exit(1);
    } else console.log('Grok weekly usage is off. Turn it on: limitcast grok-usage on');
  }
} else if (cmd === 'memory') {
  const dir = args.find((a) => !a.startsWith('-')) ?? memoryDir();
  console.log(memoryReport(scanMemory(dir), dir));
} else if (cmd === 'report' || cmd === 'trim') {
  const pro = true;
  const since = now - days() * 86400_000;
  if (cmd === 'trim' && args[0] === 'keep') {
    // The keep-list: servers and skills `trim --apply` never touches (Claude, Codex and Grok). Free to manage; apply is Pro.
    const drop = args[1] === '--remove';
    const names = args
      .slice(drop ? 2 : 1)
      .join(',')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length) setKeep(drop ? getKeep().filter((k) => !isKept(names, k)) : [...getKeep(), ...names]);
    const keep = getKeep();
    console.log(keep.length ? `Kept by \`trim --apply\`: ${keep.join(', ')}` : 'Nothing on the keep-list. Example: limitcast trim keep ego-browser');
    process.exit(0);
  }
  if (cmd === 'trim' && args.includes('--codex')) {
    // Codex: AGENTS.md and the MCP servers in ~/.codex/config.toml.
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
    const r = codexTrimReport({ servers, used: await codexUsedServers(since), startup: await codexStartup(), days: days(), pro, keep: getKeep() });
    if (args.includes('--apply')) {
      const changed = applyCodexTrim(r.unused);
      console.log(
        (changed.length
          ? `✓ Turned off ${changed.length} Codex MCP servers (enabled = false in ${codexConfigPath()}): ${changed.map((s) => s.name).join(', ')}\nTakes effect in your next Codex session. Undo: limitcast trim --codex --undo`
          : 'Nothing to turn off: every server that is on was used or is on your keep-list.') + keptNote(r.kept),
      );
    } else console.log(forTerminal(r.text));
    process.exit(0);
  }
  if (cmd === 'trim' && args.includes('--grok')) {
    if (args.includes('--undo')) {
      const e = undoGrokTrim();
      console.log(
        e ? `✓ Back to how they were: ${e.servers.map((s) => s.name).join(', ')}. Takes effect in your next Grok session.` : 'Nothing to undo.',
      );
      process.exit(0);
    }
    if (!existsSync(grokConfigPath())) {
      console.log(`No Grok setup found (${grokConfigPath()}). Set GROK_HOME if Grok keeps it elsewhere.`);
      process.exit(0);
    }
    const r = grokTrimReport({
      servers: grokServers(),
      used: grokUsedServers(since),
      startup: grokStartup(),
      days: days(),
      pro,
      keep: getKeep(),
    });
    if (args.includes('--apply')) {
      const changed = applyGrokTrim(r.unused);
      console.log(
        (changed.length
          ? `✓ Turned off ${changed.length} Grok MCP servers (enabled = false in ${grokConfigPath()}): ${changed.map((s) => s.name).join(', ')}\nTakes effect in your next Grok session. Undo: limitcast trim --grok --undo`
          : 'Nothing to turn off: every server that is on was used or is on your keep-list.') + keptNote(r.kept),
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
    // The share view omits private names; the local view includes actionable detail.
    if (args.includes('--apply') || args.includes('--undo')) {
      console.log(args.includes('--undo') ? undoMessage(undoTrim()) : applyMessage(latest, used));
      process.exit(0);
    }
    const keep = getKeep();
    if (latest && args.includes('--share')) text = shareSummary(baseline(usage), latest, used, days(), keep);
    else text = latest ? startupReport(baseline(usage), latest, used, days(), keep) : trimReport(baseline(usage), contributors(), used, days());
    if (latest && !args.includes('--share')) {
      const still = stillLoading(latest);
      text += still.length
        ? `\n\nStill loading after \`trim --apply\`: ${still.join(', ')}. A Claude Code session that was running may have rewritten ~/.claude.json; quit Claude Code and run \`limitcast trim --apply\` again.`
        : measuredSavings(latest.pieces, used, keep).tokens > 0
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
        const samples = await readSamples(since, true);
        const s = loadOverhead();
        // The daily rollup keeps the value record current; a session-start hook must not scan transcripts itself.
        const week = valuePeriod(loadValue(), since, now);
        lines.push(
          weeklyLine(resultsStats({ now, days: 7, samples, blocks: loadBlocks(since), pro: true }), s ? savedPerSession(s) : null, week.tokens),
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
  const latest = await latestInteractiveTranscript(claudeRoot());
  if (latest) recordOverhead(snapshot(latest));
  const s = loadOverhead();
  console.log(
    forTerminal(s ? savedSummary(s, await countInteractiveSince(claudeRoot(), s.first.at)) : 'Nothing measured yet. Run `limitcast trim` first.'),
  );
} else if (cmd === 'results') {
  // Historical previews remain separate from applied controls.
  const pro = true;
  const since = now - days() * 86400_000;
  let saved = '';
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
  const samples = await readSamples(since, true);
  const blocks = loadBlocks(since);
  const value = await refreshValue();
  const totals = valueTotals(value);
  const insight = periodInsights({ value, usage: await readUsage(since - days() * 86400_000, {}), blocks, since, until: now });
  if (args.includes('--share'))
    console.log(
      resultsShare(resultsStats({ now, days: days(), samples, blocks, pro }), {
        days: days(),
        pro,
        savedPerSession: perSession,
        notResent: totals.tokens,
      }) +
        '\n' +
        insightsShare(insight, pro),
    );
  else if (args.includes('--html')) {
    // results, the current windows and the burn report on one page, opened in the browser.
    const rows = forecastAll(oneClaudeAccount(await readSamples(now - KEEP_MS)), now);
    const burn = burnReport(await readUsage(since, {}), { since, now }).replace(/^(#{1,2}) /gm, '#$1 ');
    const md = [
      insightsReport(insight, pro),
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
        [
          insightsReport(insight, pro),
          resultsReport({
            now,
            days: days(),
            samples,
            blocks,
            pro,
            saved,
            value: valueSection(totals, { now, pro }),
            subagents: loadSubagents(since),
          }),
        ].join('\n\n'),
      ),
    );
} else if (cmd === 'notify') {
  // Desktop notifications from the status line (opt-in).
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
} else if (['activate', 'deactivate', 'license', 'trial'].includes(cmd)) {
  console.log('limitcast is free and open source under the MIT License. All features are available; no license key, account or trial is required.');
} else if (cmd === '--version' || cmd === '-v') {
  console.log(VERSION);
} else {
  console.log(HELP);
  process.exit(cmd && !['help', '--help', '-h'].includes(cmd) ? 1 : 0);
}

/** All supported provider readings; reports retain opt-in history after collection is disabled. */
async function readSamples(since, history = false) {
  return [...load(since), ...(await readCodex(since)), ...grokSamples(now, { history }).filter((s) => s.t >= since)];
}

/** Everything `doctor` checks: setup, data freshness, and whether each tool's logs still parse. */
async function healthChecks() {
  // Readings are only stored when they change, so freshness comes from the last feed the status line saw.
  let latest = 0;
  try {
    latest = JSON.parse(readFileSync(join(stateDir(), 'last-feed.json'), 'utf8')).at ?? 0;
  } catch {
    /* never fed */
  }
  const checks = doctor({ samplesAgeMs: latest ? now - latest : null });
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
  if (fresh.length && notifyEnabled()) send(`limitcast needs a fix: ${fresh[0]} Run: limitcast doctor`);
  return failed;
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
  recordPeaks(claude, now); // the long-lived record of window peaks behind `limitcast plan`
  const o = loadOverhead();
  // limitcast started watching at its first status-line reading (or first measurement), not when Codex's logs begin.
  const start = Math.min(now, o?.first.at ?? now, ...claude.map((s) => s.t), ...grokQuotaSamples(now, true).map((s) => s.t));
  const v = foldEvents(loadValue(), { now, samples: await readSamples(since, true), blocks: loadBlocks(since), start });
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
    if (notifyEnabled()) send(limitChangeMessage(change));
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
    keep: getKeep(),
  });
  const e = applyTrim(plan, { cwd, now });
  const lines = [];
  if (e.skills.length)
    lines.push(`✓ Hid ${e.skills.length} skills from the model (\`/name\` still works): ${e.skills.map((k) => k.name).join(', ')}`);
  if (e.mcp.length) lines.push(`✓ Turned off ${e.mcp.length} MCP servers for ${cwd}: ${e.mcp.join(', ')}`);
  if (plan.pluginSkills.length) lines.push(`- Plugin skills can only be turned off with their plugin (\`/plugin\`): ${plan.pluginSkills.join(', ')}`);
  if (plan.manualMcp.length) lines.push(`- Turn these off in \`/mcp\` (limitcast couldn't confirm their exact names): ${plan.manualMcp.join(', ')}`);
  if (plan.kept.length) lines.push(`- Kept, as on your keep-list: ${[...new Set(plan.kept)].join(', ')}`);
  if (!e.skills.length && !e.mcp.length) lines.unshift('Nothing to change automatically.');
  else
    lines.push(
      "Takes effect in your next Claude Code session; quit running sessions first so they don't write over ~/.claude.json. Undo: `limitcast trim --undo`",
    );
  return lines.join('\n');
}

/** The keep-list servers a Codex or Grok `trim --apply` left on. @param {string[]} kept */
function keptNote(kept) {
  return kept.length ? `\nKept, as on your keep-list: ${kept.join(', ')}` : '';
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
    `${Math.max(0, Math.round((now - f.observedAt) / 60_000))}m`,
    f.verdict,
  ]);
  const head = ['window', 'used', 'burn', 'runs out', 'resets', 'today', 'age', 'status'];
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
  const bits = rows.map(
    (f) =>
      `${f.src === 'claude' ? '' : `${f.src} `}${f.win} ${Math.round(f.pct)}%${f.verdict === 'AT_RISK' ? ` ⚠ out ${clock(f.wall)}` : f.verdict === 'NEAR' ? ' ⚠ near limit' : f.verdict === 'HIT' ? ' ⛔' : f.verdict === 'STALE' ? ` ⚠ stale (${Math.round((now - f.observedAt) / 60_000)}m old)` : ''}` +
      (f.today && f.verdict !== 'HIT' ? ` · today ${todayLabel(f.today)}` : ''),
  );
  return bits.join(' · ') || 'limitcast: waiting for data';
}

/**
 * Status-line body: forecasts, Grok spend when there is no cap, then hints. No "waiting for data" when spend is known.
 * @param {ReturnType<typeof forecastAll>} rows
 * @param {string} spend
 * @param {string[]} hints
 */
function statusBits(rows, spend, hints) {
  const core = oneLine(rows);
  const parts = [];
  if (core !== 'limitcast: waiting for data') parts.push(core.replace(/^limitcast: /, ''));
  if (spend) parts.push(spend);
  parts.push(...hints);
  return parts.join(' · ') || 'waiting for data';
}

/** Grok spend line when no dollar cap is set (a cap becomes a forecast row instead). */
function grokSpendLine(t) {
  if (getGrokBudget()) return '';
  const s = grokSpend(t);
  if (!s) return '';
  return `grok 5h $${s['5h'].toFixed(2)} · 7d $${s['7d'].toFixed(2)}`;
}

/**
 * "6% left" / "3% over" of today's even share of a weekly window.
 * @param {{left:number}} t
 */
function todayLabel(t) {
  const n = Math.round(Math.abs(t.left));
  return t.left >= 0 ? `${n}% left` : `${n}% over`;
}
