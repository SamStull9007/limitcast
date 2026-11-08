import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateConfig } from '../src/store.mjs';

const src = (f) => JSON.stringify(new URL(`../src/${f}`, import.meta.url).href);
const fresh = () => mkdtempSync(join(tmpdir(), 'lc-lock-state-'));

/** Run `body` in its own node process, all of them starting their loops at the same instant. */
function worker(state, body) {
  const code = `
    import { setSubagentModel, setBudget, setTodayHold } from ${src('subagents.mjs')};
    import { setGrokBudget, setGrokQuota } from ${src('grok.mjs')};
    import { setPlan } from ${src('plan.mjs')};
    import { ensureDefaultKeep, setKeep } from ${src('apply.mjs')};
    import { execFileSync } from 'node:child_process';
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ${Date.now() + 700} - Date.now()));
    ${body}`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, LIMITCAST_STATE: state, XDG_CONFIG_HOME: state, CLAUDE_CONFIG_DIR: state },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`worker exited ${c}`))));
  });
}

const config = (state) => JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'));

test('simultaneous commands changing different settings: every change survives', async () => {
  const state = fresh();
  const jobs = [];
  for (let i = 0; i < 10; i++) jobs.push(worker(state, `for (let j = 0; j < 25; j++) setSubagentModel('w${i}-' + j, 'haiku');`));
  jobs.push(worker(state, `for (let j = 0; j < 25; j++) setBudget(10 + j); setBudget(40);`));
  jobs.push(worker(state, `for (let j = 0; j < 25; j++) setTodayHold(j % 2 === 0); setTodayHold(true);`));
  jobs.push(worker(state, `for (let j = 0; j < 25; j++) setPlan('pro'); setPlan('max5');`));
  jobs.push(worker(state, `for (let j = 0; j < 25; j++) setKeep(['a' + j]); setKeep(['ego-browser', 'figma']);`));
  jobs.push(worker(state, `for (let j = 0; j < 25; j++) setGrokQuota(j % 2 === 0); setGrokQuota(true);`));
  jobs.push(worker(state, `for (let j = 0; j < 25; j++) setGrokBudget(5 + j, '7d'); setGrokBudget(9, '7d');`));
  await Promise.all(jobs);

  const cfg = config(state);
  assert.equal(Object.keys(cfg.subagentModels).length, 250, 'a model pin was lost');
  assert.equal(cfg.subagentBudget, 40);
  assert.equal(cfg.todayHold, true);
  assert.equal(cfg.plan, 'max5');
  assert.deepEqual(cfg.trimKeep, ['ego-browser', 'figma']);
  assert.equal(cfg.grokQuota, true);
  assert.deepEqual(cfg.grokBudget, { '7d': 9 });
  assert.equal(existsSync(join(state, 'config.json.lock')), false, 'the lock was left behind');
});

test('`limitcast trim keep` run from several terminals at once keeps every name', async () => {
  const state = fresh();
  const bin = JSON.stringify(new URL('../bin/limitcast.mjs', import.meta.url).pathname);
  const names = [];
  const jobs = [];
  for (let i = 0; i < 8; i++) {
    const mine = Array.from({ length: 4 }, (_, j) => `k${i}x${j}`);
    names.push(...mine);
    jobs.push(
      worker(state, `for (const n of ${JSON.stringify(mine)}) execFileSync(process.execPath, [${bin}, 'trim', 'keep', n], { stdio: 'ignore' });`),
    );
  }
  await Promise.all(jobs);
  assert.deepEqual(config(state).trimKeep.sort(), names.sort());
});

test('ensureDefaultKeep seeds once when several commands start together', async () => {
  const state = fresh();
  const outs = await Promise.all(Array.from({ length: 8 }, () => worker(state, `process.stdout.write(String(ensureDefaultKeep().seeded));`)));
  assert.equal(outs.filter((o) => o === 'true').length, 1);
  assert.deepEqual(config(state).trimKeep, ['ego-browser']);
});

test('a lock left by a dead process is broken after two seconds', () => {
  const state = fresh();
  process.env.LIMITCAST_STATE = state;
  const lock = join(state, 'config.json.lock');
  mkdirSync(lock);
  const old = new Date(Date.now() - 10_000);
  utimesSync(lock, old, old);
  updateConfig((cfg) => ({ ...cfg, plan: 'pro' }));
  assert.equal(config(state).plan, 'pro');
  assert.equal(existsSync(lock), false);
});

test('the lock is released when the change throws, and the file is left alone', () => {
  const state = fresh();
  process.env.LIMITCAST_STATE = state;
  updateConfig((cfg) => ({ ...cfg, plan: 'pro' }));
  assert.throws(
    () =>
      updateConfig(() => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(existsSync(join(state, 'config.json.lock')), false);
  assert.equal(config(state).plan, 'pro');
});

test('a config.json that is not an object is replaced, not crashed on', () => {
  const state = fresh();
  process.env.LIMITCAST_STATE = state;
  writeFileSync(join(state, 'config.json'), 'null');
  updateConfig((cfg) => ({ ...cfg, plan: 'pro' }));
  assert.equal(config(state).plan, 'pro');
});
