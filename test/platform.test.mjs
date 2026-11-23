import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { doctor, install, launcherTargets, selfCommand, uninstall } from '../src/install.mjs';
import { windowsNotificationArgs } from '../src/notify.mjs';
import { hostCommand, shellPath, shellPathname, shellQuote } from '../src/platform.mjs';

test('installed launcher preserves paths, stdin, existing status line and unrelated hooks', () => {
  const state = mkdtempSync(join(tmpdir(), "lc space ' windows-"));
  const previous = process.env.LIMITCAST_STATE;
  process.env.LIMITCAST_STATE = state;
  try {
    const path = join(state, 'settings.json');
    const original = {
      statusLine: { type: 'command', command: "printf 'original line'" },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] },
    };
    writeFileSync(path, JSON.stringify(original));
    const options = { path, codexPath: join(state, 'absent', 'hooks.json'), grokDir: join(state, 'absent'), guard: true, alerts: true };
    install(options);
    install(options);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    const input = JSON.stringify({
      session_id: 'windows',
      rate_limits: { five_hour: { used_percentage: 32, resets_at: new Date(Date.now() + 3600000).toISOString() } },
    });
    const run = (command, feed = input) => execFileSync(shellPath(), ['-c', command], { input: feed, encoding: 'utf8' });
    assert.match(run(settings.statusLine.command), /original line/);
    assert.equal(JSON.parse(readFileSync(join(state, 'last-feed.json'), 'utf8')).session_id, 'windows');
    assert.equal(run(settings.hooks.PreToolUse[0].hooks[0].command, '{}'), '');
    assert.ok(
      doctor({ path, codexPath: options.codexPath, grokDir: options.grokDir, samplesAgeMs: 0 }).some(
        (c) => c.ok && /Hook launcher points/.test(c.line),
      ),
    );
    const targets = launcherTargets(join(state, 'limitcast-hook.sh'));
    assert.equal(targets.node, shellPathname(process.execPath));
    assert.equal(targets.bin, shellPathname(fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url))));
    uninstall(options);
    const restored = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(restored.statusLine, original.statusLine);
    assert.deepEqual(restored.hooks.Stop, original.hooks.Stop);
    assert.ok(Object.entries(restored.hooks).every(([event, groups]) => event === 'Stop' || groups.length === 0));
  } finally {
    if (previous === undefined) delete process.env.LIMITCAST_STATE;
    else process.env.LIMITCAST_STATE = previous;
  }
});

test('Windows invocation passes shell metacharacters as arguments rather than code', () => {
  const value = `space ' " $HOME; $(exit 9) & <tag> \\ Unicode é`;
  const [command, args] = hostCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]);
  assert.equal(execFileSync(command, args, { encoding: 'utf8' }), value);
  assert.equal(execFileSync(shellPath(), ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' }), value);
});

test('Windows shell selection uses the configured Git Bash and normalizes launcher paths', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const oldBash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const oldState = process.env.LIMITCAST_STATE;
  const oldPath = process.env.PATH;
  const bash = shellPath();
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.CLAUDE_CODE_GIT_BASH_PATH = bash;
    process.env.LIMITCAST_STATE = mkdtempSync(join(tmpdir(), 'lc-windows-selection-'));
    assert.equal(shellPath(), bash);
    assert.equal(shellPathname('C:\\Users\\Name Space\\file'), 'C:/Users/Name Space/file');
    assert.ok(selfCommand().startsWith(`${shellQuote(shellPathname(bash))} `));
    const stub = join(process.env.LIMITCAST_STATE, 'git');
    writeFileSync(stub, '#!/bin/sh\necho fixture\n', { mode: 0o755 });
    process.env.PATH = process.env.LIMITCAST_STATE;
    assert.deepEqual(hostCommand('git', ['a & b']), [bash, ['-c', 'exec "$@"', '--', shellPathname(stub), 'a & b']]);
    assert.equal(execFileSync(...hostCommand('git', []), { encoding: 'utf8' }).trim(), 'fixture');
    assert.deepEqual(hostCommand('limitcast-missing-fixture', []), [bash, ['-c', 'exec "$@"', '--', 'limitcast-missing-fixture']]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    process.env.PATH = oldPath;
    if (oldBash === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    else process.env.CLAUDE_CODE_GIT_BASH_PATH = oldBash;
    if (oldState === undefined) delete process.env.LIMITCAST_STATE;
    else process.env.LIMITCAST_STATE = oldState;
  }
});

test('Windows toast encodes message data without inserting it into PowerShell or XML code', () => {
  const message = `don't <escape> $this; $(exit 9) é`;
  const args = windowsNotificationArgs(message);
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(script.includes(Buffer.from(message).toString('base64')));
  assert.ok(!script.includes(message));
  assert.match(script, /InnerText/);
});
