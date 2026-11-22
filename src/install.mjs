// @ts-check
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grokDoctor, grokHome, grokPresent, installGrok, uninstallGrok } from './grok.mjs';
import { stateDir } from './store.mjs';
import { editFiles, readText } from './transaction.mjs';

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
export function selfCommand(files) {
  return `/bin/sh ${q(writeLauncher(undefined, undefined, files))}`;
}

export const launcherPath = () => join(stateDir(), 'limitcast-hook.sh');

/**
 * Write the hook launcher. If this node or script is gone, it runs `limitcast` from PATH; if that is gone too,
 * the status line still runs your own wrapped command and every other hook allows (exit 0).
 * @returns {string} its path
 */
export function writeLauncher(node = process.execPath, bin = realpathSync(fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url))), files) {
  const path = launcherPath();
  const text = [
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
  ].join('\n');
  if (files) files.write(path, text);
  else {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(path, text, { mode: 0o755 });
  }
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
 * @param {{guard:boolean, alerts?:boolean, optimize?:boolean, path?:string, codexPath?:string, grokDir?:string, self?:string}} opts
 */
export function install(options) {
  return editFiles(join(stateDir(), 'install-state.json'), (files) => installSettings(options, files));
}

function installSettings(
  { guard, alerts = false, optimize = false, path = settingsPath(), codexPath = codexHooksPath(), grokDir = grokHome(), self },
  files,
) {
  const read = (path) => readHookSettings(path, files.read);
  const write = (path, cfg) => files.write(path, `${JSON.stringify(cfg, null, 2)}\n`);
  if (self === undefined) self = selfCommand(files);
  const cfg = read(path);
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
    upsertHook(
      cfg,
      'PostToolUse',
      { matcher: 'Bash|Read|Grep|WebFetch|mcp__.*', hooks: [{ type: 'command', command: `${self} tool-check`, timeout: 10 }] },
      isToolCheck,
    );
    changes.push('added the large tool-output notice');
    upsertHook(cfg, 'PreToolUse', { matcher: 'Read|Grep', hooks: [{ type: 'command', command: `${self} tool-limit`, timeout: 10 }] }, isToolLimit);
    changes.push('added the fat-tool limit check');
  }
  if (optimize) {
    addOptimizerHooks(cfg, self, 'claude', { notice: alerts || hostHasAlerts(cfg) });
    changes.push('added opt-in repository optimizer hooks (learning and map injection remain off until enabled per repository)');
  }
  foldToolNotice(cfg);
  write(path, cfg);
  if (guard && existsSync(join(codexPath, '..'))) {
    const codex = read(codexPath);
    upsertGuard(codex, { matcher: CODEX_MATCHER, hooks: [{ type: 'command', command: `${self} guard`, timeout: 10 }] });
    // A subagent's stop clears the duplicate-spawn hold; without it a finished spawn blocks its own retry for 30 minutes.
    upsertHook(codex, 'SubagentStop', { matcher: '', hooks: [{ type: 'command', command: `${self} subagent-receipt`, timeout: 15 }] }, isReceipt);
    // Codex has no status line, so its limit notifications (limitcast notify on) are raised from a throttled Stop hook.
    upsertHook(codex, 'Stop', { matcher: '', hooks: [{ type: 'command', command: `${self} codex-notify --hook`, timeout: 5 }] }, isCodexNotify);
    write(codexPath, codex);
    changes.push(
      'added the Codex subagent guard and limit notifications (Codex runs them after you trust them: start Codex and approve the new hooks)',
    );
  }
  if (alerts && existsSync(join(codexPath, '..'))) {
    const codex = read(codexPath);
    // Codex has no native Read/Grep controls. Keep result notices and remove the legacy generic MCP pre-call hold.
    upsertHook(
      codex,
      'PostToolUse',
      { matcher: 'Bash|mcp__.*', hooks: [{ type: 'command', command: `${self} tool-check --src codex`, timeout: 10 }] },
      isToolCheck,
    );
    removeHooks(codex, 'PreToolUse', isToolLimit);
    upsertHook(
      codex,
      'SessionStart',
      { matcher: '', hooks: [{ type: 'command', command: `${self} drift --hook --src codex`, timeout: 15 }] },
      isAlert,
    );
    foldToolNotice(codex);
    write(codexPath, codex);
    changes.push('added the Codex starting-context alert, large tool-output notice and fat-tool limit check (approve the new hooks in Codex)');
  }
  const grokAlertFile = join(grokDir, 'hooks', 'limitcast.json');
  const grokOptimizerFile = join(grokDir, 'hooks', 'limitcast-optimize.json');
  const grokHadAlerts = existsSync(grokAlertFile) && /\b(?:tool-check|tool-limit|drift --hook)\b/.test(files.read(grokAlertFile) ?? '');
  const grokHadOptimizer = existsSync(grokOptimizerFile) && /\b_optimize-hook\b/.test(files.read(grokOptimizerFile) ?? '');
  const grokShareNotice = grokPresent(grokDir) && (alerts || grokHadAlerts) && (optimize || grokHadOptimizer);
  if (grokPresent(grokDir)) changes.push(...installGrok({ guard, alerts, self, home: grokDir, shareNotice: grokShareNotice }, files));
  if (optimize && existsSync(join(codexPath, '..'))) {
    const codex = read(codexPath);
    addOptimizerHooks(codex, self, 'codex', { notice: alerts || hostHasAlerts(codex) });
    foldToolNotice(codex);
    write(codexPath, codex);
    changes.push('added Codex optimizer hooks; review and trust the new hooks in Codex, then restart');
  }
  if (optimize && grokPresent(grokDir)) {
    const grok = read(grokOptimizerFile);
    addOptimizerHooks(grok, self, 'grok', { notice: grokShareNotice });
    write(grokOptimizerFile, grok);
    changes.push('added Grok optimizer hooks');
  } else if (grokShareNotice) ensureGrokNotice(grokOptimizerFile, files);
  return changes;
}

function addOptimizerHooks(cfg, self, host, { notice = false } = {}) {
  const events = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'];
  // Codex reports failed calls through PostToolUse; its native hook schema has no failure event.
  for (const event of events.filter((e) => host !== 'codex' || e !== 'PostToolUseFailure'))
    upsertHook(
      cfg,
      event,
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `${self} _optimize-hook --src ${host}${notice && event === 'PostToolUse' ? ' --notice' : ''}`,
            timeout: host === 'codex' && event === 'SessionEnd' ? 3 : 10,
          },
        ],
      },
      isOptimizer,
    );
}

function removeOptimizerHooks(cfg) {
  for (const event of Object.keys(cfg.hooks ?? {})) removeHooks(cfg, event, isOptimizer);
}

/** A matcher group can contain other tools' commands; ownership applies to each command. */
function removeHooks(cfg, event, mine) {
  let removed = 0;
  if (!cfg.hooks?.[event]) return removed;
  cfg.hooks[event] = cfg.hooks[event].flatMap((entry) => {
    const hooks = entry.hooks.filter((hook) => !mine({ hooks: [hook] }));
    removed += entry.hooks.length - hooks.length;
    return hooks.length === entry.hooks.length ? [entry] : hooks.length ? [{ ...entry, hooks }] : [];
  });
  return removed;
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
  if (i >= 0) {
    const previous = list[i];
    const olds = previous.hooks.filter((hook) => mine({ hooks: [hook] })).map((hook) => hook.command);
    entry = { ...entry, hooks: entry.hooks.map((hook) => ({ ...hook, command: keepWrapper(olds, hook.command) })) };
    if (previous.hooks.every((hook) => mine({ hooks: [hook] }))) list[i] = { ...previous, ...entry };
    else {
      // Keep sibling commands and their matcher in place; give our command its required matcher separately.
      const at = previous.hooks.findIndex((hook) => mine({ hooks: [hook] }));
      if ((previous.matcher ?? '') === (entry.matcher ?? '')) previous.hooks.splice(at, 1, ...entry.hooks);
      else {
        previous.hooks = previous.hooks.filter((hook) => !mine({ hooks: [hook] }));
        list.push(entry);
      }
    }
  } else list.push(entry);
}

/**
 * A user's wrapper around our hook command (`adapter … sh -c '<our command>'`) survives reinstall and `doctor --fix`:
 * only our invocation inside it is replaced. A changed launcher path cannot be found inside, so that falls back to ours.
 * @param {unknown[]} olds previous commands of ours in this group
 * @param {string} command
 */
export function keepWrapper(olds, command) {
  const base = command.replace(/ --notice$/, '');
  for (const old of olds) {
    if (typeof old !== 'string') continue;
    const at = old.indexOf(base);
    if (at < 0) continue;
    let end = at + base.length;
    if (old.startsWith(' --notice', end)) end += ' --notice'.length;
    if (at === 0 && end === old.length) return command;
    if (!/^(?:$|['"\s;|&)])/.test(old.slice(end)) || !/(?:^|['"\s(])$/.test(old.slice(0, at))) continue;
    return old.slice(0, at) + command + old.slice(end);
  }
  return command;
}

/**
 * Remove everything limitcast added and restore the original status line.
 * @param {{path?:string, codexPath?:string, grokDir?:string}} [opts]
 */
export function uninstall(options = {}) {
  return editFiles(join(stateDir(), 'install-state.json'), (files) => uninstallSettings(options, files));
}

function uninstallSettings({ path = settingsPath(), codexPath = codexHooksPath(), grokDir = grokHome() }, files) {
  const read = (path) => readHookSettings(path, files.read);
  const write = (path, cfg) => files.write(path, `${JSON.stringify(cfg, null, 2)}\n`);
  const cfg = read(path);
  const changes = [];
  if (cfg.statusLine?.command?.includes(MARK)) {
    const prev = wrappedCommand(cfg.statusLine.command);
    if (prev) cfg.statusLine.command = prev;
    else delete cfg.statusLine;
    changes.push(prev ? 'restored your original status line' : 'removed the status line');
  }
  if (removeHooks(cfg, 'PreToolUse', isGuard)) changes.push('removed the Claude Code subagent guard');
  for (const [event, mine, what] of /** @type {[string, (h:any)=>boolean, string][]} */ ([
    ['SessionStart', isAlert, 'the starting-context alert'],
    ['UserPromptSubmit', isPromptCheck, 'the cold-cache warning'],
    ['SubagentStop', isReceipt, 'subagent receipts'],
    ['PostToolUse', isToolCheck, 'the large tool-output notice'],
    ['PreToolUse', isToolLimit, 'the fat-tool limit check'],
  ])) {
    if (removeHooks(cfg, event, mine)) changes.push(`removed ${what}`);
  }
  removeOptimizerHooks(cfg);
  write(path, cfg);
  if (existsSync(codexPath)) {
    const codex = read(codexPath);
    const list = codex.hooks?.PreToolUse ?? [];
    const ours = (/** @type {any} */ h) => isOptimizer(h) || isReceipt(h) || isToolCheck(h) || isToolLimit(h) || isCodexNotify(h) || isAlert(h);
    if (list.some(isGuard) || Object.values(codex.hooks ?? {}).some((entries) => entries.some(ours))) {
      removeHooks(codex, 'PreToolUse', (h) => isGuard(h) || isToolLimit(h));
      removeHooks(codex, 'SubagentStop', isReceipt);
      removeHooks(codex, 'PostToolUse', isToolCheck);
      removeHooks(codex, 'Stop', isCodexNotify);
      removeHooks(codex, 'SessionStart', isAlert);
      removeOptimizerHooks(codex);
      write(codexPath, codex);
      changes.push('removed the Codex subagent guard');
    }
  }
  changes.push(...uninstallGrok({ home: grokDir }, files));
  const optimizerPath = join(grokDir, 'hooks', 'limitcast-optimize.json');
  if (existsSync(optimizerPath)) {
    const grok = read(optimizerPath);
    removeOptimizerHooks(grok);
    write(optimizerPath, grok);
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
    ...((cfg.hooks?.SessionStart ?? []).some(isOptimizer) ? { optimize: true } : {}),
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
const isToolCheck = runs(/\btool-check\b/);
const isToolLimit = runs(/\btool-limit\b/);
const isCodexNotify = runs(/\bcodex-notify\b/);
const isOptimizer = runs(/\b_optimize-hook\b/);

/** Append `--notice` to our optimizer invocation, inside a user's wrapper when there is one. @param {string} command */
const addNotice = (command) => command.replace(/(\b_optimize-hook --src [^\s'"]+)/, '$1 --notice');

/** Alerts are the drift hook, the fat-tool check, or the standalone large-result notice. */
function hostHasAlerts(cfg) {
  return (
    (cfg.hooks?.PostToolUse ?? []).some(isToolCheck) ||
    (cfg.hooks?.SessionStart ?? []).some(isAlert) ||
    (cfg.hooks?.PreToolUse ?? []).some(isToolLimit)
  );
}

/**
 * When both features are installed, PostToolUse is the optimizer command with `--notice`.
 * The separate tool-check process is removed. Other optimizer events stay as they are.
 * @param {any} cfg
 */
function foldToolNotice(cfg) {
  const posts = cfg.hooks?.PostToolUse;
  if (!posts?.some(isOptimizer) || !hostHasAlerts(cfg)) return;
  for (const entry of posts) {
    if (!isOptimizer(entry)) continue;
    for (const hook of entry.hooks ?? []) {
      if (typeof hook.command === 'string' && /\b_optimize-hook\b/.test(hook.command) && !hook.command.includes(' --notice'))
        hook.command = addNotice(hook.command);
    }
  }
  removeHooks(cfg, 'PostToolUse', isToolCheck);
  if (!cfg.hooks.PostToolUse.length) delete cfg.hooks.PostToolUse;
}

/** Alerts installed after the optimizer: add `--notice` without rewriting the other optimizer events. @param {string} path */
function ensureGrokNotice(path, files) {
  if (!existsSync(path)) return;
  const cfg = readHookSettings(path, files.read);
  let changed = false;
  for (const entry of cfg.hooks?.PostToolUse ?? []) {
    if (!isOptimizer(entry)) continue;
    for (const hook of entry.hooks ?? []) {
      if (typeof hook.command === 'string' && /\b_optimize-hook\b/.test(hook.command) && !hook.command.includes(' --notice')) {
        hook.command = addNotice(hook.command);
        changed = true;
      }
    }
  }
  if (changed) files.write(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** @param {string} path */
export function readSettings(path, read = readText) {
  const text = read(path);
  if (text === null) return {};
  try {
    const cfg = JSON.parse(text);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('settings must be an object');
    return cfg;
  } catch (e) {
    // Refuse to rewrite a file we can't parse: that would destroy the user's settings.
    throw new Error(`${path} is not valid JSON; fix it first (${e instanceof Error ? e.message : e})`);
  }
}

function readHookSettings(path, read) {
  const cfg = readSettings(path, read);
  if (cfg.hooks !== undefined && (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)))
    throw new Error(`${path} has invalid hook groups; preserve it before retrying`);
  for (const entries of Object.values(cfg.hooks ?? {}))
    if (!Array.isArray(entries) || entries.some((entry) => !entry || !Array.isArray(entry.hooks)))
      throw new Error(`${path} has invalid hook groups; preserve it before retrying`);
  return cfg;
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
 * Health checks: settings wired, the node path in them still exists, data arriving, and the free distribution.
 * @param {{path?:string, codexPath?:string, samplesAgeMs:number|null, license?:ReturnType<typeof import('./license.mjs').currentLicense>}} info
 * @returns {{ok:boolean, line:string}[]}
 */
export function doctor({ path = settingsPath(), codexPath = codexHooksPath(), samplesAgeMs }) {
  /** @type {{ok:boolean, line:string}[]} */
  const out = [];
  const major = Number(process.versions.node.split('.')[0]);
  out.push({ ok: major >= 22, line: `Node ${process.versions.node}${major >= 22 ? '' : ' (need 22+)'}` });
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
  if ((hooks.SessionStart ?? []).some(isOptimizer))
    out.push({
      ok: true,
      line: 'Repository optimizer hooks configured (runtime delivery unmeasured); learning and map injection are per-repository opt-ins',
    });
  const guard = (hooks.PreToolUse ?? []).some(isGuard);
  out.push({
    ok: true,
    line: guard ? 'Claude Code subagent guard installed' : 'Claude Code subagent guard not installed (optional: `limitcast install --guard`)',
  });
  // Installed with --guard before 0.11: the cold-cache warning and subagent receipts are missing until a re-install.
  const newer = (hooks.UserPromptSubmit ?? []).some(isPromptCheck) && (hooks.SubagentStop ?? []).some(isReceipt);
  if (guard && !newer)
    out.push({
      ok: false,
      line: 'Cold-cache warning and subagent receipts not installed yet: run `limitcast doctor --fix`',
    });
  if (existsSync(codexPath)) out.push(codexGuardCheck(codexPath));
  out.push(...grokDoctor());
  out.push(
    samplesAgeMs === null
      ? { ok: false, line: 'No Claude limit readings yet: send a message in Claude Code' }
      : { ok: samplesAgeMs < 24 * 3600_000, line: `Last Claude reading ${Math.round(samplesAgeMs / 60_000)} min ago` },
  );
  out.push({
    ok: true,
    line: 'Free and open source (MIT License); all features available',
  });
  return out;
}
