import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { forecast } from '../src/forecast.mjs';
import { guardDecision, runGuard, spawnSource } from '../src/guard.mjs';
import { doctor, install, uninstall, wrappedCommand } from '../src/install.mjs';
import { checkLicense, issueLicense } from '../src/license.mjs';
import { burnReport } from '../src/report.mjs';
import { startupBreakdown } from '../src/startup.mjs';
import { baseline, contributors, measuredSavings, savings, skillListing, startupReport, trimReport } from '../src/trim.mjs';
import { claudeActivity, claudeUsage, codexUsage, grokUsage, readUsage, total } from '../src/usage.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
// Never touch the real ~/.claude, ~/.codex or ~/.grok: every default path resolves into a temp dir.
process.env.CLAUDE_CONFIG_DIR = tmp('lc-home-claude-');
process.env.CODEX_HOME = tmp('lc-home-codex-');
process.env.GROK_HOME = tmp('lc-home-grok-');
process.env.LIMITCAST_STATE = tmp('lc-home-state-');
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

test('trim measures savings from unused skills and MCP servers, honoring skillOverrides', () => {
  const home = tmp('lc-home-');
  const skill = (dir, fm) => {
    mkdirSync(join(home, '.claude', 'skills', dir), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', dir, 'SKILL.md'), `---\n${fm}\n---\n# body\n`);
  };
  skill('used-one', 'name: used-one\ndescription: Used often.');
  skill('stale', `name: stale\ndescription: "${'d'.repeat(392)}"`); // name + ': ' + 392 + 4 = 403 chars -> 101 tokens
  skill('folded', 'name: folded\ndescription: >\n  first line\n  second line');
  skill('hidden', 'name: hidden\ndescription: never listed');
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { hidden: 'user-invocable-only' } }));
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'x'.repeat(40_000));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'demo-mcp': {}, idle: {} } }));

  const c = contributors({ home, cwd: home });
  assert.deepEqual(c.files[0], { what: 'Global CLAUDE.md', tokens: 10_000, path: '~/.claude/CLAUDE.md' });
  assert.equal(c.skills.find((k) => k.name === 'hidden').tokens, 0);
  assert.equal(c.skills.find((k) => k.name === 'stale').tokens, 101);

  const used = { skills: new Set(['plugin:used-one', 'folded']), mcp: new Set(['demo_mcp']) };
  const s = savings(c, used);
  assert.deepEqual(
    s.unusedSkills.map((k) => k.name),
    ['stale'],
  );
  assert.equal(s.skillTokens, 101);
  assert.deepEqual(s.unusedMcp, ['idle']);

  const md = trimReport({ sessions: 3, median: 105_000, max: 120_000 }, c, used, 7);
  assert.match(md, /105\.0k tokens/);
  assert.match(md, /Measured savings: ~101 tokens per session \(0% of your fixed overhead\)/);
  assert.match(md, /Hide 1 skills you haven't used in 7 days/);
  assert.match(md, /Disable 1 MCP servers you haven't used in 7 days\*\*: idle/);
  assert.match(md, /Skill listing: 3 visible of 4 skills/);
});

test('skillListing reads plain, quoted and block-scalar descriptions', () => {
  assert.deepEqual(skillListing('---\nname: a\ndescription: plain text\n---', 'x'), { name: 'a', desc: 'plain text' });
  assert.deepEqual(skillListing("---\ndescription: 'quoted'\n---", 'fallback'), { name: 'fallback', desc: 'quoted' });
  assert.deepEqual(skillListing('---\nname: b\ndescription: |\n  one\n  two\nother: x\n---', 'x'), { name: 'b', desc: 'one two' });
  assert.deepEqual(skillListing('no frontmatter', 'z'), { name: 'z', desc: '' });
});

test('claudeActivity picks up Skill calls, slash commands and MCP servers', () => {
  const act = { skills: new Set(), mcp: new Set() };
  claudeActivity(
    JSON.stringify({
      message: {
        content: [
          { type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming' } },
          { type: 'tool_use', name: 'mcp__demo51-mcp__demo51_health', input: {} },
        ],
      },
    }),
    act,
  );
  claudeActivity(JSON.stringify({ type: 'user', message: { content: '<command-name>/forecast</command-name>' } }), act);
  assert.deepEqual([...act.skills].sort(), ['forecast', 'superpowers:brainstorming']);
  assert.deepEqual([...act.mcp], ['demo51-mcp']);
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
  // A Polar key has no end date for Lifetime or a subscription, so doctor must not call it lifetime.
  const polar = doctor({ path, samplesAgeMs: 0, license: { ok: true, claims: { e: 'b@x', p: 'polar', i: 0, x: 0 } } });
  assert.ok(polar.some((c) => c.line === 'Pro: b@x, last checked with Polar 1970-01-01'));
  const signed = doctor({ path, samplesAgeMs: 0, license: { ok: true, claims: { e: 'b@x', p: 'pro', i: 0, x: 0 } } });
  assert.ok(signed.some((c) => c.line === 'Pro: b@x, lifetime'));
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
  assert.match(execFileSync('node', [bin, 'help'], { env }).toString(), /limitcast license/);
});

test('CLI: free trim shows the measured totals without names, then the upgrade', () => {
  const claudeDir = tmp('lc-free-trim-');
  mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
  const att = (attachment) => JSON.stringify({ type: 'attachment', attachment });
  writeFileSync(
    join(claudeDir, 'projects', 'p', 'sess.jsonl'),
    [
      att({ type: 'skill_listing', content: '- secret-skill: Never used\n- other: Also unused' }),
      att({ type: 'mcp_instructions_delta', addedNames: ['private-mcp'], addedBlocks: ['p'.repeat(4000)] }),
      JSON.stringify({ type: 'assistant', entrypoint: 'cli', timestamp: new Date().toISOString(), message: { usage: {} } }),
    ].join('\n'),
  );
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, LIMITCAST_STATE: tmp('lc-free-state-') };
  delete env.LIMITCAST_LICENSE;
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const r = spawnSync('node', [bin, 'trim'], { env });
  const out = r.stdout.toString();
  assert.equal(r.status, 0, r.stderr.toString());
  assert.match(out, /before I type/);
  assert.match(out, /Pro names each item/);
  assert.doesNotMatch(out, /secret-skill|private-mcp/);
  // Without any session there is nothing to measure: say so, then the upgrade.
  const none = spawnSync('node', [bin, 'trim'], { env: { ...env, CLAUDE_CONFIG_DIR: tmp('lc-empty-') } });
  assert.equal(none.status, 2);
  assert.match(none.stdout.toString(), /needs one Claude Code session/);
});

// ---- Codex and Grok ----

test('spawn tools map to the tool whose limits they draw on', () => {
  assert.equal(spawnSource('Agent'), 'claude');
  assert.equal(spawnSource('Task'), 'claude');
  assert.equal(spawnSource('collaborationspawn_agent'), 'codex');
  assert.equal(spawnSource('spawn_agent'), 'codex');
  assert.equal(spawnSource('spawn_subagent'), 'grok');
  assert.equal(spawnSource('Bash'), null);
  assert.equal(spawnSource('wait_agent'), null);
});

test('guard judges each tool only by its own limits; Grok is never blocked', () => {
  const now = T0;
  const reset = now / 1000 + 7200;
  const mk = (src, minsAgo, pct) => ({ t: now - minsAgo * 60_000, src, win: '7d', pct, reset });
  const codexRisky = forecast([mk('codex', 60, 40), mk('codex', 0, 85)], now); // 20 min left
  const claudeOk = forecast([mk('claude', 60, 10), mk('claude', 0, 12)], now);
  assert.match(guardDecision('collaborationspawn_agent', [codexRisky, claudeOk], now, 30), /^limitcast: Codex 7d/);
  assert.equal(guardDecision('Agent', [codexRisky, claudeOk], now, 30), null); // Claude spawn, Codex at risk: allowed
  assert.equal(guardDecision('spawn_subagent', [codexRisky], now, 30), null);
});

// Grok's usage.json: one entry per turn with that turn's own tokens (inputTokens includes cached reads).
const grokTurn = (endedAt, inputTokens, cachedReadTokens, outputTokens) => ({
  turnNumber: 1,
  endedAt,
  inputTokens,
  cachedReadTokens,
  cacheCreationTokens: 0,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  primaryModelId: 'grok-4.6-build',
});

test('grok usage: one record per turn from the usage.json ledger, never summed across turns', () => {
  const ledger = { turns: [grokTurn(iso(0), 1000, 600, 50), grokTurn(iso(5), 300, 100, 20), { endedAt: 'bad' }] };
  const u = grokUsage(ledger, 's1', '/p/g');
  assert.deepEqual(
    u.map((x) => [x.src, x.input, x.cacheRead, x.output, x.model, x.t]),
    [
      ['grok', 400, 600, 50, 'grok-4.6-build', T0],
      ['grok', 200, 100, 20, 'grok-4.6-build', T0 + 5 * 60_000],
    ],
  );
  assert.equal(
    u.reduce((a, x) => a + total(x), 0),
    1050 + 320,
  ); // equals the turns' totalTokens
  assert.deepEqual(grokUsage({}, 's', 'p'), []);
});

test('readUsage finds Grok ledgers and decodes the project folder; skips a ledger mid-write', async () => {
  const grok = tmp('lc-grok-');
  const dir = join(grok, encodeURIComponent('/Users/me/proj'), '01abc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'usage.json'), JSON.stringify({ sessionId: '01abc', turns: [grokTurn(iso(0), 10, 0, 5)] }));
  const torn = join(grok, encodeURIComponent('/Users/me/other'), '01def');
  mkdirSync(torn, { recursive: true });
  writeFileSync(join(torn, 'usage.json'), '{"turns": [');
  const u = await readUsage(0, { claude: tmp('e1-'), codex: tmp('e2-'), grok });
  assert.deepEqual(
    u.map((x) => [x.src, x.project, x.session]),
    [['grok', '/Users/me/proj', '01abc']],
  );
});

test('install appends the Codex guard last so trusted hooks keep their positions; re-install stays put; uninstall removes it', () => {
  const codexHome = tmp('lc-codex-inst-');
  const codexPath = join(codexHome, 'hooks.json');
  const path = join(tmp('lc-claude-inst-'), 'settings.json');
  const h0 = { matcher: '', hooks: [{ type: 'command', command: 'python3 router.py' }] };
  const h1 = { matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: 'deja' }] };
  writeFileSync(codexPath, JSON.stringify({ hooks: { PreToolUse: [h0, h1], Stop: [h0] } }));
  install({ guard: true, path, codexPath, self: '/n /lc/limitcast.mjs' });
  let codex = JSON.parse(readFileSync(codexPath, 'utf8'));
  assert.deepEqual(codex.hooks.PreToolUse.slice(0, 2), [h0, h1]);
  assert.deepEqual(codex.hooks.PreToolUse[2], {
    matcher: '.*spawn_agent.*',
    hooks: [{ type: 'command', command: '/n /lc/limitcast.mjs guard', timeout: 10 }],
  });
  assert.deepEqual(codex.hooks.Stop, [h0]);

  // A later hook added by the user stays after ours; re-install updates ours in place.
  codex.hooks.PreToolUse.push({ matcher: 'x', hooks: [{ type: 'command', command: 'later' }] });
  writeFileSync(codexPath, JSON.stringify(codex));
  install({ guard: true, path, codexPath, self: '/n2 /lc/limitcast.mjs' });
  codex = JSON.parse(readFileSync(codexPath, 'utf8'));
  assert.equal(codex.hooks.PreToolUse.length, 4);
  assert.equal(codex.hooks.PreToolUse[2].hooks[0].command, '/n2 /lc/limitcast.mjs guard');

  // Trust check reads Codex's config.toml for the guard's position.
  assert.ok(doctor({ path, codexPath, samplesAgeMs: 0, license: null }).some((c) => /not trusted yet/.test(c.line)));
  writeFileSync(join(codexHome, 'config.toml'), `[hooks.state."${codexPath}:pre_tool_use:2:0"]\ntrusted_hash = "sha256:x"\n`);
  assert.ok(doctor({ path, codexPath, samplesAgeMs: 0, license: null }).some((c) => /installed and trusted/.test(c.line)));

  uninstall({ path, codexPath });
  codex = JSON.parse(readFileSync(codexPath, 'utf8'));
  assert.equal(
    codex.hooks.PreToolUse.some((h) => h.hooks[0].command.includes('limitcast.mjs guard')),
    false,
  );
  assert.equal(codex.hooks.PreToolUse.length, 3);
});

test('install skips Codex when it is not installed', () => {
  const path = join(tmp('lc-claude-only-'), 'settings.json');
  const codexPath = join(tmp('lc-parent-'), 'no-codex', 'hooks.json');
  const changes = install({ guard: true, path, codexPath, self: '/n /lc/limitcast.mjs' });
  assert.equal(
    changes.some((c) => /Codex/.test(c)),
    false,
  );
});

test('guard hook: blocks a Codex spawn on pace to run out, allows Grok, reads camelCase input; CLI needs Pro', async () => {
  const codexHome = tmp('lc-cli-codex-');
  const day = join(codexHome, 'sessions', '2026', '10', '24');
  mkdirSync(day, { recursive: true });
  const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
  const ev = (minsAgo, pct) =>
    JSON.stringify({
      timestamp: new Date(Date.now() - minsAgo * 60_000).toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: reset }, secondary: null } },
    });
  writeFileSync(join(day, 'rollout-x.jsonl'), [ev(40, 50), ev(0, 90)].join('\n')); // +60%/h, 10% left: ~10 min
  const prevCodex = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const now = Date.now();
    assert.match(await runGuard({ tool_name: 'collaborationspawn_agent', session_id: 'c1' }, now, 30), /^limitcast: Codex 5h/);
    assert.equal(await runGuard({ hookEventName: 'pre_tool_use', toolName: 'spawn_subagent', sessionId: 'g1' }, now, 30), null);
    assert.equal(await runGuard({ tool_name: 'Agent', session_id: 'x' }, now, 30), null); // Claude has no readings here
  } finally {
    process.env.CODEX_HOME = prevCodex;
  }
  // Without a license the CLI hook allows the same at-risk Codex spawn.
  const env = { ...process.env, CODEX_HOME: codexHome, LIMITCAST_STATE: tmp('lc-cli-st-') };
  delete env.LIMITCAST_LICENSE;
  const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
  assert.equal(execFileSync('node', [bin, 'guard'], { input: JSON.stringify({ tool_name: 'collaborationspawn_agent' }), env }).toString(), '');
});

test('install --guard without Pro installs only the free features', () => {
  const claudeDir = tmp('lc-free-claude-');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: tmp('lc-free-codex-'), LIMITCAST_STATE: tmp('lc-free-st-') };
  delete env.LIMITCAST_LICENSE;
  const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
  const out = execFileSync('node', [bin, 'install', '--guard'], { env }).toString();
  assert.match(out, /part of limitcast Pro/);
  const cfg = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.match(cfg.statusLine.command, /limitcast\.mjs statusline$/);
  assert.equal(cfg.hooks?.PreToolUse, undefined);
});

test('startup breakdown: measures hooks, MCP, tool names, agents, skills and files from transcript attachments', async () => {
  const dir = tmp('lc-startup-');
  const file = join(dir, 'sess.jsonl');
  const att = (attachment) => JSON.stringify({ type: 'attachment', attachment });
  writeFileSync(
    file,
    [
      att({
        type: 'hook_success',
        hookEvent: 'SessionStart',
        command: 'sed x ${CLAUDE_PLUGIN_ROOT}/hooks/session-architecture.md',
        content: 'a'.repeat(400),
      }),
      att({
        type: 'hook_success',
        hookEvent: 'SessionStart',
        command: 'python3 router.py',
        content: '',
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 'b'.repeat(80) } }),
      }),
      att({ type: 'hook_success', hookEvent: 'UserPromptSubmit', command: 'x.sh', content: 'ignored' }),
      att({ type: 'mcp_instructions_delta', addedNames: ['claude.ai Postman', 'attention'], addedBlocks: ['p'.repeat(40), 'q'.repeat(100)] }),
      att({ type: 'deferred_tools_delta', addedNames: ['Read', 'mcp__claude_ai_Postman__get'], addedLines: ['Read', 'mcp__claude_ai_Postman__get'] }),
      att({ type: 'agent_listing_delta', addedLines: ['- a: one', '- b: two'] }),
      att({ type: 'skill_listing', content: '- hookify:configure: Enable rules\n- dataviz: Charts\n  more text' }),
      att({ type: 'instructions', files: [{ path: '/Users/me/CLAUDE.md', content: 'c'.repeat(200) }] }),
      JSON.stringify({ type: 'assistant', entrypoint: 'cli', timestamp: iso(0), message: { usage: {} } }),
      att({ type: 'hook_success', hookEvent: 'SessionStart', command: 'late.sh', content: 'after first reply: not startup' }),
    ].join('\n'),
  );
  const b = await startupBreakdown(file);
  assert.equal(b.entry, 'cli');
  const by = (g) => b.pieces.filter((p) => p.group === g).map((p) => [p.name, p.chars]);
  assert.deepEqual(by('SessionStart hooks'), [
    ['session-architecture.md', 400],
    ['router.py', 80],
  ]);
  assert.deepEqual(by('MCP server instructions'), [
    ['claude.ai Postman', 40],
    ['attention', 100],
  ]);
  assert.deepEqual(by('Tool names'), [
    ['(built-in)', 5],
    ['claude_ai_Postman', 28],
  ]);
  assert.deepEqual(
    by('Skill listing').map((x) => x[0]),
    ['hookify:configure', 'dataviz'],
  );
  assert.deepEqual(by('Instruction files'), [['/Users/me/CLAUDE.md', 200]]);

  // Postman is unused: its instructions (40) and tool names (28) merge into one entry; attention was used.
  const s = measuredSavings(b.pieces, { skills: new Set(['dataviz']), mcp: new Set(['attention']) });
  assert.deepEqual(s.unusedMcp, [{ name: 'claude.ai Postman', chars: 68 }]);
  assert.deepEqual(
    s.unusedSkills.map((k) => k.name),
    ['hookify:configure'],
  );
  const md = startupReport({ sessions: 1, median: 1000, max: 1000 }, b, { skills: new Set(['dataviz']), mcp: new Set(['attention']) }, 7);
  assert.match(md, /Disable 1 MCP servers/);
  assert.match(md, /SessionStart hooks inject/);
});
