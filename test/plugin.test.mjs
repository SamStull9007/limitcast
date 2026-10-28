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
