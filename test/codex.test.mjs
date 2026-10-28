import './helpers/environment.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyCodexTrim, codexServers, codexStartup, codexTrimReport, codexUsedServers, setEnabled, undoCodexTrim } from '../src/codex.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const TOML = `model = "gpt"

[mcp_servers.grist]
command = "grist"
enabled = false

[mcp_servers.tool-router]
command = "tr"
enabled = true

[mcp_servers.tool-router.env]
KEY = "v"

[mcp_servers."node_repl"]
command = "node"

[plugins."x"]
enabled = true
`;

test('reads MCP servers and their enabled setting, ignoring sub-tables and plugins', () => {
  assert.deepEqual(codexServers(TOML), [
    { name: 'grist', enabled: false },
    { name: 'tool-router', enabled: true },
    { name: 'node_repl', enabled: undefined },
  ]);
});

test('setEnabled edits only the server table, inserting or removing the key', () => {
  const off = setEnabled(TOML, { 'tool-router': false, node_repl: false });
  assert.deepEqual(
    codexServers(off).map((s) => s.enabled),
    [false, false, false],
  );
  assert.match(off, /\[mcp_servers\."node_repl"\]\nenabled = false\ncommand = "node"/);
  assert.match(off, /\[mcp_servers\.tool-router\.env\]\nKEY = "v"/); // sub-table untouched
  assert.match(off, /\[plugins\."x"\]\nenabled = true/); // plugins untouched
  assert.equal(setEnabled(off, { 'tool-router': true, node_repl: null }), TOML);
});

test('apply backs up and undo restores the file exactly, keeping its permissions', () => {
  const dir = tmp('lc-cx-');
  const prev = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = join(dir, 'state');
  try {
    const path = join(dir, 'config.toml');
    writeFileSync(path, TOML, { mode: 0o600 });
    const changed = applyCodexTrim(['tool-router', 'node_repl'], { path, now: 1000 });
    assert.deepEqual(changed, [
      { name: 'tool-router', prev: true },
      { name: 'node_repl', prev: null },
    ]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    undoCodexTrim({ path });
    assert.equal(readFileSync(path, 'utf8'), TOML);
    assert.equal(undoCodexTrim({ path }), null);
  } finally {
    process.env.LIMITCAST_STATE = prev;
  }
});

test('used servers and startup sizes come from the rollouts; the free report names unused servers', async () => {
  const root = tmp('lc-cxs-');
  mkdirSync(join(root, '2026', '10', '25'), { recursive: true });
  const rows = [
    { type: 'session_meta', payload: { base_instructions: { text: 'b'.repeat(8000) } } },
    { type: 'world_state', payload: { state: { agents_md: { text: 'a'.repeat(4000) } } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'tool-router', tool: 'call_tool' } } },
    { type: 'response_item', payload: { type: 'function_call', name: 'js', namespace: 'mcp__node_repl' } },
  ];
  writeFileSync(join(root, '2026', '10', '25', 'rollout-1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  const used = await codexUsedServers(0, root);
  assert.deepEqual([...used].sort(), ['node_repl', 'tool_router']);
  assert.deepEqual(await codexStartup(root), { agentsMd: 4000, base: 8000 });
  const servers = codexServers(TOML);
  const pro = codexTrimReport({ servers, used: new Set(['node_repl']), startup: { agentsMd: 4000, base: 8000 }, days: 7, pro: true });
  assert.deepEqual(pro.unused, ['tool-router']); // grist is already off
  assert.match(pro.text, /~1\.0k tokens of AGENTS\.md/);
  assert.match(pro.text, /2 on, 1 not used in 7 days\n- tool-router/);
  const free = codexTrimReport({ servers, used: new Set(), startup: null, days: 7, pro: false });
  assert.match(free.text, /tool-router/);
  assert.doesNotMatch(free.text, /Pro names them/);
});
