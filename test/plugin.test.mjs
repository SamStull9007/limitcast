import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('the plugin pins the same limitcast version as package.json', () => {
  const { version } = JSON.parse(read('package.json'));
  assert.equal(JSON.parse(read('plugin/.claude-plugin/plugin.json')).version, version);
  for (const f of readdirSync(new URL('plugin/commands/', root))) {
    const pins = [...read(`plugin/commands/${f}`).matchAll(/(?:limitcast@|\/limitcast-)(\d+\.\d+\.\d+)(?:\.tgz)?/g)].map((m) => m[1]);
    assert.ok(pins.length > 0, f);
    for (const p of pins) assert.equal(p, version, f);
  }
});

test('the marketplace lists the plugin by its manifest name', () => {
  const m = JSON.parse(read('.claude-plugin/marketplace.json'));
  const p = JSON.parse(read('plugin/.claude-plugin/plugin.json'));
  assert.deepEqual(
    m.plugins.map((e) => [e.name, e.source]),
    [[p.name, './plugin']],
  );
});

test('the Codex manifest preserves plugin metadata and resolves the bundled logo', () => {
  const { interface: ui, ...metadata } = JSON.parse(read('plugin/.codex-plugin/plugin.json'));
  assert.deepEqual(metadata, JSON.parse(read('plugin/.claude-plugin/plugin.json')));
  assert.equal(ui.displayName, 'LimitCast');
  for (const key of ['composerIcon', 'logo']) {
    assert.equal(ui[key], './.claude-plugin/icon.png');
    const png = readFileSync(new URL(`plugin/${ui[key]}`, root));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
  }
});
