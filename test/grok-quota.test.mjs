import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  grokDoctor,
  grokQuotaDue,
  grokQuotaEnabled,
  grokSamples,
  parseGrokBilling,
  readGrokQuota,
  refreshGrokQuota,
  setGrokQuota,
} from '../src/grok.mjs';

const tmp = (p) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const bin = new URL('../bin/limitcast.mjs', import.meta.url).pathname;

// A gRPC-web GetGrokCreditsConfig reply: one data frame holding the config (percent, cycle start and end), one trailer frame.
const varint = (n) => {
  const o = [];
  for (; n >= 0x80; n = Math.floor(n / 128)) o.push((n & 0x7f) | 0x80);
  return Buffer.from([...o, n]);
};
const lenField = (f, payload) => Buffer.concat([varint(f * 8 + 2), varint(payload.length), payload]);
const f32 = (f, x) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(x);
  return Buffer.concat([varint(f * 8 + 5), b]);
};
const ts = (sec) => Buffer.concat([varint(8), varint(sec)]);
const frame = (flag, payload) => {
  const h = Buffer.alloc(5);
  h[0] = flag;
  h.writeUInt32BE(payload.length, 1);
  return Buffer.concat([h, payload]);
};
const reply = (pct, start, end) =>
  Buffer.concat([
    frame(0, lenField(1, Buffer.concat([f32(1, pct), lenField(4, ts(start)), lenField(5, ts(end))]))),
    frame(0x80, Buffer.from('grpc-status: 0\r\n')),
  ]);

const DAY = 86400;
const END = 1_800_604_800; // seconds
const NOW = (END - 3 * DAY) * 1000;

function sandbox() {
  const state = tmp('lc-gq-state-');
  process.env.LIMITCAST_STATE = state;
  const home = tmp('lc-gq-home-');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), '');
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({ 'https://other.example': { key: 'tok-other' }, 'https://auth.x.ai': { key: 'tok-secret', email: 'a@b.c' } }),
  );
  return { state, home };
}

test('parseGrokBilling reads the percent and the cycle, and skips trailer frames', () => {
  assert.deepEqual(parseGrokBilling(reply(9, END - 7 * DAY, END)), { pct: 9, start: END - 7 * DAY, end: END });
  assert.equal(parseGrokBilling(Buffer.from([0, 0, 0, 0, 0])), null);
  assert.equal(parseGrokBilling(Buffer.from([0, 0, 0, 0, 9, 1])), null); // truncated frame
  assert.equal(parseGrokBilling(reply(250, 0, 0))?.pct, 100); // clamped
});

test('refreshGrokQuota asks grok.com with the auth.x.ai login, records the weekly reading, and never stores the login', async () => {
  const { state, home } = sandbox();
  setGrokQuota(true);
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, redirect: init.redirect });
    return new Response(reply(9, END - 7 * DAY, END), { status: 200 });
  };
  const q = await refreshGrokQuota(NOW, { home, fetchFn });
  assert.equal(q.ok, true);
  assert.equal(q.label, 'Weekly');
  assert.equal(q.pct, 9);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/grok\.com\//);
  assert.equal(calls[0].auth, 'Bearer tok-secret'); // the auth.x.ai entry goes first
  assert.equal(calls[0].redirect, 'error');
  assert.doesNotMatch(readFileSync(join(state, 'grok-quota.json'), 'utf8'), /tok-/);

  // Within five minutes nothing is asked again; a changed percent after that adds a reading.
  await refreshGrokQuota(NOW + 60_000, { home, fetchFn });
  assert.equal(calls.length, 1);
  assert.equal(grokQuotaDue(NOW + 60_000, home), false);
  assert.equal(grokQuotaDue(NOW + 6 * 60_000, home), true);
  const f2 = async () => new Response(reply(10, END - 7 * DAY, END), { status: 200 });
  await refreshGrokQuota(NOW + 6 * 60_000, { home, fetchFn: f2 });
  assert.deepEqual(
    readGrokQuota().readings.map((r) => r.pct),
    [9, 10],
  );

  // The weekly readings feed the forecast, and a weekly dollar cap steps aside for them.
  const s = grokSamples(NOW + 7 * 60_000, { root: tmp('lc-gq-none-'), budget: { '7d': 5 } });
  assert.deepEqual(
    s.map((x) => [x.src, x.win, x.pct, x.reset]),
    [
      ['grok', '7d', 9, END],
      ['grok', '7d', 10, END],
    ],
  );
  assert.match(
    grokDoctor(home)
      .map((c) => c.line)
      .join('\n'),
    /Grok weekly: 10% used/,
  );
});

test('refreshGrokQuota records why it failed, and a monthly plan gives no weekly samples', async () => {
  const { home } = sandbox();
  setGrokQuota(true);
  const expired = await refreshGrokQuota(NOW, { home, fetchFn: async () => new Response('', { status: 401 }) });
  assert.equal(expired.ok, false);
  assert.match(expired.error, /grok login/);
  const monthly = await refreshGrokQuota(NOW + 10 * 60_000, {
    home,
    fetchFn: async () => new Response(reply(40, END - 30 * DAY, END), { status: 200 }),
  });
  assert.equal(monthly.label, 'Monthly');
  assert.equal(monthly.ok, true);
  assert.deepEqual(readGrokQuota().readings, []);
  const none = await refreshGrokQuota(NOW + 20 * 60_000, { home: tmp('lc-gq-empty-'), fetchFn: async () => assert.fail('no login, no request') });
  assert.match(none.error, /no Grok login/);
});

test('off by default: no samples and nothing due until grok-usage is on', async () => {
  const { home } = sandbox();
  assert.equal(grokQuotaEnabled(), false);
  assert.equal(grokQuotaDue(NOW, home), false);
  assert.deepEqual(grokSamples(NOW, { root: tmp('lc-gq-none-'), budget: null }), []);
});

test('CLI: grok-usage explains itself, needs Grok installed, and turns off', () => {
  const home = tmp('lc-gq-cli-home-');
  const env = {
    ...process.env,
    HOME: home,
    GROK_HOME: join(home, '.grok'),
    XDG_CONFIG_HOME: tmp('lc-gq-xdg-'),
    LIMITCAST_STATE: tmp('lc-gq-cli-state-'),
    CLAUDE_CONFIG_DIR: tmp('lc-gq-cc-'),
  };
  const run = (...a) => spawnSync('node', [bin, ...a], { env, encoding: 'utf8' });
  assert.match(run('grok-usage').stdout, /is off\. Turn it on/);
  const missing = run('grok-usage', 'on');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /not installed/);
  assert.equal(run('grok-usage', 'sideways').status, 2);
  mkdirSync(env.GROK_HOME, { recursive: true });
  writeFileSync(join(env.GROK_HOME, 'config.toml'), '');
  const on = run('grok-usage', 'on'); // no auth.json: it says so instead of failing silently
  assert.match(on.stdout, /reads the login Grok keeps in ~\/\.grok\/auth\.json/);
  assert.match(on.stdout, /no Grok login found/);
  assert.equal(on.status, 1);
  assert.match(run('grok-usage', 'off').stdout, /no longer reads your Grok login/);
});
