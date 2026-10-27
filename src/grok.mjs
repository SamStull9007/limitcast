// @ts-check
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { codexServers, setEnabled } from './codex.mjs';
import { windowMs } from './forecast.mjs';
import { stateDir } from './store.mjs';
import { grokRoot } from './usage.mjs';

/** @typedef {import('./forecast.mjs').Sample} Sample */

export const grokHome = () => process.env.GROK_HOME ?? join(homedir(), '.grok');
export const grokConfigPath = () => join(grokHome(), 'config.toml');
export const grokHooksFile = () => join(grokHome(), 'hooks', 'limitcast.json');
const trimLedger = () => join(stateDir(), 'grok-trim-applied.json');
const statusLedger = () => join(stateDir(), 'grok-statusline.json');
const configFile = () => join(stateDir(), 'config.json');
const MARK = 'limitcast';
const TICKS = 10_000_000_000; // Grok costUsdTicks: 1e10 per USD
const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]/g, '_');

/** True when this command already runs limitcast's statusline (bin or `limitcast-hook.sh`). */
export function isLimitcastStatus(s) {
  return typeof s === 'string' && s.includes(MARK) && /\bstatusline\b/.test(s);
}

/** Grok is present when it has a config or sessions, not merely an empty GROK_HOME (tests create one). */
export function grokPresent(home = grokHome()) {
  return existsSync(join(home, 'config.toml')) || existsSync(join(home, 'sessions'));
}

/**
 * @param {string} [path]
 */
export const grokServers = (path = grokConfigPath()) => (existsSync(path) ? codexServers(readFileSync(path, 'utf8')) : []);

/**
 * MCP servers Grok actually called since `since`, from each session's events.jsonl (`mcp_tool_call_started.server_name`).
 * @param {number} since
 * @param {string} [root]
 */
export function grokUsedServers(since, root = grokRoot()) {
  /** @type {Set<string>} */
  const used = new Set();
  for (const file of grokSessionFiles(root, since, 'events.jsonl')) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"mcp_tool_call_started"')) continue;
      try {
        const ev = JSON.parse(line);
        if (ev?.type === 'mcp_tool_call_started' && typeof ev.server_name === 'string') used.add(norm(ev.server_name));
      } catch {
        /* torn line */
      }
    }
  }
  return used;
}

/**
 * Sizes from the newest session: the system prompt Grok loaded and the tool list (characters).
 * @param {string} [root]
 * @returns {{prompt:number, tools:number}|null}
 */
export function grokStartup(root = grokRoot()) {
  const usage = newestFile(root, (n) => n === 'usage.json');
  if (!usage) return null;
  const dir = dirname(usage);
  const size = (/** @type {string} */ n) => {
    const p = join(dir, n);
    return existsSync(p) ? statSync(p).size : 0;
  };
  return { prompt: size('system_prompt.txt'), tools: size('tool_definitions.json') };
}

/**
 * @param {{servers:{name:string, enabled:boolean|undefined}[], used:Set<string>, startup:{prompt:number, tools:number}|null, days:number, pro:boolean}} r
 */
export function grokTrimReport({ servers, used, startup, days, pro }) {
  const on = servers.filter((s) => s.enabled !== false);
  const unused = on.filter((s) => !used.has(norm(s.name)));
  const tok = (/** @type {number} */ c) => `${(c / 4000).toFixed(1)}k`;
  const out = ['# limitcast trim --grok', ''];
  if (startup)
    out.push(
      `Grok sessions start with ~${tok(startup.prompt)} tokens of system prompt and ~${tok(startup.tools)} of tool definitions, re-sent on every turn.`,
      '',
    );
  out.push(`## MCP servers: ${on.length} on, ${unused.length} not used in ${days} days`);
  if (!unused.length) out.push('Every server that is on was used.');
  else if (pro)
    out.push(...unused.map((s) => `- ${s.name}`), '', 'Turn them off: `limitcast trim --grok --apply` (backed up; `--undo` reverses it).');
  else out.push(`Pro names them and turns them off for you: https://limitcast.dev/#pricing`);
  out.push(
    '',
    'Each server that is on starts with every Grok session and adds its tool list to the context. Moving unused servers off is `enabled = false` in ~/.grok/config.toml.',
  );
  return { text: out.join('\n'), unused: unused.map((s) => s.name) };
}

/**
 * Turn the named servers off in Grok's config.toml.
 * @param {string[]} names
 */
export function applyGrokTrim(names, { now = Date.now(), path = grokConfigPath() } = {}) {
  if (!names.length || !existsSync(path)) return [];
  const toml = readFileSync(path, 'utf8');
  const before = new Map(codexServers(toml).map((s) => [s.name, s.enabled]));
  copyFileSync(path, `${path}.limitcast-backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}`);
  writeText(path, setEnabled(toml, Object.fromEntries(names.map((n) => [n, false]))));
  const servers = names.map((name) => ({ name, prev: before.get(name) ?? null }));
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(trimLedger(), JSON.stringify([...loadTrimLedger(), { at: now, servers }], null, 2));
  return servers;
}

/** Reverse the last --apply. Servers the user turned back on stay on. */
export function undoGrokTrim({ path = grokConfigPath() } = {}) {
  const ledger = loadTrimLedger();
  const last = ledger.pop();
  if (!last || !existsSync(path)) return null;
  const toml = readFileSync(path, 'utf8');
  copyFileSync(path, `${path}.limitcast-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const off = new Set(
    codexServers(toml)
      .filter((s) => s.enabled === false)
      .map((s) => s.name),
  );
  writeText(path, setEnabled(toml, Object.fromEntries(last.servers.filter((s) => off.has(s.name)).map((s) => [s.name, s.prev]))));
  writeFileSync(trimLedger(), JSON.stringify(ledger, null, 2));
  return last;
}

/** @returns {{at:number, servers:{name:string, prev:boolean|null}[]}[]} */
function loadTrimLedger() {
  try {
    return JSON.parse(readFileSync(trimLedger(), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Dollar caps for Grok windows, from `limitcast budget grok`. Grok keeps no % used on disk, so a cap is what
 * turns spend into a forecast the guard can block on.
 * @returns {{'5h'?:number, '7d'?:number}|null}
 */
export function getGrokBudget() {
  try {
    const b = JSON.parse(readFileSync(configFile(), 'utf8')).grokBudget;
    if (typeof b === 'number' && b > 0) return { '5h': b };
    if (b && typeof b === 'object') {
      /** @type {{'5h'?:number, '7d'?:number}} */
      const out = {};
      for (const win of /** @type {const} */ (['5h', '7d'])) if (typeof b[win] === 'number' && b[win] > 0) out[win] = b[win];
      return Object.keys(out).length ? out : null;
    }
  } catch {
    /* none */
  }
  return null;
}

/**
 * @param {number|null} usd
 * @param {'5h'|'7d'} [win]
 */
export function setGrokBudget(usd, win = '5h') {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    /* new */
  }
  /** @type {{'5h'?:number, '7d'?:number}} */
  const cur = typeof cfg.grokBudget === 'number' ? { '5h': cfg.grokBudget } : { ...(cfg.grokBudget ?? {}) };
  if (usd === null) delete cur[win];
  else cur[win] = usd;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...cfg, grokBudget: Object.keys(cur).length ? cur : null }));
}

/**
 * Spend in the current aligned windows, in USD. Null when there is no Grok ledger.
 * @param {number} now
 * @param {string} [root]
 * @returns {{'5h':number, '7d':number}|null}
 */
export function grokSpend(now, root = grokRoot()) {
  if (!existsSync(root)) return null;
  const turns = grokCosts(root, now - windowMs('7d'));
  if (!turns.length && !newestFile(root, (n) => n === 'usage.json')) return null;
  /** @type {{'5h':number, '7d':number}} */
  const out = { '5h': 0, '7d': 0 };
  for (const win of /** @type {const} */ (['5h', '7d'])) {
    const start = alignedStart(now, win);
    out[win] = turns.filter((t) => t.t >= start && t.t <= now).reduce((a, t) => a + t.usd, 0);
  }
  return out;
}

/**
 * Forecast samples from Grok spend against the user's dollar cap. Empty without a budget: there is no % to judge.
 * @param {number} now
 * @param {{root?:string, budget?:ReturnType<typeof getGrokBudget>}} [opts]
 * @returns {Sample[]}
 */
export function grokSamples(now, { root = grokRoot(), budget = getGrokBudget() } = {}) {
  if (!budget) return [];
  const since = now - windowMs('7d');
  const turns = grokCosts(root, since);
  /** @type {Sample[]} */
  const out = [];
  for (const win of /** @type {const} */ (['5h', '7d'])) {
    const cap = budget[win];
    if (!(cap > 0)) continue;
    const start = alignedStart(now, win);
    const reset = (start + windowMs(win)) / 1000;
    let spent = 0;
    for (const t of turns) {
      if (t.t < start || t.t > now) continue;
      spent += t.usd;
      out.push({ t: t.t, src: 'grok', win, pct: Math.min(100, (spent / cap) * 100), reset });
    }
    out.push({ t: now, src: 'grok', win, pct: Math.min(100, (spent / cap) * 100), reset });
  }
  return out;
}

/**
 * Wire Grok's status line and, with `guard`, a PreToolUse hook on `spawn_subagent`.
 * @param {{guard:boolean, self:string, home?:string}} opts
 * @returns {string[]}
 */
export function installGrok({ guard, self, home = grokHome() }) {
  if (!grokPresent(home)) return [];
  const changes = [];
  const cfgPath = join(home, 'config.toml');
  if (existsSync(cfgPath)) {
    backup(cfgPath);
    const prev = readFileSync(cfgPath, 'utf8');
    const next = wrapGrokStatusLine(prev, self);
    if (next !== prev) {
      mkdirSync(stateDir(), { recursive: true });
      const snap = statusLineTable(prev);
      // Remember the user's table once; never snapshot a wrap we already own (launcher path includes "limitcast").
      if (!isLimitcastStatus(snap ?? '') && (snap || !existsSync(statusLedger()))) writeFileSync(statusLedger(), JSON.stringify({ previous: snap }));
      writeText(cfgPath, next);
      changes.push(
        isLimitcastStatus(statusLineCommand(prev)) ? 'Grok status line already installed (command path refreshed)' : 'wrapped the Grok status line',
      );
    }
  }
  if (guard) {
    const path = join(home, 'hooks', 'limitcast.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: 'spawn_subagent', hooks: [{ type: 'command', command: `${self} guard`, timeout: 10 }] }],
          },
        },
        null,
        2,
      )}\n`,
    );
    changes.push('added the Grok subagent guard (matcher spawn_subagent)');
  }
  return changes;
}

/**
 * Remove the Grok hook file and restore the previous [ui.status_line] table.
 * @param {{home?:string}} [opts]
 */
export function uninstallGrok({ home = grokHome() } = {}) {
  const changes = [];
  const hook = join(home, 'hooks', 'limitcast.json');
  if (existsSync(hook)) {
    const text = readFileSync(hook, 'utf8');
    if (text.includes(MARK)) {
      unlinkSync(hook);
      changes.push('removed the Grok subagent guard');
    }
  }
  const cfgPath = join(home, 'config.toml');
  if (existsSync(cfgPath)) {
    const toml = readFileSync(cfgPath, 'utf8');
    if (isLimitcastStatus(statusLineCommand(toml))) {
      backup(cfgPath);
      let previous = null;
      try {
        previous = JSON.parse(readFileSync(statusLedger(), 'utf8')).previous;
      } catch {
        /* missing ledger: drop the table */
      }
      writeText(cfgPath, restoreStatusLine(toml, previous));
      changes.push(previous ? 'restored the Grok status line' : 'removed the Grok status line');
    }
  }
  return changes;
}

/**
 * @param {string} [home]
 * @returns {{ok:boolean, line:string}[]}
 */
export function grokDoctor(home = grokHome()) {
  if (!grokPresent(home)) return [];
  /** @type {{ok:boolean, line:string}[]} */
  const out = [];
  const cfgPath = join(home, 'config.toml');
  const toml = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const sl = isLimitcastStatus(statusLineCommand(toml));
  out.push({
    ok: sl,
    line: sl ? 'Grok status-line recorder installed' : 'Grok status-line recorder missing: run `limitcast install`',
  });
  const hook = join(home, 'hooks', 'limitcast.json');
  let guard = false;
  try {
    const cfg = JSON.parse(readFileSync(hook, 'utf8'));
    guard = JSON.stringify(cfg).includes('spawn_subagent') && JSON.stringify(cfg).includes(MARK);
  } catch {
    /* absent */
  }
  out.push({
    ok: true,
    line: guard ? 'Grok subagent guard installed' : 'Grok subagent guard not installed (optional: `limitcast install --guard`)',
  });
  const budget = getGrokBudget();
  if (guard && !budget)
    out.push({
      ok: true,
      line: 'Grok has no % limit on disk: set a 5-hour dollar cap so the guard can block (`limitcast budget grok <usd>`)',
    });
  else if (budget)
    out.push({
      ok: true,
      line: `Grok budget: ${Object.entries(budget)
        .map(([w, v]) => `${w} $${v}`)
        .join(', ')}`,
    });
  return out;
}

/**
 * Wrap or insert [ui.status_line] so it runs `self statusline`, keeping an existing command underneath.
 * @param {string} toml
 * @param {string} self
 */
export function wrapGrokStatusLine(toml, self) {
  const cmd = `${self} statusline`;
  const range = tableRange(toml, 'ui.status_line');
  if (!range) {
    const block = ['', '[ui.status_line]', 'type = "command"', `command = ${tomlString(`${cmd}`)}`, 'refresh_interval = 60', ''].join('\n');
    return `${toml.trimEnd()}${block}`;
  }
  const keys = parseTable(range.body);
  const current = keys.command ?? '';
  const inner = isLimitcastStatus(current) ? unwrapStatusline(current) : current;
  keys.type = 'command';
  keys.command = inner ? `${cmd} -- sh -c ${shQuote(inner)}` : cmd;
  delete keys.items; // builtin item lists are not valid on a command row
  if (keys.refresh_interval === undefined) keys.refresh_interval = '60';
  return toml.slice(0, range.start) + renderTable('ui.status_line', keys, range.body) + toml.slice(range.end);
}

/**
 * The [ui.status_line] table text, or null when the file has none.
 * @param {string} toml
 */
export function statusLineTable(toml) {
  const range = tableRange(toml, 'ui.status_line');
  return range ? range.body.trim() : null;
}

/**
 * @param {string} toml
 * @param {string|null} previous
 */
export function restoreStatusLine(toml, previous) {
  const range = tableRange(toml, 'ui.status_line');
  if (!range) return toml;
  if (!previous) {
    const before = toml.slice(0, range.start).trimEnd();
    const after = toml.slice(range.end).replace(/^\n+/, '');
    return after ? `${before}\n\n${after}` : `${before}\n`;
  }
  return `${toml.slice(0, range.start)}${previous.trim()}${toml.slice(range.end)}`;
}

/**
 * A one-line session summary from Grok's status-line JSON (model, context %, session cost).
 * @param {any} feed
 */
export function grokSessionLine(feed) {
  if (!feed || typeof feed !== 'object') return '';
  if (feed.rate_limits) return ''; // Claude Code feed
  const bits = [];
  if (typeof feed.model?.display_name === 'string' && feed.model.display_name) bits.push(feed.model.display_name);
  const pct = Number(feed.context_window?.used_percentage);
  if (Number.isFinite(pct)) bits.push(`${pct}% ctx`);
  const usd = Number(feed.cost?.total_cost_usd);
  if (Number.isFinite(usd) && usd >= 0.005) bits.push(`$${usd.toFixed(2)}`);
  return bits.join(' · ');
}

/** Epoch-aligned window start for `win` ("5h", "7d"). */
export function alignedStart(now, win) {
  const len = windowMs(win);
  return Math.floor(now / len) * len;
}

/**
 * @param {string} root
 * @param {number} since
 * @returns {{t:number, usd:number}[]}
 */
function grokCosts(root, since) {
  /** @type {{t:number, usd:number}[]} */
  const out = [];
  for (const file of grokSessionFiles(root, since, 'usage.json')) {
    let ledger;
    try {
      ledger = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const turn of Array.isArray(ledger?.turns) ? ledger.turns : []) {
      const t = Date.parse(turn?.endedAt);
      if (!Number.isFinite(t) || t < since) continue;
      const ticks = Number(turn.costUsdTicks);
      out.push({ t, usd: Number.isFinite(ticks) ? ticks / TICKS : 0 });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * @param {string} root
 * @param {number} since
 * @param {string} name
 */
function grokSessionFiles(root, since, name) {
  if (!existsSync(root)) return [];
  /** @type {string[]} */
  const out = [];
  for (const proj of readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const sess of readdirSync(join(root, proj.name), { withFileTypes: true })) {
      const file = join(root, proj.name, sess.name, name);
      if (sess.isDirectory() && existsSync(file) && statSync(file).mtimeMs >= since) out.push(file);
    }
  }
  return out;
}

/**
 * @param {string} dir
 * @param {(name:string)=>boolean} keep
 */
function newestFile(dir, keep) {
  if (!existsSync(dir)) return null;
  let best = null;
  let bestM = -1;
  /** @param {string} d */
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (keep(e.name)) {
        const m = statSync(p).mtimeMs;
        if (m > bestM) [best, bestM] = [p, m];
      }
    }
  };
  walk(dir);
  return best;
}

/** @param {string} path @param {string} text */
function writeText(path, text) {
  const tmp = `${path}.limitcast-tmp-${process.pid}-${Date.now().toString(36)}`;
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Peel nested `self statusline -- sh -c '...'` wraps until the original command, or '' if there was none.
 * @param {string} command
 */
function unwrapStatusline(command) {
  let cur = command;
  for (let i = 0; i < 8 && isLimitcastStatus(cur); i++) {
    const rest = cur.split(' statusline -- ')[1];
    if (!rest) return '';
    const m = rest.match(/^sh -c '((?:[^']|'\\'')*)'$/);
    if (m) {
      cur = m[1].replace(/'\\''/g, "'");
      continue;
    }
    const plain = rest.match(/^sh -c (\S+)$/);
    cur = plain ? plain[1] : rest;
  }
  return isLimitcastStatus(cur) ? '' : cur;
}

/** The [ui.status_line] command value, or ''. */
function statusLineCommand(toml) {
  const range = tableRange(toml, 'ui.status_line');
  return range ? (parseTable(range.body).command ?? '') : '';
}

/** @param {string} path */
function backup(path) {
  if (existsSync(path)) copyFileSync(path, `${path}.limitcast-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

/** @param {string} s */
const tomlString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** @param {string} s */
const shQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * @param {string} toml
 * @param {string} name
 * @returns {{start:number, end:number, body:string}|null}
 */
function tableRange(toml, name) {
  const re = new RegExp(`^\\[${name.replaceAll('.', '\\.')}\\][ \\t]*$`, 'm');
  const m = re.exec(toml);
  if (!m) return null;
  const start = m.index;
  const rest = toml.slice(start + m[0].length);
  const next = rest.search(/\n\[/);
  const end = next < 0 ? toml.length : start + m[0].length + next;
  return { start, end, body: toml.slice(start, end) };
}

/** @param {string} body */
function parseTable(body) {
  /** @type {Record<string, string>} */
  const keys = {};
  for (const line of body.split('\n').slice(1)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    keys[m[1]] = unquote(m[2].trim());
  }
  return keys;
}

/** @param {string} v */
function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  return v;
}

/**
 * @param {string} name
 * @param {Record<string, string>} keys
 * @param {string} previousBody
 */
function renderTable(name, keys, previousBody) {
  const order = [];
  for (const line of previousBody.split('\n').slice(1)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (m && keys[m[1]] !== undefined && !order.includes(m[1])) order.push(m[1]);
  }
  for (const k of Object.keys(keys)) if (!order.includes(k)) order.push(k);
  const lines = [`[${name}]`];
  for (const k of order) {
    const v = keys[k];
    lines.push(k === 'refresh_interval' && /^\d+$/.test(v) ? `${k} = ${v}` : `${k} = ${tomlString(v)}`);
  }
  return `${lines.join('\n')}\n`;
}
