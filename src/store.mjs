// @ts-check
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

const LOCK_WAIT_MS = 10_000;

function releaseLock(lock, owner) {
  try {
    unlinkSync(join(lock, owner));
    // A contender can replace the now-empty directory with its populated lock. Never remove that lock recursively.
    rmdirSync(lock);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

/** Serialize settings and trim transactions. Publish a populated owner directory atomically; reclaim only dead owners. */
export function withStateLock(change) {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'config.json.lock');
  const owner = `${process.pid}-${randomUUID()}`;
  const candidate = `${lock}.${owner}`;
  mkdirSync(candidate, { mode: 0o700 });
  let acquired = false;
  try {
    writeFileSync(join(candidate, owner), '', { mode: 0o600 });
    const start = Date.now();
    for (;;) {
      try {
        renameSync(candidate, lock);
        acquired = true;
        break;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
      try {
        for (const other of readdirSync(lock)) {
          const pid = /^(\d+)-[a-f0-9-]+$/.exec(other)?.[1];
          if (!pid) continue;
          try {
            process.kill(Number(pid), 0);
          } catch (error) {
            if (error.code === 'ESRCH') releaseLock(lock, other);
            else if (error.code !== 'EPERM') throw error;
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error('could not lock settings: another limitcast command is changing settings');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 + Math.floor(Math.random() * 8));
    }
    return change();
  } finally {
    if (acquired) releaseLock(lock, owner);
    rmSync(candidate, { recursive: true, force: true });
  }
}

/**
 * Change config.json under a lock: read it, let `change` return the new settings (or the same object to leave the file
 * alone), write it. Without the lock, two commands that each read the file and then each write it lose one change.
 * @param {(cfg: any) => any} change
 */
export function updateConfig(change) {
  return withStateLock(() => {
    const file = join(stateDir(), 'config.json');
    let cfg = {};
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('cannot read settings JSON; preserve config.json and repair it before retrying');
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('settings JSON must be an object; preserve config.json');
    const next = change(cfg);
    if (next !== cfg) writeAtomic(file, JSON.stringify(next));
  });
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
