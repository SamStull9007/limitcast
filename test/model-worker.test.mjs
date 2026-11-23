import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { callOptimizationModel, reserveModelJob, startModelWorker } from '../src/model-optimize.mjs';
import { changeOptimization, normalizeEvent, processEvent, readOptimization, repository } from '../src/optimize.mjs';

test('native model subprocess stays isolated, accepts structured output, and refuses malformed/tool output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-native-model-'));
  const executable = join(dir, 'codex'),
    receipt = join(dir, 'receipt.json');
  const originalPath = process.env.PATH;
  const job = { kind: 'learn', evidence: { checks: ['node --test'] } };
  process.env.PATH = `${dir}${delimiter}${originalPath}`;
  const install = (events) =>
    writeFileSync(
      executable,
      `#!/usr/bin/env node
    const fs=require('node:fs');
    fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),prompt:fs.readFileSync(0,'utf8'),worker:process.env.LIMITCAST_MODEL_WORKER,allow:process.env.LIMITCAST_ALLOW}));
    process.stdout.write(${JSON.stringify(events)});`,
      { mode: 0o755 },
    );
  try {
    install(
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify({ stuck: false, confidence: 0.9, commands: ['node --test'] }) },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 123, cached_input_tokens: 10, output_tokens: 8 } }),
      ].join('\n'),
    );
    const result = await callOptimizationModel(job);
    assert.equal(result.usage.input_tokens, 123);
    assert.deepEqual(result.verdict.commands, ['node --test']);
    const captured = JSON.parse(readFileSync(receipt, 'utf8'));
    for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', 'read-only', '--output-schema'])
      assert.ok(captured.args.includes(flag));
    for (const feature of ['hooks', 'plugins', 'shell_tool', 'unified_exec', 'multi_agent']) assert.ok(captured.args.includes(feature));
    assert.ok(captured.args.includes('web_search="disabled"'));
    assert.equal(captured.worker, '1');
    assert.equal(captured.allow, '1');
    assert.notEqual(captured.cwd, process.cwd());
    assert.equal(existsSync(captured.cwd), false);
    assert.match(captured.prompt, /node --test/);
    install('not JSON');
    await assert.rejects(() => callOptimizationModel(job));
    install(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'forbidden' } }));
    await assert.rejects(() => callOptimizationModel(job), /unexpected model tool use/);
    install(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'not JSON' } }));
    await assert.rejects(() => callOptimizationModel(job));
  } finally {
    process.env.PATH = originalPath;
  }
});

test('detached native worker persists a bounded result and does not apply a cancelled job', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-detached-worker-'));
  execFileSync('git', ['init', '-q', dir]);
  const executable = join(dir, 'codex');
  writeFileSync(
    executable,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ stuck: false, confidence: 0.9, commands: ['node --test'] }) } }))});`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH,
    oldState = process.env.LIMITCAST_STATE;
  process.env.PATH = `${dir}${delimiter}${oldPath}`;
  process.env.LIMITCAST_STATE = join(dir, 'state');
  try {
    const repo = repository(dir);
    const event = normalizeEvent(
      {
        session_id: 'worker',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'node --test' },
        tool_response: { exit_code: 0 },
      },
      'codex',
    );
    const job = changeOptimization(repo, (s) => {
      s.config.model = true;
      s.config.learn = true;
      processEvent(s, event);
      return reserveModelJob(s, event, 'learn');
    });
    startModelWorker(repo, job);
    const deadline = Date.now() + 10000;
    while (readOptimization(repo).model.job && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const state = readOptimization(repo);
    assert.equal(state.model.job, undefined);
    assert.equal(state.model.receipts.at(-1).status, 'ok');
    assert.equal(state.model.receipts.at(-1).usage, null);
    assert.equal(state.facts[0].state, 'candidate');
    const cancelled = changeOptimization(repo, (s) => {
      const session = s.hosts.codex.sessions[event.sid];
      session.learningRequested = false;
      return reserveModelJob(s, event, 'learn');
    });
    changeOptimization(repo, (s) => {
      s.config.model = false;
      delete s.model.job;
    });
    startModelWorker(repo, cancelled);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(readOptimization(repo).model.receipts.length, 1);
  } finally {
    process.env.PATH = oldPath;
    if (oldState === undefined) delete process.env.LIMITCAST_STATE;
    else process.env.LIMITCAST_STATE = oldState;
  }
});

test('a hung native model is terminated at the production timeout', { timeout: 65000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-model-timeout-'));
  const pidFile = join(dir, 'pid');
  writeFileSync(
    join(dir, 'codex'),
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,
    { mode: 0o755 },
  );
  const old = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${old}`;
  try {
    await assert.rejects(
      () => callOptimizationModel({ kind: 'judge', evidence: { calls: 30 } }),
      (error) => error.code === 'ETIMEDOUT',
    );
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === 'ESRCH',
    );
  } finally {
    process.env.PATH = old;
  }
});
