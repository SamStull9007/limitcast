import './helpers/environment.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibrate, windowPct } from '../src/calibrate.mjs';

const t0 = Date.UTC(2026, 9, 24, 12);
const M = 60_000;
const reset = t0 / 1000 + 5 * 3600;

test('calibration recovers how much new and cached tokens each move the 5-hour meter', () => {
  // Truth: 1% per 200k new tokens (5 %/M) and per 10M cached tokens (0.1 %/M). Each minute the meter rises 1%.
  const samples = [];
  const usage = [];
  for (let i = 0; i <= 40; i++) {
    samples.push({ t: t0 + i * M, src: 'claude', win: '5h', pct: i, reset, sid: 's' });
    if (!i) continue;
    // Vary the mix so the two rates can be told apart: share k of the 1% comes from new tokens.
    const k = (i % 5) / 5;
    const fresh = k * 200_000;
    const read = (1 - k) * 10_000_000;
    usage.push({ t: t0 + i * M - 1000, src: 'claude', session: 's', input: fresh, cacheWrite: 0, output: 0, cacheRead: read });
  }
  const c = calibrate(samples, usage);
  assert.ok(Math.abs(c.fresh - 5) < 0.01, `fresh ${c.fresh}`);
  assert.ok(Math.abs(c.read - 0.1) < 0.001, `read ${c.read}`);
  assert.equal(c.n, 40);
  // 24k tokens not written (6 sessions x 4k) and 1.4M not re-read: 0.12% + 0.14% of a window.
  assert.ok(Math.abs(windowPct(c, { writes: 24_000, reads: 1_400_000 }) - 0.26) < 0.005);
});

test('too few readings, or a fit where cached tokens cost as much as new ones, is no calibration', () => {
  const s = (i) => ({ t: t0 + i * M, src: 'claude', win: '5h', pct: i, reset, sid: 's' });
  const u = (i) => ({ t: t0 + i * M - 1000, src: 'claude', session: 's', input: 100_000, cacheWrite: 0, output: 0, cacheRead: 100_000 });
  assert.equal(calibrate([s(0), s(1), s(2)], [u(1), u(2)]), null);
  const samples = Array.from({ length: 41 }, (_, i) => s(i));
  const usage = Array.from({ length: 40 }, (_, i) => u(i + 1));
  assert.equal(calibrate(samples, usage), null); // the two kinds can't be separated
});
