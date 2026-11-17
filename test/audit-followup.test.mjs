import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyTrim, undoTrim } from '../src/apply.mjs';
import { forecastAll } from '../src/forecast.mjs';
import { guardDecision } from '../src/guard.mjs';
import { capabilityProposals, normalizeEvent, processEvent, readOptimization, repository } from '../src/optimize.mjs';
import { runOptimizationHook, runOptimize, transcriptTools } from '../src/optimize-cli.mjs';
import { load, record } from '../src/store.mjs';
import { trimReport } from '../src/trim.mjs';
import { readUsage } from '../src/usage.mjs';

const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'lc-followup-'));
  process.env.LIMITCAST_STATE = join(root, 'state');
  mkdirSync(process.env.LIMITCAST_STATE);
  return root;
};
const emptyState = () => ({ version: 1, hosts: {}, facts: [], receipts: [], config: { learn: true, map: false, keep: [] } });

test('Claude activity distinguishes observed, missing and incomplete histories across cached reads', async () => {
  const root = fresh();
  const claude = join(root, 'claude');
  mkdirSync(claude);
  const file = join(claude, 's.jsonl');
  const used = () => ({ skills: new Set(), mcp: new Set() });
  const roots = { claude, codex: join(root, 'codex'), grok: join(root, 'grok') };
  const absent = used();
  await readUsage(0, roots, absent);
  assert.equal(absent.observed, false);
  assert.match(trimReport(null, { files: [], skills: [], mcp: [] }, absent, 14, true), /missing or incomplete/);
  const row = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'mcp__synthetic__query', input: {} },
        { type: 'text', text: '<command-name>/used-skill</command-name>' },
      ],
    },
  };
  writeFileSync(file, `${JSON.stringify(row).replaceAll(':', ': ')}\n`);
  for (let i = 0; i < 2; i++) {
    const activity = used();
    await readUsage(0, roots, activity);
    assert.equal(activity.complete, true);
    assert.equal(activity.observed, true);
    assert.deepEqual([...activity.mcp], ['synthetic']);
    assert.deepEqual([...activity.skills], ['used-skill']);
  }
  writeFileSync(file, `${JSON.stringify(row)}\n{"type":"assistant",`);
  for (let i = 0; i < 2; i++) {
    const activity = used();
    await readUsage(0, roots, activity);
    assert.equal(activity.complete, false);
    assert.deepEqual([...activity.mcp], ['synthetic']);
  }
});

test('Claude CLI never applies cuts from spaced used records or incomplete evidence, including cache hits', () => {
  for (const mode of ['spaced', 'torn']) {
    const root = fresh();
    const claude = join(root, 'claude');
    const project = join(root, 'project');
    mkdirSync(join(claude, 'projects', 'fixture'), { recursive: true });
    mkdirSync(project);
    const rows = [
      { type: 'user', cwd: project, message: { content: 'synthetic audit' } },
      { type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: ['synthetic'], addedBlocks: ['fixture'] } },
      { type: 'assistant', timestamp: new Date().toISOString(), entrypoint: 'cli', message: { content: [], usage: {} } },
    ].map(JSON.stringify);
    const call = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__synthetic__query', input: {} }] } });
    rows.push(mode === 'spaced' ? call.replaceAll(':', ': ') : call.slice(0, -1));
    writeFileSync(join(claude, 'projects', 'fixture', 's.jsonl'), `${rows.join('\n')}\n`);
    const config = join(claude, '.claude.json');
    const before = JSON.stringify({ mcpServers: { synthetic: { command: 'never-run' } } });
    writeFileSync(config, before);
    writeFileSync(join(claude, 'settings.json'), '{}');
    writeFileSync(join(process.env.LIMITCAST_STATE, 'config.json'), JSON.stringify({ trimKeep: ['ego-browser'] }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(root, 'codex'), GROK_HOME: join(root, 'grok') };
    for (let i = 0; i < 2; i++) {
      const output = execFileSync(process.execPath, ['bin/limitcast.mjs', 'trim', '--apply'], { env, encoding: 'utf8' });
      assert.equal(readFileSync(config, 'utf8'), before);
      assert.doesNotMatch(output, /Turned off/);
      if (mode === 'torn') assert.match(output, /missing or incomplete/i);
    }
  }
});

test('an unchanged fresh reading expires an idle burn rate without growing duplicate history', () => {
  fresh();
  const now = Date.now();
  const sample = (t, pct) => ({ t, src: 'claude', win: '5h', pct, reset: (now + 3 * 3600000) / 1000, sid: 'fixture' });
  record([sample(now - 2 * 3600000, 10)]);
  record([sample(now - 110 * 60000, 20)]);
  for (let i = 0; i < 50; i++) record([sample(now - 1000 + i, 20)]);
  const samples = load(0);
  assert.equal(samples.length, 3);
  assert.equal(Math.max(...samples.map((s) => s.t)), now - 951);
  const forecasts = forecastAll(samples, now);
  assert.equal(forecasts[0].wall, null);
  assert.equal(guardDecision('Agent', forecasts, now, 30), null);
  assert.equal(forecastAll(samples.slice(0, 2), now)[0].wall, null);
  const burst = forecastAll([sample(now - 10 * 60000, 80), sample(now, 95)], now);
  assert.match(guardDecision('Agent', burst, now, 30), /limit/);
});

test('nested Claude settings and ledgers fail before writes or false success', () => {
  const bad = [
    { skillOverrides: [] },
    { skillOverrides: 'invalid' },
    { projects: [] },
    { projects: { fixture: [] } },
    { projects: { fixture: { disabledMcpServers: 'server' } } },
    { projects: { fixture: { disabledMcpServers: [12] } } },
  ];
  for (const value of bad) {
    const root = fresh();
    const settings = join(root, 'settings.json');
    const text = JSON.stringify(value);
    writeFileSync(settings, text);
    assert.throws(() => applyTrim({ hide: ['example'], disable: [] }, { cwd: 'fixture', now: 1, settings }), /invalid/i);
    assert.equal(readFileSync(settings, 'utf8'), text);
    assert.equal(existsSync(join(process.env.LIMITCAST_STATE, 'trim-applied.json')), false);
  }
  const root = fresh();
  const settings = join(root, 'settings.json');
  writeFileSync(settings, '{}');
  writeFileSync(join(process.env.LIMITCAST_STATE, 'trim-applied.json'), JSON.stringify([{ cwd: root, skills: [null], mcp: [] }]));
  assert.throws(() => undoTrim({ settings }), /invalid/i);
  assert.equal(readFileSync(settings, 'utf8'), '{}');
});

test('Codex and Grok server proposals need five sessions that observed that server', () => {
  for (const host of ['codex', 'grok']) {
    const state = emptyState();
    const emit = (sid, event, servers) => processEvent(state, { ...normalizeEvent({ session_id: sid, hook_event_name: event }, host), servers });
    for (let i = 0; i < 5; i++) {
      emit(`old-${i}`, 'UserPromptSubmit', ['old']);
      emit(`old-${i}`, 'UserPromptSubmit', ['old']);
      emit(`old-${i}`, 'Stop', ['old']);
    }
    const configured = [
      { name: 'old', enabled: true },
      { name: 'new', enabled: true },
    ];
    assert.ok(capabilityProposals(state, host, configured).includes('old'));
    assert.ok(!capabilityProposals(state, host, configured).includes('new'));
    for (let i = 0; i < 5; i++) {
      emit(`new-${i}`, 'UserPromptSubmit', ['old', 'new']);
      emit(`new-${i}`, 'Stop', ['old', 'new']);
      emit(`new-${i}`, 'Stop', ['old', 'new']);
      assert.equal(capabilityProposals(state, host, configured).includes('new'), i === 4);
    }
    emit('removed', 'UserPromptSubmit', ['old']);
    emit('readded', 'UserPromptSubmit', ['old', 'new']);
    assert.ok(!capabilityProposals(state, host, configured).includes('new'));
  }
});

test('Claude native ingestion observes 300 tools and flags bounded-read truncation', () => {
  const root = fresh();
  execFileSync('git', ['init', '-q', root]);
  const file = join(root, 'transcript.jsonl');
  const tools = Array.from({ length: 300 }, (_, i) => `mcp__fixture__tool${i}`);
  writeFileSync(file, `${JSON.stringify({ type: 'system', subtype: 'init', tools })}\n`);
  assert.equal(transcriptTools(file).length, 300);
  assert.equal(transcriptTools(file).complete, true);
  const old = process.env.LIMITCAST_MODEL_WORKER;
  delete process.env.LIMITCAST_MODEL_WORKER;
  try {
    for (let i = 0; i < 5; i++) runOptimizationHook({ cwd: root, session_id: `s${i}`, hook_event_name: 'Stop', transcript_path: file }, 'claude');
    const state = readOptimization(repository(root));
    assert.equal(Object.keys(state.hosts.claude.catalog).length, 300);
    assert.equal(state.hosts.claude.catalog[tools[299]].sessions.length, 5);
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ type: 'user', text: 'x'.repeat(260000) })}\n`);
    assert.equal(transcriptTools(file).complete, false);
  } finally {
    if (old === undefined) delete process.env.LIMITCAST_MODEL_WORKER;
    else process.env.LIMITCAST_MODEL_WORKER = old;
  }
});

test('Claude keeps used tools protected when usage history fills before catalog discovery', () => {
  const state = emptyState();
  const emit = (sid, event, extra = {}) => processEvent(state, normalizeEvent({ session_id: sid, hook_event_name: event, ...extra }, 'claude'));
  for (let i = 0; i < 400; i++) emit('busy', 'PostToolUse', { tool_name: `mcp__fixture__used${i}` });
  emit('busy', 'PostToolUse', { tool_name: 'mcp__fixture__late' });
  for (let i = 0; i < 5; i++) {
    emit(`s${i}`, 'UserPromptSubmit');
    emit(`s${i}`, 'UserPromptSubmit');
    emit(`s${i}`, 'Stop', { tools: ['mcp__fixture__late'] });
  }
  assert.ok(!capabilityProposals(state, 'claude').includes('mcp__fixture__late'));
});

test('learning explains eligible, unsupported and ambiguous checks without retaining their text', () => {
  const state = emptyState();
  const events = [
    { tool_name: 'Bash', tool_input: { command: 'node --test' }, tool_response: { exit_code: 0 } },
    { tool_name: 'Bash', tool_input: { command: 'pytest' }, tool_response: { exit_code: 1 } },
    { tool_name: 'Bash', tool_input: { command: 'node --test test/private-canary.test.mjs' }, tool_response: { exit_code: 0 } },
    {
      tool_name: 'exec',
      tool_input: { code: 'tools.exec_command({cmd:"npm test"}); tools.exec_command({cmd:"npm run lint"});' },
      tool_response: { exit_code: 0 },
    },
    { tool_name: 'Read', tool_input: { path: 'private-canary' }, tool_response: {} },
  ];
  for (const [i, value] of events.entries()) {
    const e = normalizeEvent({ session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: String(i), ...value }, 'codex');
    processEvent(state, e);
    processEvent(state, e);
  }
  assert.deepEqual(state.hosts.codex.learningEvidence, { eligible: 2, passed: 1, failed: 1, unsupported: 1, ambiguous: 1 });
  assert.equal(JSON.stringify(state).includes('private-canary'), false);
  assert.equal(state.facts.length, 0);
});

test('native hooks record configured server availability and expose learning diagnostics', () => {
  const root = fresh();
  execFileSync('git', ['init', '-q', root]);
  const prior = { CODEX_HOME: process.env.CODEX_HOME, GROK_HOME: process.env.GROK_HOME, LIMITCAST_MODEL_WORKER: process.env.LIMITCAST_MODEL_WORKER };
  delete process.env.LIMITCAST_MODEL_WORKER;
  try {
    for (const [host, key] of [
      ['codex', 'CODEX_HOME'],
      ['grok', 'GROK_HOME'],
    ]) {
      process.env[key] = join(root, host);
      mkdirSync(process.env[key]);
      writeFileSync(join(process.env[key], 'config.toml'), '[mcp_servers.fixture]\ncommand="never-run"\n');
      for (let i = 0; i < 5; i++) {
        for (const event of ['SessionStart', 'UserPromptSubmit', 'UserPromptSubmit', 'Stop'])
          runOptimizationHook({ cwd: root, session_id: `${host}-${i}`, hook_event_name: event }, host);
      }
      const state = readOptimization(repository(root));
      assert.equal(state.hosts[host].serverSessions.fixture.length, 5);
      assert.ok(capabilityProposals(state, host, [{ name: 'fixture' }, { name: 'new' }]).includes('fixture'));
      assert.ok(!capabilityProposals(state, host, [{ name: 'new' }]).includes('new'));
    }
    const status = runOptimize(['status'], root);
    assert.equal(status.measurements.learning.eligibleChecks, 0);
    assert.match(status.measurements.learning.requirements, /allowlisted/);
    assert.equal(status.hosts.codex.learningEvidence, null);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
