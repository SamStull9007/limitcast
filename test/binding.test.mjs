import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bindingLine } from '../src/hints.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const clock = (ms) => `t${ms}`;
const row = (src, win, pct, verdict, wall = null) => ({ src, win, pct, reset: 9, wall, verdict, rate: 1, today: null });

test('binding line: names the window that runs out first and the roomiest other tool', () => {
  const rows = [
    row('claude', '5h', 30, 'OK'),
    row('claude', '7d', 60, 'AT_RISK', 500),
    row('claude', '5h', 80, 'AT_RISK', 900),
    row('grok', '5h', 24, 'OK'),
  ];
  assert.equal(bindingLine(rows, { '5h': 50 }, clock), "You'll hit Claude 7d first (t500). Grok 5h still has $38.");
  assert.equal(bindingLine(rows, null, clock), "You'll hit Claude 7d first (t500). Grok 5h has 76% left."); // no dollar cap known: a percent
  assert.equal(bindingLine([row('claude', '7d', 60, 'AT_RISK', 500)], null, clock), "You'll hit Claude 7d first (t500).");
  assert.equal(bindingLine([row('claude', '7d', 60, 'OK'), row('codex', '7d', 5, 'OK')], null, clock), null); // nothing on pace to run out
});

test('CLI: status prints the binding line when a window is on pace to run out', () => {
  const state = tmp('lc-binding-');
  const now = Date.now();
  const reset = Math.floor(now / 1000) + 3 * 86400;
  const lines = [
    [now - 24 * 3600_000, 10],
    [now - 3600_000, 40],
    [now, 45],
  ].map(([t, pct]) => JSON.stringify({ t, src: 'claude', win: '7d', pct, reset, sid: 's' }));
  writeFileSync(join(state, 'samples.jsonl'), lines.join('\n'));
  const env = { ...process.env, LIMITCAST_STATE: state, GROK_HOME: tmp('lc-binding-grok-'), CODEX_HOME: tmp('lc-binding-codex-') };
  const out = spawnSync('node', [new URL('../bin/limitcast.mjs', import.meta.url).pathname, 'status'], { env }).stdout.toString();
  assert.match(out, /You'll hit Claude 7d first \(/);
});
