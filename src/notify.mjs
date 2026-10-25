// @ts-check
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * Show a desktop notification. macOS: through limitcast's own notifier app, so it is listed as "limitcast" in
 * System Settings → Notifications (osascript's notifications are attributed to Script Editor, which may not be
 * listed at all). Linux: notify-send. Fire and forget.
 * @param {string} message
 */
export function send(message) {
  if (process.platform === 'darwin' && existsSync(notifierApp())) {
    appendFileSync(queueFile(), `${message.replace(/\n/g, ' ')}\n`);
    run('open', ['-g', '-a', notifierApp()]);
    return;
  }
  if (process.platform === 'darwin') run('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "limitcast"`]);
  else run('notify-send', ['limitcast', message]);
}

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // no notifier installed: nothing to do
  child.unref();
}

export const notifierApp = () => join(stateDir(), 'limitcast.app');
const queueFile = () => join(stateDir(), 'notify-queue.txt');

/**
 * Build the macOS notifier: a tiny AppleScript app (bundle id dev.limitcast.notifier, no Dock icon) that shows
 * every queued message and exits. Built with the tools macOS ships (osacompile, plutil, codesign); ad-hoc signed.
 * @returns {boolean} whether the app is ready
 */
export function buildNotifierApp() {
  if (process.platform !== 'darwin') return false;
  mkdirSync(stateDir(), { recursive: true });
  const app = notifierApp();
  const src = join(stateDir(), 'notifier.applescript');
  const q = queueFile().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  writeFileSync(
    src,
    [
      'on run',
      `\tset q to "${q}"`,
      '\ttry',
      `\t\tset msgs to do shell script "f=" & quoted form of q & "; if [ -f \\"$f\\" ]; then cat \\"$f\\"; rm -f \\"$f\\"; fi"`,
      '\ton error',
      '\t\treturn',
      '\tend try',
      '\trepeat with m in paragraphs of msgs',
      '\t\tif (length of (m as text)) > 0 then display notification (m as text) with title "limitcast"',
      '\tend repeat',
      '\tdelay 2', // let Notification Center take the messages before the app exits
      'end run',
      '',
    ].join('\n'),
  );
  rmSync(app, { recursive: true, force: true });
  const plist = join(app, 'Contents', 'Info.plist');
  const steps = [
    ['osacompile', ['-o', app, src]],
    ['plutil', ['-replace', 'CFBundleIdentifier', '-string', 'dev.limitcast.notifier', plist]],
    ['plutil', ['-replace', 'CFBundleName', '-string', 'limitcast', plist]],
    ['plutil', ['-replace', 'LSUIElement', '-bool', 'true', plist]],
    ['codesign', ['--force', '--sign', '-', app]],
  ];
  for (const [cmd, args] of /** @type {[string, string[]][]} */ (steps)) {
    if (spawnSync(cmd, args, { stdio: 'ignore' }).status !== 0) return false;
  }
  return existsSync(app);
}
