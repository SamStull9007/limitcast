import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGuard } from '../src/guard.mjs';
import { findDuplicate, forgetInflight, rememberInflight, spawnIdentity } from '../src/inflight.mjs';
import { install, uninstall } from '../src/install.mjs';
import { installGrok } from '../src/grok.mjs';
import { pinnedModel, setSubagentModel } from '../src/subagents.mjs';

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
