// @ts-check
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './store.mjs';

// Desktop notifications (Pro, opt-in): one per change of state, raised from the status line.

const flag = () => join(stateDir(), 'notify.on');
const stateFile = () => join(stateDir(), 'notified.json');
const RANK = { OK: 0, RESET: 0, NEAR: 1, AT_RISK: 2, HIT: 3 };
const NAMES = { claude: 'Claude', codex: 'Codex' };

export const notifyEnabled = () => existsSync(flag());

/** @param {boolean} on */
export function setNotify(on) {
  mkdirSync(stateDir(), { recursive: true });
  if (on) writeFileSync(flag(), '');
  else rmSync(flag(), { force: true });
}

/**
 * Messages for windows that got worse since the last notification, or reset after reaching their limit.
 * Within one window the state only ratchets up, so a pace that wobbles around a threshold notifies once.
 * @param {{src:string, win:string, pct:number, reset:number, wall:number|null, verdict:string}[]} rows
 * @param {Record<string, {reset:number, verdict:string}>} prev
 * @param {(ms:number)=>string} clock
 */
export function transitions(rows, prev, clock) {
  const messages = [];
  const next = { ...prev };
  for (const f of rows) {
    const key = `${f.src}|${f.win}`;
    const name = `${NAMES[/** @type {'claude'} */ (f.src)] ?? f.src} ${f.win}`;
    const p = prev[key];
    const sameWindow = p && Math.abs(p.reset - f.reset) <= 120_000;
    if (!sameWindow) {
      if (p?.verdict === 'HIT' && f.verdict !== 'HIT') messages.push(`${name} limit reset: you're clear.`);
      next[key] = { reset: f.reset, verdict: 'OK' };
    }
    const before = next[key].verdict;
    const rank = RANK[/** @type {'OK'} */ (f.verdict)] ?? 0;
    if (rank <= (RANK[/** @type {'OK'} */ (before)] ?? 0)) continue;
    next[key] = { reset: f.reset, verdict: f.verdict };
    if (f.verdict === 'NEAR') messages.push(`${name} limit is at ${Math.round(f.pct)}%. Resets ${clock(f.reset)}.`);
    if (f.verdict === 'AT_RISK' && f.wall)
      messages.push(`${name} limit is on pace to run out at ${clock(f.wall)}, before it resets at ${clock(f.reset)}.`);
    if (f.verdict === 'HIT') messages.push(`${name} limit reached. Resets ${clock(f.reset)}.`);
  }
  return { messages, next };
}

/**
 * Check the rows against what was last notified and send what's new. Never throws.
 * @param {Parameters<typeof transitions>[0]} rows
 * @param {(ms:number)=>string} clock
 */
export function notifyChanges(rows, clock) {
  try {
    let prev = {};
    try {
      prev = JSON.parse(readFileSync(stateFile(), 'utf8'));
    } catch {
      /* first run */
    }
    const { messages, next } = transitions(rows, prev, clock);
    if (JSON.stringify(next) !== JSON.stringify(prev)) writeFileSync(stateFile(), JSON.stringify(next));
    for (const m of messages) send(m);
    return messages;
  } catch {
    return [];
  }
}

/**
 * Show a desktop notification: macOS through osascript, Linux through notify-send. Fire and forget.
 * @param {string} message
 */
export function send(message) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['osascript', ['-e', `display notification ${JSON.stringify(message)} with title "limitcast"`]]
      : ['notify-send', ['limitcast', message]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // no notifier installed: nothing to do
  child.unref();
}
