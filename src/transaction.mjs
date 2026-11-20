import { copyFileSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { withStateLock, writeAtomic } from './store.mjs';

/** Stage every file before committing; adapters share the same journal and never write during planning. */
export function editFiles(ledger, change) {
  return withStateLock(() => {
    recoverTransaction(ledger);
    const files = new Map();
    const read = (path) => {
      if (!files.has(path)) {
        const before = readText(path);
        files.set(path, { path, before, after: before });
      }
      return files.get(path).after;
    };
    const write = (path, after) => {
      read(path);
      files.get(path).after = after;
    };
    const result = change({ read, write, remove: (path) => write(path, null) });
    const updates = [...files.values()];
    const changed = updates.filter((c) => c.before !== c.after);
    if (changed.length) {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-');
      for (const c of changed) {
        mkdirSync(dirname(c.path), { recursive: true });
        if (c.before !== null) copyFileSync(c.path, `${c.path}.limitcast-backup-${suffix}`);
      }
      commitTransaction(ledger, [], updates);
    }
    return result;
  });
}

export function readText(path) {
  try {
    if (!lstatSync(path).isFile()) throw new Error('refusing non-file configuration or recovery record');
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readLedger(path) {
  const text = readText(path);
  if (text === null) return [];
  try {
    const entries = JSON.parse(text);
    if (Array.isArray(entries) && entries.every((e) => e && typeof e === 'object' && !Array.isArray(e))) return entries;
  } catch {
    /* preserve invalid recovery evidence */
  }
  throw new Error('invalid trim ledger; preserve it and repair before retrying');
}

export function editText(path, edit) {
  const before = readText(path);
  return { path, before, after: edit(before) };
}

export function editJson(path, edit) {
  return editText(path, (before) => {
    let cfg;
    try {
      cfg = JSON.parse(before ?? '{}');
    } catch {
      throw new Error('invalid configuration JSON; original bytes preserved');
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('configuration must be an object');
    edit(cfg);
    return `${JSON.stringify(cfg, null, 2)}\n`;
  });
}

const write = (path, text) => (text === null ? unlinkSync(path) : writeAtomic(path, text));

/** Called under the state lock. Resolve a fully committed operation, or roll back a partial one without overwriting edits. */
export function recoverTransaction(ledger) {
  const journal = `${ledger}.pending.json`;
  const text = readText(journal);
  if (text === null) return;
  let tx;
  try {
    tx = JSON.parse(text);
  } catch {
    throw new Error('invalid trim recovery record; preserve it for manual recovery');
  }
  if (
    tx.version !== 1 ||
    !Array.isArray(tx.changes) ||
    !tx.changes.length ||
    tx.changes.at(-1)?.path !== ledger ||
    tx.changes.some((c) => !c || typeof c.path !== 'string' || ![c.before, c.after].every((v) => v === null || typeof v === 'string'))
  )
    throw new Error('unsupported trim recovery record; preserve it for manual recovery');
  const current = tx.changes.map((c) => readText(c.path));
  if (tx.changes.some((c, i) => current[i] !== c.before && current[i] !== c.after))
    throw new Error('configuration changed after interrupted trim; recovery record retained, reconcile manually');
  if (!tx.changes.every((c, i) => current[i] === c.after)) {
    for (const c of tx.changes.toReversed()) {
      if (readText(c.path) === c.after && c.before !== c.after) write(c.path, c.before);
    }
  }
  unlinkSync(journal);
}

/** Journal all original bytes before the first write, including the undo ledger. Caller holds the state lock. */
export function commitTransaction(ledger, entries, updates) {
  const changes = [...updates, editText(ledger, () => `${JSON.stringify(entries, null, 2)}\n`)];
  if (changes.some((c) => readText(c.path) !== c.before)) throw new Error('configuration changed during trim; retry after reviewing it');
  const journal = `${ledger}.pending.json`;
  writeAtomic(journal, JSON.stringify({ version: 1, changes }));
  try {
    for (const c of changes) {
      if (readText(c.path) !== c.before) throw new Error('configuration changed during trim');
      if (c.before !== c.after) write(c.path, c.after);
    }
    unlinkSync(journal);
  } catch (error) {
    recoverTransaction(ledger);
    throw error;
  }
}
