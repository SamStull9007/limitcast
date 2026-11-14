// @ts-check
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

// Codex trusts a hook by a hash of its definition (`trusted_hash` in config.toml), which cannot be recomputed from outside:
// a hook that was edited keeps its key and still fails the hash. So ask Codex itself, the way its own /hooks screen does:
// the app server's `hooks/list` says each hook's trust status.

/** @typedef {{key:string, trustStatus:string, enabled:boolean, command:string}} HookRow */

/**
 * Every hook Codex has configured for `cwd`, with its trust status. Null when Codex does not answer.
 * @param {{cwd?:string, timeoutMs?:number, command?:string[]}} [o] command: the app-server command line, `codex app-server` by default
 * @returns {Promise<HookRow[]|null>}
 */
export function codexHooks({ cwd = homedir(), timeoutMs = 15_000, command = ['codex', 'app-server'] } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command[0], command.slice(1), { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    /** @param {HookRow[]|null} rows */
    const finish = (rows) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(rows);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    /** @param {unknown} msg */
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg?.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
      } else if (msg?.id === 2) {
        if (msg.error) return finish(null);
        const rows = (msg.result?.data ?? []).flatMap((/** @type {any} */ entry) => entry?.hooks ?? []);
        finish(
          rows.map((/** @type {any} */ h) => ({
            key: String(h.key ?? ''),
            trustStatus: String(h.trustStatus ?? ''),
            enabled: h.enabled !== false,
            command: String(h.command ?? ''),
          })),
        );
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'limitcast-doctor', title: 'limitcast doctor', version: '1' } } });
  });
}

/**
 * Doctor line for limitcast's own hooks, from what Codex says about them. Null when none of them is configured.
 * @param {HookRow[]} rows
 * @returns {{ok:boolean, line:string}|null}
 */
export function trustLine(rows) {
  const mine = rows.filter((h) => /limitcast/i.test(h.command));
  if (!mine.length) return null;
  const waiting = mine.filter((h) => h.trustStatus !== 'trusted');
  if (!waiting.length) return { ok: true, line: `Codex hooks: all ${mine.length} limitcast hooks are trusted` };
  const what = waiting
    .map((h) => h.key.replace(/^.*[\\/]/, '').replace(/^hooks\.json:/, ''))
    .slice(0, 4)
    .join(', ');
  return {
    ok: false,
    line: `Codex hooks: ${waiting.length} of ${mine.length} limitcast hooks are not trusted (${what}): start Codex, open /hooks and approve them. Codex skips an unreviewed hook`,
  };
}
