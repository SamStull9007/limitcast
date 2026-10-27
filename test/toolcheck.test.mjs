import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { install, readSettings, uninstall } from '../src/install.mjs';
import { firstFlag, resultTokens, tipFor, toolKey, toolNotice } from '../src/toolcheck.mjs';
import { attribute, whyReport } from '../src/where.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
process.env.LIMITCAST_STATE = tmp('lc-tool-state-'); // the once-per-session record lives here, never in the real state dir
process.env.GROK_HOME = tmp('lc-tool-grok-'); // install() wraps Grok when ~/.grok exists

test('resultTokens estimates from size and works on any result shape', () => {
  assert.equal(resultTokens('x'.repeat(4000)), 1000);
  assert.equal(
    resultTokens({ content: [{ type: 'text', text: 'x'.repeat(4000) }] }),
    Math.round(JSON.stringify({ content: [{ type: 'text', text: 'x'.repeat(4000) }] }).length / 4),
  );
  assert.equal(resultTokens(undefined), 0);
  assert.equal(resultTokens(null), 1);
});

test('toolKey and tipFor name MCP tools by server and suggest what to ask for', () => {
  assert.equal(toolKey('mcp__claude_ai_HubSpot__get_crm_objects'), 'mcp:claude_ai_HubSpot');
  assert.equal(toolKey('Read'), 'Read');
  assert.match(tipFor('mcp:claude_ai_HubSpot'), /fewer fields/);
  assert.match(tipFor('Read'), /offset and limit/);
  assert.equal(tipFor('Skill'), null);
  assert.equal(tipFor('(your messages)'), null);
});

test('toolNotice: silent under the threshold; names the tool, size, window cost and tip above it', () => {
  const big = 'x'.repeat(100_000); // 25k tokens
  assert.equal(toolNotice('Bash', 'x'.repeat(40_000), null), null); // 10k tokens
  assert.equal(
    toolNotice('mcp__claude_ai_HubSpot__get_crm_objects', big, { fresh: 6.7 }),
    'limitcast: that HubSpot get_crm_objects result was ≈25k tokens (≈0.17% of a 5-hour window to write, then re-read on every later call). Next time: ask for fewer fields and a smaller limit.',
  );
  assert.equal(toolNotice('Bash', big, null), 'limitcast: that Bash result was ≈25k tokens. Next time: pipe long output through head, tail or grep.');
  assert.equal(toolNotice('Skill', big, null), 'limitcast: that Skill result was ≈25k tokens.'); // nothing to suggest
  assert.match(toolNotice('Bash', 'x'.repeat(40_000), null, 5000), /≈10k tokens/); // a lower threshold
});

test('firstFlag is true once per tool per session', () => {
  assert.equal(firstFlag('s1', 'Bash'), true);
  assert.equal(firstFlag('s1', 'Bash'), false);
  assert.equal(firstFlag('s1', 'Read'), true);
  assert.equal(firstFlag('s2', 'Bash'), true);
});

test('install --alerts adds the PostToolUse hook and uninstall removes it, leaving your own hooks', () => {
  const dir = tmp('lc-tool-install-');
  const path = join(dir, 'settings.json');
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
  writeFileSync(path, JSON.stringify({ hooks: { PostToolUse: [mine] } }));
  const opts = { path, codexPath: join(dir, 'codex', 'hooks.json'), self: '/x/limitcast' };
  assert.ok(install({ guard: false, alerts: true, ...opts }).includes('added the large tool-output notice'));
  install({ guard: false, alerts: true, ...opts }); // idempotent
  const list = readSettings(path).hooks.PostToolUse;
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], mine);
  assert.equal(list[1].hooks[0].command, '/x/limitcast tool-check');
  assert.match(list[1].matcher, /mcp__/);
  assert.ok(uninstall(opts).includes('removed the large tool-output notice'));
  assert.deepEqual(readSettings(path).hooks.PostToolUse, [mine]);
});

test('report --why: what to try names the big steps and the sources with a tip', () => {
  const call = (o) => ({ t: 1, input: 1, cacheWrite: 0, cacheRead: 0, output: 0, tools: [], side: false, entry: 'cli', project: '/p', ...o });
  const calls = [
    call({ tools: ['mcp:hs'] }),
    call({ t: 2, cacheWrite: 30_000, tools: ['mcp:hs'] }),
    call({ t: 3, cacheWrite: 5_000, tools: ['Skill'] }),
    call({ t: 4, cacheWrite: 25_000, tools: ['Bash'] }),
    call({ t: 5, cacheWrite: 100 }),
  ];
  const md = whyReport(attribute([calls]), { since: 0, now: 5, calib: null });
  assert.match(md, /## What to try/);
  assert.match(md, /2 single steps added over 20\.0k new tokens each: \d+% of all tool-result tokens, mostly mcp:hs\./);
  assert.match(md, /- mcp:hs \(.*per call\): ask for fewer fields and a smaller limit\./);
  assert.doesNotMatch(md, /- Skill/); // a Skill has no tip
  assert.doesNotMatch(md, /- Bash/); // results averaging about 100 tokens are not worth a tip
});

test('CLI: the tool-check hook prints the notice for Pro, once per tool per session', () => {
  const state = tmp('lc-tool-cli-state-');
  // XDG_CONFIG_HOME too: starting a trial also writes a marker there, which must not land in the real ~/.config.
  const env = { ...process.env, LIMITCAST_STATE: state, XDG_CONFIG_HOME: tmp('lc-tool-cli-xdg-') };
  delete env.LIMITCAST_LICENSE;
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const hook = (tool, size, sid = 's1') =>
    JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: {}, tool_response: { stdout: 'x'.repeat(size) }, session_id: sid });
  const run = (input) => spawnSync('node', [bin, 'tool-check'], { env, input });
  assert.equal(run(hook('Bash', 100_000)).stdout.toString(), ''); // free: nothing
  assert.equal(spawnSync('node', [bin, 'trial'], { env }).status, 0);
  const first = run(hook('Bash', 100_000));
  assert.equal(first.status, 0, first.stderr.toString());
  const out = JSON.parse(first.stdout.toString());
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  assert.match(out.systemMessage, /^limitcast: that Bash result was ≈25k tokens/);
  assert.equal(run(hook('Bash', 100_000)).stdout.toString(), ''); // same tool, same session
  assert.equal(run(hook('Bash', 4_000, 's2')).stdout.toString(), ''); // small result
  assert.equal(run('not json').status, 0); // fails open
  assert.match(run(hook('Bash', 100_000, 's2')).stdout.toString(), /systemMessage/); // another session
});
