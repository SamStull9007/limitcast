import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { coldCost, coldNotice } from '../src/cold.mjs';
import { findDuplicate, forgetInflight, pruneInflight, rememberInflight, spawnIdentity } from '../src/inflight.mjs';
import { pieceDiff } from '../src/startup.mjs';
import { findLimits, toolLimitDecision, toolStats } from '../src/toollimit.mjs';
import { attribute, jobsReport, readCalls } from '../src/where.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
const M = 60_000;
const T0 = Date.parse('2026-10-24T12:00:00.000Z');

test('cold cache: a short idle is a notice, and the hold stays at its own threshold', () => {
  const now = Date.now();
  const last = { tokens: 200_000, t: now - 10 * M };
  const notice = coldCost('continue', last, now, { minutes: 60, noticeMinutes: 5, calib: { fresh: 6, read: 0.09 } });
  assert.equal(notice.hold, false);
  assert.equal(notice.idle, 10);
  assert.match(coldNotice(notice), /idle for 10 minutes.*200k tokens.*going through/);
  assert.equal(coldCost('continue', last, now, { minutes: 60, noticeMinutes: 5, calib: null }).hold, false);
  const held = coldCost('continue', { ...last, t: now - 75 * M }, now, { minutes: 60, noticeMinutes: 5, calib: null });
  assert.equal(held.hold, true);
  // Callers that only pass the hold threshold keep the old "still warm" result.
  assert.equal(coldCost('continue', last, now, { minutes: 60, calib: null }), null);
  assert.equal(coldCost('continue', { tokens: 200_000, t: now - 3 * M }, now, { minutes: 60, noticeMinutes: 5, calib: null }), null);
});

test('duplicate spawn: same session, type and prompt, and a stop clears the oldest', () => {
  const hook = (prompt, sid = 's') => ({ tool_name: 'Agent', session_id: sid, tool_input: { subagent_type: 'Explore', prompt } });
  const a = spawnIdentity(hook('find the parser'));
  const b = spawnIdentity(hook('find the parser'));
  const other = spawnIdentity(hook('find the tests'));
  const elsewhere = spawnIdentity(hook('find the parser', 'other'));
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, other.hash);
  const now = Date.now();
  let live = rememberInflight(pruneInflight([], now), a, now);
  assert.ok(findDuplicate(live, b));
  assert.equal(findDuplicate(live, other), null);
  assert.equal(findDuplicate(live, elsewhere), null);
  live = rememberInflight(live, other, now + 1);
  live = forgetInflight(live, 's', 'explore', now + 2); // case-insensitive, oldest first
  assert.equal(findDuplicate(live, a), null);
  assert.ok(findDuplicate(live, other));
  assert.equal(pruneInflight([{ sid: 's', type: 'Explore', hash: a.hash, t: now - 31 * M }], now).length, 0);
  assert.equal(spawnIdentity({ tool_name: 'Bash', tool_input: { prompt: 'x' }, session_id: 's' }), null);
  assert.equal(spawnIdentity({ tool_name: 'Agent', session_id: 's', tool_input: { subagent_type: 'Explore' } }), null);
});

test('fat tool calls: deny a missing limit, lower one that is too high, leave Bash and small tools alone', () => {
  const stats = {
    'mcp:claude_ai_HubSpot': { avg: 7700, calls: 12 },
    Read: { avg: 6000, calls: 4 },
    Grep: { avg: 8000, calls: 3 },
    Bash: { avg: 9000, calls: 20 },
  };
  assert.equal(toolLimitDecision('mcp__claude_ai_HubSpot__search', { limit: 20 }, stats), null);
  const denied = toolLimitDecision('mcp__claude_ai_HubSpot__search', { properties: ['name'] }, stats);
  assert.match(denied.deny, /claude_ai_HubSpot results average ≈8k.*no limit/);
  const nested = toolLimitDecision('mcp__claude_ai_HubSpot__search', { query: { max_results: '500' } }, stats);
  assert.equal(nested.updatedInput.query.max_results, 100);
  assert.match(nested.reason, /lowered to 100/);
  assert.equal(findLimits({ query: { max_results: '500' } })[0].value, 500);
  const read = toolLimitDecision('Read', { file_path: 'a.js' }, stats);
  assert.match(read.deny, /offset and limit/);
  assert.equal(toolLimitDecision('Read', { file_path: 'a.js', limit: 200 }, stats), null);
  assert.equal(toolLimitDecision('Read', { file_path: 'a.js', limit: 900 }, stats).updatedInput.limit, 400);
  assert.match(toolLimitDecision('Grep', { pattern: 'x' }, stats).deny, /path or a glob/);
  assert.equal(toolLimitDecision('Grep', { pattern: 'x', path: 'src' }, stats), null);
  assert.equal(toolLimitDecision('Bash', { command: 'ls' }, stats), null);
  assert.equal(toolLimitDecision('mcp__claude_ai_HubSpot__search', {}, { 'mcp:hubspot': { avg: 7700, calls: 2 } }), null);
  assert.deepEqual(toolStats(new Map([['Read', { tokens: 9000, calls: 3 }]])), { Read: { avg: 3000, calls: 3 } });
});

test('jobs report names the startup piece that changed and ignores a stable one', () => {
  const start = (startup, t) => ({
    t,
    tokens: 20_000,
    size: 40_000,
    calls: 2,
    prompt: 'Prepare the nightly brief',
    project: '/p',
    entry: 'sdk-cli',
    startup,
  });
  const r = attribute([]);
  r.total = 100_000;
  r.startHeadless = 40_000;
  r.starts = [
    start(
      [
        { group: 'SessionStart hooks', name: 'status.sh', chars: 400 },
        { group: 'Skill listing', name: 'trim', chars: 800 },
      ],
      T0,
    ),
    start(
      [
        { group: 'SessionStart hooks', name: 'status.sh', chars: 4400 },
        { group: 'Skill listing', name: 'trim', chars: 800 },
      ],
      T0 + 60_000,
    ),
  ];
  const md = jobsReport(r, { since: T0 - 86400_000, now: T0 + 86400_000 });
  assert.match(md, /## What changed between runs/);
  assert.match(md, /\| Prepare the nightly brief \| SessionStart hooks: status\.sh \| 100 \| 1\.1k \|/);
  assert.doesNotMatch(md, /Skill listing: trim/);
  assert.deepEqual(pieceDiff([{ group: 'Tool names', name: 'hubspot', chars: 10 }], [{ group: 'Tool names', name: 'hubspot', chars: 10 }]), []);
});

test('readCalls keeps the startup breakdown that arrived before the first response', async () => {
  const dir = tmp('lc-eff-read-');
  const file = join(dir, 's.jsonl');
  const att = (attachment) => JSON.stringify({ type: 'attachment', attachment });
  writeFileSync(
    file,
    [
      att({ type: 'hook_success', hookEvent: 'SessionStart', command: 'plugins/cache/x/limitcast/hooks/s.sh', content: 'hello hello' }),
      att({ type: 'hook_success', hookEvent: 'PostToolUse', command: 'nope', content: 'later' }),
      JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'Prepare the nightly brief' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(T0).toISOString(),
        requestId: 'a',
        entrypoint: 'sdk-cli',
        cwd: '/p',
        message: { id: 'a', usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }, content: [] },
      }),
      att({ type: 'hook_success', hookEvent: 'SessionStart', command: 'plugins/cache/x/other/hooks/s.sh', content: 'after the response' }),
    ].join('\n'),
  );
  const calls = await readCalls(file);
  assert.deepEqual(calls[0].startup, [{ group: 'SessionStart hooks', name: 'limitcast', chars: 11 }]);
  const r = attribute([calls]);
  assert.equal(r.starts[0].startup.length, 1);
});

test('CLI: duplicate spawns are held, a short idle is announced, and a fat call with no limit is denied', () => {
  const state = tmp('lc-eff-cli-');
  const env = {
    ...process.env,
    LIMITCAST_STATE: state,
    XDG_CONFIG_HOME: tmp('lc-eff-xdg-'),
    LIMITCAST_CACHE_NOTICE_MINUTES: '5',
    LIMITCAST_CACHE_MINUTES: '60',
  };
  delete env.LIMITCAST_LICENSE;
  delete env.LIMITCAST_ALLOW;
  const spawn = (prompt) =>
    JSON.stringify({ tool_name: 'Agent', session_id: 's1', tool_use_id: prompt, tool_input: { subagent_type: 'Explore', prompt } });
  const run = (cmd, input) => execFileSync('node', [bin, cmd], { env, input });
  assert.equal(run('guard', spawn('find the parser')).toString(), '');
  assert.equal(run('guard', spawn('find the tests')).toString(), '');
  const denied = JSON.parse(run('guard', spawn('find the parser')).toString());
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Explore subagent with this same prompt is already running/);
  run(
    'subagent-receipt',
    JSON.stringify({ session_id: 's1', agent_type: 'Explore', agent_transcript_path: join(tmp('lc-eff-missing-'), 'nope.jsonl') }),
  );
  assert.equal(run('guard', spawn('find the parser')).toString(), '');

  const tr = join(tmp('lc-eff-tr-'), 's.jsonl');
  const usage = (ago) =>
    JSON.stringify({
      timestamp: new Date(Date.now() - ago).toISOString(),
      message: { usage: { input_tokens: 10, cache_read_input_tokens: 250_000 } },
    });
  writeFileSync(tr, `${usage(10 * M)}\n`);
  const prompt = JSON.stringify({ session_id: 'cold', transcript_path: tr, prompt: 'continue' });
  const announced = JSON.parse(run('prompt-check', prompt).toString());
  assert.equal(announced.decision, undefined);
  assert.match(announced.systemMessage, /idle for 10 minutes.*going through/);
  assert.equal(run('prompt-check', prompt).toString(), '');
  writeFileSync(tr, `${usage(90 * M)}\n`);
  const held = JSON.parse(run('prompt-check', prompt).toString());
  assert.equal(held.decision, 'block');

  writeFileSync(join(state, 'tool-stats.json'), JSON.stringify({ 'mcp:claude_ai_HubSpot': { avg: 7700, calls: 9 } }));
  const open = JSON.parse(run('tool-limit', JSON.stringify({ tool_name: 'mcp__claude_ai_HubSpot__search', tool_input: { q: 'acme' } })).toString());
  assert.equal(open.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(open.hookSpecificOutput.permissionDecisionReason, /no limit/);
  const capped = JSON.parse(
    run('tool-limit', JSON.stringify({ tool_name: 'mcp__claude_ai_HubSpot__search', tool_input: { limit: 1000 } })).toString(),
  );
  assert.equal(capped.hookSpecificOutput.updatedInput.limit, 100);
  assert.equal(run('tool-limit', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toString(), '');
  assert.match(readFileSync(join(state, 'guard.jsonl'), 'utf8'), /"kind":"duplicate"/);
  assert.match(readFileSync(join(state, 'guard.jsonl'), 'utf8'), /"kind":"cold-notice"/);
  assert.match(readFileSync(join(state, 'guard.jsonl'), 'utf8'), /"kind":"tool-limit"/);
});
