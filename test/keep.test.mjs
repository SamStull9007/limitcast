import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getKeep, planTrim, setKeep } from '../src/apply.mjs';
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
