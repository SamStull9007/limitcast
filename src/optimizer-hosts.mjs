import { copyFileSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './install.mjs';
import { writeAtomic } from './store.mjs';

export function installOptimizerHost(
  host,
  {
    home = host === 'copilot'
      ? (process.env.COPILOT_HOME ?? join(homedir(), '.copilot'))
      : (process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')),
    undo = false,
  } = {},
) {
  if (!['copilot', 'pi'].includes(host)) throw new Error('choose --copilot or --pi');
  const path = host === 'copilot' ? join(home, 'hooks', 'limitcast.json') : join(home, 'settings.json');
  for (const item of [home, dirname(path), path])
    if (existsSync(item) && lstatSync(item).isSymbolicLink()) throw new Error('refuse symlinked optimizer settings');
  const cfg = readSettings(path);
  if (host === 'copilot') {
    if (cfg.limitcast !== undefined && cfg.limitcast !== true) throw new Error('existing hook file is not owned by Limitcast');
    if (existsSync(path) && cfg.limitcast !== true) throw new Error('preserve the existing hook file before installing');
    cfg.version = 1;
    cfg.limitcast = true;
    cfg.hooks = undo
      ? {}
      : Object.fromEntries(
          ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'].map((event) => [
            event,
            [
              {
                type: 'command',
                exec: process.execPath,
                args: [fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url)), '_optimize-hook', '--src', host],
                timeoutSec: 10,
              },
            ],
          ]),
        );
  } else {
    const extension = fileURLToPath(new URL('./pi-extension.mjs', import.meta.url));
    if (cfg.extensions !== undefined && !Array.isArray(cfg.extensions)) throw new Error('Pi extensions must be an array');
    cfg.extensions = (cfg.extensions ?? []).filter(
      (p) => typeof p !== 'string' || (!/(?:^|\/)limitcast(?:\/|$).*\/pi-extension\.mjs$/.test(p) && p !== extension),
    );
    if (!undo) cfg.extensions.push(extension);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) copyFileSync(path, `${path}.limitcast-backup`);
  writeAtomic(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return { host, path, installed: !undo, runtimeDelivery: 'unverified; restart the host' };
}
