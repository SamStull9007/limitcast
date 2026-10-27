import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { limitChange, limitChangeMessage } from '../src/calibrate.mjs';
import { coldCost, coldMessage } from '../src/cold.mjs';
import { install, installedFeatures, uninstall } from '../src/install.mjs';
import { remoteArgs } from '../src/notify.mjs';
import { resultsReport, resultsStats } from '../src/results.mjs';
import { budgetSpent, receiptMessage, subagentUsage, windowStart } from '../src/subagents.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
process.env.GROK_HOME = tmp('lc-pro11-grok-'); // install() wraps Grok when ~/.grok exists
const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
const M = 60_000;
const D = 86400_000;
const calib = { fresh: 6, read: 0.09 };

test('cold cache: only a large context after the cache lifetime, never for notifications or /compact', () => {
  const now = Date.now();
  const last = { tokens: 300_000, t: now - 75 * M };
  const c = coldCost('fix the bug', last, now, { minutes: 60, calib });
  assert.equal(c.idle, 75);
  assert.equal(c.pct.toFixed(2), '1.80'); // 0.3M new tokens × 6% per million
  assert.match(
    coldMessage(c),
    /idle for 75 minutes.*300k tokens.*≈1\.8% of your 5-hour window \(≈0\.03% if the cache were still warm\).*Send it again/,
  );
  assert.equal(coldCost('x', { ...last, t: now - 30 * M }, now, { minutes: 60, calib }), null); // still warm
  assert.equal(coldCost('x', { ...last, tokens: 80_000 }, now, { minutes: 60, calib }), null); // small context
  assert.equal(coldCost('<task-notification>done</task-notification>', last, now, { minutes: 60, calib }), null);
  assert.equal(coldCost('/compact', last, now, { minutes: 60, calib }), null);
  assert.equal(coldCost('x', null, now, { minutes: 60, calib }), null);
  // Without a calibration it says what happens, not a made-up percentage.
  assert.match(coldMessage(coldCost('x', { ...last, t: now - 3 * 60 * M }, now, { minutes: 60, calib: null })), /3 hours.*new-token rate/);
});

test('subagent receipt: usage counted once per call, priced against the window', () => {
  const dir = tmp('lc-sub-');
  const p = join(dir, 'agent-a.jsonl');
  const line = (id, u) => JSON.stringify({ isSidechain: true, message: { id, usage: u } });
  const u1 = { input_tokens: 10, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 100_000, output_tokens: 1000 };
  const u2 = { input_tokens: 5, cache_creation_input_tokens: 4995, cache_read_input_tokens: 200_000, output_tokens: 4000 };
  // A call streamed as two content blocks repeats its usage line.
  writeFileSync(p, [line('m1', u1), line('m1', u1), line('m2', u2), 'not json', ''].join('\n'));
  const u = subagentUsage(p);
  assert.deepEqual(u, { fresh: 30_010, read: 300_000, calls: 2 });
  assert.equal(receiptMessage('Explore', u, 0.207), 'limitcast: that Explore subagent used ≈0.21% of your 5-hour window (2 calls, 30k new tokens).');
  assert.match(receiptMessage('Explore', u, null), /used 330k tokens, 30k of them new \(2 calls\)/);
});

test('subagent budget: counts this window and this account only', () => {
  const now = Date.now();
  const reset = now + 2 * 3600_000;
  const start = windowStart([{ src: 'claude', win: '5h', verdict: 'OK', reset }], now);
  assert.equal(start, reset - 5 * 3600_000);
  assert.equal(windowStart([], now), now - 5 * 3600_000);
  const e = [
    { t: now, sid: 'a', calls: 1, fresh: 0, read: 0, pct: 3 },
    { t: now, sid: 'a', calls: 1, fresh: 0, read: 0, pct: 4.5 },
    { t: now, sid: 'other-account', calls: 1, fresh: 0, read: 0, pct: 50 },
    { t: now, sid: 'a', calls: 1, fresh: 0, read: 0 }, // before the first calibration
  ];
  assert.equal(budgetSpent(e, new Set(['a']), new Set(['a', 'other-account'])), 7.5);
  assert.equal(budgetSpent(e, new Set(), new Set()), 57.5); // no readings yet: every session counts
});

test('limit change: the newest 3 days against the median of earlier ones, 15% or more', () => {
  const at = (d) => d * D;
  const h = [0, 1, 2, 3, 4].map((d) => ({ fresh: 6, at: at(d) }));
  assert.equal(limitChange(h), null); // nothing moved
  assert.equal(limitChange([...h, { fresh: 6.5, at: at(8) }]), null); // 8% is noise
  const smaller = limitChange([...h, { fresh: 7.2, at: at(8) }]);
  assert.deepEqual(smaller, { from: 166_667, to: 138_889 });
  assert.equal(limitChangeMessage(smaller), 'Your Claude limit looks smaller: 1% of the 5-hour window now takes ~139k new tokens, down from ~167k.');
  assert.equal(
    limitChange([
      { fresh: 6, at: 0 },
      { fresh: 9, at: at(8) },
    ]),
    null,
  ); // too little history
});

test('phone and webhook: curl arguments, data never read as a file', () => {
  const a = remoteArgs({ ntfy: 'https://ntfy.sh/t', webhook: 'https://hooks.slack.com/x' }, '@limit near');
  assert.deepEqual(a[0].slice(-4), ['Title: limitcast', '--data-raw', '@limit near', 'https://ntfy.sh/t']);
  assert.equal(a[1].at(-1), 'https://hooks.slack.com/x');
  assert.deepEqual(JSON.parse(a[1].at(-2)), { text: '@limit near', content: '@limit near' });
  assert.deepEqual(remoteArgs({}, 'x'), []);
});

test('install --guard adds the prompt check and receipts; uninstall removes them, keeping your hooks', () => {
  const path = join(tmp('lc-inst11-'), 'settings.json');
  const mine = { hooks: [{ type: 'command', command: 'my-hook' }] };
  writeFileSync(path, JSON.stringify({ hooks: { UserPromptSubmit: [mine], SubagentStop: [mine] } }));
  install({ guard: true, path, codexPath: join(tmp('lc-nocodex-'), 'x', 'hooks.json'), self: '/bin/sh /s/limitcast-hook.sh' });
  install({ guard: true, path, codexPath: join(tmp('lc-nocodex-'), 'x', 'hooks.json'), self: '/bin/sh /s/limitcast-hook.sh' }); // idempotent
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(cfg.hooks.UserPromptSubmit.length, 2);
  assert.match(cfg.hooks.UserPromptSubmit[1].hooks[0].command, /limitcast-hook\.sh prompt-check$/);
  assert.match(cfg.hooks.SubagentStop[1].hooks[0].command, /limitcast-hook\.sh subagent-receipt$/);
  assert.equal(installedFeatures(path).guard, true);
  uninstall({ path, codexPath: join(tmp('lc-nocodex-'), 'hooks.json') });
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after.hooks.UserPromptSubmit, [mine]);
  assert.deepEqual(after.hooks.SubagentStop, [mine]);
});

test('results: cold-cache holds and subagent totals', () => {
  const now = Date.now();
  const cold = { t: now - M, kind: 'cold', src: 'claude', win: '5h', pct: 1.8, wall: now, reset: now, tokens: 300_000 };
  const st = resultsStats({ now, days: 7, samples: [], blocks: [cold, { ...cold, kind: 'budget' }], pro: true });
  assert.deepEqual([st.colds, st.coldPct, st.budgets, st.outcomes.length], [1, 1.8, 1, 0]);
  const subagents = [
    { t: now, calls: 10, fresh: 0, read: 0, pct: 1.5 },
    { t: now, calls: 40, fresh: 0, read: 0, pct: 4 },
  ];
  const text = resultsReport({ now, days: 7, samples: [], blocks: [cold], pro: true, saved: null, subagents });
  assert.match(text, /2 subagents finished, ≈5\.5% of a 5-hour window in all; the biggest ≈4\.0%\./);
  assert.match(text, /Held 1 message sent after the prompt cache had expired/);
  const free = resultsReport({ now, days: 7, samples: [], blocks: [{ ...cold, shadow: true }], pro: false, saved: null, subagents });
  assert.match(free, /Pro would have held 1 message/);
});

test('CLI hooks: a Pro prompt is held once, then goes through; a receipt is shown and logged', () => {
  const state = tmp('lc-cli11-');
  const env = { ...process.env, LIMITCAST_STATE: state, XDG_CONFIG_HOME: tmp('lc-cli11-cfg-') };
  delete env.LIMITCAST_LICENSE;
  delete env.LIMITCAST_ALLOW;
  execFileSync('node', [bin, 'trial'], { env });
  writeFileSync(
    join(state, 'value.json'),
    JSON.stringify({ since: 1, scanned: 0, sessions: {}, hits: {}, blocks: {}, calib: { ...calib, n: 40, at: 1 } }),
  );
  const tr = join(tmp('lc-tr-'), 's.jsonl');
  const old = new Date(Date.now() - 90 * M).toISOString();
  writeFileSync(tr, `${JSON.stringify({ timestamp: old, message: { usage: { input_tokens: 10, cache_read_input_tokens: 250_000 } } })}\n`);
  const prompt = JSON.stringify({ session_id: 's1', transcript_path: tr, prompt: 'continue' });
  const first = JSON.parse(execFileSync('node', [bin, 'prompt-check'], { env, input: prompt }).toString());
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /idle for 90 minutes.*250k tokens.*≈1\.5% of your 5-hour window/);
  assert.equal(execFileSync('node', [bin, 'prompt-check'], { env, input: prompt }).toString(), ''); // sent again: goes through

  const sub = join(tmp('lc-subtr-'), 'agent-x.jsonl');
  writeFileSync(sub, `${JSON.stringify({ message: { id: 'm', usage: { input_tokens: 100_000, cache_read_input_tokens: 1_000_000 } } })}\n`);
  const stop = JSON.stringify({ session_id: 's1', agent_id: 'x', agent_type: 'Explore', agent_transcript_path: sub });
  const r = JSON.parse(execFileSync('node', [bin, 'subagent-receipt'], { env, input: stop }).toString());
  assert.equal(r.systemMessage, 'limitcast: that Explore subagent used ≈0.69% of your 5-hour window (1 call, 100k new tokens).');
  assert.match(readFileSync(join(state, 'subagents.jsonl'), 'utf8'), /"id":"x".*"pct":0\.69/);
  // Internal agents (no type) and broken input stay silent.
  assert.equal(execFileSync('node', [bin, 'subagent-receipt'], { env, input: JSON.stringify({ agent_transcript_path: sub }) }).toString(), '');
  assert.equal(execFileSync('node', [bin, 'prompt-check'], { env, input: 'not json' }).toString(), '');

  assert.match(execFileSync('node', [bin, 'budget', 'subagents', '10'], { env }).toString(), /Subagent budget: 10% .*≈0\.7%/);
  assert.equal(JSON.parse(readFileSync(join(state, 'config.json'), 'utf8')).subagentBudget, 10);
  assert.match(execFileSync('node', [bin, 'budget', 'subagents', 'off'], { env }).toString(), /No subagent budget/);
});

test('guard: holds a new Claude subagent once the budget is spent (Pro), only logs it in preview', async () => {
  const { runGuard } = await import('../src/guard.mjs');
  const { logSubagent, setBudget } = await import('../src/subagents.mjs');
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = tmp('lc-budget-');
  try {
    const now = Date.now();
    const hook = { tool_name: 'Agent', session_id: 's', tool_input: { model: 'sonnet' } };
    logSubagent({ t: now - M, id: 'a', sid: 's', calls: 30, fresh: 0, read: 0, pct: 6 });
    assert.equal(await runGuard(hook, now, 30), null); // no budget set
    setBudget(5);
    assert.match(await runGuard(hook, now, 30), /subagents have used ≈6\.0% of this 5-hour window, over your 5% budget/);
    assert.equal(await runGuard(hook, now, 30, { preview: true }), null);
    assert.equal(await runGuard({ ...hook, tool_name: 'spawn_subagent' }, now, 30), null); // Grok: not Claude's window
    setBudget(10);
    assert.equal(await runGuard(hook, now, 30), null);
  } finally {
    if (prev === undefined) delete process.env.LIMITCAST_STATE;
    else process.env.LIMITCAST_STATE = prev;
  }
});
