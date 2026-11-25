import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attribute, hostWhyReport, jobsReport, readCalls, whyReport } from '../src/where.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
process.env.LIMITCAST_STATE = tmp('lc-jobs-state-');
const T0 = Date.parse('2026-10-24T12:00:00.000Z');
const BASE = `Brief for ${'x'.repeat(35)}`; // exactly 45 characters: runs that differ after it are one job
const iso = (mins) => new Date(T0 + mins * 60_000).toISOString();
const user = (content, extra = {}) => JSON.stringify({ type: 'user', timestamp: iso(0), message: { role: 'user', content }, ...extra });
const asst = (id, mins, usage, entry = 'sdk-cli') =>
  JSON.stringify({ type: 'assistant', timestamp: iso(mins), requestId: id, entrypoint: entry, cwd: '/p/a', message: { id, usage, content: [] } });
const use = (input, cw, cr, out) => ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out });
const write = (lines) => {
  const f = join(tmp('lc-jobs-'), 's.jsonl');
  writeFileSync(f, lines.join('\n'));
  return f;
};

test('readCalls puts the first words of the first real user message on the first main-thread call', async () => {
  const calls = await readCalls(
    write([
      user('<local-command-caveat>ignored</local-command-caveat>', { isMeta: true }),
      user('subagent text', { isSidechain: true }),
      user([{ type: 'tool_result', content: 'no text here' }]),
      user([{ type: 'text', text: `  Update   the\n canvas ${'x'.repeat(200)}` }]),
      asst('a', 0, use(1, 100, 0, 5)),
      asst('b', 1, use(1, 10, 100, 5)),
    ]),
  );
  assert.equal(calls[0].prompt.length, 80);
  assert.match(calls[0].prompt, /^Update the canvas x+$/);
  assert.equal(calls[1].prompt, undefined);
  assert.equal((await readCalls(write([asst('a', 0, use(1, 1, 0, 1))])))[0].prompt, undefined); // no user line: nothing
});

test('attribute collects headless starts only, with new tokens and the whole starting prompt', () => {
  const call = (o) => ({ t: T0, input: 1, cacheWrite: 0, cacheRead: 0, output: 0, tools: [], side: false, entry: 'sdk-cli', project: '/p', ...o });
  const r = attribute([
    [call({ cacheWrite: 1000, cacheRead: 500, prompt: 'job A', tools: ['mcp:demo'] }), call({ t: T0 + 1, cacheWrite: 10, tools: ['Read'] })],
    [call({ cacheWrite: 7, entry: 'cli' })],
  ]);
  assert.deepEqual(r.starts, [
    { t: T0, tokens: 1001, size: 1501, calls: 2, prompt: 'job A', project: '/p', entry: 'sdk-cli', tools: ['mcp:demo', 'Read'] },
  ]);
  assert.equal(r.sessionsInteractive, 1);
});

test('jobsReport groups runs by their first 45 characters, ranks by total start, escapes pipes', () => {
  const start = (prompt, tokens, size, calls = 3) => ({ t: T0, tokens, size, calls, prompt, project: '/p', entry: 'sdk-cli' });
  const r = attribute([]);
  r.total = 1_000_000;
  r.startHeadless = 62_000;
  r.starts = [
    start(`${BASE} one`, 20_000, 30_000),
    start(`${BASE} two`, 30_000, 40_000, 5),
    start('Slack | canvas job', 12_000, 14_000, 1),
    start('', 0, 9_000),
  ];
  const md = jobsReport(r, { since: T0 - 86400_000, now: T0 });
  assert.match(md, /^# limitcast: heaviest scheduled-job starts/);
  assert.match(md, /4 headless runs spent 62\.0k new tokens just starting: 6% of all new tokens\./);
  // Two runs of one job: 50k total, 25k average new at start, 35k average prompt, 4.0 calls; first in the table.
  assert.match(md, new RegExp(`\\| ${BASE} \\| 2 \\| 25\\.0k \\| 35\\.0k \\| 50\\.0k \\| 5% \\| 100% \\| 4\\.0 \\|`));
  assert.match(md, /\| Slack \/ canvas job \| 1 \| 12\.0k \| 14\.0k \| 12\.0k \| 1% \| 100% \| 1\.0 \|/);
  assert.match(md, /\| \/p \| 1 \| 0 \| 9\.0k \| 0 \| 0% \| 0% \|/); // no prompt: the project names it; a start served from the cache is warm
  assert.ok(md.indexOf(BASE) < md.indexOf('Slack /'));
  assert.match(md, /smallest starting prompt among these jobs averages 9\.0k \(\/p\); the heaviest job's averages 35\.0k/);
  assert.match(md, /verify it can run without its user and project hooks, including approval and validation hooks/);
  assert.equal(md.match(/disableAllHooks/g)?.length, 1);
  assert.doesNotMatch(md, /Launch this job with hooks off/);
  assert.match(md, /--setting-sources "" --strict-mcp-config.*drops the claude\.ai connectors/);
  assert.ok(md.indexOf('disableAllHooks') < md.indexOf('--strict-mcp-config')); // the safe flag comes first
  assert.match(jobsReport(attribute([]), { since: T0, now: T0 }), /No headless runs in this period\./);
});

test('jobsReport names startup groups, the unitemized remainder, and main-thread connector evidence', () => {
  const r = attribute([]);
  r.total = 1_000_000;
  r.startHeadless = 80_000;
  r.starts = [
    {
      t: T0,
      tokens: 60_000,
      size: 98_000,
      calls: 4,
      prompt: 'Import the approved rows',
      project: '/p',
      entry: 'sdk-cli',
      tools: ['mcp:claude_ai_HubSpot', 'Read'],
      startup: [
        { group: 'Skill listing', name: 'trim', chars: 28_000 },
        { group: 'Tool names', name: 'demo51-mcp', chars: 8_000 },
        { group: 'Tool names', name: 'claude_ai_HubSpot', chars: 4_000 },
        { group: 'MCP server instructions', name: 'attention', chars: 4_000 },
        { group: 'SessionStart hooks', name: 'session-start-hook.sh', chars: 4_000 },
      ],
    },
  ];
  const md = jobsReport(r, { since: T0 - 86400_000, now: T0 });
  assert.match(md, /## What the latest run loaded/);
  assert.match(md, /Starting prompt 98\.0k\. Named pieces 12\.0k\. Not broken out 86\.0k\./);
  assert.match(md, /\| Skill listing \| 7\.0k \|/);
  assert.match(md, /Called on the main thread: claude_ai_hubspot\./);
  assert.match(md, /Loaded at start without a recorded main-thread call: attention, demo51-mcp\./);
  assert.match(md, /A child agent or hook may still use a server listed here/);
  assert.doesNotMatch(md, /not called in this run/);
});

test('hostWhyReport splits Codex and Grok into subagents, new input and output', () => {
  const row = (o) => ({
    t: T0,
    src: 'grok',
    session: '01abcdef-1234',
    project: '/Users/me/proj',
    model: 'grok-4',
    sidechain: false,
    input: 1000,
    cacheWrite: 0,
    cacheRead: 9000,
    output: 100,
    ...o,
  });
  const md = hostWhyReport([row({}), row({ sidechain: true, input: 500, output: 50, session: '01abcdef-1234' }), row({ src: 'codex', input: 9 })], {
    since: T0 - 1000,
    now: T0 + 1000,
    src: 'grok',
  });
  assert.match(md, /· Grok/);
  assert.match(md, /1\.6k new tokens/); // 1000+100 + 500+50; the codex row is ignored
  assert.match(md, /\| Subagents \| 550 \| 33% \|/);
  assert.match(md, /\| Main thread, new input \| 1\.0k \| 61% \|/);
  assert.match(md, /\| Main thread, model output \| 100 \| 6% \|/);
  assert.match(md, /does not name the tool/);
  assert.match(md, /\| 01abcdef-123 \|/);
  assert.match(hostWhyReport([], { since: T0, now: T0, src: 'codex' }), /No Codex usage in this period/);
});

test('whyReport points to the jobs report when there are headless runs', () => {
  const session = (entry) => [[{ t: T0, input: 1, cacheWrite: 10, cacheRead: 0, output: 0, tools: [], side: false, entry, project: '/p' }]];
  assert.match(whyReport(attribute(session('sdk-py')), { since: 0, now: T0 + 1, calib: null }), /`limitcast report --jobs`/);
  assert.doesNotMatch(whyReport(attribute(session('cli')), { since: 0, now: T0 + 1, calib: null }), /report --jobs/);
});

test('CLI: report --jobs is free and lists each job from the transcripts', () => {
  const claudeDir = tmp('lc-jobs-claude-');
  mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
  const now = Date.now() - 60_000;
  const session = (name, prompt, n) => {
    const lines = [JSON.stringify({ type: 'user', timestamp: new Date(now).toISOString(), message: { role: 'user', content: prompt } })];
    for (let i = 0; i < n; i++) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(now + i * 1000).toISOString(),
          requestId: `${name}${i}`,
          entrypoint: 'sdk-cli',
          cwd: '/',
          message: { id: `${name}${i}`, usage: use(1, i === 0 ? 20_000 : 100, i === 0 ? 0 : 20_000, 10), content: [] },
        }),
      );
    }
    writeFileSync(join(claudeDir, 'projects', 'p', `${name}.jsonl`), lines.join('\n'));
  };
  session('a1', 'Prepare the nightly brief for the team', 3);
  session('a2', 'Prepare the nightly brief for the team', 3);
  session('b1', 'Update the Slack canvas', 2);
  // XDG_CONFIG_HOME too: starting a trial also writes a marker there, which must not land in the real ~/.config.
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, LIMITCAST_STATE: tmp('lc-jobs-cli-state-'), XDG_CONFIG_HOME: tmp('lc-jobs-cli-xdg-') };
  delete env.LIMITCAST_LICENSE;
  const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
  const free = spawnSync('node', [bin, 'report', '--jobs'], { env });
  assert.equal(free.status, 0);
  assert.doesNotMatch(free.stdout.toString(), /part of limitcast Pro/);
  assert.equal(spawnSync('node', [bin, 'trial'], { env }).status, 0);
  const pro = spawnSync('node', [bin, 'report', '--jobs'], { env });
  assert.equal(pro.status, 0, pro.stderr.toString());
  const out = pro.stdout.toString();
  assert.match(out, /3 headless runs spent 60\.0k new tokens just starting/);
  assert.match(out, /\| Prepare the nightly brief for the team \| 2 \| 20\.0k \| 20\.0k \| 40\.0k \| \d+% \| 100% \| 3\.0 \|/);
  assert.match(out, /\| Update the Slack canvas \| 1 \| 20\.0k \|/);
});
