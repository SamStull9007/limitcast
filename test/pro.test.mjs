import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { claudeUsage, codexUsage, readUsage, total } from '../src/usage.mjs';
import { burnReport } from '../src/report.mjs';
import { baseline, contributors, trimReport } from '../src/trim.mjs';
import { checkLicense, issueLicense } from '../src/license.mjs';
import { doctor, install, uninstall, wrappedCommand } from '../src/install.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const T0 = Date.parse('2026-10-24T12:00:00.000Z');
const iso = (mins) => new Date(T0 + mins * 60_000).toISOString();

const claudeLine = ({ id = 'm1', req = 'r1', mins = 0, side = false, cw = 100, cr = 0, inp = 2, out = 10, cwd = '/p/a' } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(mins),
    requestId: req,
    isSidechain: side,
    cwd,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: { input_tokens: inp, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out },
    },
  });
const codexTok = (mins, input, cached, output) =>
  JSON.stringify({
    timestamp: iso(mins),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
  });

test('claude usage counts each message once despite repeated content blocks', () => {
  const seen = new Set();
  const a = claudeUsage(claudeLine(), seen, 's');
  assert.equal(total(a), 112);
  assert.equal(claudeUsage(claudeLine(), seen, 's'), null);
  assert.ok(claudeUsage(claudeLine({ id: 'm2', req: 'r2' }), seen, 's'));
  assert.equal(claudeUsage('{"type":"user","message":{}}', seen, 's'), null);
  assert.equal(claudeUsage('not json "usage"', seen, 's'), null);
});

test('codex usage turns running totals into increases and splits cached input', () => {
  const st = { prev: null, cwd: '', model: '' };
  codexUsage(JSON.stringify({ timestamp: iso(0), type: 'session_meta', payload: { cwd: '/p/c' } }), st, 's');
  const a = codexUsage(codexTok(1, 1000, 800, 50), st, 's');
  assert.deepEqual([a.input, a.cacheRead, a.output, a.project], [200, 800, 50, '/p/c']);
  assert.equal(codexUsage(codexTok(2, 1000, 800, 50), st, 's'), null); // repeated total: no new usage
  const b = codexUsage(codexTok(3, 1500, 1200, 80), st, 's');
  assert.deepEqual([b.input, b.cacheRead, b.output], [100, 400, 30]);
});

test('readUsage reads both tools and respects the time window', async () => {
  const claude = tmp('lc-cl-');
  const codex = tmp('lc-cx-');
  mkdirSync(join(claude, 'proj'));
  writeFileSync(join(claude, 'proj', 'sess1.jsonl'), [claudeLine(), claudeLine(), claudeLine({ id: 'old', req: 'x', mins: -600 })].join('\n'));
  mkdirSync(join(codex, '2026', '10', '24'), { recursive: true });
  writeFileSync(join(codex, '2026', '10', '24', 'rollout-x.jsonl'), [codexTok(1, 100, 0, 10)].join('\n'));
  const u = await readUsage(T0 - 60 * 60_000, { claude, codex });
  assert.deepEqual(u.map((x) => x.src).sort(), ['claude', 'codex']);
});

test('burn report has totals, subagent share and sections', () => {
  const seen = new Set();
  const usage = [
    claudeUsage(claudeLine({ id: 'a', cw: 900 }), seen, 'sess-main'),
    claudeUsage(claudeLine({ id: 'b', side: true, cw: 100 }), seen, 'sess-main'),
  ];
  const md = burnReport(usage, { since: T0 - 86400_000, now: T0 });
  assert.match(md, /# limitcast burn report/);
  assert.match(md, /Subagents used \*\*11%\*\*/); // 112 of 1,024 tokens
  assert.match(md, /## Top projects/);
  assert.match(burnReport([], { since: T0, now: T0 }), /No Claude Code or Codex usage/);
});

test('baseline is the median first-response context of main sessions only', () => {
  const mk = (session, mins, cw, side = false) => ({
    t: T0 + mins * 60_000,
    src: 'claude',
    session,
    project: '',
    model: '',
    sidechain: side,
    input: 0,
    cacheWrite: cw,
    cacheRead: 0,
    output: 0,
  });
  const b = baseline([mk('a', 0, 100), mk('a', 5, 999), mk('b', 0, 300), mk('c', 0, 200), mk('d', 0, 5000, true)]);
  assert.deepEqual(b, { sessions: 3, median: 200, max: 300 }); // no session has 5+ responses: use all
  // One interactive session (5 responses) outweighs two one-shot scripts.
  const chatty = [0, 1, 2, 3, 4].map((m) => mk('chat', m, m === 0 ? 100_000 : 1));
  assert.deepEqual(baseline([...chatty, mk('p1', 0, 16_000), mk('p2', 0, 16_000)]), { sessions: 1, median: 100_000, max: 100_000 });
  // Where the launch mode is recorded, a CLI session counts even if short; SDK runs never do.
  const cli = { ...mk('cli1', 0, 98_000), entry: 'cli' };
  const sdk = [0, 1, 2, 3, 4, 5].map((m) => ({ ...mk('sdk1', m, 12_000), entry: 'sdk-py' }));
  assert.deepEqual(baseline([cli, ...sdk]), { sessions: 1, median: 98_000, max: 98_000 });
  assert.equal(baseline([]), null);
});

test('trim lists what loads every session, largest first, with fixes', () => {
  const home = tmp('lc-home-');
  mkdirSync(join(home, '.claude', 'skills', 'one'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'x'.repeat(40_000));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: {}, b: {} } }));
  const parts = contributors({ home, cwd: home });
  assert.equal(parts[0].what, 'Global CLAUDE.md');
  assert.equal(parts[0].tokens, 10_000);
  const md = trimReport({ sessions: 3, median: 105_000, max: 120_000 }, parts);
  assert.match(md, /105\.0k tokens/);
  assert.match(md, /2 MCP servers/);
  assert.match(md, /1 skills/);
});

test('license: valid, tampered, expired, wrong format', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const now = Date.now();
  const key = issueLicense({ e: 'a@b.co', p: 'pro', i: 1, x: 0 }, pem);
  assert.deepEqual(checkLicense(key, now, pub), { ok: true, claims: { e: 'a@b.co', p: 'pro', i: 1, x: 0 } });
  const [p, , sig] = key.split('.');
  const forged = `${p}.${Buffer.from(JSON.stringify({ e: 'x@y.z', p: 'pro', i: 1, x: 0 })).toString('base64url')}.${sig}`;
  assert.equal(checkLicense(forged, now, pub).ok, false);
  const expired = issueLicense({ e: 'a@b.co', p: 'pro', i: 1, x: 1000 }, pem);
  assert.match(checkLicense(expired, now, pub).reason, /expired/);
  assert.equal(checkLicense('hello', now, pub).ok, false);
  // A key signed by someone else's key never validates against the shipped public key.
  assert.equal(checkLicense(key, now).ok, false);
});

test('install wraps the status line, adds the guard once, keeps other hooks; uninstall restores', () => {
  const dir = tmp('lc-set-');
  const path = join(dir, 'settings.json');
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
  writeFileSync(
    path,
    JSON.stringify({
      model: 'opus',
      statusLine: { type: 'command', command: 'bash ~/my status.sh | cut -c1-80', padding: 1 },
      hooks: { PreToolUse: [other] },
    }),
  );
  const self = "'/opt/node' /x/limitcast.mjs";
  install({ guard: true, path, self });
  install({ guard: true, path, self }); // idempotent
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(cfg.model, 'opus');
  assert.equal(cfg.statusLine.padding, 1);
  assert.equal(cfg.statusLine.command, `${self} statusline -- sh -c 'bash ~/my status.sh | cut -c1-80'`);
  assert.equal(cfg.hooks.PreToolUse.length, 2);
  assert.deepEqual(cfg.hooks.PreToolUse[0], other);
  assert.ok(readdirSync(dir).some((f) => f.includes('limitcast-backup')));

  uninstall({ path });
  const back = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(back.statusLine.command, 'bash ~/my status.sh | cut -c1-80');
  assert.deepEqual(back.hooks.PreToolUse, [other]);
});

test('wrappedCommand recovers hand-written and quoted wraps; install refuses broken JSON', () => {
  assert.equal(wrappedCommand('/n /x statusline -- bash /a/s.sh'), 'bash /a/s.sh');
  assert.equal(wrappedCommand(`/n /x statusline -- sh -c 'it'\\''s'`), "it's");
  assert.equal(wrappedCommand('/n /x statusline'), null);
  const path = join(tmp('lc-bad-'), 'settings.json');
  writeFileSync(path, '{ broken');
  assert.throws(() => install({ guard: false, path, self: 'x' }), /not valid JSON/);
  assert.equal(readFileSync(path, 'utf8'), '{ broken');
});

test('doctor reports missing setup and stale data', () => {
  const path = join(tmp('lc-doc-'), 'settings.json');
  writeFileSync(path, '{}');
  const checks = doctor({ path, samplesAgeMs: null, license: null });
  assert.ok(checks.some((c) => !c.ok && /recorder missing/.test(c.line)));
  assert.ok(checks.some((c) => /Free tier/.test(c.line)));
});

test('CLI: Pro commands are gated; version and help work', () => {
  const env = { ...process.env, LIMITCAST_STATE: tmp('lc-cli-'), LIMITCAST_LICENSE: '' };
  delete env.LIMITCAST_LICENSE;
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const r = spawnSync('node', [bin, 'report'], { env });
  assert.equal(r.status, 2);
  assert.match(r.stdout.toString(), /limitcast Pro/);
  assert.match(execFileSync('node', [bin, '--version'], { env }).toString(), /^\d+\.\d+\.\d+/);
  assert.match(execFileSync('node', [bin, 'help'], { env }).toString(), /limitcast install/);
  const bad = spawnSync('node', [bin, 'activate', 'LC1.bad.key'], { env });
  assert.equal(bad.status, 1);
});
