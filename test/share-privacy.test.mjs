import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { trimReport } from '../src/trim.mjs';

test('fallback sharing retains totals without file, skill, or server identities', () => {
  const c = {
    files: [{ what: 'private-file', path: '/private/project/notes.md', tokens: 400 }],
    skills: [{ name: 'private-skill', tokens: 200, hidden: false }],
    mcp: ['private-server'],
  };
  const used = { skills: new Set(), mcp: new Set() };
  const local = trimReport(null, c, used, 7);
  assert.match(local, /private-file|private-skill|private-server/);
  for (const base of [null, { median: 8000, max: 9000, sessions: 3 }]) {
    const shared = trimReport(base, c, used, 7, true);
    assert.doesNotMatch(shared, /private-file|private-skill|private-server|\/private\/|notes\.md/);
    assert.match(shared, /1 skills, 1 MCP servers/);
    assert.match(shared, /~200 tokens per session/);
  }
});

test('CLI sharing covers fallback, provider setup, missing setup, and rejects mutations', () => {
  const root = mkdtempSync(join(tmpdir(), 'lc-share-privacy-'));
  const env = {
    ...process.env,
    LIMITCAST_STATE: join(root, 'state'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    GROK_HOME: join(root, 'grok'),
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [bin, 'trim', ...args], { env, encoding: 'utf8' });
  for (const args of [[], ['--codex'], ['--grok']]) {
    const r = run(...args, '--share');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.includes(root), false);
    assert.match(r.stdout, /unavailable|Totals only/);
  }
  const exported = join(root, 'private-export.md');
  const exportResult = run('--share', '--out', exported);
  assert.equal(exportResult.status, 0);
  assert.equal(exportResult.stdout, 'Wrote shared summary.\n');
  assert.doesNotMatch(readFileSync(exported, 'utf8'), /private-export/);
  mkdirSync(env.LIMITCAST_STATE, { recursive: true });
  const keep = join(env.LIMITCAST_STATE, 'config.json');
  writeFileSync(keep, JSON.stringify({ trimKeep: ['private-server'] }));
  for (const home of [env.CODEX_HOME, env.GROK_HOME]) {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.toml'), '[mcp_servers.private-server]\ncommand = "unused"\n');
  }
  for (const provider of ['--codex', '--grok']) {
    const r = run(provider, '--share');
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /private-server|private-keep/);
    assert.match(r.stdout, /0 unused MCP servers, 1 kept/);
  }
  for (const args of [['--apply'], ['--undo'], ['keep', 'private-change'], ['--codex', '--apply'], ['--grok', '--undo']]) {
    const r = run(...args, '--share');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--share is read-only/);
  }
  assert.deepEqual(JSON.parse(readFileSync(keep, 'utf8')), { trimKeep: ['private-server'] });
});
