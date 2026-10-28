import './helpers/environment.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'smol-toml';
import { forecast } from '../src/forecast.mjs';
import { installGrok, patchGrokSubagentModel, wrapGrokStatusLine } from '../src/grok.mjs';
import { runGuard } from '../src/guard.mjs';
import { load, record } from '../src/store.mjs';

const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
const M = 60_000;
const tmp = () => mkdtempSync(join(tmpdir(), 'lc-reliability-'));
function environment() {
  const root = tmp();
  return {
    ...process.env,
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    GROK_HOME: join(root, 'grok'),
    LIMITCAST_STATE: join(root, 'state'),
  };
}
const run = (env, ...args) => execFileSync(process.execPath, [bin, ...args], { env, encoding: 'utf8' });

test('stale burst permits a spawn, unchanged observations stay fresh, and fresh burn can hold again', async () => {
  process.env.LIMITCAST_STATE = tmp();
  const now = Date.now();
  const sample = (t, pct, sid = 'account-a') => ({ t, pct, sid, src: 'claude', win: '5h', reset: (now + 3 * 3600_000) / 1000 });
  record([sample(now - 120 * M, 70)]);
  record([sample(now - 110 * M, 90)]);
  assert.equal(forecast(load(0), now).verdict, 'STALE');
  assert.equal(await runGuard({ tool_name: 'Agent', session_id: 'account-a', tool_input: { model: 'opus' } }, now, 30), null);
  record([sample(now, 90)]);
  record([sample(now + 5 * M, 90)]);
  const fresh = forecast(load(0), now + 5 * M);
  assert.equal(fresh.observedAt, now + 5 * M);
  assert.equal(fresh.wall, null, 'old burn must not be extrapolated over a confirmed idle plateau');
  record([sample(now + 10 * M, 97)]);
  assert.match(await runGuard({ tool_name: 'Agent', session_id: 'account-a' }, now + 10 * M, 30), /run out/);
  record([sample(now + 11 * M, 1, 'account-b')]);
  assert.equal(await runGuard({ tool_name: 'Agent', session_id: 'account-b' }, now + 11 * M, 30), null);
});

test('CLI stale reading is visible and never emits a deny decision', () => {
  const env = environment();
  mkdirSync(env.LIMITCAST_STATE);
  const now = Date.now();
  writeFileSync(
    join(env.LIMITCAST_STATE, 'samples.jsonl'),
    [120, 110]
      .map((minutes, i) => JSON.stringify({ t: now - minutes * M, pct: 70 + i * 20, src: 'claude', win: '5h', reset: now / 1000 + 10800 }))
      .join('\n'),
  );
  assert.match(run(env, 'status'), /STALE/);
  const guard = execFileSync(process.execPath, [bin, 'guard'], { env, input: '{"tool_name":"Agent"}', encoding: 'utf8' });
  assert.equal(guard, '');
});

test('Grok edits retain comments, typed fields, escaped commands and following indented tables', () => {
  const original =
    '[ui.status_line] # keep this header\ntype = "command"\ncommand = "echo \\"hello\\"" # command note\nrefresh_interval = 30 # cadence\n# keep this note\n  [models] # next table\ndefault = "grok-4.6"\n';
  const before = parse(original);
  const wrapped = wrapGrokStatusLine(original, '/tmp/limitcast');
  const after = parse(wrapped);
  assert.deepEqual(after.models, before.models);
  assert.equal(after.ui.status_line.refresh_interval, 30);
  assert.match(wrapped, /# keep this header/);
  assert.match(wrapped, /# cadence/);
  assert.match(wrapped, /# command note/);
  assert.match(wrapped, /# keep this note/);
  assert.match(after.ui.status_line.command, /hello/);
  assert.equal(wrapGrokStatusLine(wrapped, '/tmp/limitcast'), wrapped);
  assert.equal(
    parse(wrapGrokStatusLine('[ "ui" . status_line ] # quoted\n"command" = "echo hello"\n', '/tmp/limitcast')).ui.status_line.type,
    'command',
  );
  const pinned = patchGrokSubagentModel(
    '[subagents.models] # models\nexplore = "grok-4.3"\n  [models]\ndefault = "grok-4.6"\n',
    'explore',
    'grok-4.6',
  );
  assert.equal(parse(pinned).subagents.models.explore, 'grok-4.6');
  assert.equal(parse(pinned).models.default, 'grok-4.6');
});

test('invalid Grok config is refused before its contents or hooks change', () => {
  const home = tmp();
  const path = join(home, 'config.toml');
  const original = '[ui.status_line]\ntype = "command"\ntype = "builtin"\n';
  writeFileSync(path, original);
  assert.throws(() => installGrok({ guard: true, self: '/tmp/limitcast', home }));
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(existsSync(join(home, 'hooks', 'limitcast.json')), false);
});

test('single-host setup avoids unrelated Claude settings and doctor requirements', () => {
  for (const host of ['claude', 'codex', 'grok']) {
    const env = environment();
    const dir = env[host === 'claude' ? 'CLAUDE_CONFIG_DIR' : host === 'codex' ? 'CODEX_HOME' : 'GROK_HOME'];
    mkdirSync(dir);
    writeFileSync(join(dir, host === 'claude' ? 'settings.json' : 'config.toml'), host === 'claude' ? '{}' : '');
    const onboard = run(env, 'onboard');
    assert.match(onboard, host === 'claude' ? /Claude Code/ : host === 'codex' ? /Codex/ : /Grok/);
    run(env, 'install', '--host', host, '--guard');
    const checked = spawnSync(process.execPath, [bin, 'doctor'], { env, encoding: 'utf8' });
    assert.equal(checked.status, host === 'codex' ? 1 : 0, checked.stderr);
    const doctor = checked.stdout;
    if (host === 'grok') assert.doesNotMatch(run(env, 'budget', 'grok', '20'), /limitcast install --guard/);
    if (host !== 'claude') {
      assert.doesNotMatch(doctor, /No Claude limit readings|Status-line recorder missing/);
      assert.equal(existsSync(env.CLAUDE_CONFIG_DIR), false);
      run(env, 'uninstall');
      assert.equal(existsSync(env.CLAUDE_CONFIG_DIR), false);
    }
  }
});

test('Grok quota and applied guard evidence reach status, HTML and historical results', () => {
  const env = environment();
  mkdirSync(env.LIMITCAST_STATE);
  const now = Date.now();
  const reset = Math.floor(now / 1000) + 3 * 86400;
  const quota = {
    at: now,
    ok: true,
    label: 'Weekly',
    pct: 100,
    reset,
    readings: [
      { t: now - 20 * M, pct: 95, reset },
      { t: now - 10 * M, pct: 97, reset },
      { t: now, pct: 100, reset },
    ],
  };
  writeFileSync(join(env.LIMITCAST_STATE, 'config.json'), '{"grokQuota":true}');
  writeFileSync(join(env.LIMITCAST_STATE, 'grok-quota.json'), JSON.stringify(quota));
  writeFileSync(
    join(env.LIMITCAST_STATE, 'guard.jsonl'),
    `${JSON.stringify({ t: now - 9 * M, src: 'grok', win: '7d', pct: 97, reset: reset * 1000, wall: now, operation: 'grok-spawn' })}\n`,
  );
  assert.match(run(env, 'status'), /grok 7d/);
  const out = join(env.LIMITCAST_STATE, 'dashboard.html');
  run(env, 'results', '--html', '--no-open', '--out', out);
  assert.match(readFileSync(out, 'utf8'), /grok 7d/);
  const results = run(env, 'results');
  assert.match(results, /grok.*7d|Grok.*7d/);
  assert.match(results, /1 subagent spawn/);
  writeFileSync(join(env.LIMITCAST_STATE, 'config.json'), '{"grokQuota":false}');
  assert.match(run(env, 'results'), /grok.*7d|Grok.*7d/);
  writeFileSync(join(env.LIMITCAST_STATE, 'config.json'), '{"grokQuota":true}');
  writeFileSync(join(env.LIMITCAST_STATE, 'grok-quota.json'), JSON.stringify({ ...quota, label: 'Monthly' }));
  assert.doesNotMatch(run(env, 'status'), /grok 7d/);
  assert.match(run(env, 'results'), /grok.*7d|Grok.*7d/);
});
