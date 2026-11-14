import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { codexStartup, codexTrimReport } from '../src/codex.mjs';
import { codexHooks, trustLine } from '../src/codex-trust.mjs';
import { grokStartup, grokTrimReport } from '../src/grok.mjs';
import { findDuplicate, forgetInflight, rememberInflight, spawnIdentity } from '../src/inflight.mjs';
import { install, uninstall } from '../src/install.mjs';
import { codexNotifyDue, transitions } from '../src/notify.mjs';
import { callCost, costOf } from '../src/prices.mjs';
import { codexSubagentUsage, grokSubagentUsage, stopHost } from '../src/receipts.mjs';
import { burnReport } from '../src/report.mjs';
import { spawnNotice } from '../src/subagents.mjs';
import { mcpParts, toolKey, toolNotice } from '../src/toolcheck.mjs';
import { toolLimitDecision } from '../src/toollimit.mjs';
import { readUsage } from '../src/usage.mjs';
import { foldEvents } from '../src/value.mjs';

const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
process.env.LIMITCAST_STATE = tmp('lc-parity2-state-');

test('value record: old Grok "under" outcomes are judged again, or say unknown when the block is gone', () => {
  const now = Date.now();
  const hour = 3600_000;
  const t1 = now - 6 * hour;
  const t2 = now - 40 * hour;
  const v = {
    since: now - 10 * 86400_000,
    scanned: 0,
    sessions: {},
    hits: {},
    blocks: {
      [t1]: { t: t1, src: 'grok', win: '5h', shadow: false, outcome: 'under' },
      [t2]: { t: t2, src: 'grok', win: '5h', shadow: false, outcome: 'under' },
      99: { t: 99, src: 'codex', win: '7d', shadow: false, outcome: 'hit' },
    },
  };
  const reset = now - hour;
  const blocks = [{ t: t1, src: 'grok', win: '5h', pct: 80, wall: t1, reset }];
  const samples = [{ t: t1 + hour, src: 'grok', win: '5h', pct: 100, reset: reset / 1000 }];
  foldEvents(v, { now, samples, blocks });
  assert.equal(v.outcomesVersion, 2);
  assert.equal(v.blocks[t1].outcome, 'hit', 'judged again from the rebuilt Grok readings');
  assert.equal(v.blocks[t2].outcome, 'unknown', 'no block log entry: kept as a block, outcome not guessed');
  assert.equal(v.blocks[99].outcome, 'hit', 'other hosts are untouched');
  v.blocks[t1].outcome = 'under';
  foldEvents(v, { now, samples, blocks });
  assert.equal(v.blocks[t1].outcome, 'under', 'the migration runs once');
});

test('Codex models are priced at OpenAI list prices, with the long-context tier above 272k prompt tokens', () => {
  const call = (model, input, cacheRead, output) => ({ model, input, cacheWrite: 0, cacheRead, output });
  // 100k new + 100k cached + 10k output at $2 / $0.10 / $10 per million.
  assert.ok(Math.abs(callCost(call('gpt-6.1-sol', 100_000, 100_000, 10_000)) - 0.31) < 1e-9);
  // 300k prompt tokens: the whole request bills $4 in, $15 out.
  assert.ok(Math.abs(callCost(call('gpt-6.1-sol', 300_000, 0, 10_000)) - 1.35) < 1e-9);
  assert.ok(Math.abs(callCost(call('gpt-5.6-sol', 100_000, 100_000, 10_000)) - (0.4 + 0.04 + 0.2)) < 1e-9);
  assert.equal(callCost(call('codex-auto-review', 1000, 0, 10)), null, 'a routing alias with no list price stays unpriced');
  const c = costOf([call('gpt-6.1-sol', 100_000, 0, 0), call('codex-auto-review', 5, 5, 5)]);
  assert.equal(c.unpriced, 15);
  assert.equal(c.priced, 100_000);
});

const stopState = () => {
  const state = tmp('lc-parity2-stop-');
  const env = { ...process.env, LIMITCAST_STATE: state, GROK_HOME: join(state, '.grok'), CODEX_HOME: join(state, '.codex') };
  const stop = (hook) => spawnSync('node', [bin, 'subagent-receipt'], { env, input: JSON.stringify(hook), encoding: 'utf8', timeout: 20000 });
  const ledger = () => {
    try {
      return readFileSync(join(state, 'subagents.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    } catch {
      return [];
    }
  };
  return { state, env, stop, ledger };
};

const rollout = (path) => {
  const line = (type, payload, t) => JSON.stringify({ timestamp: new Date(t).toISOString(), type, payload });
  const total = (input, cached, output) => ({
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
  });
  const t = Date.now() - 60_000;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(
    path,
    [
      line('session_meta', { cwd: '/work' }, t),
      line('turn_context', { model: 'gpt-6.1-sol' }, t),
      line('event_msg', total(150_000, 50_000, 5_000), t + 1000), // 100k new + 50k cached + 5k out
      line('event_msg', total(300_000, 150_000, 8_000), t + 2000), // +50k new, +100k cached, +3k out
    ].join('\n'),
  );
};

test('a Codex subagent receipt is priced from its rollout and logged for Codex only', () => {
  const { state, stop, ledger } = stopState();
  const path = join(state, '.codex', 'sessions', 'child.jsonl');
  rollout(path);
  const u = codexSubagentUsage(path);
  assert.deepEqual([u.calls, u.fresh, u.read], [2, 158_000, 150_000]);
  // $2/M new, $0.10/M cached, $10/M output: 0.3 + 0.015 + 0.08
  assert.ok(Math.abs(/** @type {number} */ (u.usd) - 0.395) < 1e-9);
  const hook = { session_id: 'parent', agent_id: 'a1', agent_type: 'worker', agent_transcript_path: path };
  assert.equal(stopHost(hook), 'codex');
  const r = stop(hook);
  assert.match(
    JSON.parse(r.stdout).systemMessage,
    /that worker subagent used 308k tokens, 158k of them new \(2 calls\): about \$0\.40 at API list prices/,
  );
  const [entry] = ledger();
  assert.equal(entry.src, 'codex');
  assert.equal(entry.type, 'worker');
  assert.equal(entry.usd.toFixed(3), '0.395');
  assert.equal(entry.pct, undefined);
});

const grokChild = (root, proj, id, kind, ticks) => {
  const dir = join(root, proj, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ session_kind: kind }));
  writeFileSync(
    join(dir, 'usage.json'),
    JSON.stringify({
      session: { modelCalls: 14 },
      turns: [
        {
          endedAt: new Date().toISOString(),
          inputTokens: 600_000,
          cachedReadTokens: 500_000,
          cacheCreationTokens: 0,
          outputTokens: 12_000,
          costUsdTicks: ticks,
          primaryModelId: 'grok-4.6-build',
        },
      ],
    }),
  );
  return join(dir, 'chat_history.jsonl');
};

test('a Grok subagent receipt reads the child session ledger and never the parent session', () => {
  const { state, stop, ledger } = stopState();
  const root = join(state, '.grok', 'sessions');
  const transcript = grokChild(root, '%2Fwork', 'child-1', 'subagent', 1_947_037_200);
  grokChild(root, '%2Fwork', 'parent-1', 'main', 9_000_000_000);
  const u = grokSubagentUsage({ subagentId: 'child-1', sessionId: 'parent-1', transcriptPath: transcript }, root);
  assert.deepEqual([u?.calls, u?.fresh, u?.read], [14, 112_000, 500_000]);
  assert.equal(u?.usd?.toFixed(4), '0.1947', "Grok's own recorded cost, not a re-pricing");
  const hook = { sessionId: 'parent-1', subagentType: 'explore', subagentId: 'child-1', transcriptPath: transcript };
  assert.equal(stopHost(hook), 'grok');
  assert.match(JSON.parse(stop(hook).stdout).systemMessage, /that explore subagent used 612k tokens.*\(14 calls\): about \$0\.19 at API list prices/);
  assert.equal(ledger()[0].src, 'grok');
  // A hook that only names the parent session finds no child ledger, so there is no receipt.
  assert.equal(grokSubagentUsage({ sessionId: 'parent-1', transcriptPath: join(root, '%2Fwork', 'parent-1', 'chat_history.jsonl') }, root), null);
});

test("Grok writes a subagent's usage after its stop hook: the receipt is parked, then settled by the next hook", () => {
  const { state, env, stop, ledger } = stopState();
  const root = join(state, '.grok', 'sessions');
  const transcript = join(root, '%2Fwork', 'child-2', 'updates.jsonl');
  const hook = { sessionId: 'child-2', subagentId: 'child-2', subagentType: 'explore', transcriptPath: transcript };
  assert.equal(stop(hook).stdout, '', 'nothing to price yet, nothing printed');
  assert.deepEqual(ledger(), []);
  assert.equal(JSON.parse(readFileSync(join(state, 'pending-receipts.json'), 'utf8')).length, 1);
  grokChild(root, '%2Fwork', 'child-2', 'subagent', 1_947_037_200); // Grok writes the ledger a moment after the stop
  const next = spawnSync('node', [bin, 'tool-check', '--src', 'grok'], {
    env,
    input: JSON.stringify({ sessionId: 's', toolName: 'read_file', toolResult: 'x' }),
    encoding: 'utf8',
  });
  assert.equal(next.status, 0);
  const [entry] = ledger();
  assert.deepEqual([entry.src, entry.type, entry.id, entry.calls], ['grok', 'explore', 'child-2', 14]);
  assert.equal(entry.usd.toFixed(4), '0.1947');
  assert.equal(JSON.parse(readFileSync(join(state, 'pending-receipts.json'), 'utf8')).length, 0, 'settled receipts leave the queue');
});

test('Codex as seen live: spawn_agent arguments are encrypted, so a duplicate is the same task name; a custom CODEX_HOME is still Codex', () => {
  // Shapes captured from a real `codex exec` 0.169 run (gpt-6.1-sol): the hook's tool name joins namespace and name, the
  // message is a Fernet-style token that differs on every call, and no agent_type was given.
  const spawn = (message, task_name = 'read_hello') => ({
    session_id: 'parent-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'collaborationspawn_agent',
    tool_input: { task_name, message },
    tool_use_id: 'call_1',
  });
  const token = (seed) => `gAAAAABq97nu${seed}ne3NeLXmiVsuUE6bJX8V0rpEwUomOidCJsxCnWcjH7Sp8F0Y5JZsFFP3_F4rA7GEjg4aw4-qZKRYbjV7r_ZMkzJXEsReEaz0xu`;
  const a = spawnIdentity(spawn(token('3')));
  assert.deepEqual([a?.src, a?.type, a?.prompt], ['codex', 'default', 'task read_hello']);
  assert.equal(spawnIdentity(spawn(token('9')))?.hash, a?.hash, 'the same task, encrypted differently, is still a duplicate');
  assert.notEqual(spawnIdentity(spawn(token('3'), 'read_other'))?.hash, a?.hash);
  assert.ok(findDuplicate(rememberInflight([], a, Date.now()), spawnIdentity(spawn(token('7')))));
  // Its stop reports agent_type "default", which is the type recorded above, so the stop clears the hold.
  assert.deepEqual(forgetInflight(rememberInflight([], a, Date.now()), 'parent-1', 'default', Date.now()), []);
  const stop = {
    session_id: 'parent-1',
    turn_id: 't1',
    transcript_path: '/tmp/lc/codex/sessions/2026/11/13/rollout-2026-11-13T19-31-20-aaa.jsonl',
    agent_transcript_path: '/tmp/lc/codex/sessions/2026/11/13/rollout-2026-11-13T19-31-26-bbb.jsonl',
    hook_event_name: 'SubagentStop',
    agent_id: 'bbb',
    agent_type: 'default',
  };
  assert.equal(stopHost(stop), 'codex');
  const { turn_id: _t, ...noTurn } = stop;
  assert.equal(stopHost(noTurn), 'codex', 'a rollout path alone says Codex');
  assert.equal(
    stopHost({
      session_id: 's',
      agent_id: 'a',
      agent_type: 'Explore',
      agent_transcript_path: '/Users/you/.claude/projects/p/s/subagents/agent-a.jsonl',
    }),
    'claude',
  );
});

test('tool names: Grok says server__tool and read_file, Codex and Claude say mcp__server__tool', () => {
  assert.equal(toolKey('mcp__claude_ai_HubSpot__search'), 'mcp:claude_ai_HubSpot');
  assert.equal(toolKey('mcp__codex_apps__plugin_management__search_plugins', 'codex'), 'mcp:codex_apps');
  assert.equal(toolKey('basic-memory__search_notes', 'grok'), 'mcp:basic-memory');
  assert.equal(toolKey('basic-memory__search_notes', 'claude'), 'basic-memory__search_notes', 'Claude never drops the prefix');
  assert.equal(toolKey('read_file', 'grok'), 'Read');
  assert.equal(toolKey('run_terminal_command', 'grok'), 'Bash');
  assert.equal(toolKey('Bash', 'codex'), 'Bash');
  assert.deepEqual(mcpParts('basic-memory__write_note', 'grok'), { server: 'basic-memory', tool: 'write_note' });
  const big = { 'mcp:basic-memory': { avg: 9000, calls: 6 }, Read: { avg: 9000, calls: 6 } };
  const grok = (name, input) => toolLimitDecision(name, input, big, { host: 'grok' });
  assert.match(
    grok('basic-memory__search_notes', { query: 'x' }).deny,
    /basic-memory results average ≈9k tokens a call over 6 calls\. This call sets no limit/,
  );
  assert.equal(grok('basic-memory__search_notes', { query: 'x', limit: 500 }).updatedInput.limit, 100, 'Grok honors a rewritten input');
  assert.match(grok('read_file', { path: '/a' }).deny, /Read results average/);
  assert.equal(grok('read_file', { path: '/a', limit: 200 }), null);
  const codex = toolLimitDecision(
    'mcp__tool_router__call_tool',
    { limit: 500 },
    { 'mcp:tool_router': { avg: 9000, calls: 6 } },
    { host: 'codex', rewrite: false },
  );
  assert.match(codex.deny, /Use a limit of 100 or fewer \(this call asked for 500\)/);
  assert.match(
    toolNotice('basic-memory__search_notes', 'x'.repeat(100_000), { fresh: 5 }, undefined, 'grok'),
    /^limitcast: that basic-memory search_notes result was ≈25k tokens \(written once as new tokens, then re-read on every later call\)\. Next time: ask for fewer fields/,
  );
  assert.doesNotMatch(toolNotice('mcp__x__y', 'x'.repeat(100_000), { fresh: 5 }, undefined, 'codex'), /5-hour/);
});

test('tool-check learns result sizes for Grok, and tool-limit then holds a fat call', () => {
  const { env } = stopState();
  const run = (cmd, hook) => spawnSync('node', [bin, cmd, '--src', 'grok'], { env, input: JSON.stringify(hook), encoding: 'utf8', timeout: 20000 });
  for (let i = 0; i < 4; i++) {
    const r = run('tool-check', {
      sessionId: 's1',
      toolName: 'basic-memory__search_notes',
      toolInput: { query: 'q' },
      toolResult: 'y'.repeat(32_000),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'under the notice threshold: nothing is said');
  }
  const stats = readFileSync(join(env.LIMITCAST_STATE, 'tool-sizes-grok.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(stats[0], { k: 'mcp:basic-memory', n: 8000 });
  assert.equal(stats.length, 4);
  const held = run('tool-limit', { sessionId: 's1', toolUseId: 'call-1', toolName: 'basic-memory__search_notes', toolInput: { query: 'q' } });
  const out = JSON.parse(held.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /basic-memory results average ≈8k tokens a call over 4 calls/);
  const ok = run('tool-limit', { sessionId: 's1', toolName: 'basic-memory__search_notes', toolInput: { query: 'q', limit: 20 } });
  assert.equal(ok.stdout, '');
  assert.equal(run('tool-limit', { sessionId: 's1', toolName: 'other__tool', toolInput: {} }).stdout, '', 'a tool with no history is left alone');
  // The Claude stats file is separate: a Grok call never reads it, a Claude call never reads the live file.
  assert.equal(
    spawnSync('node', [bin, 'tool-limit'], {
      env,
      input: JSON.stringify({ tool_name: 'mcp__basic-memory__search_notes', tool_input: {} }),
      encoding: 'utf8',
    }).stdout,
    '',
  );
});

test('install --alerts adds the tool hooks for Codex and Grok beside the guard, and uninstall removes them', () => {
  const home = tmp('lc-parity2-install-');
  const settings = join(home, 'settings.json');
  const codexPath = join(home, 'codex', 'hooks.json');
  const grokDir = join(home, 'grok');
  mkdirSync(join(home, 'codex'), { recursive: true });
  mkdirSync(grokDir, { recursive: true });
  writeFileSync(join(grokDir, 'config.toml'), 'model = "grok-4.6"\n');
  const self = '/usr/local/bin/limitcast';
  install({ guard: true, path: settings, codexPath, grokDir, self });
  install({ guard: false, alerts: true, path: settings, codexPath, grokDir, self });
  const codex = JSON.parse(readFileSync(codexPath, 'utf8')).hooks;
  assert.equal(codex.PostToolUse[0].hooks[0].command, `${self} tool-check --src codex`);
  assert.equal(codex.PreToolUse.find((h) => h.hooks[0].command.includes('tool-limit')).matcher, 'mcp__.*');
  assert.ok(
    codex.PreToolUse.some((h) => h.hooks[0].command.endsWith(' guard')),
    'the guard stays',
  );
  assert.equal(codex.Stop[0].hooks[0].command, `${self} codex-notify --hook`);
  const grokHooks = JSON.parse(readFileSync(join(grokDir, 'hooks', 'limitcast.json'), 'utf8')).hooks;
  assert.ok(grokHooks.SubagentStop, 'installing alerts later keeps the Grok guard hooks');
  assert.deepEqual(
    grokHooks.PreToolUse.map((h) => h.hooks[0].command),
    [`${self} guard`, `${self} tool-limit --src grok`],
  );
  assert.equal(grokHooks.PostToolUse[0].hooks[0].command, `${self} tool-check --src grok`);
  install({ guard: false, alerts: true, path: settings, codexPath, grokDir, self });
  assert.equal(JSON.parse(readFileSync(codexPath, 'utf8')).hooks.PostToolUse.length, 1, 'idempotent');
  uninstall({ path: settings, codexPath, grokDir });
  const after = JSON.parse(readFileSync(codexPath, 'utf8')).hooks;
  assert.equal(JSON.stringify(after).includes('limitcast'), false);
  assert.equal(existsSync(join(grokDir, 'hooks', 'limitcast.json')), false);
});

test('trim: the start-context measure skips subagent sessions and uses the first call (Codex) or the instruction files (Grok)', async () => {
  const day = join(tmp('lc-parity2-cx-'), '2026', '11', '13');
  mkdirSync(day, { recursive: true });
  const rows = (meta, first) =>
    [
      { type: 'session_meta', payload: { base_instructions: { text: 'b'.repeat(8000) }, ...meta } },
      { type: 'world_state', payload: { state: { agents_md: { text: 'a'.repeat(4000) } } } },
      ...(first ? [{ type: 'event_msg', payload: { info: { total_token_usage: { input_tokens: first } } } }] : []),
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
  writeFileSync(join(day, 'rollout-main.jsonl'), rows({ thread_source: 'user' }, 31_000));
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(day, 'rollout-child.jsonl'), rows({ thread_source: 'subagent', source: { subagent: {} } }, 90_000)); // the newest
  const startup = await codexStartup(join(day, '..', '..', '..'));
  assert.deepEqual(startup, { agentsMd: 4000, base: 8000, first: 31_000 });
  const report = codexTrimReport({ servers: [], used: new Set(), startup, days: 7, pro: true });
  assert.match(
    report.text,
    /Your latest Codex session started with 31\.0k tokens on its first call \(measured\): ~1\.0k of AGENTS\.md \(your instruction files\), ~2\.0k of Codex's own instructions/,
  );

  const root = tmp('lc-parity2-gk-');
  const session = (id, kind) => {
    const dir = join(root, '%2Fwork', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'usage.json'), '{}');
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(kind ? { session_kind: kind } : {}));
    writeFileSync(join(dir, 'system_prompt.txt'), 's'.repeat(8000));
    writeFileSync(join(dir, 'tool_definitions.json'), 't'.repeat(40_000));
    writeFileSync(
      join(dir, 'prompt_context.json'),
      JSON.stringify({ agents_md_files: [{ content: 'a'.repeat(12_000) }, { content: 'b'.repeat(4000) }] }),
    );
  };
  session('main-1');
  await new Promise((r) => setTimeout(r, 20));
  session('child-1', 'subagent');
  const g = grokStartup(root);
  assert.deepEqual(g, { prompt: 8000, tools: 40_000, agentsMd: 16_000 });
  assert.match(
    grokTrimReport({ servers: [], used: new Set(), startup: g, days: 7, pro: true }).text,
    /~2\.0k tokens of system prompt, ~10\.0k of tool definitions and ~4\.0k of instruction files \(about 16\.0k in all, estimated from file sizes\)/,
  );
  assert.equal(grokStartup(join(root, 'none')), null);
});

test('report: Codex and Grok subagent threads count as subagent usage of the session that spawned them', async () => {
  const base = tmp('lc-parity2-attr-');
  const codex = join(base, 'codex');
  const grok = join(base, 'grok');
  mkdirSync(codex, { recursive: true });
  const ts = new Date().toISOString();
  const rollout = (id, meta, out) =>
    writeFileSync(
      join(codex, `rollout-2026-11-13T10-00-00-${id}.jsonl`),
      [
        { type: 'session_meta', payload: { id, cwd: '/work', model: 'gpt-6.1-sol', ...meta } },
        {
          timestamp: ts,
          type: 'event_msg',
          payload: { info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: out } } },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
  rollout('parent-thread', {}, 1000);
  rollout(
    'child-thread',
    { parent_thread_id: 'parent-thread', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'parent-thread' } } } },
    1000,
  );
  const ledger = (dir, kind) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(kind ? { session_kind: kind } : {}));
    writeFileSync(
      join(dir, 'usage.json'),
      JSON.stringify({
        turns: [
          {
            endedAt: ts,
            inputTokens: 1000,
            outputTokens: 1000,
            cachedReadTokens: 0,
            cacheCreationTokens: 0,
            costUsdTicks: 1,
            primaryModelId: 'grok-4.6',
          },
        ],
      }),
    );
  };
  ledger(join(grok, '%2Fwork', 'g-parent'), undefined);
  ledger(join(grok, '%2Fwork', 'g-child'), 'subagent');
  mkdirSync(join(grok, '%2Fwork', 'g-parent', 'subagents', 'g-child'), { recursive: true });
  writeFileSync(
    join(grok, '%2Fwork', 'g-parent', 'subagents', 'g-child', 'meta.json'),
    JSON.stringify({ child_session_id: 'g-child', parent_session_id: 'g-parent' }),
  );
  const usage = await readUsage(0, { claude: join(base, 'none'), codex, grok });
  const by = (src, sidechain) => usage.filter((u) => u.src === src && u.sidechain === sidechain);
  assert.equal(by('codex', true).length, 1);
  assert.equal(by('codex', true)[0].session, 'parent-thread', 'attributed to the spawning thread');
  assert.equal(by('grok', true)[0].session, 'g-parent');
  assert.equal(by('grok', false)[0].session, 'g-parent');
  const text = burnReport(usage, { since: 0, now: Date.now() });
  assert.match(text, /Subagents used \*\*50%\*\* of Codex tokens\./);
  assert.match(text, /Subagents used \*\*50%\*\* of Grok tokens\./);
  assert.doesNotMatch(text, /g-child|child-thr/, 'no child session is listed as a session of its own');
});

test('doctor asks Codex which limitcast hooks it trusts, and names the ones waiting for approval', async () => {
  const dir = tmp('lc-parity2-trust-');
  const server = join(dir, 'fake-app-server.mjs');
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline';
const hooks = [
  { key: '/h/.codex/hooks.json:pre_tool_use:0:0', trustStatus: 'trusted', enabled: true, command: '/bin/sh /s/limitcast-hook.sh guard' },
  { key: '/h/.codex/hooks.json:subagent_stop:0:0', trustStatus: 'untrusted', enabled: true, command: '/bin/sh /s/limitcast-hook.sh subagent-receipt' },
  { key: '/h/.codex/hooks.json:stop:0:0', trustStatus: 'modified', enabled: true, command: '/bin/sh /s/limitcast-hook.sh codex-notify --hook' },
  { key: '/h/.codex/hooks.json:stop:1:0', trustStatus: 'untrusted', enabled: true, command: 'someone-elses-hook' },
];
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
  if (m.method === 'hooks/list') console.log(JSON.stringify({ id: m.id, result: { data: [{ hooks }] } }));
});
`,
  );
  const rows = await codexHooks({ command: [process.execPath, server], timeoutMs: 10_000 });
  assert.equal(rows?.length, 4);
  const line = trustLine(rows ?? []);
  assert.equal(line?.ok, false);
  assert.match(
    line?.line ?? '',
    /^Codex hooks: 2 of 3 limitcast hooks are not trusted \(subagent_stop:0:0, stop:0:0\): start Codex, open \/hooks and approve them/,
  );
  assert.deepEqual(trustLine((rows ?? []).filter((h) => h.trustStatus === 'trusted')), {
    ok: true,
    line: 'Codex hooks: all 1 limitcast hooks are trusted',
  });
  assert.equal(trustLine([rows?.[3]]), null, "another tool's hook says nothing");
  assert.equal(await codexHooks({ command: [join(dir, 'no-such-codex')], timeoutMs: 2000 }), null, 'no Codex: no answer, no failure');
});

test('drift: Codex and Grok get a starting-context alert from the sizes their logs hold, with their own baseline', async () => {
  const { state, env } = stopState();
  const day = join(state, '.codex', 'sessions', '2026', '11', '13');
  mkdirSync(day, { recursive: true });
  const session = (name, started, agents) =>
    writeFileSync(
      join(day, name),
      [
        { type: 'session_meta', payload: { timestamp: started, base_instructions: { text: 'b'.repeat(8000) } } },
        { type: 'world_state', payload: { state: { agents_md: { text: 'a'.repeat(agents) } } } },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
  const drift = (src) => spawnSync('node', [bin, 'drift', '--hook', '--src', src], { env, input: '{}', encoding: 'utf8', timeout: 30000 });
  const messages = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).systemMessage : '');
  session('rollout-1.jsonl', '2026-11-13T10:00:00Z', 4000);
  assert.doesNotMatch(messages(drift('codex')), /starting context grew/, 'the first session only sets the baseline');
  await new Promise((r) => setTimeout(r, 20));
  session('rollout-2.jsonl', '2026-11-13T11:00:00Z', 12_000);
  assert.match(
    messages(drift('codex')),
    /^limitcast: your Codex starting context grew ~2\.0k tokens since your last session \(Instruction files: AGENTS\.md \+~2\.0k\)\. Run `limitcast trim --codex` for details\.$/m,
  );
  assert.equal(messages(drift('codex')), '', 'the same session again says nothing');
  assert.equal(existsSync(join(state, 'overhead.json')), false, "Claude's baseline file is not touched");
  assert.equal(existsSync(join(state, 'overhead-codex.json')), true);
  assert.equal(drift('grok').status, 0, 'no Grok sessions yet: nothing to record, no failure');
});

test('Codex notifications: a throttled Stop hook starts the check, and a Codex window is named', () => {
  assert.equal(codexNotifyDue(1_000_000), true);
  assert.equal(codexNotifyDue(1_000_000 + 60_000), false, 'asked again within three minutes');
  assert.equal(codexNotifyDue(1_000_000 + 200_000), true);
  const now = Date.now();
  const rows = [{ src: 'codex', win: '7d', pct: 100, reset: now + 86_400_000, wall: now, verdict: 'HIT' }];
  const { messages } = transitions(rows, {}, () => 'Friday 9am', now);
  assert.deepEqual(messages, ['Codex 7d limit reached. Resets Friday 9am.']);

  const { env } = stopState();
  env.CODEX_HOME = join(env.LIMITCAST_STATE, 'nocodex');
  const hook = () => spawnSync('node', [bin, 'codex-notify', '--hook'], { env, input: '{}', encoding: 'utf8', timeout: 20000 });
  assert.equal(hook().status, 0);
  assert.equal(existsSync(join(env.LIMITCAST_STATE, 'notify-codex.at')), false, 'notifications are off: nothing is started');
  writeFileSync(join(env.LIMITCAST_STATE, 'notify.on'), '');
  assert.equal(hook().status, 0);
  assert.equal(existsSync(join(env.LIMITCAST_STATE, 'notify-codex.at')), true, 'on: the check was started');
});

test('the spawn hint counts only the receipts of the tool that is spawning', () => {
  const entries = [
    ...[0.5, 0.7, 0.9].map((usd, i) => ({ t: i, src: 'grok', type: 'explore', calls: 1, fresh: 1, read: 1, usd })),
    ...[2, 3, 4].map((pct, i) => ({ t: 10 + i, type: 'Explore', calls: 1, fresh: 1, read: 1, pct })),
  ];
  assert.match(
    spawnNotice(entries, 'explore', undefined, 'grok'),
    /explore subagents have cost a median ≈\$0\.70 \(max ≈\$0\.90\) at API list prices over 3 runs/,
  );
  assert.match(spawnNotice(entries, 'Explore', undefined, 'claude'), /median ≈3\.0% \(max ≈4\.0%\) of a 5-hour window over 3 runs/);
  assert.equal(spawnNotice(entries, 'worker', undefined, 'codex'), null, 'no Codex receipts yet');
});
