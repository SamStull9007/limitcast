import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { burnReport } from '../src/report.mjs';
import { attribute, readCalls, whyReport } from '../src/where.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const T0 = Date.parse('2026-10-24T12:00:00.000Z');
const call = ({ mins = 0, input = 1, cw = 0, cr = 0, out = 0, tools = [], side = false, entry = 'cli' }) => ({
  t: T0 + mins * 60_000,
  input,
  cacheWrite: cw,
  cacheRead: cr,
  output: out,
  tools,
  side,
  entry,
  project: '/p/a',
});

// Interactive session: a start, a user message step, a Read step, an MCP step; one subagent call.
const interactive = [
  call({ input: 2, cw: 1000, out: 50, entry: 'cli' }),
  call({ mins: 1, input: 2, cw: 700, cr: 1000, out: 10, tools: ['Read'] }),
  call({ mins: 2, input: 2, cw: 5000, cr: 1700, out: 20, tools: ['mcp:hs'] }),
  call({ mins: 3, input: 1, cw: 100, cr: 6700, out: 5 }),
  call({ mins: 1, input: 10, cw: 500, out: 40, side: true }),
];
// Headless run whose cache missed on a 200k context: the second call is a rebuild.
const headless = [
  call({ input: 1, cw: 200_000, out: 5, tools: ['Bash'], entry: 'sdk-cli' }),
  call({ mins: 90, input: 1, cw: 200_000, out: 7, entry: 'sdk-cli' }),
];

test('attribute sorts every new token into a category and the categories add up', () => {
  const r = attribute([interactive, headless]);
  assert.equal(r.total, 407_456);
  assert.equal(r.subagents, 550);
  assert.deepEqual([r.startInteractive, r.startHeadless, r.sessionsInteractive, r.sessionsHeadless], [1002, 200_001, 1, 1]);
  assert.equal(r.rebuilds, 199_996);
  // The step after a call is charged to the tools that call used.
  assert.deepEqual(
    [...r.tools].map(([k, e]) => [k, e.tokens]),
    [
      ['(your messages)', 652],
      ['Read', 4992],
      ['mcp:hs', 81],
    ],
  );
  assert.equal(r.output, 182); // output, plus the same output written to the cache on the next call
  assert.equal(r.other, 0);
  const tools = [...r.tools.values()].reduce((a, e) => a + e.tokens, 0);
  assert.equal(r.subagents + r.startInteractive + r.startHeadless + r.rebuilds + tools + r.output + r.other, r.total);
  assert.deepEqual(r.steps.map((s) => s.tool).sort(), ['(your messages)', 'Read', 'mcp:hs']);
});

test('attribute skips calls before the window but still uses them as the previous call', () => {
  const r = attribute([interactive], T0 + 90_000); // from minute 1.5: only the third and fourth calls, and nothing of the start
  assert.equal(r.sessionsInteractive, 0);
  assert.deepEqual(
    [...r.tools].map(([k, e]) => [k, e.tokens]),
    [
      ['Read', 4992],
      ['mcp:hs', 81],
    ],
  );
});

test('several tools in one step are reported as one group', () => {
  const r = attribute([[call({ out: 5 }), call({ mins: 1, tools: ['Read', 'Bash'], out: 5, cw: 305 }), call({ mins: 2, cw: 500 })]]);
  assert.equal(r.tools.get('several tools in one step').tokens, 496); // 1 + 500 new input, less the call's own 5 output
});

test('readCalls merges the repeated blocks of one message and collects tool names', async () => {
  const line = (content) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(T0).toISOString(),
      requestId: 'r1',
      entrypoint: 'cli',
      cwd: '/p/a',
      message: { id: 'm1', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 5, output_tokens: 10 }, content },
    });
  const f = join(tmp('lc-where-'), 's.jsonl');
  writeFileSync(
    f,
    [
      line([{ type: 'text', text: 'hi' }]),
      line([{ type: 'tool_use', name: 'mcp__claude_ai_HubSpot__get_crm_objects' }]),
      line([{ type: 'tool_use', name: 'Bash' }]),
      '{"type":"user","message":{}}',
    ].join('\n'),
  );
  const calls = await readCalls(f);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].input, calls[0].cacheWrite, calls[0].cacheRead, calls[0].output], [2, 100, 5, 10]);
  assert.deepEqual(calls[0].tools, ['mcp:claude_ai_HubSpot', 'Bash']);
  assert.equal(calls[0].entry, 'cli');
});

test('whyReport lists categories, tools and steps; shows windows only with a calibration', () => {
  const r = attribute([interactive, headless]);
  const md = whyReport(r, { since: T0 - 86400_000, now: T0, calib: { fresh: 6.7 } });
  assert.match(md, /# limitcast: where your new tokens went/);
  assert.match(md, /\| Session starts, headless runs \(1\) \| 200\.0k \|/);
  assert.match(md, /5-hour windows/);
  assert.match(md, /## Tool results by source/);
  assert.match(md, /## Largest single steps/);
  assert.doesNotMatch(whyReport(r, { since: T0, now: T0, calib: null }), /5-hour windows/);
  assert.match(whyReport(attribute([]), { since: T0, now: T0 }), /No Claude Code usage/);
});

test('burn report ranks sessions by new tokens, not by cached reads', () => {
  const u = (session, input, cacheRead) => ({
    t: T0,
    src: 'claude',
    session,
    project: '/p/a',
    model: 'm',
    sidechain: false,
    input,
    cacheWrite: 0,
    cacheRead,
    output: 0,
  });
  const md = burnReport([u('cachey-session', 10, 1_000_000), u('fresh-session', 5000, 0)], { since: T0, now: T0 });
  const heaviest = md.split('## Heaviest sessions')[1];
  assert.ok(heaviest.indexOf('fresh-se') < heaviest.indexOf('cachey-s'));
  assert.match(heaviest, /\| new tokens \| share \|/);
});

test('CLI: report --why is Pro; with a trial it reads the transcripts', () => {
  const claudeDir = tmp('lc-why-claude-');
  mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
  const ev = (id, mins, usage, content = []) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.now() - 60_000 + mins * 1000).toISOString(),
      requestId: id,
      entrypoint: 'cli',
      cwd: '/p/a',
      message: { id, usage, content },
    });
  const use = (input, cw, cr, out) => ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out });
  writeFileSync(
    join(claudeDir, 'projects', 'p', 's.jsonl'),
    [
      ev('a', 0, use(2, 1000, 0, 50)),
      ev('b', 1, use(2, 700, 1000, 10), [{ type: 'tool_use', name: 'Read' }]),
      ev('c', 2, use(2, 5000, 1700, 20)),
    ].join('\n'),
  );
  // XDG_CONFIG_HOME too: starting a trial also writes a marker there, which must not land in the real ~/.config.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, LIMITCAST_STATE: tmp('lc-why-state-'), XDG_CONFIG_HOME: tmp('lc-why-xdg-') };
  delete env.LIMITCAST_LICENSE;
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const free = spawnSync('node', [bin, 'report', '--why'], { env });
  assert.equal(free.status, 2);
  assert.match(free.stdout.toString(), /limitcast Pro/);
  assert.equal(spawnSync('node', [bin, 'trial'], { env }).status, 0);
  const pro = spawnSync('node', [bin, 'report', '--why'], { env });
  assert.equal(pro.status, 0, pro.stderr.toString());
  const out = pro.stdout.toString();
  assert.match(out, /where your new tokens went/);
  assert.match(out, /\| Read \| 5\.0k \| 1 \| 5\.0k \|/);
});
