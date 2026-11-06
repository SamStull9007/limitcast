import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { APPLY_BLOCKED, applyBlocked, ensureDefaultKeep, getKeep, planTrim, setKeep } from '../src/apply.mjs';
import { codexTrimReport } from '../src/codex.mjs';
import { grokTrimReport } from '../src/grok.mjs';
import { measuredSavings } from '../src/trim.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const state = tmp('lc-keep-state-');
process.env.LIMITCAST_STATE = state;
process.env.CLAUDE_CONFIG_DIR = tmp('lc-keep-claude-');
process.env.CODEX_HOME = tmp('lc-keep-codex-');
process.env.GROK_HOME = tmp('lc-keep-grok-');
const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;

const base = {
  cwd: '/p',
  settings: {},
  claudeJson: { mcpServers: { 'ego-browser': {}, figma: {} } },
  plugins: { names: new Set(), servers: [] },
  projectMcpJson: [],
  localSkills: new Set(['dataviz']),
};

test('keep-list: a kept server or skill is never in disable or hide, under any spelling', () => {
  const plan = planTrim({ ...base, skills: ['dataviz', 'mine'], mcp: ['ego_browser', 'figma'], keep: ['ego-browser', 'dataviz'] });
  assert.deepEqual(plan.disable, ['figma']);
  assert.deepEqual(plan.hide, ['mine']);
  assert.deepEqual(plan.kept, ['dataviz', 'ego_browser']);
  assert.equal(planTrim({ ...base, skills: [], mcp: ['ego-browser'] }).disable.includes('ego-browser'), true); // no keep-list: unchanged
});

test('keep-list: the report counts kept items as kept, not as savings', () => {
  const pieces = [
    { group: 'MCP server instructions', name: 'ego-browser', chars: 4000 },
    { group: 'MCP server instructions', name: 'figma', chars: 4000 },
  ];
  const s = measuredSavings(pieces, { skills: new Set(), mcp: new Set() }, ['ego-browser']);
  assert.deepEqual(
    s.unusedMcp.map((m) => m.name),
    ['figma'],
  );
  assert.deepEqual(s.kept, ['ego-browser']);
  assert.equal(s.tokens, 1000);
});

test('keep-list: Codex and Grok reports leave kept servers out of what --apply turns off', () => {
  const servers = [
    { name: 'ego-browser', enabled: undefined },
    { name: 'figma', enabled: true },
  ];
  const r = { servers, used: new Set(), startup: null, days: 7, pro: true, keep: ['ego_browser'] };
  for (const out of [codexTrimReport(r), grokTrimReport(r)]) {
    assert.deepEqual(out.unused, ['figma']);
    assert.deepEqual(out.kept, ['ego-browser']);
    assert.match(out.text, /Would keep \(your keep-list\): ego-browser/);
  }
});

test('CLI: trim keep adds, lists and removes names, and the list persists', () => {
  const env = { ...process.env, LIMITCAST_STATE: tmp('lc-keep-cli-') };
  const run = (...a) =>
    spawnSync('node', [bin, 'trim', 'keep', ...a], { env })
      .stdout.toString()
      .trim();
  assert.match(run(), /Nothing on the keep-list/);
  assert.equal(run('ego-browser,figma'), 'Kept by `trim --apply`: ego-browser, figma');
  assert.equal(run('ego-browser'), 'Kept by `trim --apply`: ego-browser, figma'); // no duplicates
  assert.equal(run('--remove', 'figma'), 'Kept by `trim --apply`: ego-browser');
  assert.equal(run(), 'Kept by `trim --apply`: ego-browser');
});

test('keep-list: setKeep drops duplicates and getKeep reads them back', () => {
  setKeep(['a', 'a', 'b']);
  assert.deepEqual(getKeep(), ['a', 'b']);
});

test('keep-list: a missing list seeds ego-browser once; an explicit empty list stays empty', () => {
  const prev = process.env.LIMITCAST_STATE;
  const state = tmp('lc-keep-seed-');
  process.env.LIMITCAST_STATE = state;
  try {
    const first = ensureDefaultKeep();
    assert.equal(first.seeded, true);
    assert.deepEqual(first.keep, ['ego-browser']);
    assert.equal(ensureDefaultKeep().seeded, false);
    setKeep([]);
    assert.equal(ensureDefaultKeep().seeded, false);
    assert.deepEqual(getKeep(), []);
    assert.equal(applyBlocked(getKeep(), false), true);
    assert.equal(applyBlocked(getKeep(), true), false);
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});

test('measured savings: a server used in 30 days stays off the apply list', () => {
  const pieces = [
    { group: 'MCP server instructions', name: 'demo51-mcp', chars: 10000 },
    { group: 'MCP server instructions', name: 'node_repl', chars: 2000 },
  ];
  const s = measuredSavings(pieces, { skills: new Set(), mcp: new Set() }, [], { skills: new Set(), mcp: new Set(['demo51-mcp']) });
  assert.deepEqual(
    s.standingMcp.map((m) => m.name),
    ['demo51-mcp'],
  );
  assert.deepEqual(
    s.staleMcp.map((m) => m.name),
    ['node_repl'],
  );
  assert.equal(s.tokens, 500);
});

test('Codex trim: a server used in 30 days is not what --apply turns off', () => {
  const servers = [
    { name: 'demo51-mcp', enabled: true },
    { name: 'node_repl', enabled: true },
  ];
  const out = codexTrimReport({
    servers,
    used: new Set(),
    usedMonth: new Set(['demo51_mcp']),
    startup: null,
    days: 7,
    pro: true,
  });
  assert.deepEqual(out.standing, ['demo51-mcp']);
  assert.deepEqual(out.unused, ['node_repl']);
  assert.match(out.text, /leaves them on/);
  assert.match(out.text, /quiet for 30 days/);
});

test('CLI: trim --apply refuses an explicit empty keep-list and does not edit Codex', () => {
  const state = tmp('lc-keep-empty-');
  const codex = tmp('lc-keep-empty-codex-');
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(state, 'config.json'), JSON.stringify({ trimKeep: [] }));
  writeFileSync(join(codex, 'config.toml'), '[mcp_servers.node_repl]\ncommand = "x"\n');
  const env = { ...process.env, LIMITCAST_STATE: state, CODEX_HOME: codex, GROK_HOME: tmp('lc-keep-empty-grok-') };
  const blocked = spawnSync('node', [bin, 'trim', '--codex', '--apply'], { env, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stdout.trim(), APPLY_BLOCKED);
  assert.equal(readFileSync(join(codex, 'config.toml'), 'utf8').includes('enabled'), false);
});
