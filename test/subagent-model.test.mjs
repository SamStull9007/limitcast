import './helpers/environment.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGuard } from '../src/guard.mjs';
import { loadBlocks } from '../src/results.mjs';
import { record } from '../src/store.mjs';
import { getSubagentModels, setSubagentModel, validModel } from '../src/subagents.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
// Config, samples and blocks live in a temp state dir, never the real one; each test starts with a fresh one.
const fresh = () => {
  process.env.LIMITCAST_STATE = tmp('lc-model-state-');
};
fresh();
const NOW = Date.now();
const spawn = (input) => ({ tool_name: 'Agent', tool_input: input, session_id: 's1' });

test('validModel accepts the aliases and full ids, nothing else', () => {
  for (const m of ['sonnet', 'opus', 'haiku', 'claude-haiku-5-5', 'Haiku', 'grok-4.6', 'grok-4.3', 'grok-4.6-build'])
    assert.equal(validModel(m), true, m);
  for (const m of ['gpt-5', '', 'off', 'sonnet 4', undefined, 5, 'llama-3']) assert.equal(validModel(m), false, String(m));
});

test('setSubagentModel pins and unpins a type, and a bad stored value is ignored', () => {
  fresh();
  assert.deepEqual(getSubagentModels(), {});
  setSubagentModel('Explore', 'haiku');
  setSubagentModel('Plan', 'opus');
  assert.deepEqual(getSubagentModels(), { Explore: 'haiku', Plan: 'opus' });
  setSubagentModel('Plan', null);
  assert.deepEqual(getSubagentModels(), { Explore: 'haiku' });
  writeFileSync(
    join(process.env.LIMITCAST_STATE, 'config.json'),
    JSON.stringify({ subagentBudget: 10, subagentModels: { Explore: 'haiku', Bad: 'gpt-5' } }),
  );
  assert.deepEqual(getSubagentModels(), { Explore: 'haiku' });
  setSubagentModel('Plan', 'sonnet'); // keeps the other settings
  assert.equal(JSON.parse(readFileSync(join(process.env.LIMITCAST_STATE, 'config.json'), 'utf8')).subagentBudget, 10);
});

test('a pinned type runs on its model when the spawn names none; an explicit model is left alone', async () => {
  fresh();
  setSubagentModel('Explore', 'haiku');
  const d = await runGuard(spawn({ subagent_type: 'Explore', prompt: 'x' }), NOW, 30);
  assert.equal(d.updatedInput.model, 'haiku');
  assert.equal(d.updatedInput.prompt, 'x'); // the rest of the input is kept
  assert.match(d.reason, /Explore subagents run on haiku/);
  assert.equal((await runGuard(spawn({ subagent_type: 'Explore', model: 'inherit' }), NOW, 30)).updatedInput.model, 'haiku');
  assert.equal(await runGuard(spawn({ subagent_type: 'Explore', model: 'opus' }), NOW, 30), null); // the caller chose
  assert.equal(await runGuard(spawn({ subagent_type: 'Plan' }), NOW, 30), null); // not pinned
});

test('a free preview records what it would have done and changes nothing; Pro records the real thing', async () => {
  fresh();
  setSubagentModel('Explore', 'haiku');
  const since = NOW - 60_000;
  assert.equal(await runGuard(spawn({ subagent_type: 'Explore' }), NOW, 30, { preview: true }), null);
  await runGuard(spawn({ subagent_type: 'Explore' }), NOW, 30);
  const blocks = loadBlocks(since).filter((b) => b.kind === 'default');
  assert.deepEqual(
    blocks.map((b) => [Boolean(b.shadow), b.type, b.from, b.to]),
    [
      [true, 'Explore', 'default', 'haiku'],
      [false, 'Explore', 'default', 'haiku'],
    ],
  );
});

test('a tight window still moves a subagent pinned to Opus to Sonnet, but leaves one pinned to Haiku alone', async () => {
  fresh();
  const reset = Math.floor(NOW / 1000) + 1800;
  record([{ t: NOW, src: 'claude', win: '5h', pct: 96, reset, sid: 's1' }]); // 96%: NEAR
  setSubagentModel('Plan', 'opus');
  setSubagentModel('Explore', 'haiku');
  assert.equal((await runGuard(spawn({ subagent_type: 'Plan' }), NOW, 30)).updatedInput.model, 'sonnet');
  assert.equal((await runGuard(spawn({ subagent_type: 'Explore' }), NOW, 30)).updatedInput.model, 'haiku');
});

test('CLI: subagent-model is free, validates, lists and removes', () => {
  const state = tmp('lc-model-cli-state-');
  // XDG_CONFIG_HOME too: starting a trial also writes a marker there, which must not land in the real ~/.config.
  // GROK_HOME: pinning writes [subagents.models] and must not touch the real ~/.grok.
  const env = {
    ...process.env,
    LIMITCAST_STATE: state,
    XDG_CONFIG_HOME: tmp('lc-model-cli-xdg-'),
    GROK_HOME: tmp('lc-model-cli-grok-'),
  };
  delete env.LIMITCAST_LICENSE;
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const run = (...a) => spawnSync('node', [bin, 'subagent-model', ...a], { env });
  assert.equal(run('Explore', 'haiku').status, 0); // no key required
  assert.equal(spawnSync('node', [bin, 'trial'], { env }).status, 0);
  assert.equal(run('Explore').status, 1);
  assert.equal(run('Explore', 'gpt-5').status, 1);
  assert.match(run('Explore', 'haiku').stdout.toString(), /Explore: haiku[\s\S]*Needs the guard/);
  assert.match(run().stdout.toString(), /Explore: haiku/);
  assert.match(run('Explore', 'grok-4.3').stdout.toString(), /Explore: grok-4\.3[\s\S]*\[subagents\.models\]/);
  assert.match(run('Explore', 'off').stdout.toString(), /No subagent type is pinned/);
});

const grokSpawn = (input) => ({ toolName: 'spawn_subagent', toolInput: input, sessionId: 'g1' });

test('Grok: pin rewrites only when the spawn already has a model field; types match case-insensitively', async () => {
  fresh();
  setSubagentModel('explore', 'grok-4.3');
  const withField = await runGuard(grokSpawn({ subagent_type: 'Explore', prompt: 'x', model: undefined }), NOW, 30);
  assert.equal(withField.updatedInput.model, 'grok-4.3');
  assert.equal(withField.updatedInput.prompt, 'x');
  assert.equal(await runGuard(grokSpawn({ subagent_type: 'explore', prompt: 'x' }), NOW, 30), null); // no model field: schema would reject a rewrite
  assert.equal(await runGuard(grokSpawn({ subagent_type: 'explore', prompt: 'x', model: 'grok-4.6' }), NOW, 30), null); // caller chose
});
