import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyTrim, installedPlugins, planTrim, reapplyTrim, stillLoading, transcriptCwd, undoTrim } from '../src/apply.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('re-apply: a rewrite that drops every cut puts them back; one turned back on by you stays on', () => {
  const dir = tmp('lc-reapply-');
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = join(dir, 'state');
  try {
    const settings = join(dir, 'settings.json');
    const claudeJson = join(dir, 'claude.json');
    writeFileSync(settings, '{}');
    writeFileSync(claudeJson, JSON.stringify({ projects: { '/p': {} } }));
    applyTrim({ hide: ['a', 'b'], pluginSkills: [], disable: ['x', 'y'], manualMcp: [] }, { cwd: '/p', now: 1, settings, claudeJson });
    assert.deepEqual(reapplyTrim({ settings, claudeJson }), { reapplied: [], released: [] }); // nothing changed
    // Claude Code rewrites ~/.claude.json from memory: both servers gone at once.
    writeFileSync(claudeJson, JSON.stringify({ projects: { '/p': { disabledMcpServers: ['mine'] } } }));
    assert.deepEqual(reapplyTrim({ settings, claudeJson }).reapplied, ['x', 'y']);
    assert.deepEqual(JSON.parse(readFileSync(claudeJson, 'utf8')).projects['/p'].disabledMcpServers, ['mine', 'x', 'y']);
    // You turn one skill back on in /skills: limitcast lets it be, and forgets it.
    const s = JSON.parse(readFileSync(settings, 'utf8'));
    delete s.skillOverrides.a;
    writeFileSync(settings, JSON.stringify(s));
    assert.deepEqual(reapplyTrim({ settings, claudeJson }), { reapplied: [], released: ['a'] });
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).skillOverrides.a, undefined);
    assert.deepEqual(reapplyTrim({ settings, claudeJson }), { reapplied: [], released: [] });
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});
const plugins = { names: new Set(['slack']), servers: ['plugin:greptile:greptile'] };

test('plan: standalone skills are hidden, plugin skills listed; MCP names must be exact', () => {
  const plan = planTrim({
    skills: ['dataviz', 'slack:block-kit', 'kept-off', 'my:nested', 'unlisted-plugin:skill'],
    mcp: ['claude_ai_Figma', 'claude.ai Postman', 'younium', 'plugin_greptile_greptile', 'claude_ai_Mystery', 'fs', 'already'],
    cwd: '/p',
    settings: { skillOverrides: { 'kept-off': 'off' } },
    claudeJson: {
      mcpServers: { younium: {} },
      projects: { '/other': { disabledMcpServers: ['claude.ai Figma'] }, '/p': { disabledMcpServers: ['already'] } },
    },
    plugins,
    projectMcpJson: ['fs'],
    localSkills: new Set(['my', 'dataviz']),
  });
  assert.deepEqual(plan.hide, ['dataviz', 'my:nested']); // the user's own "off" is left alone
  // A namespace that isn't one of your skill folders is a plugin, even one installed_plugins.json doesn't list.
  assert.deepEqual(plan.pluginSkills, ['slack:block-kit', 'unlisted-plugin:skill']);
  // Figma's exact name comes from another project's /mcp toggle; Postman's spelling is already exact.
  assert.deepEqual(plan.disable, ['claude.ai Figma', 'claude.ai Postman', 'younium', 'plugin:greptile:greptile']);
  assert.deepEqual(plan.manualMcp, ['claude_ai_Mystery', 'fs']); // unknown spelling; .mcp.json server
});

test('apply backs up, writes, and undo restores exactly what it changed', () => {
  const dir = tmp('lc-apply-');
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = join(dir, 'state');
  try {
    const settings = join(dir, 'settings.json');
    const claudeJson = join(dir, 'claude.json');
    writeFileSync(settings, JSON.stringify({ theme: 'dark', skillOverrides: { dataviz: 'on', other: 'off' } }));
    writeFileSync(claudeJson, JSON.stringify({ numStartups: 5, projects: { '/p': { disabledMcpServers: ['mine'] } } }), { mode: 0o600 });
    const plan = { hide: ['dataviz', 'deploy'], pluginSkills: [], disable: ['claude.ai Figma'], manualMcp: [] };
    const e = applyTrim(plan, { cwd: '/p', now: 1000, settings, claudeJson });
    assert.deepEqual(e.mcp, ['claude.ai Figma']);
    const s1 = JSON.parse(readFileSync(settings, 'utf8'));
    assert.deepEqual(s1.skillOverrides, { dataviz: 'user-invocable-only', other: 'off', deploy: 'user-invocable-only' });
    assert.equal(s1.theme, 'dark');
    const c1 = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.deepEqual(c1.projects['/p'].disabledMcpServers, ['mine', 'claude.ai Figma']);
    assert.equal(c1.numStartups, 5);
    assert.equal(statSync(claudeJson).mode & 0o777, 0o600); // credentials file stays owner-only

    // The user changes something after applying; undo leaves it alone.
    s1.skillOverrides.deploy = 'off';
    writeFileSync(settings, JSON.stringify(s1));
    undoTrim({ settings, claudeJson });
    assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')).skillOverrides, { dataviz: 'on', other: 'off', deploy: 'off' });
    assert.deepEqual(JSON.parse(readFileSync(claudeJson, 'utf8')).projects['/p'].disabledMcpServers, ['mine']);
    assert.equal(undoTrim({ settings, claudeJson }), null);
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});

test('items turned off by apply that still load in a later session are reported', () => {
  const dir = tmp('lc-still-');
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = join(dir, 'state');
  try {
    const settings = join(dir, 'settings.json');
    const claudeJson = join(dir, 'claude.json');
    applyTrim({ hide: ['dataviz'], pluginSkills: [], disable: ['claude.ai Figma'], manualMcp: [] }, { cwd: '/p', now: 1000, settings, claudeJson });
    const pieces = [
      { group: 'Tool names', name: 'claude_ai_Figma' },
      { group: 'Skill listing', name: 'other' },
    ];
    assert.deepEqual(stillLoading({ pieces, at: 2000 }), ['claude.ai Figma']);
    assert.deepEqual(stillLoading({ pieces, at: 500 }), []); // session started before the apply
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});

test('plugins, transcript cwd, and the Pro gate on --apply', () => {
  const dir = tmp('lc-plug-');
  const install = join(dir, 'cache', 'greptile');
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, '.mcp.json'), JSON.stringify({ greptile: { type: 'http' } }));
  mkdirSync(join(dir, 'plugins'));
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'greptile@official': [{ installPath: install }] } }));
  const p = installedPlugins(dir);
  assert.deepEqual([[...p.names], p.servers], [['greptile'], ['plugin:greptile:greptile']]);

  const t = join(dir, 'sess.jsonl');
  writeFileSync(t, `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ type: 'user', cwd: '/work/app' })}\n`);
  assert.equal(transcriptCwd(t), '/work/app');

  const claudeDir = tmp('lc-gate-');
  mkdirSync(join(claudeDir, 'projects', 'p'), { recursive: true });
  writeFileSync(join(claudeDir, 'projects', 'p', 's.jsonl'), '');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, LIMITCAST_STATE: tmp('lc-gate-st-'), CODEX_HOME: tmp('lc-gate-cx-') };
  delete env.LIMITCAST_LICENSE;
  const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
  assert.throws(
    () => execFileSync('node', [bin, 'trim', '--apply'], { env, stdio: 'pipe' }),
    (e) => e.status === 2,
  );
});
