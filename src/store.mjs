// @ts-check
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** @typedef {import('./forecast.mjs').Sample} Sample */

export const KEEP_MS = 8 * 24 * 3600_000;
const PRUNE_BYTES = 1_000_000;

export function stateDir() {
  return process.env.LIMITCAST_STATE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'limitcast');
}

/** Write through a temp file and rename, so a hook reading at the same moment never sees a half-written file. */
export function writeAtomic(/** @type {string} */ path, /** @type {string} */ text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Append samples whose pct or reset changed since the last one for the same series.
 * The status line fires on every message, so unchanged readings are skipped.
 * @param {Sample[]} samples
 */
export function record(samples) {
  if (!samples.length) return;
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const lastPath = join(dir, 'last.json');
  /** @type {Record<string, {pct:number, reset:number}>} */
  let last = {};
  try {
    last = JSON.parse(readFileSync(lastPath, 'utf8'));
  } catch {
    /* first run or corrupt: start fresh */
  }
  const key = (/** @type {Sample} */ s) => `${s.src}:${s.win}:${s.sid ?? ''}`;
  const fresh = samples.filter((s) => {
    const prev = last[key(s)];
    return !prev || prev.pct !== s.pct || prev.reset !== s.reset;
  });
  if (!fresh.length) return;
  const file = join(dir, 'samples.jsonl');
  appendFileSync(file, `${fresh.map((s) => JSON.stringify(s)).join('\n')}\n`);
  for (const s of fresh) last[key(s)] = { pct: s.pct, reset: s.reset };
  writeAtomic(lastPath, JSON.stringify(last));
  if (statSync(file).size > PRUNE_BYTES)
    writeAtomic(
      file,
      load(Date.now() - KEEP_MS)
        .map((s) => `${JSON.stringify(s)}\n`)
        .join(''),
    );
}

/**
 * @param {number} since epoch ms
 * @returns {Sample[]}
 */
export function load(since) {
  const file = join(stateDir(), 'samples.jsonl');
  if (!existsSync(file)) return [];
  /** @type {Sample[]} */
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const s = JSON.parse(line);
      if (s.t >= since) out.push(s);
    } catch {
      /* skip a torn line from a concurrent write */
    }
  }
  return out;
}
