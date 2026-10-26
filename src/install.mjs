// @ts-check
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './store.mjs';

export const settingsPath = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
export const codexHooksPath = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'hooks.json');
const MARK = 'limitcast';
// Codex reports the tool with a namespace prefix (e.g. "collaborationspawn_agent"); match it anywhere.
const CODEX_MATCHER = '.*spawn_agent.*';

/** Shell-quote one argument. @param {string} s */
const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The command hooks run: a launcher script in the state dir that runs this copy of limitcast (absolute node +
 * script, so hooks work without PATH) and outlives a Node upgrade, which moves both under nvm and Homebrew.
 */
export function selfCommand() {
  return `/bin/sh ${q(writeLauncher())}`;
}

export const launcherPath = () => join(stateDir(), 'limitcast-hook.sh');

/**
 * Write the hook launcher. If this node or script is gone, it runs `limitcast` from PATH; if that is gone too,
 * the status line still runs your own wrapped command and every other hook allows (exit 0).
 * @returns {string} its path
 */
export function writeLauncher(node = process.execPath, bin = realpathSync(fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url)))) {
  const path = launcherPath();
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      '# limitcast hook launcher, written by `limitcast install`. Survives Node upgrades.',
      `NODE=${q(node)}`,
      `BIN=${q(bin)}`,
      'if [ -x "$NODE" ] && [ -f "$BIN" ]; then exec "$NODE" "$BIN" "$@"; fi',
      'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"',
      'if command -v limitcast >/dev/null 2>&1; then exec limitcast "$@"; fi',
      '# limitcast is gone: keep your status line working, allow every hook.',
      'if [ "$1" = statusline ]; then',
      '  while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done',
      '  if [ $# -gt 0 ]; then shift; exec "$@"; fi',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return path;
}

/**
 * The node and script a launcher points at (null when it isn't a launcher).
 * @param {string} path
 */
export function launcherTargets(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const val = (/** @type {string} */ k) => {
      const m = new RegExp(`^${k}=(?:'((?:[^']|'\\\\'')*)'|(\\S+))$`, 'm').exec(text);
      return m ? (m[1] ?? m[2]).replace(/'\\''/g, "'") : null;
    };
    return { node: val('NODE'), bin: val('BIN') };
  } catch {
    return null;
  }
}

/**
 * Add the status-line recorder (wrapping any existing status line) and, optionally, the subagent guard.
 * Idempotent; backs up settings.json first; remembers the original status line for uninstall.
 * With `guard`, Codex gets the guard too when ~/.codex exists. With `alerts`, a SessionStart hook tells you
 * (never the model) when your starting context grew.
 * @param {{guard:boolean, alerts?:boolean, path?:string, codexPath?:string, self?:string}} opts
 */
export function install({ guard, alerts = false, path = settingsPath(), codexPath = codexHooksPath(), self = selfCommand() }) {
  const cfg = readSettings(path);
  backup(path);
  const changes = [];
  const current = cfg.statusLine?.command;
  if (!current?.includes(MARK)) {
    cfg.statusLine = {
      ...(cfg.statusLine ?? { type: 'command' }),
      type: 'command',
      command: current ? `${self} statusline -- sh -c ${q(current)}` : `${self} statusline`,
    };
    changes.push(current ? 'wrapped your status line' : 'added a status line');
  } else {
    cfg.statusLine.command = current.replace(/^.*? statusline\b/, `${self} statusline`);
    changes.push('status line already installed (command path refreshed)');
  }
  if (guard) {
    upsertGuard(cfg, { matcher: 'Task|Agent', hooks: [{ type: 'command', command: `${self} guard`, timeout: 10 }] });
    upsertHook(cfg, 'UserPromptSubmit', { hooks: [{ type: 'command', command: `${self} prompt-check`, timeout: 10 }] }, isPromptCheck);
    upsertHook(cfg, 'SubagentStop', { matcher: '', hooks: [{ type: 'command', command: `${self} subagent-receipt`, timeout: 15 }] }, isReceipt);
    changes.push('added the Claude Code subagent guard, subagent receipts and the cold-cache warning');
  }
  if (alerts) {
    upsertHook(cfg, 'SessionStart', { matcher: '', hooks: [{ type: 'command', command: `${self} drift --hook`, timeout: 15 }] }, isAlert);
    changes.push('added the starting-context alert');
  }
  writeSettings(path, cfg);
  if (guard && existsSync(join(codexPath, '..'))) {
    const codex = readSettings(codexPath);
    backup(codexPath);
    upsertGuard(codex, { matcher: CODEX_MATCHER, hooks: [{ type: 'command', command: `${self} guard`, timeout: 10 }] });
    writeSettings(codexPath, codex);
    changes.push('added the Codex subagent guard (Codex runs it after you trust it: start Codex and approve the new hook)');
  }
  return changes;
}

/**
 * Put the guard in PreToolUse: update it where it is, else append.
 * Codex trusts hooks by their position, so existing hooks must keep their places.
 * @param {any} cfg
 * @param {any} entry
 */
function upsertGuard(cfg, entry) {
  upsertHook(cfg, 'PreToolUse', entry, isGuard);
}

/**
 * Put limitcast's entry in one hook event: update it where it is, else append.
 * @param {any} cfg
 * @param {string} event
 * @param {any} entry
 * @param {(h:any)=>boolean} mine
 */
function upsertHook(cfg, event, entry, mine) {
  cfg.hooks ??= {};
  const list = (cfg.hooks[event] ??= []);
  const i = list.findIndex(mine);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
}

/**
 * Remove everything limitcast added and restore the original status line.
 * @param {{path?:string, codexPath?:string}} [opts]
 */
export function uninstall({ path = settingsPath(), codexPath = codexHooksPath() } = {}) {
  const cfg = readSettings(path);
  backup(path);
  const changes = [];
  if (cfg.statusLine?.command?.includes(MARK)) {
    const prev = wrappedCommand(cfg.statusLine.command);
    if (prev) cfg.statusLine.command = prev;
    else delete cfg.statusLine;
    changes.push(prev ? 'restored your original status line' : 'removed the status line');
  }
  const before = cfg.hooks?.PreToolUse?.length ?? 0;
  if (before) {
    cfg.hooks.PreToolUse = cfg.hooks.PreToolUse.filter((/** @type {any} */ h) => !isGuard(h));
    if (cfg.hooks.PreToolUse.length < before) changes.push('removed the Claude Code subagent guard');
  }
  for (const [event, mine, what] of /** @type {[string, (h:any)=>boolean, string][]} */ ([
    ['SessionStart', isAlert, 'the starting-context alert'],
    ['UserPromptSubmit', isPromptCheck, 'the cold-cache warning'],
    ['SubagentStop', isReceipt, 'subagent receipts'],
  ])) {
    const n = cfg.hooks?.[event]?.length ?? 0;
    if (!n) continue;
    cfg.hooks[event] = cfg.hooks[event].filter((/** @type {any} */ h) => !mine(h));
    if (cfg.hooks[event].length < n) changes.push(`removed ${what}`);
  }
  writeSettings(path, cfg);
  if (existsSync(codexPath)) {
    const codex = readSettings(codexPath);
    const list = codex.hooks?.PreToolUse ?? [];
    if (list.some(isGuard)) {
      backup(codexPath);
      codex.hooks.PreToolUse = list.filter((/** @type {any} */ h) => !isGuard(h));
      writeSettings(codexPath, codex);
      changes.push('removed the Codex subagent guard');
    }
  }
  return changes;
}

/**
 * The status-line command limitcast wraps, recovered from `... statusline -- <cmd>`; null if none.
 * @param {string} command
 */
export function wrappedCommand(command) {
  const rest = command.split(' statusline -- ')[1];
  if (!rest) return null;
  const m = rest.match(/^sh -c '((?:[^']|'\\'')*)'$/);
  if (m) return m[1].replace(/'\\''/g, "'");
  const plain = rest.match(/^sh -c (\S+)$/);
  return plain ? plain[1] : rest;
}

/**
 * Which optional parts are installed, so `doctor --fix` can re-install exactly those.
 * @param {string} [path]
 */
export function installedFeatures(path = settingsPath()) {
  const cfg = readSettings(path);
  return {
    statusLine: Boolean(cfg.statusLine?.command?.includes(MARK)),
    guard: (cfg.hooks?.PreToolUse ?? []).some(isGuard),
    alerts: (cfg.hooks?.SessionStart ?? []).some(isAlert),
  };
}

/** @param {any} h */
const isGuard = (h) =>
  (h.hooks ?? []).some((/** @type {any} */ x) => typeof x.command === 'string' && x.command.includes(MARK) && /\bguard\b/.test(x.command));
/** @param {RegExp} re @returns {(h:any)=>boolean} */
const runs = (re) => (h) =>
  (h.hooks ?? []).some((/** @type {any} */ x) => typeof x.command === 'string' && x.command.includes(MARK) && re.test(x.command));
const isAlert = runs(/\bdrift --hook\b/);
const isPromptCheck = runs(/\bprompt-check\b/);
const isReceipt = runs(/\bsubagent-receipt\b/);

/** @param {string} path */
export function readSettings(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    // Refuse to rewrite a file we can't parse: that would destroy the user's settings.
    throw new Error(`${path} is not valid JSON; fix it first (${e instanceof Error ? e.message : e})`);
  }
}

/** @param {string} path @param {any} cfg */
function writeSettings(path, cfg) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** @param {string} path */
function backup(path) {
  if (existsSync(path)) copyFileSync(path, `${path}.limitcast-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

/**
 * Is the Codex guard installed, and has Codex trusted it? Codex records trust in config.toml per hook position.
 * @param {string} codexPath
 */
function codexGuardCheck(codexPath) {
  let list = [];
  try {
    list = readSettings(codexPath).hooks?.PreToolUse ?? [];
  } catch (e) {
    return { ok: false, line: String(e instanceof Error ? e.message : e) };
  }
  const i = list.findIndex(isGuard);
  if (i < 0) return { ok: true, line: 'Codex subagent guard not installed (optional: `limitcast install --guard`)' };
  let toml = '';
  try {
    toml = readFileSync(join(codexPath, '..', 'config.toml'), 'utf8');
  } catch {
    /* no config yet */
  }
  const trusted = toml.includes(`hooks.json:pre_tool_use:${i}:0"]`);
  return trusted
    ? { ok: true, line: 'Codex subagent guard installed and trusted' }
    : { ok: false, line: 'Codex subagent guard installed but not trusted yet: start Codex and approve the new hook' };
}

/**
 * Health checks: settings wired, the node path in them still exists, data arriving, license state.
 * @param {{path?:string, codexPath?:string, samplesAgeMs:number|null, license:ReturnType<typeof import('./license.mjs').currentLicense>}} info
 * @returns {{ok:boolean, line:string}[]}
 */
export function doctor({ path = settingsPath(), codexPath = codexHooksPath(), samplesAgeMs, license }) {
  /** @type {{ok:boolean, line:string}[]} */
  const out = [];
  const major = Number(process.versions.node.split('.')[0]);
  out.push({ ok: major >= 20, line: `Node ${process.versions.node}${major >= 20 ? '' : ' (need 20+)'}` });
  let cfg = {};
  try {
    cfg = readSettings(path);
  } catch (e) {
    out.push({ ok: false, line: String(e instanceof Error ? e.message : e) });
  }
  const sl = /** @type {any} */ (cfg).statusLine?.command ?? '';
  out.push({
    ok: sl.includes(MARK),
    line: sl.includes(MARK) ? 'Status-line recorder installed' : 'Status-line recorder missing: run `limitcast install`',
  });
  const launcher = /^\/bin\/sh '?([^' ]+limitcast-hook\.sh)'?/.exec(sl)?.[1];
  const targets = launcher ? launcherTargets(launcher) : null;
  if (sl.includes(MARK) && targets) {
    const ok = Boolean(targets.node && existsSync(targets.node) && targets.bin && existsSync(targets.bin));
    out.push({
      ok,
      line: ok
        ? 'Hook launcher points at this Node and limitcast'
        : 'Node or limitcast moved (a Node upgrade?): hooks fall back to `limitcast` on PATH. Fix: `limitcast doctor --fix`',
    });
  } else if (sl.includes(MARK)) {
    // Installed before 0.10: settings call node directly.
    const exe = sl.match(/^'([^']+)'|^(\S+)/);
    const exePath = exe?.[1] ?? exe?.[2];
    if (exePath?.startsWith('/'))
      out.push({
        ok: existsSync(exePath),
        line: existsSync(exePath)
          ? 'Node path in settings exists (`limitcast doctor --fix` switches to the upgrade-proof launcher)'
          : `Node path in settings is gone (${exePath}): run \`limitcast doctor --fix\``,
      });
  }
  const hooks = /** @type {any} */ (cfg).hooks ?? {};
  const guard = (hooks.PreToolUse ?? []).some(isGuard);
  out.push({
    ok: true,
    line: guard ? 'Claude Code subagent guard installed' : 'Claude Code subagent guard not installed (optional: `limitcast install --guard`)',
  });
  // Installed with --guard before 0.11: the cold-cache warning and subagent receipts are missing until a re-install.
  const newer = (hooks.UserPromptSubmit ?? []).some(isPromptCheck) && (hooks.SubagentStop ?? []).some(isReceipt);
  if (guard && !newer)
    out.push({
      ok: !license?.ok,
      line: 'Cold-cache warning and subagent receipts not installed yet: run `limitcast doctor --fix`',
    });
  if (existsSync(codexPath)) out.push(codexGuardCheck(codexPath));
  out.push(
    samplesAgeMs === null
      ? { ok: false, line: 'No Claude limit readings yet: send a message in Claude Code' }
      : { ok: samplesAgeMs < 24 * 3600_000, line: `Last Claude reading ${Math.round(samplesAgeMs / 60_000)} min ago` },
  );
  out.push({
    ok: license?.ok !== false,
    line: license === null ? 'Free tier' : license.ok ? `Pro: ${license.claims.e}${proTerm(license.claims)}` : `License problem: ${license.reason}`,
  });
  return out;
}

/** @param {{p:string, i:number, x:number}} c */
function proTerm(c) {
  const day = (/** @type {number} */ s) => new Date(s * 1000).toISOString().slice(0, 10);
  if (c.x) return `, ${c.p === 'polar' ? 'valid until' : 'renews'} ${day(c.x)}`;
  // A Polar key has no end date for Lifetime or an active subscription; the weekly check is what keeps it honest.
  return c.p === 'polar' ? `, last checked with Polar ${day(c.i)}` : ', lifetime';
}
