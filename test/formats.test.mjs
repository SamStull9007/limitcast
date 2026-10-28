// Log-format contract tests: fixtures mirror the field names Claude Code, Codex and Grok write (October 2026).
// If one of those tools changes its format, update the fixture from a real log and these tests show what broke.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatChecks } from '../src/formats.mjs';
import { install, uninstall } from '../src/install.mjs';
import { drift, driftMessage, recordOverhead, savedSummary, snapshot } from '../src/overhead.mjs';
import { claudeSamples, readCodex } from '../src/sources.mjs';
import { countInteractiveSince, latestInteractiveTranscript } from '../src/startup.mjs';
import { shareSummary } from '../src/trim.mjs';
import { readUsage } from '../src/usage.mjs';

const FX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
process.env.LIMITCAST_STATE = tmp('lc-fmt-state-');
process.env.CLAUDE_CONFIG_DIR = join(FX, 'claude-config-unused');
process.env.GROK_HOME = tmp('lc-fmt-grok-'); // install() wraps Grok when ~/.grok exists; formatChecks overrides this
const roots = { claude: join(FX, 'claude'), codex: join(FX, 'codex', 'sessions'), grok: join(FX, 'grok', 'sessions') };

test('contract: usage from all three tools', async () => {
  const act = { skills: new Set(), mcp: new Set() };
  const u = await readUsage(0, roots, act);
  const by = Object.fromEntries(u.map((x) => [x.src, x]));
  assert.deepEqual([by.claude.cacheWrite, by.claude.output, by.claude.entry, by.claude.project], [98000, 300, 'cli', '/Users/me/proj']);
  assert.deepEqual([by.codex.input, by.codex.cacheRead, by.codex.output, by.codex.session], [200, 800, 50, '01a16e34-0ef5-7b10-a2f6-1431b6891767']);
  assert.deepEqual([by.grok.input, by.grok.cacheRead, by.grok.output, by.grok.project], [1000, 4000, 300, '/Users/me/proj']);
  assert.deepEqual([...act.skills], ['dataviz']);
});

test('contract: limit readings from the Claude status-line feed and Codex logs', async () => {
  const feed = JSON.parse(readFileSync(join(FX, 'claude-statusline.json'), 'utf8'));
  assert.deepEqual(
    claudeSamples(feed, 1).map((s) => [s.win, s.pct, s.sid]),
    [
      ['5h', 42, '0a1b2c3d'],
      ['7d', 63, '0a1b2c3d'],
    ],
  );
  const codex = await readCodex(0, join(FX, 'codex', 'sessions'));
  assert.deepEqual(
    codex.map((s) => [s.win, s.pct]),
    [['7d', 10]],
  );
});

test('contract: starting-context breakdown from a Claude transcript', async () => {
  const b = await latestInteractiveTranscript(roots.claude);
  const groups = [...new Set(b.pieces.map((p) => p.group))].sort();
  assert.deepEqual(groups, ['Agent list', 'Instruction files', 'MCP server instructions', 'SessionStart hooks', 'Skill listing', 'Tool names']);
  assert.equal(await countInteractiveSince(roots.claude, 0), 1);
});

test('format checks pass on current formats and flag a changed one', async () => {
  const prev = { ...process.env };
  const claudeHome = tmp('lc-fmt-claude-');
  mkdirSync(join(claudeHome, 'projects', 'p'), { recursive: true });
  copyFileSync(join(FX, 'claude', 'proj', '0a1b2c3d-sess.jsonl'), join(claudeHome, 'projects', 'p', 's.jsonl'));
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: join(FX, 'codex'), GROK_HOME: join(FX, 'grok') });
  writeFileSync(join(process.env.LIMITCAST_STATE, 'last-feed.json'), JSON.stringify({ at: 1, rate_limits: { five_hour: { used_percentage: 5 } } }));
  try {
    const ok = await formatChecks();
    assert.equal(ok.length, 4);
    assert.ok(
      ok.every((c) => c.ok),
      JSON.stringify(ok),
    );
    // A future Claude Code that renames `usage` must be reported, not silently read as zero.
    writeFileSync(
      join(claudeHome, 'projects', 'p', 's.jsonl'),
      JSON.stringify({ type: 'assistant', message: { tokenUsage: { out: 1 } }, usage: 'x' }),
    );
    writeFileSync(join(process.env.LIMITCAST_STATE, 'last-feed.json'), JSON.stringify({ at: 1, rate_limits: { five_hour: { used_percentage: 'unknown' } } }));
    const bad = await formatChecks();
    assert.ok(bad.some((c) => !c.ok && /transcript has no readable usage/.test(c.line)));
    assert.ok(bad.some((c) => !c.ok && /status-line feed has unreadable rate_limits/.test(c.line)));
  } finally {
    for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME']) process.env[k] = prev[k];
  }
});

test('format checks allow optional limits and transcripts awaiting their first response', async () => {
  const prev = { ...process.env };
  const claudeHome = tmp('lc-fmt-pending-');
  const state = tmp('lc-fmt-pending-state-');
  mkdirSync(join(claudeHome, 'projects', 'p'), { recursive: true });
  const transcript = join(claudeHome, 'projects', 'p', 's.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'ai-title', title: 'New session' }));
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: claudeHome, LIMITCAST_STATE: state });
  try {
    for (const rate_limits of [undefined, null, {}, { spend_limit: { used_percentage: 5 } }]) {
      writeFileSync(join(state, 'last-feed.json'), JSON.stringify({ at: 1, keys: ['session_id'], rate_limits }));
      const checks = await formatChecks();
      assert.ok(checks.find((c) => /no subscription limit readings available/.test(c.line))?.ok);
      assert.ok(checks.find((c) => /no assistant usage yet/.test(c.line))?.ok);
    }
    writeFileSync(join(state, 'last-feed.json'), '{broken');
    assert.ok((await formatChecks()).some((c) => !c.ok && /status-line feed/.test(c.line)));
    writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { tokenUsage: { out: 1 } } }));
    assert.ok((await formatChecks()).some((c) => !c.ok && /transcript has no readable usage/.test(c.line)));
  } finally {
    for (const k of ['CLAUDE_CONFIG_DIR', 'LIMITCAST_STATE']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

test('overhead: drift names what grew, ignores noise, and saved counts the drop', () => {
  const a = { at: 1, chars: 100_000, items: { 'SessionStart hooks|x.sh': 4000, 'Skill listing|dataviz': 400 } };
  const b = {
    at: 2,
    chars: 110_400,
    items: { 'SessionStart hooks|x.sh': 4000, 'Skill listing|dataviz': 400, 'MCP server instructions|new-mcp': 10_400 },
  };
  const d = drift(a, b);
  assert.equal(d.alert, true);
  assert.deepEqual(
    d.grew.map((g) => [g.key, g.isNew]),
    [['MCP server instructions|new-mcp', true]],
  );
  assert.match(driftMessage(d), /grew ~2\.6k tokens.*new-mcp new/);
  assert.equal(drift(a, { ...a, at: 3, chars: 101_000 }).alert, false); // +250 tokens: not worth an alert

  assert.match(savedSummary({ first: b, last: a }, 40), /2\.6k less per session.*Across 40 interactive sessions that's ~104\.0k tokens/s);
  assert.match(savedSummary({ first: a, last: b }, 40), /\+2\.6k/);
});

test('overhead: recordOverhead keeps the first snapshot and ignores the same session twice', () => {
  process.env.LIMITCAST_STATE = tmp('lc-fmt-oh-');
  const s1 = snapshot({ at: 10, pieces: [{ group: 'Instruction files', name: 'a', chars: 8000 }] });
  assert.equal(recordOverhead(s1), null);
  assert.equal(recordOverhead(s1).alert, false);
  const s2 = snapshot({ at: 20, pieces: [{ group: 'Instruction files', name: 'a', chars: 16000 }] });
  assert.equal(recordOverhead(s2).alert, true);
});

test('share summary has totals only: no file, skill, server or hook names', async () => {
  const b = await latestInteractiveTranscript(roots.claude);
  const text = shareSummary({ sessions: 1, median: 98_002, max: 98_002 }, b, { skills: new Set(['dataviz']), mcp: new Set() }, 7);
  assert.match(text, /start at 98\.0k tokens/);
  assert.match(text, /1 MCP servers, 1 skills/);
  for (const secret of ['context7', 'block-kit', 'dataviz', 'session-start-hook', 'CLAUDE.md', '/Users/me'])
    assert.equal(text.includes(secret), false, secret);
});

test('install --alerts adds one SessionStart hook; uninstall removes only it', () => {
  const path = join(tmp('lc-alert-'), 'settings.json');
  const mine = { matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] };
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [mine] } }));
  const opts = { guard: false, alerts: true, path, codexPath: join(tmp('lc-nocodex-'), 'x', 'hooks.json'), self: '/n /x/limitcast.mjs' };
  install(opts);
  install(opts);
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(cfg.hooks.SessionStart.length, 2);
  assert.equal(cfg.hooks.SessionStart[1].hooks[0].command, '/n /x/limitcast.mjs drift --hook');
  uninstall({ path, codexPath: opts.codexPath });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).hooks.SessionStart, [mine]);
});

test('CLI: drift and saved are free; empty drift hooks stay silent', () => {
  const env = { ...process.env, LIMITCAST_STATE: tmp('lc-cli-drift-'), CLAUDE_CONFIG_DIR: tmp('lc-cli-cc-') };
  delete env.LIMITCAST_LICENSE;
  const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
  assert.equal(execFileSync('node', [bin, 'drift', '--hook'], { env }).toString(), '');
  assert.match(execFileSync('node', [bin, 'drift'], { env }).toString(), /No interactive Claude Code session/);
  assert.match(execFileSync('node', [bin, 'saved'], { env }).toString(), /Nothing measured yet/);
});
