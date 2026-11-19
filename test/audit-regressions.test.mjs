import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyTrim, reapplyTrim, undoTrim } from '../src/apply.mjs';
import { applyCodexTrim, codexTrimReport, codexUsedServers, undoCodexTrim } from '../src/codex.mjs';
import { applyGrokTrim, undoGrokTrim } from '../src/grok.mjs';
import { changeOptimization, readOptimization, repository } from '../src/optimize.mjs';
import { runOptimizationHook, runOptimize } from '../src/optimize-cli.mjs';
import { updateConfig, withStateLock } from '../src/store.mjs';
import { toolLimitDecision } from '../src/toollimit.mjs';
import { commitTransaction, editText, recoverTransaction } from '../src/transaction.mjs';

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-audit-'));
  process.env.LIMITCAST_STATE = join(dir, 'state');
  mkdirSync(process.env.LIMITCAST_STATE);
  return dir;
};
const plan = { hide: ['example'], disable: ['server'] };

test('unknown MCP schemas never authorize rewriting business inputs or holding unpaginated calls', () => {
  const stats = { 'mcp:billing': { avg: 6000, calls: 20 } };
  for (const host of ['claude', 'codex', 'grok']) {
    for (const [tool, input] of [
      ['set_credit_limit', { limit: 5000 }],
      ['get_invoice', { id: 'a' }],
      ['search', { query: { first: 900 } }],
    ]) {
      assert.equal(toolLimitDecision(`${host === 'grok' ? '' : 'mcp__'}billing__${tool}`, input, stats, { host }), null);
    }
  }
});

test('malformed, unreadable and non-object existing settings survive an attempted update byte for byte', () => {
  for (const text of ['{"trimKeep":["critical"],', 'null', '[]', '42']) {
    const dir = fresh();
    const file = join(process.env.LIMITCAST_STATE, 'config.json');
    writeFileSync(file, text);
    assert.throws(() => updateConfig((c) => ({ ...c, plan: 'pro' })), /preserve/);
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.equal(existsSync(join(dir, 'state/config.json.lock')), false);
  }
  fresh();
  mkdirSync(join(process.env.LIMITCAST_STATE, 'config.json'));
  assert.throws(() => updateConfig((c) => ({ ...c, plan: 'pro' })), /preserve/);
});

test('a paused live owner cannot be evicted; a killed owner and competing recoverers do not lose updates', async () => {
  fresh();
  const url = new URL('../src/store.mjs', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {updateConfig} from ${JSON.stringify(url)};
    updateConfig(c => { console.log('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000); return {...c,first:true}; });`,
    ],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const done = once(child, 'close');
  await once(child.stdout, 'data');
  updateConfig((c) => ({ ...c, second: true }));
  assert.equal((await done)[0], 0);
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.LIMITCAST_STATE, 'config.json'), 'utf8')), { first: true, second: true });
  const dead = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {updateConfig} from ${JSON.stringify(url)};
    updateConfig(c => { console.log('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000); return c; });`,
    ],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const stopped = once(dead, 'close');
  await once(dead.stdout, 'data');
  dead.kill('SIGKILL');
  await stopped;
  const workers = Array.from({ length: 6 }, (_, i) => {
    const p = spawn(
      process.execPath,
      ['--input-type=module', '-e', `import {updateConfig} from ${JSON.stringify(url)}; updateConfig(c=>({...c,k${i}:true}));`],
      { env: { ...process.env }, stdio: 'inherit' },
    );
    return once(p, 'close');
  });
  assert.ok((await Promise.all(workers)).every(([code]) => code === 0));
  const cfg = JSON.parse(readFileSync(join(process.env.LIMITCAST_STATE, 'config.json'), 'utf8'));
  assert.equal(Object.keys(cfg).length, 8);
});

test('all three trim adapters refuse bad ledgers before touching configuration', () => {
  for (const [name, apply, undo] of [
    [
      'trim-applied.json',
      (path, dir) => applyTrim(plan, { cwd: dir, now: 1, settings: path, claudeJson: join(dir, 'claude.json') }),
      (path) => undoTrim({ settings: path }),
    ],
    ['codex-trim-applied.json', (path) => applyCodexTrim(['server'], { path }), (path) => undoCodexTrim({ path })],
    ['grok-trim-applied.json', (path) => applyGrokTrim(['server'], { path }), (path) => undoGrokTrim({ path })],
  ]) {
    for (const bad of ['directory', 'json']) {
      const dir = fresh();
      const path = join(dir, 'config');
      const before = name === 'trim-applied.json' ? '{}' : '[mcp_servers.server]\ncommand="server"\n';
      writeFileSync(path, before);
      writeFileSync(join(dir, 'claude.json'), '{}');
      const ledger = join(process.env.LIMITCAST_STATE, name);
      if (bad === 'directory') mkdirSync(ledger);
      else writeFileSync(ledger, 'not JSON');
      assert.throws(() => apply(path, dir));
      assert.throws(() => undo(path));
      assert.equal(readFileSync(path, 'utf8'), before);
    }
  }
});

test('invalid second configuration is caught before the first file changes', () => {
  const dir = fresh(),
    settings = join(dir, 'settings.json'),
    claudeJson = join(dir, 'claude.json');
  writeFileSync(settings, '{}');
  writeFileSync(claudeJson, 'invalid');
  assert.throws(() => applyTrim(plan, { cwd: dir, now: 1, settings, claudeJson }), /invalid/);
  assert.equal(readFileSync(settings, 'utf8'), '{}');
});

test('partial apply and undo recover exactly, completed journals finalize, and user edits refuse recovery', () => {
  const dir = fresh(),
    ledger = join(process.env.LIMITCAST_STATE, 'ledger.json'),
    config = join(dir, 'settings.json');
  const before = 'original',
    after = 'trimmed';
  const changes = [
    { path: config, before, after },
    { path: ledger, before: null, after: '[{"at":1}]' },
  ];
  const journal = `${ledger}.pending.json`;
  for (const completed of [false, true]) {
    writeFileSync(config, after);
    if (completed) writeFileSync(ledger, changes[1].after);
    writeFileSync(journal, JSON.stringify({ version: 1, changes }));
    withStateLock(() => recoverTransaction(ledger));
    assert.equal(readFileSync(config, 'utf8'), completed ? after : before);
    assert.equal(existsSync(journal), false);
  }
  writeFileSync(config, 'user edit');
  writeFileSync(journal, JSON.stringify({ version: 1, changes }));
  assert.throws(() => withStateLock(() => recoverTransaction(ledger)), /reconcile manually/);
  assert.equal(readFileSync(config, 'utf8'), 'user edit');
  assert.equal(existsSync(journal), true);
});

test('a write failure after journaling rolls back earlier writes and retains a usable ledger', () => {
  const dir = fresh(),
    ledger = join(process.env.LIMITCAST_STATE, 'ledger.json'),
    config = join(dir, 'settings.json');
  writeFileSync(config, 'before');
  const updates = [editText(config, () => 'after'), { path: join(dir, 'missing-parent/config'), before: null, after: 'new' }];
  assert.throws(() => withStateLock(() => commitTransaction(ledger, [{ at: 1 }], updates)), /ENOENT/);
  assert.equal(readFileSync(config, 'utf8'), 'before');
  assert.equal(existsSync(`${ledger}.pending.json`), false);
});

test('drift preserves an explicit off setting and re-enabled servers, including a single trimmed item', () => {
  const dir = fresh(),
    settings = join(dir, 'settings.json'),
    claudeJson = join(dir, 'claude.json');
  writeFileSync(settings, '{}');
  writeFileSync(claudeJson, '{}');
  applyTrim(plan, { cwd: dir, now: 1, settings, claudeJson });
  writeFileSync(settings, JSON.stringify({ skillOverrides: { example: 'off' } }));
  writeFileSync(claudeJson, '{}');
  assert.deepEqual(reapplyTrim({ settings, claudeJson }), { reapplied: [], released: ['example', 'server'] });
  assert.equal(JSON.parse(readFileSync(settings)).skillOverrides.example, 'off');
  assert.equal(readFileSync(claudeJson, 'utf8'), '{}');
});

test('stale trim plans cannot own user-disabled settings, and undo does not recreate deleted configuration', () => {
  const dir = fresh(),
    settings = join(dir, 'settings.json'),
    claudeJson = join(dir, 'claude.json');
  const originalSettings = JSON.stringify({ skillOverrides: { example: 'off' } });
  const originalServers = JSON.stringify({ projects: { [dir]: { disabledMcpServers: ['server'] } } });
  writeFileSync(settings, originalSettings);
  writeFileSync(claudeJson, originalServers);
  const entry = applyTrim(plan, { cwd: dir, now: 1, settings, claudeJson });
  assert.deepEqual(entry.skills, []);
  assert.deepEqual(entry.mcp, []);
  assert.equal(readFileSync(settings, 'utf8'), originalSettings);
  assert.equal(readFileSync(claudeJson, 'utf8'), originalServers);
  writeFileSync(settings, '{}');
  writeFileSync(claudeJson, '{}');
  applyTrim(plan, { cwd: dir, now: 2, settings, claudeJson });
  unlinkSync(settings);
  unlinkSync(claudeJson);
  undoTrim({ settings, claudeJson });
  assert.equal(existsSync(settings), false);
  assert.equal(existsSync(claudeJson), false);
});

test('Codex usage supports flat, spaced namespace and completion records; absent or torn telemetry cannot prune', async () => {
  const dir = fresh();
  const path = join(dir, 'rollout-1.jsonl');
  const rows = [
    { type: 'response_item', payload: { type: 'function_call', name: 'mcp__flat__get_record' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'get_record', namespace: 'mcp__spaced' } },
    { type: 'event_msg', payload: { item: { type: 'McpToolCall', server: 'completed' } } },
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r).replaceAll(':', ': ')).join('\n'));
  const used = await codexUsedServers(0, dir);
  assert.deepEqual([...used].sort(), ['completed', 'flat', 'spaced']);
  assert.equal(used.complete, true);
  const servers = [{ name: 'unused', enabled: true }];
  assert.deepEqual(codexTrimReport({ servers, used, startup: null, days: 30, pro: true }).unused, ['unused']);
  writeFileSync(path, '{torn');
  assert.deepEqual(codexTrimReport({ servers, used: await codexUsedServers(0, dir), startup: null, days: 30, pro: true }).unused, []);
  assert.deepEqual(codexTrimReport({ servers, used: await codexUsedServers(0, join(dir, 'absent')), startup: null, days: 30, pro: true }).unused, []);
});

test('optimizer updates ignore a broken settings file and do not rewrite an unchanged state', () => {
  const dir = fresh();
  execFileSync('git', ['init', '-q', dir]);
  const repo = repository(dir);
  const state = process.env.LIMITCAST_STATE;
  const settings = join(state, 'config.json');
  writeFileSync(settings, '{');
  changeOptimization(repo, (s) => {
    s.config.learn = true;
  });
  const file = join(state, 'optimize', `${repo.id}.json`);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).config.learn, true);
  assert.equal(readFileSync(settings, 'utf8'), '{');
  assert.equal(existsSync(join(state, 'config.json.lock')), false);
  assert.equal(existsSync(join(state, 'optimize.json.lock')), false);
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  const mtime = statSync(file).mtimeMs;
  assert.equal(
    changeOptimization(repo, () => 'same'),
    'same',
  );
  assert.equal(statSync(file).mtimeMs, mtime);
  assert.throws(
    () =>
      changeOptimization(repo, () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(existsSync(join(state, 'optimize.json.lock')), false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).config.learn, true);
});

test('optimizer measurements expose injected overhead without inventing task success or net savings', () => {
  const dir = fresh();
  execFileSync('git', ['init', '-q', dir]);
  const repo = repository(dir);
  changeOptimization(repo, (s) => {
    s.config.learn = true;
    s.facts = [{ state: 'active', from: 'pytest', to: 'python3 -m pytest' }];
  });
  const old = process.env.LIMITCAST_MODEL_WORKER;
  delete process.env.LIMITCAST_MODEL_WORKER;
  try {
    const hook = { session_id: 'measure', cwd: dir, hook_event_name: 'SessionStart' };
    const result = runOptimizationHook(hook, 'codex');
    assert.match(result.hookSpecificOutput.additionalContext, /Repository evidence/);
    assert.deepEqual(runOptimizationHook(hook, 'codex'), {});
    assert.equal(readOptimization(repo).measurements.injections, 1);
    const status = runOptimize(['status'], dir).measurements;
    assert.ok(status.injectedContext.estimatedContextTokens > 0);
    assert.match(status.netSavings, /unproven/);
    assert.match(status.taskSuccess, /unmeasured/);
  } finally {
    if (old === undefined) delete process.env.LIMITCAST_MODEL_WORKER;
    else process.env.LIMITCAST_MODEL_WORKER = old;
  }
});
