import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeAccounts, forecast, oneClaudeAccount, slopePerHour, windowName } from '../src/forecast.mjs';
import { guardDecision, runGuard } from '../src/guard.mjs';
import { claudeSamples, codexSamples, readCodex } from '../src/sources.mjs';

const H = 3600_000;
process.env.GROK_HOME = mkdtempSync(join(tmpdir(), 'lc-main-grok-'));
const now = Date.UTC(2026, 9, 24, 18, 0);
const reset = now / 1000 + 2 * 3600; // resets in 2h
const s = (minsAgo, pct, r = reset) => ({ t: now - minsAgo * 60_000, src: 'claude', win: '5h', pct, reset: r });

test('slope is % per hour and ignores spans under 5 minutes', () => {
  assert.equal(slopePerHour([s(60, 10), s(0, 30)]), 20);
  assert.equal(slopePerHour([s(3, 10), s(0, 30)]), null);
  assert.equal(slopePerHour([s(0, 10)]), null);
});

test('on pace to run out before reset is AT_RISK with the right time', () => {
  const f = forecast([s(60, 40), s(30, 55), s(0, 70)], now); // +30%/h, 30% left -> 1h
  assert.equal(f.verdict, 'AT_RISK');
  assert.equal(Math.round(f.rate), 30);
  assert.equal(f.wall, now + H);
});

test('slow burn that outlasts the reset is OK', () => {
  const f = forecast([s(60, 40), s(0, 45)], now); // +5%/h, 55% left -> 11h > 2h
  assert.equal(f.verdict, 'OK');
});

test('100% is HIT; a passed reset is RESET; flat usage has no runout time', () => {
  assert.equal(forecast([s(0, 100)], now).verdict, 'HIT');
  assert.equal(forecast([s(0, 50, now / 1000 - 60)], now).verdict, 'RESET');
  const flat = forecast([s(60, 50), s(0, 50)], now);
  assert.equal(flat.verdict, 'OK');
  assert.equal(flat.wall, null);
});

test('samples from the previous window are ignored', () => {
  const old = reset - 5 * 3600;
  const f = forecast([s(200, 95, old), s(60, 10), s(0, 20)], now);
  assert.equal(Math.round(f.rate), 10);
});

test('two accounts in parallel: each session forecasts only its own readings', () => {
  const a = (minsAgo, pct) => ({ ...s(minsAgo, pct), win: '7d', sid: 'A' });
  const b = (minsAgo, pct) => ({ ...s(minsAgo, pct), win: '7d', sid: 'B' });
  const mixed = [a(60, 90), b(50, 10), a(30, 94), b(1, 13), a(0, 98)];
  assert.deepEqual(
    oneClaudeAccount(mixed, 'B').map((x) => x.pct),
    [10, 13],
  );
  assert.deepEqual(
    oneClaudeAccount(mixed).map((x) => x.pct),
    [90, 94, 98],
  ); // latest is A
  assert.deepEqual(
    oneClaudeAccount(mixed, 'unknown').map((x) => x.pct),
    [90, 94, 98],
  );
  const codex = { t: now, src: 'codex', win: '7d', pct: 10, reset };
  assert.ok(oneClaudeAccount([...mixed, codex], 'B').includes(codex));
});

test('sessions of one account share one history, so a short session still forecasts', () => {
  // Three short sessions of the same account: each alone has under 5 minutes of readings.
  const r = (minsAgo, pct, sid) => ({ ...s(minsAgo, pct), sid });
  const mixed = [r(60, 40, 'A'), r(58, 41, 'A'), r(30, 55, 'B'), r(29, 56, 'B'), r(1, 69, 'C'), r(0, 70, 'C')];
  const acct = oneClaudeAccount(mixed, 'C');
  assert.equal(acct.length, 6);
  assert.equal(forecast(acct, now).verdict, 'AT_RISK'); // +30%/h, 30% left -> 1h, reset in 2h
  assert.equal(
    forecast(
      mixed.filter((x) => x.sid === 'C'),
      now,
    ).verdict,
    'OK',
  ); // one session alone: no rate
  // A session from another window of the same account (earlier 5h reset) shares the 7d window and joins.
  const older = { ...s(300, 20, reset - 5 * 3600), sid: 'D' };
  const week = (minsAgo, pct, sid) => ({ ...s(minsAgo, pct), win: '7d', sid });
  assert.equal(claudeAccounts([older, week(300, 30, 'D'), r(0, 70, 'C'), week(0, 33, 'C')]).length, 1);
});

test('NEAR at 95%+ even with no burn rate; the guard does not block on NEAR alone', () => {
  assert.equal(forecast([s(0, 96)], now).verdict, 'NEAR');
  assert.equal(forecast([s(60, 96), s(0, 96)], now).verdict, 'NEAR'); // flat
  assert.equal(forecast([s(0, 94)], now).verdict, 'OK');
  assert.equal(guardDecision('Agent', [forecast([s(0, 97)], now)], now, 30), null);
});

test('7d: one busy hour is not projected across the week; a burst near the end still is', () => {
  const week = now / 1000 + 5 * 86400; // resets in 5 days
  const w = (minsAgo, pct) => ({ ...s(minsAgo, pct, week), win: '7d' });
  // Reset 14h ago at 0%, idle, then +3% in the last hour: the hour alone says ~32h to runout (AT_RISK);
  // the day's pace says weeks.
  const burst = [w(14 * 60, 0), w(60, 0), w(30, 1.5), w(0, 3)];
  const f = forecast(burst, now);
  assert.equal(f.verdict, 'OK');
  assert.ok(f.rate < 0.5);
  // 97% and +6%/h over the last 20 minutes: out in ~30 min, so the short pace wins and the guard can act.
  const end = [w(24 * 60, 80), w(20, 95), w(10, 96), w(0, 97)];
  const g = forecast(end, now);
  assert.equal(g.verdict, 'AT_RISK');
  assert.ok(g.wall - now <= 60 * 60_000);
  assert.match(guardDecision('Agent', [g], now, 60), /Claude 7d/);
  assert.equal(f.rate, 3 / 24); // 3% over the last full day
  // A week window that began 2h ago at 0%: still averaged over a full day, not 2 hours.
  const fresh = (minsAgo, pct) => ({ ...s(minsAgo, pct, now / 1000 + 7 * 86400 - 2 * 3600), win: '7d' });
  assert.equal(forecast([fresh(60, 1), fresh(0, 2)], now).verdict, 'OK');
  // A day after the burst with nothing new: no pace, no runout.
  assert.equal(forecast(burst, now + 25 * 3600_000).wall, null);
  // The 5h window keeps the last hour's pace.
  assert.equal(forecast([s(60, 40), s(30, 55), s(0, 70)], now).wall, now + 3600_000);
});

test('window names', () => {
  assert.equal(windowName(300), '5h');
  assert.equal(windowName(10080), '7d');
  assert.equal(windowName(1440), '1d');
  assert.equal(windowName(90), '90m');
});

test('claude status-line JSON parses both windows and skips missing ones', () => {
  const out = claudeSamples(
    { rate_limits: { five_hour: { used_percentage: 42.5, resets_at: 1793390000 }, seven_day: { used_percentage: 63 } } },
    now,
  );
  assert.deepEqual(out, [{ t: now, src: 'claude', win: '5h', pct: 42.5, reset: 1793390000 }]);
  assert.deepEqual(claudeSamples({}, now), []);
  assert.deepEqual(claudeSamples(null, now), []);
});

const codexLine = (pct, ts = '2026-10-24T17:00:00.000Z') =>
  JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: 1793382091 }, secondary: null } },
  });

test('codex token_count line parses; other lines are ignored', () => {
  assert.deepEqual(codexSamples(codexLine(10)), [{ t: Date.parse('2026-10-24T17:00:00.000Z'), src: 'codex', win: '7d', pct: 10, reset: 1793382091 }]);
  assert.deepEqual(codexSamples('{"type":"session_meta"}'), []);
  assert.deepEqual(codexSamples('{"rate_limits": broken'), []);
});

test('readCodex walks nested rollout files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lc-codex-'));
  mkdirSync(join(root, '2026', '10', '24'), { recursive: true });
  writeFileSync(
    join(root, '2026', '10', '24', 'rollout-a.jsonl'),
    [codexLine(10), '{"type":"x"}', codexLine(12, '2026-10-24T17:30:00.000Z')].join('\n'),
  );
  writeFileSync(join(root, '2026', '10', '24', 'other.jsonl'), codexLine(99));
  const out = await readCodex(0, root);
  assert.deepEqual(
    out.map((x) => x.pct),
    [10, 12],
  );
});

test('guard blocks subagents only when a Claude window runs out soon', () => {
  const risky = forecast([s(60, 40), s(0, 85)], now); // +45%/h, 15% left -> 20 min
  const later = forecast([s(60, 10), s(0, 30)], now); // +20%/h, 70% left -> 3.5h > reset: OK
  assert.match(guardDecision('Agent', [risky], now, 30), /run out in ~20 min/);
  assert.equal(guardDecision('Agent', [risky], now, 10), null);
  assert.equal(guardDecision('Bash', [risky], now, 30), null);
  assert.equal(guardDecision('Task', [later], now, 30), null);
  assert.equal(guardDecision('Task', [forecast([s(0, 100)], now)], now, 30), null); // extra usage may continue past 100%
  assert.equal(guardDecision('Agent', [{ ...risky, src: 'codex' }], now, 30), null);
});

test('CLI end to end: statusline records, wraps the command; guard is Pro-gated and denies with Pro', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lc-state-'));
  const env = { ...process.env, LIMITCAST_STATE: state, CODEX_HOME: join(state, 'nocodex'), GROK_HOME: join(state, 'nogrok') };
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const r = Math.floor(Date.now() / 1000) + 3600;
  const feed = (pct) => JSON.stringify({ rate_limits: { five_hour: { used_percentage: pct, resets_at: r } } });

  // Wrapped command receives the same stdin and its output passes through.
  const out = execFileSync('node', [bin, 'statusline', '--', 'node', '-e', 'process.stdin.pipe(process.stdout)'], {
    input: feed(50),
    env,
  }).toString();
  const [passed, ours] = out.trimEnd().split('\n');
  assert.equal(JSON.parse(passed).rate_limits.five_hour.used_percentage, 50);
  assert.match(ours, /^limitcast: 5h 50%/);

  // Backdate the first sample so the slope spans > 5 minutes, then add a second.
  const file = join(state, 'samples.jsonl');
  writeFileSync(file, `${JSON.stringify({ t: Date.now() - 30 * 60_000, src: 'claude', win: '5h', pct: 50, reset: r })}\n`);
  execFileSync('node', [bin, 'statusline'], { input: feed(90), env });

  const status = JSON.parse(execFileSync('node', [bin, 'status', '--json'], { env }).toString());
  assert.equal(status[0].verdict, 'AT_RISK'); // +80%/h, 10% left -> ~7 min, reset in 60 min

  // No license: the guard allows even though the window is at risk, and records the preview.
  const free = execFileSync('node', [bin, 'guard'], { input: JSON.stringify({ tool_name: 'Agent' }), env }).toString();
  assert.equal(free, '');
  const preview = execFileSync('node', [bin, 'results'], { env }).toString();
  assert.match(preview, /Pro would have blocked 1 subagent spawn/);
  // With Pro the CLI runs runGuard; on the same readings it denies.
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = state;
  try {
    assert.match(await runGuard({ tool_name: 'Agent' }, Date.now(), 30), /^limitcast: Claude 5h/);
    assert.equal(await runGuard({ tool_name: 'Bash' }, Date.now(), 30), null);
    // Only blocks are logged, for `limitcast results`: the free preview, then the real block.
    const logged = readFileSync(join(state, 'guard.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      logged.map((b) => [b.src, b.win, b.pct, Boolean(b.shadow)]),
      [
        ['claude', '5h', 90, true],
        ['claude', '5h', 90, false],
      ],
    );
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});

test('untagged readings from before session tagging never mix into a tagged session', () => {
  const tagged = (minsAgo, pct) => ({ ...s(minsAgo, pct), win: '7d', sid: 'A' });
  const legacy = (minsAgo, pct) => ({ ...s(minsAgo, pct), win: '7d' });
  const kept = oneClaudeAccount([legacy(50, 13), legacy(40, 98), tagged(10, 98), tagged(0, 98)]);
  assert.deepEqual(
    kept.map((x) => x.sid),
    ['A', 'A'],
  );
  const f = forecast(kept, now);
  assert.deepEqual([f.verdict, f.wall], ['NEAR', null]); // flat at 98%: near the limit, but no false runout time
  assert.equal(oneClaudeAccount([legacy(5, 13), legacy(0, 98)]).length, 2); // nothing tagged yet: keep all
});
