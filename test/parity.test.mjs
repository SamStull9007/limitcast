import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { alignedStart, grokHistory, installGrok } from '../src/grok.mjs';
import { runGuard } from '../src/guard.mjs';
import { findDuplicate, forgetInflight, rememberInflight, spawnIdentity } from '../src/inflight.mjs';
import { install, uninstall } from '../src/install.mjs';
import { transitions } from '../src/notify.mjs';
import { costOf } from '../src/prices.mjs';
import { blockOutcomes } from '../src/results.mjs';
import { pinnedModel, setSubagentModel } from '../src/subagents.mjs';
import { grokUsage } from '../src/usage.mjs';

const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
const TICKS = 10_000_000_000;

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const fresh = () => {
  process.env.LIMITCAST_STATE = tmp('lc-parity-state-');
};
fresh();

test('a model pinned for Grok never applies to a Claude spawn, and the reverse', () => {
  fresh();
  setSubagentModel('explore', 'grok-4.3');
  assert.equal(pinnedModel('Explore', 'claude'), undefined);
  assert.equal(pinnedModel('Explore', 'grok'), 'grok-4.3');
  assert.equal(pinnedModel('Explore', 'codex'), undefined);
  setSubagentModel('Explore', 'haiku');
  assert.equal(pinnedModel('Explore', 'claude'), 'haiku');
  assert.equal(pinnedModel('explore', 'grok'), 'grok-4.3');
  assert.equal(pinnedModel('Explore'), 'haiku', 'no host keeps the old exact-name lookup');
});

test('runGuard leaves a Claude Explore spawn alone when only a grok model is pinned', async () => {
  fresh();
  setSubagentModel('Explore', 'grok-4.3');
  const hook = { tool_name: 'Agent', session_id: 's1', tool_input: { subagent_type: 'Explore', prompt: 'find the parser' } };
  assert.equal(await runGuard(hook, Date.now(), 30), null);
  setSubagentModel('Explore', 'haiku');
  const pinned = await runGuard(hook, Date.now(), 30);
  assert.equal(pinned.updatedInput.model, 'haiku');
});

test('Codex spawn_agent is tracked by its message, and a second identical spawn is a duplicate', () => {
  const codex = (message, extra = {}) => ({
    tool_name: 'collaboration__spawn_agent',
    session_id: 'thread-1',
    tool_input: { task_name: 'scan', agent_type: 'worker', fork_turns: 'none', message, ...extra },
  });
  const a = spawnIdentity(codex('find the parser'));
  assert.equal(a.src, 'codex');
  assert.equal(a.type, 'worker');
  assert.equal(spawnIdentity(codex('find the parser')).hash, a.hash);
  assert.notEqual(spawnIdentity(codex('find the tests')).hash, a.hash);
  const now = Date.now();
  assert.ok(findDuplicate(rememberInflight([], a, now), spawnIdentity(codex('find the parser'))));
  const items = spawnIdentity({ ...codex(''), tool_input: { agent_type: 'worker', items: [{ type: 'text', text: 'find the parser' }] } });
  assert.equal(items.hash, a.hash, 'a list of text parts reads as the same prompt');
});

test('a Grok resume_from re-run is a continuation, not a duplicate', () => {
  const grok = (extra = {}) => ({
    tool_name: 'spawn_subagent',
    sessionId: 'g1',
    toolInput: { subagent_type: 'explore', description: 'look', prompt: 'find the parser', ...extra },
  });
  assert.ok(spawnIdentity(grok()));
  assert.equal(spawnIdentity(grok({ resume_from: 'sub-123' })), null);
});

test('a stop that reports the subagent own session still clears the parent record of that type', () => {
  const now = Date.now();
  const id = { sid: 'parent', type: 'worker', hash: 'h' };
  const live = rememberInflight([], id, now);
  assert.equal(forgetInflight(live, 'child-thread', 'worker', now).length, 0);
  assert.equal(forgetInflight(live, 'child-thread', 'other-type', now).length, 1);
  assert.equal(forgetInflight(live, 'parent', 'worker', now).length, 0);
});

test('install --guard adds a SubagentStop receipt hook for Codex and Grok, and uninstall removes it', () => {
  fresh();
  const dir = tmp('lc-parity-install-');
  const path = join(dir, 'claude-settings.json');
  const codexPath = join(dir, 'codex', 'hooks.json');
  mkdirSync(join(dir, 'codex'), { recursive: true });
  const grokDir = join(dir, 'grok');
  mkdirSync(join(grokDir, 'sessions'), { recursive: true });
  const self = "/bin/sh '/tmp/limitcast-hook.sh'";
  install({ guard: true, path, codexPath, grokDir, self });
  const codex = JSON.parse(readFileSync(codexPath, 'utf8'));
  assert.match(codex.hooks.SubagentStop[0].hooks[0].command, /subagent-receipt/);
  const grok = JSON.parse(readFileSync(join(grokDir, 'hooks', 'limitcast.json'), 'utf8'));
  assert.match(grok.hooks.SubagentStop[0].hooks[0].command, /subagent-receipt/);
  install({ guard: true, path, codexPath, grokDir, self }); // idempotent
  assert.equal(JSON.parse(readFileSync(codexPath, 'utf8')).hooks.SubagentStop.length, 1);
  uninstall({ path, codexPath, grokDir });
  assert.equal(JSON.parse(readFileSync(codexPath, 'utf8')).hooks.SubagentStop.length, 0);
});

test('installGrok on its own writes the stop hook beside the guard', () => {
  fresh();
  const home = tmp('lc-parity-grok-');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'config.toml'), '[ui]\ntheme = "terminal"\n');
  installGrok({ guard: true, self: '/x/limitcast', home });
  const hook = JSON.parse(readFileSync(join(home, 'hooks', 'limitcast.json'), 'utf8'));
  assert.equal(hook.hooks.PreToolUse[0].matcher, 'spawn_subagent');
  assert.equal(hook.hooks.SubagentStop.length, 1);
});

test('grokHistory rebuilds past Grok windows so results can judge an old block', () => {
  const root = tmp('lc-parity-grok-root-');
  const len = 5 * 3600_000;
  const a = alignedStart(Date.now(), '5h') - 2 * len; // an old window, then the one after it
  const dir = join(root, encodeURIComponent('/p/g'), '01abc');
  mkdirSync(dir, { recursive: true });
  const turn = (t, usd) => ({ endedAt: new Date(t).toISOString(), costUsdTicks: usd * TICKS });
  writeFileSync(join(dir, 'usage.json'), JSON.stringify({ turns: [turn(a + 600_000, 2), turn(a + 3_600_000, 2.5), turn(a + len + 600_000, 1)] }));
  const now = a + len + 30 * 60_000;
  const samples = grokHistory(a - 3600_000, now, { root, budget: { '5h': 4 } });
  const first = samples.filter((s) => s.reset === (a + len) / 1000);
  assert.equal(first.length, 2);
  assert.equal(first.at(-1).pct, 100, 'spend past the cap reads as 100, not 125');
  assert.equal(samples.find((s) => s.reset === (a + 2 * len) / 1000).pct, 25);
  const block = { t: a + 1_800_000, src: 'grok', win: '5h', pct: 90, wall: a + 2_400_000, reset: a + len };
  assert.equal(blockOutcomes([block], samples, now)[0].outcome, 'hit', 'the window did reach its cap');
  assert.equal(blockOutcomes([block], [], now)[0].outcome, 'under', 'without readings the old code invented this');
  assert.deepEqual(grokHistory(a, now, { root, budget: null }), []);
});

test('notifications name Grok like the other tools', () => {
  const row = { src: 'grok', win: '5h', pct: 85, reset: 1_800_000_000, wall: null, verdict: 'NEAR' };
  const { messages } = transitions([row], {}, () => '19:00');
  assert.match(messages[0], /^Grok 5h limit is at 85%/);
});

test('a Grok turn carries its own recorded cost, and costOf prefers it to re-pricing the whole turn', () => {
  const ledger = {
    turns: [
      {
        endedAt: '2026-11-13T12:00:00.000Z',
        inputTokens: 300_000,
        cachedReadTokens: 250_000,
        cacheCreationTokens: 0,
        outputTokens: 2000,
        primaryModelId: 'grok-4.3',
        costUsdTicks: 0.2 * TICKS,
      },
    ],
  };
  const [u] = grokUsage(ledger, 's', '/p');
  assert.equal(u.costUsd, 0.2);
  assert.equal(costOf([u]).total, 0.2);
  assert.ok(costOf([{ ...u, costUsd: undefined }]).total > 0.2, 'the token re-price used the long-context tier');
});

test('the status line keeps Grok and Claude feed shapes in separate files', () => {
  const state = tmp('lc-parity-feed-');
  const env = { ...process.env, LIMITCAST_STATE: state, GROK_HOME: join(state, 'nogrok'), CODEX_HOME: join(state, 'nocodex') };
  const run = (feed) => execFileSync('node', [bin, 'statusline'], { env, input: JSON.stringify(feed) });
  run({ model: { display_name: 'Grok 4.6' }, context_window: { used_percentage: 12 }, schema_version: 1, trigger: 'turn' });
  assert.ok(existsSync(join(state, 'last-feed-grok.json')));
  assert.equal(existsSync(join(state, 'last-feed.json')), false, 'a Grok feed must not satisfy the Claude feed check');
  run({ session_id: 's', rate_limits: { five_hour: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 3600 } } });
  assert.ok(existsSync(join(state, 'last-feed.json')));
});
