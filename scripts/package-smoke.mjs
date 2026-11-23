import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostCommand, shellPath } from '../src/platform.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'limitcast-package-'));
try {
  const result = JSON.parse(execFileSync(...hostCommand('npm', ['pack', '--json', '--pack-destination', dir]), { cwd: root, encoding: 'utf8' }));
  const pack = Array.isArray(result) ? result[0] : Object.values(result)[0];
  assert.ok(pack.filename.endsWith('.tgz'));
  execFileSync('tar', ['-xzf', join(dir, pack.filename), '-C', dir]);
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of [
    'LIMITCAST_STATE',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'GROK_HOME',
    'COPILOT_HOME',
    'PI_CODING_AGENT_DIR',
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
  ])
    env[name] = join(home, name);
  delete env.LIMITCAST_ALLOW;
  delete env.LIMITCAST_MODEL_WORKER;
  const bin = join(dir, 'package/bin/limitcast.mjs');
  const run = (...args) => execFileSync(process.execPath, [bin, ...args], { cwd: home, env, encoding: 'utf8', timeout: 20000 });
  const pkg = JSON.parse(readFileSync(join(dir, 'package/package.json'), 'utf8'));
  assert.ok(pkg.os.includes(process.platform));
  const prefix = join(dir, 'global install');
  execFileSync(
    ...hostCommand('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(dir, pack.filename)]),
    { env, encoding: 'utf8', timeout: 60000 },
  );
  assert.match(
    execFileSync(...hostCommand(join(prefix, process.platform === 'win32' ? 'limitcast' : 'bin/limitcast'), ['--version']), {
      env,
      encoding: 'utf8',
    }),
    new RegExp(pkg.version.replaceAll('.', '\\.')),
  );
  assert.ok(run('--version').includes(pkg.version));
  assert.deepEqual(JSON.parse(run('status', '--json')), []);
  assert.match(run('onboard'), /limitcast/i);
  assert.match(run('trim', '--codex', '--share'), /unavailable/i);
  execFileSync('git', ['init', '-q', home]);
  for (const path of [env.CODEX_HOME, join(env.GROK_HOME, 'sessions')]) mkdirSync(path, { recursive: true });
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const original = { statusLine: { type: 'command', command: "printf 'existing status line'" } };
  writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify(original));
  run('install', '--guard', '--alerts', '--optimize');
  const statusCommand = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).statusLine.command;
  assert.match(
    execFileSync(shellPath(), ['-c', statusCommand], { cwd: home, env, input: '{"session_id":"packed"}', encoding: 'utf8' }),
    /existing status line/,
  );
  const seed = `import {repository,changeOptimization} from ${JSON.stringify(pathToFileURL(join(dir, 'package/src/optimize.mjs')).href)};
    changeOptimization(repository(),s=>{s.config.learn=true;s.facts=[{state:'active',from:'pytest',to:'python3 -m pytest'}];});`;
  execFileSync(process.execPath, ['--input-type=module', '-e', seed], { cwd: home, env, timeout: 20000 });
  for (const [host, path] of [
    ['claude', join(env.CLAUDE_CONFIG_DIR, 'settings.json')],
    ['codex', join(env.CODEX_HOME, 'hooks.json')],
    ['grok', join(env.GROK_HOME, 'hooks/limitcast-optimize.json')],
  ]) {
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    const invoke = (event, fields = {}) => {
      const command = settings.hooks[event].flatMap((entry) => entry.hooks).find((hook) => hook.command.includes('_optimize-hook')).command;
      return JSON.parse(
        execFileSync(shellPath(), ['-c', command], {
          cwd: home,
          env,
          input: JSON.stringify({ session_id: host, cwd: home, hook_event_name: event, ...fields }),
          encoding: 'utf8',
          timeout: 20000,
        }),
      );
    };
    const start = invoke('SessionStart');
    const result = host === 'grok' ? invoke('PostToolUse', { tool_name: 'Read', tool_input: {} }) : start;
    assert.match(result.hookSpecificOutput.additionalContext, /Repository evidence/);
    invoke('Stop');
  }
  run('optimize', 'install', '--copilot');
  const copilot = JSON.parse(readFileSync(join(env.COPILOT_HOME, 'hooks/limitcast.json'), 'utf8')).hooks.SessionStart[0];
  const copilotResult = JSON.parse(
    execFileSync(copilot.exec, copilot.args, {
      cwd: home,
      env,
      input: JSON.stringify({ sessionId: 'copilot', cwd: home, hookEventName: 'SessionStart' }),
      encoding: 'utf8',
      timeout: 20000,
    }),
  );
  assert.match(copilotResult.additionalContext, /Repository evidence/);
  run('optimize', 'install', '--pi');
  const extension = JSON.parse(readFileSync(join(env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8')).extensions[0];
  const piCheck = `import assert from 'node:assert/strict';
    import extension from ${JSON.stringify(pathToFileURL(extension).href)};
    const handlers={};extension({on:(name,fn)=>{handlers[name]=fn;}});
    const ctx={cwd:${JSON.stringify(home)},sessionManager:{getSessionId:()=> 'pi',getBranch:()=>[]}};
    await handlers.session_start({},ctx);
    const event={systemPromptOptions:{sections:{existing:'preserved'}}};
    await handlers.before_agent_start(event,ctx);
    assert.equal(event.systemPromptOptions.sections.existing,'preserved');
    assert.match(event.systemPromptOptions.sections.limitcast,/Repository evidence/);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', piCheck], { cwd: home, env, timeout: 20000 });
  const status = JSON.parse(run('optimize', 'status'));
  for (const host of ['claude', 'codex', 'grok', 'copilot', 'pi']) assert.ok(status.hosts[host]);
  assert.equal(status.measurements.injectedContext.injections, 5);
  run('uninstall');
  const restored = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.deepEqual(restored.statusLine, original.statusLine);
  assert.ok(Object.values(restored.hooks).every((groups) => groups.length === 0));
  console.log(`Packed ${pkg.name}@${pkg.version}: isolated CLI and five installed adapter contracts passed (${pack.integrity})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
