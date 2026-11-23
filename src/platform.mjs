import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function shellPath() {
  if (process.platform !== 'win32') return '/bin/sh';
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH];
  try {
    const git = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    candidates.push(join(dirname(git), '..', 'bin', 'bash.exe'));
  } catch {
    // Git may be installed without its cmd directory on PATH.
  }
  for (const root of [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
  ])
    if (root) candidates.push(join(root, 'Git', 'bin', 'bash.exe'));
  const bash = candidates.find((path) => path && existsSync(path));
  if (!bash) throw new Error('Windows hooks require Git for Windows. Install it, or set CLAUDE_CODE_GIT_BASH_PATH to bash.exe, then retry.');
  return bash;
}

export const shellPathname = (path) => (process.platform === 'win32' ? path.replace(/\\/g, '/') : path);
export const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Bash runs npm shims on Windows without interpolating their arguments into shell code. */
export function hostCommand(command, args) {
  return process.platform === 'win32' ? [shellPath(), ['-c', 'exec "$@"', '--', shellPathname(command), ...args]] : [command, args];
}
