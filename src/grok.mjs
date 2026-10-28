// @ts-check
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { codexServers, setEnabled } from './codex.mjs';
import { windowMs } from './forecast.mjs';
import { KEEP_MS, stateDir } from './store.mjs';
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
 * @param {{servers:{name:string, enabled:boolean|undefined}[], used:Set<string>, startup:{prompt:number, tools:number}|null, days:number, pro?:boolean, keep?:string[]}} r
 *   keep: the `trim keep` list; unused servers on it are reported as kept and left out of `unused`
 */
export function grokTrimReport({ servers, used, startup, days, keep = [] }) {
  const on = servers.filter((s) => s.enabled !== false);
  const idle = on.filter((s) => !used.has(norm(s.name)));
  const kept = idle.filter((s) => keep.some((k) => norm(k) === norm(s.name)));
  const unused = idle.filter((s) => !kept.includes(s));
  const tok = (/** @type {number} */ c) => `${(c / 4000).toFixed(1)}k`;
  const out = ['# limitcast trim --grok', ''];
  if (startup)
    out.push(
      `Grok sessions start with ~${tok(startup.prompt)} tokens of system prompt and ~${tok(startup.tools)} of tool definitions, re-sent on every turn.`,
      '',
    );
  out.push(`## MCP servers: ${on.length} on, ${unused.length} not used in ${days} days`);
  if (!unused.length) out.push(kept.length ? 'Nothing else to turn off.' : 'Every server that is on was used.');
  else out.push(...unused.map((s) => `- ${s.name}`), '', 'Turn them off: `limitcast trim --grok --apply` (backed up; `--undo` reverses it).');
  if (kept.length) out.push('', `Would keep (your keep-list): ${kept.map((s) => s.name).join(', ')}.`);
  out.push(
    '',
    'Each server that is on starts with every Grok session and adds its tool list to the context. Moving unused servers off is `enabled = false` in ~/.grok/config.toml.',
  );
  return { text: out.join('\n'), unused: unused.map((s) => s.name), kept: kept.map((s) => s.name) };
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

// Grok weekly %, opt-in (`limitcast grok-usage on`). Grok keeps no % on disk, so limitcast asks grok.com for the billing
// cycle with the login Grok already holds in auth.json (the call TokScale makes; checked 2026-10-27, not documented by xAI).
// That login is read in this process, sent only to grok.com, and never stored or logged.
const QUOTA_URL = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
const QUOTA_EVERY_MS = 5 * 60_000;
const quotaFile = () => join(stateDir(), 'grok-quota.json');

/** @typedef {{at:number, ok:boolean, error?:string, label?:string, pct?:number, reset?:number, readings:{t:number, pct:number, reset:number}[]}} QuotaState */

export function grokQuotaEnabled() {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8')).grokQuota === true;
  } catch {
    return false;
  }
}

/** @param {boolean} on */
export function setGrokQuota(on) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    /* new */
  }
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...cfg, grokQuota: on }));
}

/** @returns {QuotaState} */
export function readGrokQuota() {
  try {
    return { at: 0, ok: false, readings: [], ...JSON.parse(readFileSync(quotaFile(), 'utf8')) };
  } catch {
    return { at: 0, ok: false, readings: [] };
  }
}

/** @param {QuotaState} s */
function writeGrokQuota(s) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(quotaFile(), JSON.stringify(s));
}

/** True when the feature is on, Grok is installed, and the last attempt is older than the refresh interval. */
export function grokQuotaDue(now, home = grokHome()) {
  return grokQuotaEnabled() && grokPresent(home) && now - readGrokQuota().at >= QUOTA_EVERY_MS;
}

/** Mark an attempt before a background refresh starts, so a burst of status lines starts only one. */
export function touchGrokQuota(now) {
  writeGrokQuota({ ...readGrokQuota(), at: now });
}

/**
 * Protobuf fields of one message as [field, value, wireType]: varints as numbers, length-delimited as Buffers,
 * fixed32 as its 4 bytes. Stops quietly at a truncated message.
 * @param {Buffer} buf
 * @returns {Generator<[number, any, number]>}
 */
function* fields(buf) {
  let pos = 0;
  const varint = () => {
    let r = 0;
    let mul = 1;
    while (pos < buf.length) {
      const b = buf[pos++];
      r += (b & 0x7f) * mul;
      if (!(b & 0x80)) return r;
      mul *= 128;
    }
    return null;
  };
  while (pos < buf.length) {
    const key = varint();
    if (key === null) return;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const v = varint();
      if (v === null) return;
      yield [field, v, 0];
    } else if (wire === 1) {
      if (pos + 8 > buf.length) return;
      pos += 8;
    } else if (wire === 2) {
      const len = varint();
      if (len === null || pos + len > buf.length) return;
      yield [field, buf.subarray(pos, pos + len), 2];
      pos += len;
    } else if (wire === 5) {
      if (pos + 4 > buf.length) return;
      yield [field, buf.subarray(pos, pos + 4), 5];
      pos += 4;
    } else return;
  }
}

/** Seconds of a protobuf Timestamp. @param {Buffer} msg */
const timestamp = (msg) => {
  for (const [f, v, w] of fields(msg)) if (f === 1 && w === 0) return /** @type {number} */ (v);
  return null;
};

/**
 * The billing cycle from a gRPC-web `GetGrokCreditsConfig` reply: % used and the cycle's start and end (epoch seconds).
 * Null when the reply holds no percentage.
 * @param {Uint8Array} body
 * @returns {{pct:number, start:number|null, end:number|null}|null}
 */
export function parseGrokBilling(body) {
  const buf = Buffer.from(body);
  for (let pos = 0; pos + 5 <= buf.length; ) {
    const flag = buf[pos];
    const len = buf.readUInt32BE(pos + 1);
    pos += 5;
    if (pos + len > buf.length) return null;
    const payload = buf.subarray(pos, pos + len);
    pos += len;
    if (flag & 0x80) continue; // trailers
    for (const [f, cfg, w] of fields(payload)) {
      if (f !== 1 || w !== 2) continue;
      let pct = null;
      let start = null;
      let end = null;
      for (const [g, v, ww] of fields(cfg)) {
        if (g === 1 && ww === 5) {
          const x = v.readFloatLE(0);
          if (Number.isFinite(x)) pct = Math.min(100, Math.max(0, x));
        } else if (g === 4 && ww === 2) start = timestamp(v);
        else if (g === 5 && ww === 2) end = timestamp(v);
      }
      if (pct !== null) return { pct, start, end };
    }
  }
  return null;
}

/** Grok's logins from auth.json, the auth.x.ai one first. @param {string} home */
function grokTokens(home) {
  try {
    const doc = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
    return Object.entries(doc ?? {})
      .filter(([, v]) => typeof (/** @type {any} */ (v)?.key) === 'string' && /** @type {any} */ (v).key)
      .sort(([a], [b]) => Number(b.includes('auth.x.ai')) - Number(a.includes('auth.x.ai')))
      .map(([, v]) => /** @type {string} */ (/** @type {any} */ (v).key));
  } catch {
    return [];
  }
}

/**
 * @param {string} token
 * @param {typeof fetch} fetchFn
 */
async function askGrok(token, fetchFn) {
  let r;
  try {
    r = await fetchFn(QUOTA_URL, {
      method: 'POST',
      redirect: 'error', // the login must never follow a redirect to another host
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: `Bearer ${token}`,
        'x-xai-token-auth': 'xai-grok-cli',
        accept: 'application/grpc-web+proto',
        'content-type': 'application/grpc-web+proto',
        'user-agent': 'limitcast', // says who is asking; grok.com gave the same answer as with a Grok client's User-Agent (checked 2026-10-27)
      },
      body: new Uint8Array([0, 0, 0, 0, 0]),
    });
  } catch {
    throw new Error('could not reach grok.com');
  }
  if (r.status === 401 || r.status === 403) throw new Error('Grok login expired: run `grok login`');
  if (!r.ok) throw new Error(`grok.com answered HTTP ${r.status}`);
  return parseGrokBilling(new Uint8Array(await r.arrayBuffer()));
}

/**
 * Ask grok.com for the weekly % (at most every 5 minutes unless `force`), keep the reading, and say what happened.
 * Never throws: a failure is recorded in the state for `status` and `doctor`.
 * @param {number} now
 * @param {{force?:boolean, home?:string, fetchFn?:typeof fetch}} [opts]
 * @returns {Promise<QuotaState>}
 */
export async function refreshGrokQuota(now, { force = false, home = grokHome(), fetchFn = fetch } = {}) {
  const prev = readGrokQuota();
  if (!force && now - prev.at < QUOTA_EVERY_MS) return prev;
  /** @type {QuotaState} */
  const next = { ...prev, at: now, ok: false };
  delete next.error;
  const tokens = grokTokens(home);
  if (!tokens.length) next.error = 'no Grok login found: run `grok login`';
  for (const token of tokens) {
    try {
      const b = await askGrok(token, fetchFn);
      if (!b) {
        next.error = 'grok.com sent a billing reply limitcast does not recognise';
        continue;
      }
      const days = b.start !== null && b.end !== null ? Math.trunc((b.end - b.start) / 86400) : null;
      next.label = days !== null && days >= 6 && days <= 8 ? 'Weekly' : days !== null && days >= 27 && days <= 33 ? 'Monthly' : 'Credits';
      next.ok = true;
      next.pct = b.pct;
      if (b.end !== null) next.reset = b.end;
      delete next.error;
      const last = next.readings[next.readings.length - 1];
      if (next.label === 'Weekly' && b.end !== null && (!last || last.pct !== b.pct || last.reset !== b.end || now - last.t >= QUOTA_EVERY_MS))
        next.readings = [...next.readings, { t: now, pct: b.pct, reset: b.end }];
      break;
    } catch (e) {
      next.error = e instanceof Error ? e.message : 'unknown error';
    }
  }
  next.readings = next.readings.filter((r) => r.t >= now - KEEP_MS);
  writeGrokQuota(next);
  return next;
}

/** Forecast samples from the recorded weekly readings; none unless the feature is on. @param {number} now @returns {Sample[]} */
export function grokQuotaSamples(now, history = false) {
  if (!history && !grokQuotaEnabled()) return [];
  const quota = readGrokQuota();
  if (!history && quota.label && quota.label !== 'Weekly') return [];
  return quota.readings.filter((r) => r.t >= now - KEEP_MS).map((r) => ({ t: r.t, src: 'grok', win: '7d', pct: r.pct, reset: r.reset }));
}

/**
 * Forecast samples for Grok: the real weekly % when `grok-usage` is on, plus spend against the user's dollar cap
 * for the windows with a cap (a weekly cap steps aside for the real %). Empty without either.
 * @param {number} now
 * @param {{root?:string, budget?:ReturnType<typeof getGrokBudget>, history?:boolean}} [opts]
 * @returns {Sample[]}
 */
export function grokSamples(now, { root = grokRoot(), budget = getGrokBudget(), history = false } = {}) {
  const quota = grokQuotaSamples(now, history);
  if (!budget) return quota;
  const since = now - windowMs('7d');
  const turns = grokCosts(root, since);
  /** @type {Sample[]} */
  const out = [...quota];
  for (const win of /** @type {const} */ (['5h', '7d'])) {
    const cap = budget[win];
    if (!(cap > 0)) continue;
    if (win === '7d' && quota.length) continue;
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
  if (grokQuotaEnabled()) {
    const q = readGrokQuota();
    const ago = q.at ? `${Math.max(0, Math.round((Date.now() - q.at) / 60_000))} min ago` : 'not yet';
    out.push(
      q.ok
        ? { ok: true, line: `Grok ${q.label?.toLowerCase() ?? 'usage'}: ${Math.round(q.pct ?? 0)}% used (checked ${ago})` }
        : { ok: false, line: `Grok usage unavailable (checked ${ago}): ${q.error ?? 'no reading yet'}` },
    );
  } else if (guard && !budget)
    out.push({
      ok: true,
      line: 'Grok has no % limit on disk: turn on the weekly % with `limitcast grok-usage on`, or set a 5-hour dollar cap so the guard can block (`limitcast budget grok <usd>`)',
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
  parseToml(toml);
  const cmd = `${self} statusline`;
  const range = tableRange(toml, 'ui.status_line');
  if (!range) {
    const block = ['', '[ui.status_line]', 'type = "command"', `command = ${tomlString(`${cmd}`)}`, 'refresh_interval = 60', ''].join('\n');
    return `${toml.trimEnd()}${block}`;
  }
  const keys = parseTable(range.body, 'ui.status_line');
  const current = keys.command ?? '';
  const inner = isLimitcastStatus(current) ? unwrapStatusline(current) : current;
  keys.type = 'command';
  keys.command = inner ? `${cmd} -- sh -c ${shQuote(inner)}` : cmd;
  delete keys.items; // builtin item lists are not valid on a command row
  if (keys.refresh_interval === undefined) keys.refresh_interval = 60;
  return replaceTable(toml, range, 'ui.status_line', keys);
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
/**
 * Set or clear a Grok `[subagents.models]` pin. A non-grok model (or null) removes that type's key.
 * @param {string} type
 * @param {string|null} model
 * @param {{path?:string}} [opts]
 */
export function applyGrokSubagentModel(type, model, { path = grokConfigPath() } = {}) {
  if (!existsSync(path)) return false;
  const grokId = typeof model === 'string' && /^grok-[a-z0-9.-]+$/i.test(model) ? model : null;
  const prev = readFileSync(path, 'utf8');
  const next = patchGrokSubagentModel(prev, type, grokId);
  if (next === prev) return false;
  backup(path);
  writeText(path, next);
  return true;
}

/**
 * Pure TOML patch for `[subagents.models.<type>]`. `model` null deletes the key; an empty table is removed.
 * @param {string} toml
 * @param {string} type
 * @param {string|null} model
 */
export function patchGrokSubagentModel(toml, type, model) {
  const key = type.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!key) return toml;
  const range = tableRange(toml, 'subagents.models');
  if (!range) {
    if (!model) return toml;
    return `${toml.trimEnd()}\n\n[subagents.models]\n${key} = ${tomlString(model)}\n`;
  }
  const keys = parseTable(range.body, 'subagents.models');
  if (model) keys[key] = model;
  else delete keys[key];
  if (!Object.keys(keys).length) {
    const before = toml.slice(0, range.start).trimEnd();
    const after = toml.slice(range.end).replace(/^\n+/, '');
    return after ? `${before}\n\n${after}` : `${before}\n`;
  }
  return replaceTable(toml, range, 'subagents.models', keys);
}

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
  return range ? (parseTable(range.body, 'ui.status_line').command ?? '') : '';
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
  const parts = name
    .split('.')
    .map((part) => `(?:${part}|"${part}"|'${part}')`)
    .join('[ \\t]*\\.[ \\t]*');
  const re = new RegExp(`^[ \\t]*\\[[ \\t]*${parts}[ \\t]*\\][ \\t]*(?:#[^\\r\\n]*)?\\r?$`, 'm');
  const m = re.exec(toml);
  if (!m) return null;
  const start = m.index;
  const rest = toml.slice(start + m[0].length);
  const next = rest.search(/\n[ \t]*\[/);
  const end = next < 0 ? toml.length : start + m[0].length + next;
  return { start, end, body: toml.slice(start, end) };
}

/** Parse values with their TOML types and escaping intact. */
function parseTable(body, name) {
  return name.split('.').reduce((v, k) => v[k], parseToml(body));
}

/** Preserve untouched fields/comments; verify the entire configuration has only the intended change. */
function replaceTable(toml, range, name, keys) {
  const before = parseTable(range.body, name);
  const lines = range.body.split('\n');
  const field = /^\s*(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)')\s*=/;
  const starts = lines.flatMap((line, i) => (field.test(line) ? [i] : []));
  const out = [lines[0]];
  out.push(...lines.slice(1, starts[0] ?? lines.length));
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const match = field.exec(lines[from]);
    const key = match[1] ?? match[2] ?? match[3];
    const block = lines.slice(from, starts[i + 1] ?? lines.length);
    if (!Object.hasOwn(keys, key)) {
      out.push(...commentsIn(block));
      continue;
    }
    if (isDeepStrictEqual(before[key], keys[key])) out.push(...block);
    else {
      const comments = commentsIn(block);
      out.push(stringifyToml({ [key]: keys[key] }).trimEnd(), ...comments);
    }
  }
  for (const key of Object.keys(keys)) if (!Object.hasOwn(before, key)) out.push(stringifyToml({ [key]: keys[key] }).trimEnd());
  const next = `${toml.slice(0, range.start)}${out.join('\n').trimEnd()}\n${toml.slice(range.end)}`;
  const expected = parseToml(toml);
  const path = name.split('.');
  const parent = path.slice(0, -1).reduce((v, k) => v[k], expected);
  parent[path.at(-1)] = keys;
  if (!isDeepStrictEqual(parseToml(next), expected))
    throw new Error(`Cannot safely edit [${name}]; leave the configuration unchanged and edit this table manually.`);
  return next;
}

/** Keep comments outside quoted values when replacing or removing a field. */
function commentsIn(lines) {
  return lines.flatMap((line) => {
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote === '"' && c === '\\') {
        i++;
        continue;
      }
      if (quote && c === quote) quote = '';
      else if (!quote && (c === '"' || c === "'")) quote = c;
      else if (!quote && c === '#') return [line.slice(i)];
    }
    return [];
  });
}
