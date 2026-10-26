import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { forecast, resetTarget } from '../src/forecast.mjs';
import { runGuard, switchable } from '../src/guard.mjs';
import { compactHint, headroom, lastCallTokens } from '../src/hints.mjs';
import { mdToHtml } from '../src/html.mjs';
import { buildNotifierApp, notifierApp, transitions } from '../src/notify.mjs';
import { resultsStats } from '../src/results.mjs';

const H = 3600_000;
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('daily allowance: an even share of what was left this morning, minus what today used', () => {
  const now = new Date(2026, 9, 27, 15, 0).getTime(); // Tue 15:00 local
  const midnight = new Date(2026, 9, 27).getTime();
  const reset = (midnight + 4 * 24 * H) / 1000; // 4 days after this midnight
  const w = (t, pct) => ({ t, src: 'claude', win: '7d', pct, reset });
  // 40% used by midnight, 52% now: 60% left over 4 days = 15%/day; used 12% today -> 3% left.
  const f = forecast([w(midnight - 2 * H, 40), w(now - H, 50), w(now, 52)], now);
  assert.equal(Math.round(f.today.budget), 15);
  assert.equal(Math.round(f.today.used), 12);
  assert.equal(Math.round(f.today.left), 3);
  // Over budget shows negative; the 5h window has no allowance.
  assert.ok(forecast([w(midnight - 2 * H, 40), w(now, 60)], now).today.left < 0);
  assert.equal(forecast([{ ...w(now, 10), win: '5h', reset: now / 1000 + H / 1000 }], now).today, null);
  // A window that began today starts at 0%.
  const fresh = forecast([{ ...w(now, 5), reset: (now + 7 * 24 * H - 2 * H) / 1000 }], now);
  assert.equal(Math.round(fresh.today.used), 5);
});

test('after-reset waits for the reset, or runs now if it already happened', () => {
  assert.equal(resetTarget({ verdict: 'HIT', reset: 5000_000 }, 1000), 5000_000 + 60_000);
  assert.equal(resetTarget({ verdict: 'RESET', reset: 500 }, 1000), 1000);
});

test('macOS notifier app: its own bundle id and name, no Dock icon, reads the queue', { skip: process.platform !== 'darwin' }, () => {
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = tmp('lc-notifier-');
  try {
    assert.equal(buildNotifierApp(), true);
    const plist = readFileSync(join(notifierApp(), 'Contents', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>dev\.limitcast\.notifier<\/string>/);
    assert.match(plist, /<key>CFBundleName<\/key>\s*<string>limitcast<\/string>/);
    assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/);
    assert.match(readFileSync(join(process.env.LIMITCAST_STATE, 'notifier.applescript'), 'utf8'), /notify-queue\.txt/);
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});

test('notifications: one per worsening, a reset after a HIT, and no repeats', () => {
  const clock = () => '14:00';
  const row = (verdict, reset = 10 * H, pct = 96, wall = null) => ({ src: 'claude', win: '5h', pct, reset, wall, verdict });
  let r = transitions([row('NEAR')], {}, clock);
  assert.deepEqual(r.messages, ['Claude 5h limit is at 96%. Resets 14:00.']);
  assert.deepEqual(transitions([row('NEAR')], r.next, clock).messages, []); // no repeat
  assert.deepEqual(transitions([row('OK', 10 * H, 90)], r.next, clock).messages, []); // dips don't re-arm
  r = transitions([row('HIT', 10 * H, 100)], r.next, clock);
  assert.deepEqual(r.messages, ['Claude 5h limit reached. Resets 14:00.']);
  assert.deepEqual(transitions([row('OK', 15 * H, 3)], r.next, clock).messages, ["Claude 5h limit reset: you're clear."]);
  assert.match(transitions([row('AT_RISK', 10 * H, 80, 9 * H)], {}, clock).messages[0], /on pace to run out at 14:00/);
});

test('headroom: point to the other account only when the current one is in trouble', () => {
  const now = Date.UTC(2026, 9, 25, 12);
  const r5 = now / 1000 + 2 * 3600;
  const r7 = now / 1000 + 3 * 86400;
  const s = (sid, win, pct, minsAgo, reset) => ({ t: now - minsAgo * 60_000, src: 'claude', win, pct, reset, sid });
  // Account A (sessions a) near its 5h limit; account B (session b) quiet. Different resets keep them apart.
  const A = [s('a', '5h', 90, 30, r5), s('a', '5h', 97, 0, r5), s('a', '7d', 40, 0, r7)];
  const B = [s('b', '5h', 12, 60, r5 + 3600), s('b', '7d', 30, 60, r7 + 3600)];
  assert.equal(headroom([...A, ...B], 'a', now), '⇄ other account 5h 12% · 7d 30%');
  assert.equal(headroom([...A, ...B], 'b', now), null); // b is fine
  assert.equal(headroom(A, 'a', now), null); // no other account
});

test('long sessions: tokens re-sent per call from the transcript tail', () => {
  const dir = tmp('lc-ctx-');
  const p = join(dir, 's.jsonl');
  const call = (input, read, side = false) =>
    JSON.stringify({ type: 'assistant', isSidechain: side, message: { usage: { input_tokens: input, cache_read_input_tokens: read } } });
  writeFileSync(p, `${call(5, 100_000)}\n${'x'.repeat(300_000)}\n${call(10, 170_000)}\n${call(1, 900_000, true)}\n`);
  assert.equal(lastCallTokens(p), 170_010); // last main-thread call; the subagent's is skipped
  assert.equal(compactHint(170_010), 'ctx 170k · /compact');
  assert.equal(compactHint(90_000), null);
});

test('HTML: headings, lists, tables with right-aligned numbers, escaped text', () => {
  const html = mdToHtml('# T\n- **a** <b>\n\n| x | n |\n|---|---:|\n| y | 2 |\n\n```\nwin  5h\n```');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<li><strong>a<\/strong> &lt;b&gt;<\/li>/);
  assert.match(html, /<th class="num">n<\/th>/);
  assert.match(html, /<td class="num">2<\/td>/);
  assert.match(html, /<pre>win {2}5h<\/pre>/);
});

test('model guard: a tight window runs new Claude subagents on Sonnet; free only records it', async () => {
  const state = tmp('lc-switch-');
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = state;
  try {
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 3 * 3600;
    // 96% and flat: NEAR (no runout time), so nothing is blocked, but the window is tight.
    writeFileSync(
      join(state, 'samples.jsonl'),
      [30, 0].map((m) => JSON.stringify({ t: now - m * 60_000, src: 'claude', win: '5h', pct: 96, reset, sid: 's' })).join('\n'),
    );
    const hook = (model) => ({ tool_name: 'Agent', session_id: 's', tool_input: { prompt: 'p', description: 'd', ...(model ? { model } : {}) } });
    const d = await runGuard(hook(), now, 30);
    assert.deepEqual(d.updatedInput, { prompt: 'p', description: 'd', model: 'sonnet' }); // the whole input, model replaced
    assert.match(d.reason, /Claude 5h limit is 96% used; this subagent runs on Sonnet/);
    assert.equal((await runGuard(hook('opus'), now, 30)).updatedInput.model, 'sonnet');
    assert.equal(await runGuard(hook('haiku'), now, 30), null); // an explicit cheaper model is left alone
    assert.equal(await runGuard(hook(), now, 30, { preview: true }), null);
    const log = readFileSync(join(state, 'guard.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      log.map((b) => [b.kind, b.from, Boolean(b.shadow)]),
      [
        ['switch', 'default', false],
        ['switch', 'opus', false],
        ['switch', 'default', true],
      ],
    );
    const st = resultsStats({ now, days: 7, samples: [], blocks: log, pro: true });
    assert.deepEqual([st.switches, st.outcomes.length], [2, 0]); // switches aren't blocks
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
  assert.equal(switchable('claude-opus-5-5'), true);
  assert.equal(switchable('sonnet'), false);
});

test('CLI: Pro gates and the status line hint when wrapping a status line', () => {
  const state = tmp('lc-act-');
  const env = { ...process.env, LIMITCAST_STATE: state, CODEX_HOME: join(state, 'nocodex') };
  delete env.LIMITCAST_LICENSE;
  const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
  for (const args of [
    ['notify', 'on'],
    ['after-reset', '--', 'true'],
    ['results', '--html'],
  ]) {
    assert.throws(
      () => execFileSync('node', [bin, ...args], { env, stdio: 'pipe' }),
      (e) => e.status === 2,
      args.join(' '),
    );
  }
  // Free: the wrapped status line is passed through untouched, with limitcast's line under it.
  const out = execFileSync('node', [bin, 'statusline', '--', 'echo', 'mine'], { input: '{}', env }).toString();
  assert.equal(out, 'mine\nlimitcast: waiting for data\n');
  assert.equal(readFileSync(join(state, 'last-feed.json'), 'utf8').includes('"keys"'), true);
});
