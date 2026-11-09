// @ts-check
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const fd = openSync(tmp, 'wx', mode);
  let closed = false;
  try {
    writeFileSync(fd, text);
    closeSync(fd);
    closed = true;
    renameSync(tmp, path);
  } finally {
    if (!closed) closeSync(fd);
    rmSync(tmp, { force: true });
  }
}

const LOCK_STALE_MS = 2_000; // the lock is held for one read and one write; older than this means its owner died
const LOCK_WAIT_MS = 5_000;

/**
 * Change config.json under a lock: read it, let `change` return the new settings (or the same object to leave the file
 * alone), write it. Without the lock, two commands that each read the file and then each write it lose one change.
 * shortcut: two waiters that break the same stale lock in the same instant can both write; fix with a lockfile library if seen.
 * @param {(cfg: any) => any} change
 */
export function updateConfig(change) {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.json');
  const lock = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock); // atomic: exactly one process creates it
      break;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released while we looked */
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`could not lock ${file}: another limitcast command is changing settings`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    let cfg = {};
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      /* new or corrupt: start fresh */
    }
    if (!cfg || typeof cfg !== 'object') cfg = {};
    const next = change(cfg);
    if (next !== cfg) writeAtomic(file, JSON.stringify(next));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
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
