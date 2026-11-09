import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { digest } from './optimize.mjs';
import { stateDir, writeAtomic } from './store.mjs';

const SOURCE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|php|[ch](?:pp)?)$/;
const EXCLUDE =
  /(?:^|\/)(?:\.[^/]+|node_modules|vendor|dist|build|coverage|fixtures|generated|__pycache__)(?:\/|$)|(?:secret|credential|private[-_]?key|\.min\.)/i;

export function repositoryMap(repo, { refresh = false, maxChars = 6000 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 8000) throw new Error('map budget must be 100–8000 characters');
  const git = (...args) => execFileSync('git', ['-C', repo.root, ...args], { encoding: 'utf8', timeout: 2000, maxBuffer: 1_000_000 });
  const head = git('rev-parse', 'HEAD').trim();
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  const path = join(stateDir(), 'optimize', `${repo.id}.map.json`);
  if (!refresh && !dirty && existsSync(path)) {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    if (cached.head === head && cached.budget === maxChars) return cached.text;
  }
  const files = git('ls-files', '-z')
    .split('\0')
    .filter((f) => /^[\w./@+-]+$/.test(f) && SOURCE.test(f) && !EXCLUDE.test(f))
    .slice(0, 1000);
  const rows = [];
  let read = 0;
  for (const name of files) {
    const full = join(repo.root, name);
    if (!existsSync(full) || !lstatSync(full).isFile() || lstatSync(full).size > 100_000) continue;
    const rel = relative(repo.root, realpathSync(full));
    if (rel.startsWith(`..${sep}`) || rel === '..') continue;
    const text = readFileSync(full, 'utf8');
    read += text.length;
    if (read > 2_000_000) break;
    const names = [
      ...text.matchAll(
        /(?:^|\n)\s*(?:export\s+)?(?:pub\s+)?(?:async\s+)?(?:function|class|def|fn|func)\s+([A-Za-z_$][\w$]*)|(?:^|\n)export\s+const\s+([A-Za-z_$][\w$]*)/g,
      ),
    ]
      .map((m) => m[1] ?? m[2])
      .slice(0, 12);
    rows.push({ name, symbols: [...new Set(names)], score: (name.startsWith('src/') ? 3 : 0) + (name.startsWith('test/') ? 0 : 1) + names.length });
  }
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let text = 'Repository map (tracked source files; names only):\n';
  for (const row of rows) {
    const line = `${row.name}${row.symbols.length ? `: ${row.symbols.join(', ')}` : ''}\n`;
    if (text.length + line.length <= maxChars) text += line;
  }
  mkdirSync(join(stateDir(), 'optimize'), { recursive: true, mode: 0o700 });
  writeAtomic(path, JSON.stringify({ head, budget: maxChars, fingerprint: digest(text), text }));
  return text;
}
