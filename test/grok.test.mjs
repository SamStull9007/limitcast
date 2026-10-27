import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { forecast } from '../src/forecast.mjs';
import {
  grokSamples,
  grokSessionLine,
  grokSpend,
  grokStartup,
  grokTrimReport,
  grokUsedServers,
  installGrok,
  patchGrokSubagentModel,
  setGrokBudget,
  uninstallGrok,
  wrapGrokStatusLine,
} from '../src/grok.mjs';
import { runGuard } from '../src/guard.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const T0 = Date.parse('2026-10-24T12:00:00.000Z');
const iso = (mins) => new Date(T0 + mins * 60_000).toISOString();
const TICKS = 10_000_000_000;
const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));

// Leave these set for the whole process: restoring the real ~/.grok mid-suite lets parallel tests mutate it.
process.env.GROK_HOME = tmp('lc-grok-home-');
process.env.LIMITCAST_STATE = tmp('lc-grok-state-');

function writeSession({ root, project = '/p/g', session = '01abc', turns, events }) {
  const dir = join(root, encodeURIComponent(project), session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'usage.json'), JSON.stringify({ sessionId: session, turns }));
  if (events) writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
  writeFileSync(join(dir, 'system_prompt.txt'), 'x'.repeat(8000));
  writeFileSync(join(dir, 'tool_definitions.json'), 'y'.repeat(4000));
  return dir;
}

test.describe({ concurrency: 1 }, () => {
  test('grok spend and samples: costUsdTicks become USD; a cap turns spend into pct', () => {
    const root = join(process.env.GROK_HOME, 'sessions');
    writeSession({
      root,
      turns: [
        { endedAt: iso(0), inputTokens: 10, outputTokens: 1, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 1.0 * TICKS },
        { endedAt: iso(10), inputTokens: 10, outputTokens: 1, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 1.5 * TICKS },
      ],
    });
    const now = T0 + 15 * 60_000;
    const spend = grokSpend(now, root);
    assert.ok(spend);
    assert.equal(Number(spend['5h'].toFixed(2)), 2.5);

    process.env.LIMITCAST_STATE = tmp('lc-grok-budget-');
    setGrokBudget(5);
    const samples = grokSamples(now, { root });
    const five = samples.filter((s) => s.win === '5h');
    assert.ok(five.length >= 2);
    assert.equal(five.at(-1)?.src, 'grok');
    assert.equal(Math.round(five.at(-1)?.pct ?? 0), 50); // $2.50 / $5
  });

  test('grok trim: unused MCP from events.jsonl; apply is covered by report.unused', () => {
    const root = join(tmp('lc-grok-trim-'), 'sessions');
    writeSession({
      root,
      turns: [{ endedAt: iso(0), inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 0 }],
      events: [
        { ts: iso(0), type: 'mcp_tool_call_started', server_name: 'deja', tool_name: 'deja' },
        { ts: iso(1), type: 'mcp_tool_call_started', server_name: 'grist', tool_name: 'query' },
      ],
    });
    const used = grokUsedServers(0, root);
    assert.deepEqual([...used].sort(), ['deja', 'grist']);
    const startup = grokStartup(root);
    assert.equal(startup?.prompt, 8000);
    assert.equal(startup?.tools, 4000);
    const r = grokTrimReport({
      servers: [
        { name: 'deja', enabled: true },
        { name: 'office-word', enabled: true },
        { name: 'idle', enabled: false },
      ],
      used,
      startup,
      days: 7,
      pro: true,
    });
    assert.deepEqual(r.unused, ['office-word']);
    assert.match(r.text, /office-word/);
    assert.doesNotMatch(r.text, /idle/);
  });

  test('installGrok wraps [ui.status_line] and writes a spawn_subagent hook; uninstall restores', () => {
    process.env.LIMITCAST_STATE = tmp('lc-grok-inst-state-');
    const home = tmp('lc-grok-inst-');
    mkdirSync(join(home, 'sessions'), { recursive: true }); // grokPresent
    writeFileSync(join(home, 'config.toml'), '[ui]\ntheme = "terminal"\n\n[ui.status_line]\ntype = "builtin"\nitems = ["cwd", "model"]\n');
    const self = "/bin/sh '/tmp/limitcast-hook.sh'";
    const changes = installGrok({ guard: true, self, home });
    assert.ok(changes.some((c) => /status line/.test(c)));
    assert.ok(changes.some((c) => /spawn_subagent/.test(c)));
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    assert.match(toml, /type = "command"/);
    assert.match(toml, /limitcast-hook\.sh' statusline/);
    assert.doesNotMatch(toml, /^items =/m);
    const hook = JSON.parse(readFileSync(join(home, 'hooks', 'limitcast.json'), 'utf8'));
    assert.equal(hook.hooks.PreToolUse[0].matcher, 'spawn_subagent');

    const undone = uninstallGrok({ home });
    assert.ok(undone.some((c) => /guard/.test(c)));
    const restored = readFileSync(join(home, 'config.toml'), 'utf8');
    assert.match(restored, /type = "builtin"/);
    assert.match(restored, /items = \["cwd", "model"\]/);
  });

  test('wrapGrokStatusLine keeps an existing command underneath', () => {
    const self = '/n /lc/limitcast.mjs';
    const next = wrapGrokStatusLine('[ui.status_line]\ntype = "command"\ncommand = "~/.grok/statusline.sh"\n', self);
    assert.match(next, /statusline -- sh -c '~\/\.grok\/statusline\.sh'/);
    assert.equal(wrapGrokStatusLine(next, self), next);
  });

  test('wrapGrokStatusLine is idempotent for the hook launcher path', () => {
    const self = "/bin/sh '/tmp/limitcast-hook.sh'";
    const first = wrapGrokStatusLine('[ui.status_line]\ntype = "builtin"\nitems = ["cwd"]\n', self);
    assert.match(first, /limitcast-hook\.sh' statusline/);
    assert.doesNotMatch(first, /^items =/m);
    const twice = wrapGrokStatusLine(first, self);
    assert.equal((twice.match(/statusline/g) || []).length, 1);
    assert.equal(twice, first);
  });

  test('grokSessionLine reads Grok feed fields and ignores a Claude rate_limits feed', () => {
    assert.equal(
      grokSessionLine({ model: { display_name: 'Grok 4.6' }, context_window: { used_percentage: 12 }, cost: { total_cost_usd: 0.31 } }),
      'Grok 4.6 · 12% ctx · $0.31',
    );
    assert.equal(grokSessionLine({ rate_limits: { five_hour: {} }, model: { display_name: 'Opus' } }), '');
  });

  test('guard blocks spawn_subagent when the Grok 5h cap is on pace to run out', async () => {
    const home = tmp('lc-grok-guard-');
    process.env.GROK_HOME = home;
    process.env.LIMITCAST_STATE = tmp('lc-grok-guard-state-');
    const root = join(home, 'sessions');
    const len = 5 * 3600_000;
    const start = Math.floor(T0 / len) * len;
    const now = start + 30 * 60_000; // 30 min into the window so a steep slope runs out before reset
    writeSession({
      root,
      turns: [
        {
          endedAt: new Date(start + 5 * 60_000).toISOString(),
          inputTokens: 1,
          outputTokens: 1,
          cachedReadTokens: 0,
          cacheCreationTokens: 0,
          costUsdTicks: 4 * TICKS,
        },
        {
          endedAt: new Date(now).toISOString(),
          inputTokens: 1,
          outputTokens: 1,
          cachedReadTokens: 0,
          cacheCreationTokens: 0,
          costUsdTicks: 4.5 * TICKS,
        },
      ],
    });
    setGrokBudget(10); // $8.50 of $10 in 25 min → AT_RISK
    const samples = grokSamples(now, { root });
    const f = forecast(
      samples.filter((s) => s.win === '5h'),
      now,
    );
    assert.equal(f?.verdict, 'AT_RISK');
    const reason = await runGuard({ toolName: 'spawn_subagent', sessionId: 'g1' }, now, 30);
    assert.match(String(reason), /^limitcast: Grok 5h/);
  });

  test('statusline: Grok feed shows spend; a Claude feed does not', () => {
    const home = tmp('lc-grok-sl-');
    const state = tmp('lc-grok-sl-state-');
    // Keep this output test independent of the detached daily health/rollup process.
    writeFileSync(join(state, 'value.at'), String(Date.now()));
    const root = join(home, 'sessions');
    writeSession({
      root,
      turns: [{ endedAt: iso(0), inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 2 * TICKS }],
    });
    const env = { ...process.env, GROK_HOME: home, LIMITCAST_STATE: state };
    const grokOut = execFileSync('node', [bin, 'statusline'], {
      input: JSON.stringify({ model: { display_name: 'Grok 4.6' }, context_window: { used_percentage: 12 }, cost: { total_cost_usd: 0.31 } }),
      env,
    }).toString();
    assert.match(grokOut, /Grok 4\.6 · 12% ctx · \$0\.31/);
    assert.match(grokOut, /grok 5h \$/);
    const claudeOut = execFileSync('node', [bin, 'statusline'], {
      input: JSON.stringify({ rate_limits: { five_hour: {} } }),
      env,
    }).toString();
    assert.match(claudeOut, /waiting for data/);
    assert.doesNotMatch(claudeOut, /grok 5h/);
  });

  test('patchGrokSubagentModel writes, updates and removes [subagents.models]', () => {
    const base = '[models]\ndefault = "grok-4.6"\n';
    const added = patchGrokSubagentModel(base, 'Explore', 'grok-4.3');
    assert.match(added, /\[subagents\.models\]\nexplore = "grok-4\.3"/);
    const general = patchGrokSubagentModel(added, 'general-purpose', 'grok-4.6');
    assert.match(general, /general-purpose = "grok-4\.6"/);
    const gone = patchGrokSubagentModel(general, 'explore', null);
    assert.doesNotMatch(gone, /explore =/);
    assert.match(gone, /general-purpose = "grok-4\.6"/);
    const empty = patchGrokSubagentModel(gone, 'general-purpose', null);
    assert.doesNotMatch(empty, /\[subagents\.models\]/);
    assert.match(empty, /\[models\]/);
    assert.equal(patchGrokSubagentModel(base, 'explore', null), base);
  });
});
