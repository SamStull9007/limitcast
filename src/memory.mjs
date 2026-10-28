import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code loads only the first 200 lines or 25 KB of MEMORY.md into every session; the rest is never read.
const INDEX_LINES = 200;
const INDEX_BYTES = 25 * 1024;
// A topic file is read whole when opened, so one past this is worth splitting by topic.
const BIG_LINES = 150;
const BIG_BYTES = 24 * 1024;

/** The auto-memory folder Claude Code keeps for a project.
 * @param {{home?:string, cwd?:string}} [where] */
export function memoryDir({ home = homedir(), cwd = process.cwd() } = {}) {
  return join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
}

/** @param {string} text */
const lineCount = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);
/** @param {string} s */
const slug = (s) => s.toLowerCase().replace(/\.md$/, '').replace(/[_\s]/g, '-');

/**
 * What a memory folder looks like from the index down: how much of MEMORY.md loads, which links are broken,
 * which topic files nothing reaches from the index, and which are big. Null when there is no index.
 * @param {string} dir
 */
export function scanMemory(dir) {
  const indexPath = join(dir, 'MEMORY.md');
  if (!existsSync(indexPath)) return null;
  const names = readdirSync(dir).filter((f) => f.endsWith('.md'));
  /** @type {Map<string, string>} */
  const text = new Map(names.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  const index = /** @type {string} */ (text.get('MEMORY.md'));
  const bySlug = new Map(names.map((f) => [slug(f), f]));

  const broken = /** @type {{from:string, target:string}[]} */ ([]);
  const reached = new Set(['MEMORY.md']);
  const queue = ['MEMORY.md'];
  for (let f = queue.pop(); f; f = queue.pop()) {
    const body = /** @type {string} */ (text.get(f));
    const targets = [
      ...[...body.matchAll(/\]\(([^)\s#]+\.md)[^)]*\)/g)]
        .map((m) => m[1])
        .filter((t) => !/^[a-z]+:/.test(t))
        .map((t) => {
          if (!existsSync(join(dir, t))) broken.push({ from: f, target: t });
          return t;
        }),
      // [[name]] links; one with no file yet is allowed (a note worth writing later), so never "broken".
      ...[...body.matchAll(/\[\[([^\]|#]+)/g)].map((m) => bySlug.get(slug(m[1].trim())) ?? ''),
    ];
    for (const t of targets) {
      if (!text.has(t) || reached.has(t)) continue;
      reached.add(t);
      queue.push(t);
    }
  }

  const big = names
    .filter((f) => f !== 'MEMORY.md')
    .map((name) => ({
      name,
      lines: lineCount(/** @type {string} */ (text.get(name))),
      bytes: Buffer.byteLength(/** @type {string} */ (text.get(name))),
    }))
    .filter((f) => f.lines > BIG_LINES || f.bytes > BIG_BYTES)
    .sort((a, b) => b.lines - a.lines);
  return {
    dir,
    index: { lines: lineCount(index), bytes: Buffer.byteLength(index) },
    files: names.length - 1,
    broken,
    orphans: names.filter((f) => !reached.has(f)),
    big,
  };
}

/** @param {NonNullable<ReturnType<typeof scanMemory>>} s */
const overCap = (s) => s.index.lines > INDEX_LINES || s.index.bytes > INDEX_BYTES;

/**
 * One doctor line. Only an index past the cap fails: that is memory Claude silently never reads.
 * @param {ReturnType<typeof scanMemory>} s
 * @returns {{ok:boolean, line:string}|null}
 */
export function memoryCheck(s) {
  if (!s) return null;
  const size = `index ${s.index.lines}/${INDEX_LINES} lines, ${Math.round(s.index.bytes / 1000)}/25 KB`;
  if (overCap(s))
    return {
      ok: false,
      line: `Memory ${size}: Claude Code loads only the first ${INDEX_LINES} lines or 25 KB of MEMORY.md, so the rest is never read. Fix: /limitcast:memory-audit`,
    };
  const parts = [
    s.index.lines >= INDEX_LINES * 0.8 || s.index.bytes >= INDEX_BYTES * 0.8 ? 'index close to the cap' : '',
    s.orphans.length ? `${s.orphans.length} not linked from the index` : '',
    s.broken.length ? `${s.broken.length} broken link${s.broken.length === 1 ? '' : 's'}` : '',
    s.big.length ? `${s.big.length} file${s.big.length === 1 ? '' : 's'} over ${BIG_LINES} lines` : '',
  ].filter(Boolean);
  const next = s.big.length ? '/limitcast:memory-audit, then /limitcast:memory-split' : '/limitcast:memory-audit';
  return { ok: true, line: `Memory: ${s.files} files, ${size}${parts.length ? `; ${parts.join(', ')}. Run ${next}` : ', no problems'}` };
}

/** The sweep `/limitcast:memory-audit` and `/limitcast:memory-split` start from.
 * @param {ReturnType<typeof scanMemory>} s
 * @param {string} [dir] shown when there is no index */
export function memoryReport(s, dir = '') {
  if (!s) return `No auto-memory index (MEMORY.md) in ${dir.replace(homedir(), '~')}`;
  const out = [
    `Memory: ${s.dir.replace(homedir(), '~')}`,
    `Index: MEMORY.md ${s.index.lines} / ${INDEX_LINES} lines, ${(s.index.bytes / 1000).toFixed(1)} / 25 KB${overCap(s) ? ' (OVER: what is past the cap is never loaded)' : ''}`,
    `Topic files: ${s.files}`,
  ];
  if (s.orphans.length) out.push(`Not linked from the index (${s.orphans.length}): ${s.orphans.join(', ')}`);
  if (s.broken.length) out.push(`Broken links (${s.broken.length}): ${s.broken.map((b) => `${b.from} -> ${b.target}`).join(', ')}`);
  if (s.big.length)
    out.push(
      `Over ${BIG_LINES} lines or 24 KB (${s.big.length}): ${s.big.map((b) => `${b.name} (${b.lines} lines, ${Math.round(b.bytes / 1000)} KB)`).join(', ')}`,
    );
  return out.join('\n');
}
