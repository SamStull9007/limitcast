import './helpers/environment.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGuard } from '../src/guard.mjs';
import { logSubagent, spawnNotice } from '../src/subagents.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
process.env.LIMITCAST_STATE = tmp('lc-spawn-state-'); // the ledger lives here, never in the real state dir
const NOW = Date.parse('2026-10-26T20:00:00.000Z');
const run = (type, pct, i = 0) => ({
  t: NOW - 3600_000,
  id: `${type}-${i}`,
  type,
  calls: 10,
  fresh: 1000,
  read: 0,
  ...(pct === undefined ? {} : { pct }),
});

test('spawnNotice: median, max and count of the same type, with the window', () => {
  const entries = [run('Explore', 0.5, 1), run('Explore', 1.2, 2), run('Explore', 3.6, 3), run('Plan', 9, 4)];
  assert.equal(
    spawnNotice(entries, 'Explore', { pct: 38.2, verdict: 'OK' }),
    'limitcast: Explore subagents have cost you a median ≈1.2% (max ≈3.6%) of a 5-hour window over 3 runs; this window is 38% used.',
  );
  // An even count averages the middle two; a window we know nothing about is simply not mentioned.
  assert.match(spawnNotice([run('a', 1), run('a', 2), run('a', 3), run('a', 4)], 'a', undefined), /median ≈2\.5% \(max ≈4\.0%\) .* over 4 runs\.$/);
});

test('spawnNotice: falls back to every subagent, and stays quiet when it has little to say', () => {
  const entries = [run('Explore', 2, 1), run('Plan', 3, 2), run('Explore', 4, 3)];
  assert.match(spawnNotice(entries, 'Bash', undefined), /^limitcast: Your subagents have cost you a median ≈3\.0% .* over 3 runs\.$/);
  assert.equal(spawnNotice(entries.slice(0, 2), 'Explore', undefined), null); // under 3 runs
  assert.equal(spawnNotice([run('a', undefined, 1), run('a', undefined, 2), run('a', undefined, 3)], 'a', undefined), null); // unpriced runs do not count
  const cheap = [run('a', 0.2, 1), run('a', 0.3, 2), run('a', 0.4, 3)];
  assert.equal(spawnNotice(cheap, 'a', { pct: 10, verdict: 'OK' }), null); // typical run under 1%: not worth a message
  assert.match(spawnNotice(cheap, 'a', { pct: 85, verdict: 'NEAR' }), /median ≈0\.30% .* this window is 85% used\.$/);
});

test('runGuard: a Pro spawn gets the notice; a preview, Codex and an unknown history get nothing', async () => {
  for (const [i, pct] of [0.8, 1.5, 2.5].entries()) logSubagent(run('Explore', pct, i));
  const spawn = { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', model: 'sonnet' }, session_id: 's1' };
  const d = await runGuard(spawn, NOW, 30);
  assert.match(d.notice, /Explore subagents have cost you a median ≈1\.5% \(max ≈2\.5%\) of a 5-hour window over 3 runs\.$/);
  assert.equal(await runGuard(spawn, NOW, 30, { preview: true }), null);
  assert.equal(await runGuard({ ...spawn, tool_name: 'Read' }, NOW, 30), null);
});

test('CLI: the guard hook prints the notice as a systemMessage without a license', () => {
  const state = tmp('lc-spawn-cli-state-');
  const entries = [0.8, 1.5, 2.5].map((pct, i) => JSON.stringify({ ...run('Explore', pct, i), t: Date.now() - 60_000 }));
  writeFileSync(join(state, 'subagents.jsonl'), `${entries.join('\n')}\n`);
  // XDG_CONFIG_HOME too: starting a trial also writes a marker there, which must not land in the real ~/.config.
  const env = { ...process.env, LIMITCAST_STATE: state, XDG_CONFIG_HOME: tmp('lc-spawn-cli-xdg-') };
  delete env.LIMITCAST_LICENSE;
  delete env.LIMITCAST_ALLOW;
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Explore' }, session_id: 's1' });
  const free = spawnSync('node', [bin, 'guard'], { env, input });
  assert.equal(free.status, 0);
  assert.match(free.stdout.toString(), /systemMessage/);
  assert.equal(spawnSync('node', [bin, 'trial'], { env }).status, 0);
  const pro = spawnSync('node', [bin, 'guard'], { env, input });
  assert.equal(pro.status, 0, pro.stderr.toString());
  const out = JSON.parse(pro.stdout.toString());
  assert.deepEqual(Object.keys(out), ['systemMessage']); // allows the call: no permissionDecision
  assert.match(out.systemMessage, /^limitcast: Explore subagents have cost you a median ≈1\.5%/);
});
