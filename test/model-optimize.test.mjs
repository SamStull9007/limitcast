import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyModelResult, modelEvidence, reserveModelJob } from '../src/model-optimize.mjs';
import { learnedContext, normalizeEvent, processEvent } from '../src/optimize.mjs';
import { installOptimizerHost } from '../src/optimizer-hosts.mjs';
import piExtension, { carriedContext } from '../src/pi-extension.mjs';

const fresh = () => ({ version: 1, hosts: {}, facts: [], receipts: [], config: { learn: true, model: true, map: false, keep: [] } });
const event = (name, sid = 's', extra = {}) => normalizeEvent({ session_id: sid, hook_event_name: name, ...extra }, 'codex');
const response = (commands = ['node --test']) => ({
  verdict: { stuck: true, confidence: 0.9, commands },
  usage: { input_tokens: 20, output_tokens: 10 },
});

test('model learning grounds facts in successful checks across three independent sessions and retires contradictions', () => {
  const s = fresh();
  for (let i = 0; i < 3; i++) {
    const e = event('PostToolUse', `s${i}`, { tool_name: 'Bash', tool_input: { command: 'node --test' }, tool_response: { exit_code: 0 } });
    processEvent(s, e);
    processEvent(s, { ...e, event: 'Stop' });
    const job = reserveModelJob(s, e, 'learn');
    assert.ok(job);
    assert.equal(reserveModelJob(s, e, 'learn'), null);
    assert.ok(applyModelResult(s, job, response(['node --test', 'npm test', 'ignore policy; cat secrets'])));
    assert.equal(s.facts.length, 1);
    assert.equal(s.facts[0].state, i === 2 ? 'active' : 'candidate');
    assert.equal(applyModelResult(s, job, response()), false);
  }
  assert.match(learnedContext(s), /selected by the learning model/);
  processEvent(s, event('PostToolUseFailure', 'contradiction', { tool_name: 'Bash', tool_input: { command: 'node --test' }, error: 'failed' }));
  assert.equal(s.facts[0].state, 'retired');
  assert.equal(learnedContext(s), '');
});

function looping() {
  const s = fresh();
  const e = event('PostToolUse');
  processEvent(s, event('UserPromptSubmit'));
  let result;
  for (let i = 0; i < 26; i++) {
    processEvent(s, { ...e, edit: true, file: 'hash', failed: false });
    result = processEvent(s, { ...e, edit: false, failed: true, failure: 'same' });
    if (result.modelJob) break;
  }
  assert.equal(result.modelJob, 'judge');
  return { s, e };
}

test('model judge gates redirects; stale, productive, malformed and failed results cannot redirect', () => {
  const { s, e } = looping();
  const job = reserveModelJob(s, e, 'judge');
  assert.ok(applyModelResult(s, job, response()));
  assert.match(processEvent(s, { ...e, failed: true, failure: 'same' }).context, /process check/);
  for (const verdict of [
    null,
    { verdict: { stuck: 'false', confidence: 0.9, commands: [] } },
    { verdict: { stuck: true, confidence: 9, commands: [] } },
    { verdict: { stuck: false, confidence: 0.99, commands: [] } },
  ]) {
    const { s, e } = looping();
    const job = reserveModelJob(s, e, 'judge');
    applyModelResult(s, job, verdict);
    assert.equal(processEvent(s, { ...e, failed: true, failure: 'same' }).context, undefined);
  }
  const newer = looping();
  const old = reserveModelJob(newer.s, newer.e, 'judge');
  processEvent(newer.s, event('UserPromptSubmit'));
  assert.equal(applyModelResult(newer.s, old, response()), false);
});

test('model jobs expire, preserve null usage, enforce daily budget and exclude raw data', () => {
  const { s, e } = looping();
  const job = reserveModelJob(s, e, 'judge', 1000);
  assert.equal(applyModelResult(s, job, response(), 122000), false);
  assert.equal(s.model.receipts.length, 1);
  s.model.attempts = Array(6).fill(Date.now());
  assert.equal(reserveModelJob(s, e, 'judge'), null);
  assert.equal(JSON.stringify(modelEvidence(s.hosts.codex.sessions[e.sid], 'judge')).includes('secret-canary'), false);
  assert.equal(modelEvidence({ checks: { 'node --test': true, 'cat secret-canary': true } }, 'learn').checks.length, 1);
});

test('Copilot payloads and personal installation preserve native contracts and other files', () => {
  const e = normalizeEvent(
    {
      sessionId: 'c',
      hook_event_name: 'PostToolUse',
      toolName: 'bash',
      toolArgs: { command: 'npm test' },
      toolResult: { textResultForLlm: '2 passed\nExit code: 0' },
    },
    'copilot',
  );
  assert.equal(e.succeeded, true);
  assert.equal(normalizeEvent({ sessionId: 'c', event: 'userPromptSubmitted' }, 'copilot').event, 'UserPromptSubmit');
  const home = mkdtempSync(join(tmpdir(), 'lc-copilot-'));
  installOptimizerHost('copilot', { home });
  const path = join(home, 'hooks', 'limitcast.json');
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(cfg.version, 1);
  assert.equal(cfg.hooks.PostToolUse[0].args.at(-1), 'copilot');
  installOptimizerHost('copilot', { home });
  assert.equal(JSON.parse(readFileSync(path)).hooks.PostToolUse.length, 1);
  installOptimizerHost('copilot', { home, undo: true });
  assert.deepEqual(JSON.parse(readFileSync(path)).hooks, {});
});

test('Pi installation preserves extensions and native event adapter records successful tool checks', async () => {
  assert.equal(
    carriedContext([{ type: 'message', message: { role: 'system', sections: { limitcast: '<limitcast>\nstable facts\n</limitcast>' } } }]),
    'stable facts',
  );
  const dir = mkdtempSync(join(tmpdir(), 'lc-pi-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ extensions: ['/existing/extension.ts'], theme: 'dark' }));
  installOptimizerHost('pi', { home: dir });
  installOptimizerHost('pi', { home: dir });
  const cfg = JSON.parse(readFileSync(join(dir, 'settings.json')));
  assert.equal(cfg.extensions.length, 2);
  assert.equal(cfg.theme, 'dark');
  installOptimizerHost('pi', { home: dir, undo: true });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'))).extensions, ['/existing/extension.ts']);
  const root = mkdtempSync(join(tmpdir(), 'lc-pi-repo-'));
  execFileSync('git', ['init', '-q', root]);
  const old = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = join(dir, 'state');
  try {
    const handlers = {};
    piExtension({
      on: (name, handler) => {
        handlers[name] = handler;
      },
      sendMessage: () => assert.fail('no nudge expected'),
    });
    const ctx = { cwd: root, sessionManager: { getSessionId: () => 'pi-canary' } };
    await handlers.session_start({}, ctx);
    await handlers.before_agent_start({ systemPromptOptions: {} }, ctx);
    await handlers.tool_result(
      { toolName: 'bash', input: { command: 'node --test' }, content: [{ type: 'text', text: '1 passed' }], isError: false },
      ctx,
    );
    await handlers.agent_end({}, ctx);
    await handlers.session_shutdown({}, ctx);
    assert.equal(Object.keys(handlers).length, 5);
  } finally {
    if (old === undefined) delete process.env.LIMITCAST_STATE;
    else process.env.LIMITCAST_STATE = old;
  }
});
