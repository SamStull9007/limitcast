import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { doctor, install, uninstall } from '../src/install.mjs';
import { editFiles } from '../src/transaction.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lc-install-safety-'));
  process.env.LIMITCAST_STATE = join(root, 'state');
  process.env.GROK_HOME = join(root, 'grok');
  mkdirSync(join(root, 'codex'));
  return { path: join(root, 'settings.json'), codexPath: join(root, 'codex', 'hooks.json'), grokDir: process.env.GROK_HOME, self: 'limitcast' };
}
const command = (command) => ({ type: 'command', command });
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('shared groups preserve foreign commands, metadata and positions through reinstall and uninstall', () => {
  const opts = fixture();
  const hooks = {
    PreToolUse: [
      { matcher: 'Task|Agent', tag: 'security', hooks: [command('before-security'), command('limitcast guard'), command('after-security')] },
    ],
    PostToolUse: [
      { matcher: '', tag: 'audit', hooks: [command('audit-log'), command('limitcast _optimize-hook --src claude'), command('limitcast tool-check')] },
    ],
    Stop: [{ matcher: '', tag: 'stop', hooks: [command('stop-check'), command('limitcast _optimize-hook --src claude')] }],
  };
  for (const path of [opts.path, opts.codexPath]) writeFileSync(path, JSON.stringify({ hooks }));
  install({ ...opts, guard: true, alerts: true, optimize: true });
  install({ ...opts, guard: true, alerts: true, optimize: true, self: '/new/limitcast' });
  for (const path of [opts.path, opts.codexPath]) {
    const cfg = read(path);
    assert.equal(cfg.hooks.PreToolUse[0].tag, 'security');
    assert.deepEqual(
      cfg.hooks.PreToolUse[0].hooks.filter((h) => !h.command.includes('limitcast')),
      [command('before-security'), command('after-security')],
    );
    assert.equal(cfg.hooks.PostToolUse[0].tag, 'audit');
    assert.ok(cfg.hooks.PostToolUse[0].hooks.some((h) => h.command === 'audit-log'));
    assert.equal(cfg.hooks.PostToolUse.flatMap((e) => e.hooks).filter((h) => /_optimize-hook/.test(h.command)).length, 1);
    assert.equal(cfg.hooks.PostToolUse.flatMap((e) => e.hooks).filter((h) => /tool-check/.test(h.command)).length, 0);
  }
  uninstall(opts);
  for (const path of [opts.path, opts.codexPath]) {
    const cfg = read(path);
    assert.deepEqual(cfg.hooks.PreToolUse, [
      { matcher: 'Task|Agent', tag: 'security', hooks: [command('before-security'), command('after-security')] },
    ]);
    assert.deepEqual(cfg.hooks.PostToolUse, [{ matcher: '', tag: 'audit', hooks: [command('audit-log')] }]);
    assert.deepEqual(cfg.hooks.Stop, [{ matcher: '', tag: 'stop', hooks: [command('stop-check')] }]);
  }
});

test('invalid later-host settings leave all earlier settings unchanged during install and uninstall', () => {
  for (const operation of [install, uninstall]) {
    const opts = fixture();
    const original = '{"statusLine":{"command":"limitcast statusline"},"hooks":{}}';
    writeFileSync(opts.path, original);
    writeFileSync(opts.codexPath, '{invalid-json');
    assert.throws(() => operation({ ...opts, guard: true }), /not valid JSON/);
    assert.equal(readFileSync(opts.path, 'utf8'), original);
    assert.equal(readFileSync(opts.codexPath, 'utf8'), '{invalid-json');
  }
});

test('invalid or foreign Grok hook files refuse the whole install without changing earlier hosts', () => {
  for (const text of [
    '{bad',
    'null',
    '{"hooks":[]}',
    '{"hooks":{"Stop":[{}]}}',
    JSON.stringify({ hooks: { Stop: [{ hooks: [command('foreign-check')] }] } }),
  ]) {
    const opts = fixture();
    mkdirSync(join(opts.grokDir, 'hooks'), { recursive: true });
    const config = join(opts.grokDir, 'config.toml');
    const hook = join(opts.grokDir, 'hooks', 'limitcast.json');
    writeFileSync(config, '[ui.status_line]\ncommand = "original"\n');
    writeFileSync(hook, text);
    assert.throws(() => install({ ...opts, guard: true }), /JSON|Grok/);
    assert.equal(existsSync(opts.path), false);
    assert.equal(existsSync(opts.codexPath), false);
    assert.equal(readFileSync(config, 'utf8'), '[ui.status_line]\ncommand = "original"\n');
    assert.equal(readFileSync(hook, 'utf8'), text);
    assert.equal(existsSync(join(process.env.LIMITCAST_STATE, 'grok-statusline.json')), false);
  }
});

test('installation transaction rolls back a later rename failure, including a newly created file', () => {
  const opts = fixture();
  const ledger = join(process.env.LIMITCAST_STATE, 'install-state.json');
  writeFileSync(opts.codexPath, 'before');
  const rename = fs.renameSync;
  let failed = false;
  fs.renameSync = (from, to) => {
    if (to === opts.codexPath && !failed) {
      failed = true;
      throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        editFiles(ledger, (files) => {
          files.write(opts.path, 'new');
          files.write(opts.codexPath, 'after');
        }),
      /injected write failure/,
    );
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.ok(failed);
  assert.equal(existsSync(opts.path), false);
  assert.equal(readFileSync(opts.codexPath, 'utf8'), 'before');
  assert.equal(existsSync(`${ledger}.pending.json`), false);
});

test('installation planning refuses concurrent user edits and invalid settings shapes', () => {
  const opts = fixture();
  writeFileSync(opts.path, 'before');
  assert.throws(
    () =>
      editFiles(join(process.env.LIMITCAST_STATE, 'install-state.json'), (files) => {
        files.write(opts.path, 'planned');
        writeFileSync(opts.path, 'user-edit');
      }),
    /configuration changed/,
  );
  assert.equal(readFileSync(opts.path, 'utf8'), 'user-edit');
  for (const value of [null, [], { hooks: [] }, { hooks: { Stop: {} } }, { hooks: { Stop: [null] } }]) {
    const text = JSON.stringify(value);
    writeFileSync(opts.path, text);
    assert.throws(() => install({ ...opts, guard: true }), /not valid JSON|invalid hook groups/);
    assert.equal(readFileSync(opts.path, 'utf8'), text);
  }
});

test('doctor rejects Node 20 and 21 and accepts the package minimum of 22', () => {
  const opts = fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node');
  try {
    for (const [version, supported] of [
      ['20.19.0', false],
      ['21.0.0', false],
      ['22.0.0', true],
    ]) {
      Object.defineProperty(process.versions, 'node', { ...descriptor, value: version });
      const check = doctor({ ...opts, samplesAgeMs: null })[0];
      assert.equal(check.ok, supported);
      if (!supported) assert.match(check.line, /need 22\+/);
    }
  } finally {
    Object.defineProperty(process.versions, 'node', descriptor);
  }
});

test('CLI doctor repair and uninstall preserve unrelated hooks in an isolated host', () => {
  const opts = fixture();
  const foreign = { matcher: '', hooks: [command('security-check')] };
  writeFileSync(opts.path, JSON.stringify({ statusLine: { type: 'command', command: 'echo original' }, hooks: { PreToolUse: [foreign] } }));
  install({ ...opts, guard: false });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dirname(opts.path), CODEX_HOME: dirname(opts.codexPath), GROK_HOME: opts.grokDir };
  const bin = fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, cwd: dirname(opts.path), encoding: 'utf8', timeout: 20000 });
  const repaired = run('doctor', '--fix');
  assert.equal(repaired.status, 1, 'missing telemetry remains unhealthy after a successful path repair');
  assert.match(repaired.stdout, /command path refreshed/);
  assert.deepEqual(read(opts.path).hooks.PreToolUse, [foreign]);
  const removed = run('uninstall');
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /restored your original status line/);
  assert.equal(read(opts.path).statusLine.command, 'echo original');
  assert.deepEqual(read(opts.path).hooks.PreToolUse, [foreign]);
});
