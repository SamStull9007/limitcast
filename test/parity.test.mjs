import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyCapabilities, patchMcpServers, restoreCapabilities, validateCodex, validateGrok } from '../src/capabilities.mjs';
import { alignedStart, grokHistory, installGrok } from '../src/grok.mjs';
import { runGuard } from '../src/guard.mjs';
import { findDuplicate, forgetInflight, rememberInflight, spawnIdentity } from '../src/inflight.mjs';
import { install, uninstall } from '../src/install.mjs';
import { transitions } from '../src/notify.mjs';
import { capabilityProposals, changeOptimization, normalizeEvent, processEvent, readOptimization, repository } from '../src/optimize.mjs';
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

const hostState = (host, extra = {}) => ({
  version: 1,
  hosts: {
    [host]: {
      sessions: {},
      completed: 5,
      finished: [],
      prompts: 10,
      used: [],
      usedTools: [],
      usedServers: [],
      catalog: {},
      productive: [],
      ...extra,
    },
  },
  facts: [],
  receipts: [],
  config: { learn: false, map: false, keep: [] },
});

test('Grok proposes MCP servers no session in the repository called, and a keep-list entry protects one', () => {
  const state = hostState('grok', { usedTools: ['basic-memory__search_notes', 'Read'] });
  const servers = [{ name: 'basic-memory' }, { name: 'demo51-mcp' }, { name: 'firecrawl', enabled: false }];
  assert.deepEqual(capabilityProposals(state, 'grok', servers), ['demo51-mcp']);
  state.config.keep.push('demo51-mcp');
  assert.deepEqual(capabilityProposals(state, 'grok', servers), []);
  assert.deepEqual(capabilityProposals(hostState('grok', { completed: 4 }), 'grok', servers), [], 'five sessions first');
  assert.deepEqual(capabilityProposals(hostState('grok'), 'grok', []), [], 'no configured servers, nothing to propose');
});

test('Codex proposes unused MCP servers beside its built-in packages, matching hyphens to underscores', () => {
  const state = hostState('codex', { used: ['image_media', 'collaboration'], usedTools: ['mcp__tool_router__call_tool'] });
  const servers = [{ name: 'tool-router' }, { name: 'deja' }];
  assert.deepEqual(capabilityProposals(state, 'codex', servers), ['goals', 'deja']);
});

test('hook events record which MCP server each host called, on their own list that outlives the tool-name cap', () => {
  const state = hostState('grok');
  const call = (host, tool, i) => ({
    session_id: 's1',
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_input: {},
    tool_use_id: `${host}-${i}`,
  });
  processEvent(state, normalizeEvent(call('grok', 'demo51-mcp__demo51_health', 1), 'grok'));
  assert.deepEqual(state.hosts.grok.usedServers, ['demo51_mcp']);
  const codex = hostState('codex');
  processEvent(codex, normalizeEvent(call('codex', 'mcp__deja__deja', 2), 'codex'));
  assert.deepEqual(codex.hosts.codex.usedServers, ['deja']);
  const full = hostState('grok', { usedTools: Array.from({ length: 200 }, (_, i) => `x__t${i}`) });
  processEvent(full, normalizeEvent(call('grok', 'late-server__tool', 3), 'grok'));
  assert.ok(full.hosts.grok.usedServers.includes('late_server'), 'a server called after the tool list filled up still counts as used');
});

test('patchMcpServers adds an enabled=false table and refuses a server the project already configures', () => {
  assert.equal(patchMcpServers('', ['demo']), '[mcp_servers.demo]\nenabled = false # limitcast optimizer\n');
  const next = patchMcpServers('[features]\ngoals = false\n', ['a', 'b-c']);
  assert.match(next, /^\[features\]\ngoals = false\n\n\[mcp_servers\.a\]\nenabled = false/);
  assert.match(next, /\[mcp_servers\.b-c\]\nenabled = false/);
  assert.throws(() => patchMcpServers('[mcp_servers.demo]\ncommand = "x"\n', ['demo']), /preserve explicit/);
  assert.throws(() => patchMcpServers('', ['bad name']), /unsupported MCP server name/);
});

const gitRepo = () => {
  const root = tmp('lc-parity-repo-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  return repository(root);
};

test('applying Grok MCP servers is journaled, validated, undoable, and rolled back when Grok ignores the file', () => {
  fresh();
  process.env.GROK_HOME = tmp('lc-parity-grok-home-');
  writeFileSync(join(process.env.GROK_HOME, 'config.toml'), '[mcp_servers.demo51-mcp]\ncommand = "x"\n\n[mcp_servers.basic-memory]\ncommand = "y"\n');
  const r = gitRepo();
  changeOptimization(r, (s) => Object.assign(s, hostState('grok', { usedTools: ['basic-memory__search_notes'] })));
  assert.throws(() => applyCapabilities(r, 'grok', ['basic-memory'], { validate() {} }), /protected, used, or lacks evidence/);
  const seen = [];
  const out = applyCapabilities(r, 'grok', ['demo51-mcp'], { validate: (_repo, names = []) => seen.push(names.slice()) });
  assert.deepEqual(seen, [['demo51-mcp']]);
  assert.equal(out.path, join(r.root, '.grok/config.toml'));
  assert.match(readFileSync(out.path, 'utf8'), /\[mcp_servers\.demo51-mcp\]\nenabled = false/);
  assert.deepEqual(readOptimization(r).applied.grok.names, ['demo51-mcp']);
  assert.equal(restoreCapabilities(r, 'grok').restored, true);
  assert.equal(existsSync(out.path), false, 'a file the optimizer created is removed again');
  assert.ok(readOptimization(r).config.keep.includes('demo51-mcp'), 'a restored server is protected from later proposals');

  const ignored = gitRepo();
  changeOptimization(ignored, (s) => Object.assign(s, hostState('grok', { usedTools: [] })));
  assert.throws(
    () =>
      applyCapabilities(ignored, 'grok', ['demo51-mcp'], {
        validate() {
          throw new Error('Grok ignored the project setting for demo51-mcp; check project trust');
        },
      }),
    /check project trust/,
  );
  assert.equal(readOptimization(ignored).applied?.grok, undefined);
  assert.equal(existsSync(join(ignored.root, '.grok/config.toml')), false);
});

test('after-reset accepts --src grok and says what Grok needs when there is nothing to wait for', () => {
  const state = tmp('lc-parity-after-');
  const env = { ...process.env, LIMITCAST_STATE: state, GROK_HOME: join(state, 'nogrok'), CODEX_HOME: join(state, 'nocodex') };
  const run = (...args) => spawnSync('node', [bin, 'after-reset', ...args], { env, encoding: 'utf8', timeout: 20000 });
  const none = run('--src', 'grok', '--', 'true');
  assert.equal(none.status, 1);
  assert.match(none.stdout, /No grok readings yet.*limitcast budget grok/);
  assert.match(run().stdout, /\[--src claude\|codex\|grok\]/);
});

test('Codex 0.169 lists multi_agent as deprecated: that is still a control, while a removed key is not', () => {
  const r = gitRepo();
  const bins = tmp('lc-parity-features-');
  const features = (multiAgent) =>
    `#!${process.execPath}\nconsole.log(${JSON.stringify(`multi_agent ${multiAgent}\ngoals stable true\nview_image stable true`)});\n`;
  const previous = process.env.PATH;
  process.env.PATH = `${bins}:${previous}`;
  try {
    writeFileSync(join(bins, 'codex'), features('deprecated true'), { mode: 0o755 });
    validateCodex(r); // exposes every control: no throw
    writeFileSync(join(bins, 'codex'), features('removed true'), { mode: 0o755 });
    assert.throws(() => validateCodex(r), /does not expose supported multi_agent control/);
  } finally {
    process.env.PATH = previous;
  }
});

test('Codex applies MCP servers and built-in packages together, and the host check reads the real project directory', () => {
  fresh();
  const codexHome = tmp('lc-parity-codex-home-');
  process.env.CODEX_HOME = codexHome;
  writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.deja]\ncommand = "x"\n');
  const r = gitRepo();
  changeOptimization(r, (s) => Object.assign(s, hostState('codex', { used: ['image_media', 'collaboration'] })));
  const out = applyCapabilities(r, 'codex', ['goals', 'deja'], { validate() {} });
  const text = readFileSync(out.path, 'utf8');
  assert.match(text, /\[features\]\ngoals = false/);
  assert.match(text, /\[mcp_servers\.deja\]\nenabled = false/);
  restoreCapabilities(r, 'codex');

  for (const [validate, command, listed, name] of [
    [validateGrok, 'grok', '[{"name":"demo51-mcp","enabled":false}]', 'demo51-mcp'],
    [validateCodex, 'codex', '[{"name":"deja","enabled":false}]', 'deja'],
  ]) {
    const bins = tmp('lc-parity-bin-');
    const script = (json) =>
      `#!${process.execPath}\nif(process.cwd()!==${JSON.stringify(r.root)})process.exit(2);\nconst a=process.argv.slice(2).join(' ');\nif(a==='features list')console.log('multi_agent stable false\\ngoals stable false\\nview_image stable false');\nelse if(a==='mcp list --json')console.log(${JSON.stringify(json)});\nelse process.exit(3);\n`;
    const previous = process.env.PATH;
    process.env.PATH = `${bins}:${previous}`;
    try {
      writeFileSync(join(bins, command), script(listed), { mode: 0o755 });
      validate(r, [name]);
      writeFileSync(join(bins, command), script(listed.replace('false', 'true')), { mode: 0o755 });
      assert.throws(() => validate(r, [name]), /ignored the project setting.*project trust/);
    } finally {
      process.env.PATH = previous;
    }
  }
});
