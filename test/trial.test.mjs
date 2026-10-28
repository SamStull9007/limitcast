import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isPro, startTrial, trialStatus } from '../src/license.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));

test('trial: 7 days of Pro, once per machine, even after the state dir is cleared', () => {
  const prev = { s: process.env.LIMITCAST_STATE, c: process.env.XDG_CONFIG_HOME, l: process.env.LIMITCAST_LICENSE };
  process.env.LIMITCAST_STATE = tmp('lc-trial-st-');
  process.env.XDG_CONFIG_HOME = tmp('lc-trial-cfg-');
  delete process.env.LIMITCAST_LICENSE;
  try {
    const D = 86400_000;
    const t0 = Date.now();
    assert.equal(trialStatus(t0), null);
    assert.equal(isPro(), true);
    assert.deepEqual(startTrial(t0), { ok: true, active: true, ends: t0 + 7 * D });
    assert.equal(isPro(), true);
    assert.equal(startTrial(t0 + D).ok, false); // once
    assert.equal(trialStatus(t0 + 8 * D).active, false);
    rmSync(process.env.LIMITCAST_STATE, { recursive: true });
    assert.equal(startTrial(t0 + 9 * D).ok, false); // the marker outside the state dir remembers
  } finally {
    for (const [k, v] of [
      ['LIMITCAST_STATE', prev.s],
      ['XDG_CONFIG_HOME', prev.c],
      ['LIMITCAST_LICENSE', prev.l],
    ])
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test('CLI: legacy trial commands report free availability without starting a trial', () => {
  const env = { ...process.env, LIMITCAST_STATE: tmp('lc-trial-cli-'), XDG_CONFIG_HOME: tmp('lc-trial-cfg2-'), CODEX_HOME: tmp('lc-trial-cx-') };
  delete env.LIMITCAST_LICENSE;
  const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
  assert.match(execFileSync('node', [bin, 'license'], { env }).toString(), /MIT License/);
  assert.match(execFileSync('node', [bin, 'trial'], { env }).toString(), /no license key, account or trial is required/);
  assert.match(execFileSync('node', [bin, 'license'], { env }).toString(), /All features are available/);
  assert.match(execFileSync('node', [bin, 'notify', 'off'], { env }).toString(), /Notifications are off/); // a Pro command now works
  assert.match(execFileSync('node', [bin, 'trial'], { env }).toString(), /All features are available/);
});
