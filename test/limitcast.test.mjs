import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { forecast, oneClaudeSession, slopePerHour, windowName } from '../src/forecast.mjs';
import { claudeSamples, codexSamples, readCodex } from '../src/sources.mjs';
import { guardDecision } from '../src/guard.mjs';

const H = 3600_000;
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
  assert.deepEqual(oneClaudeSession(mixed, 'B').map((x) => x.pct), [10, 13]);
  assert.deepEqual(oneClaudeSession(mixed).map((x) => x.pct), [90, 94, 98]); // latest is A
  assert.deepEqual(oneClaudeSession(mixed, 'unknown').map((x) => x.pct), [90, 94, 98]);
  const codex = { t: now, src: 'codex', win: '7d', pct: 10, reset };
  assert.ok(oneClaudeSession([...mixed, codex], 'B').includes(codex));
});

test('window names', () => {
  assert.equal(windowName(300), '5h');
  assert.equal(windowName(10080), '7d');
  assert.equal(windowName(1440), '1d');
  assert.equal(windowName(90), '90m');
});

test('claude status-line JSON parses both windows and skips missing ones', () => {
  const out = claudeSamples({ rate_limits: { five_hour: { used_percentage: 42.5, resets_at: 1793390000 }, seven_day: { used_percentage: 63 } } }, now);
  assert.deepEqual(out, [{ t: now, src: 'claude', win: '5h', pct: 42.5, reset: 1793390000 }]);
  assert.deepEqual(claudeSamples({}, now), []);
  assert.deepEqual(claudeSamples(null, now), []);
});

const codexLine = (pct, ts = '2026-10-24T17:00:00.000Z') => JSON.stringify({
  timestamp: ts, type: 'event_msg',
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
  writeFileSync(join(root, '2026', '10', '24', 'rollout-a.jsonl'), [codexLine(10), '{"type":"x"}', codexLine(12, '2026-10-24T17:30:00.000Z')].join('\n'));
  writeFileSync(join(root, '2026', '10', '24', 'other.jsonl'), codexLine(99));
  const out = await readCodex(0, root);
  assert.deepEqual(out.map((x) => x.pct), [10, 12]);
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

test('CLI end to end: statusline records, wraps the command, guard denies', () => {
  const state = mkdtempSync(join(tmpdir(), 'lc-state-'));
  const env = { ...process.env, LIMITCAST_STATE: state, CODEX_HOME: join(state, 'nocodex') };
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const r = Math.floor(Date.now() / 1000) + 3600;
  const feed = (pct) => JSON.stringify({ rate_limits: { five_hour: { used_percentage: pct, resets_at: r } } });

  // Wrapped command receives the same stdin and its output passes through.
  const out = execFileSync('node', [bin, 'statusline', '--', 'node', '-e', 'process.stdin.pipe(process.stdout)'], { input: feed(50), env }).toString();
  assert.equal(JSON.parse(out).rate_limits.five_hour.used_percentage, 50);

  // Backdate the first sample so the slope spans > 5 minutes, then add a second.
  const file = join(state, 'samples.jsonl');
  writeFileSync(file, JSON.stringify({ t: Date.now() - 30 * 60_000, src: 'claude', win: '5h', pct: 50, reset: r }) + '\n');
  execFileSync('node', [bin, 'statusline'], { input: feed(90), env });

  const status = JSON.parse(execFileSync('node', [bin, 'status', '--json'], { env }).toString());
  assert.equal(status[0].verdict, 'AT_RISK'); // +80%/h, 10% left -> ~7 min, reset in 60 min

  const deny = execFileSync('node', [bin, 'guard'], { input: JSON.stringify({ tool_name: 'Agent' }), env }).toString();
  assert.equal(JSON.parse(deny).hookSpecificOutput.permissionDecision, 'deny');
  const allowed = execFileSync('node', [bin, 'guard'], { input: JSON.stringify({ tool_name: 'Agent' }), env: { ...env, LIMITCAST_ALLOW: '1' } }).toString();
  assert.equal(allowed, '');
  const failOpen = execFileSync('node', [bin, 'guard'], { input: 'not json', env, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
  assert.equal(failOpen, '');
});
