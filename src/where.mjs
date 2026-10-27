// @ts-check
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fmt } from './report.mjs';
import { stateDir } from './store.mjs';
import { BIG_RESULT, tipFor, toolKey } from './toolcheck.mjs';
import { jsonlFiles } from './usage.mjs';

// `limitcast report --why` (Pro): where the new tokens went, which is what moves the limit (cached reads barely count).
// A model call's new tokens are input + cache writes + output. The input of call i is what entered the context since
// call i-1: its own output (written to the cache) plus the tool results it asked for plus your messages. So the input
// of call i, less call i-1's output, is attributed to the tools call i-1 used. Claude Code transcripts only.

/** @typedef {{t:number, input:number, cacheWrite:number, cacheRead:number, output:number, tools:string[], side:boolean, entry:string, project:string}} Call */

const COLD_MIN = 100_000; // prompt size from which a missed cache is called a rebuild after idle
const NO_TOOL = '(your messages)';
const TIP_MIN_PER_CALL = 2000; // a tip is only worth showing for a source whose results average at least this many new tokens

/**
 * One transcript's model calls in order. A call's usage repeats on every content block it streamed, so calls are
 * merged by message id and their tool_use names collected.
 * @param {string} file
 * @returns {Promise<Call[]>}
 */
export async function readCalls(file) {
  /** @type {Map<string, Call>} */
  const calls = new Map();
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.includes('"usage"')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const m = ev?.message;
    const u = m?.usage;
    const t = Date.parse(ev?.timestamp);
    if (ev?.type !== 'assistant' || !u || !Number.isFinite(t)) continue;
    const id = `${m.id ?? ''}:${ev.requestId ?? ''}`;
    let c = calls.get(id);
    if (!c || id === ':') {
      c = {
        t,
        input: u.input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        tools: [],
        side: !!ev.isSidechain,
        entry: String(ev.entrypoint ?? ''),
        project: ev.cwd ?? '',
      };
      calls.set(id === ':' ? `line${calls.size}` : id, c);
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'tool_use' && typeof b.name === 'string' && !c.tools.includes(toolKey(b.name))) c.tools.push(toolKey(b.name));
    }
  }
  return [...calls.values()];
}

/**
 * Sort a week of calls into categories. The categories add up to `total` exactly.
 * @param {Call[][]} sessions one entry per transcript, calls in order
 * @param {number} since epoch ms; earlier calls are skipped (they still serve as the previous call)
 */
export function attribute(sessions, since = 0) {
  const r = {
    total: 0,
    subagents: 0,
    startInteractive: 0,
    startHeadless: 0,
    sessionsInteractive: 0,
    sessionsHeadless: 0,
    rebuilds: 0,
    output: 0,
    other: 0,
    /** @type {Map<string, {tokens:number, calls:number}>} */
    tools: new Map(),
    /** @type {{tokens:number, tool:string, t:number, project:string}[]} */
    steps: [],
  };
  for (const calls of sessions) {
    const main = calls.filter((c) => !c.side);
    for (const c of calls.filter((x) => x.side && x.t >= since)) {
      const n = c.input + c.cacheWrite + c.output;
      r.total += n;
      r.subagents += n;
    }
    main.forEach((c, i) => {
      if (c.t < since) return;
      r.total += c.input + c.cacheWrite + c.output;
      r.output += c.output;
      if (i === 0) {
        const interactive = c.entry === 'cli';
        r[interactive ? 'startInteractive' : 'startHeadless'] += c.input + c.cacheWrite;
        r[interactive ? 'sessionsInteractive' : 'sessionsHeadless']++;
        return;
      }
      const p = main[i - 1];
      r.output += p.output; // the previous call's output, written to the cache again as this call's input
      const added = c.input + c.cacheWrite - p.output;
      const prompt = p.input + p.cacheRead + p.cacheWrite;
      if (added <= 0) r.other += added;
      else if (prompt > COLD_MIN && c.cacheRead < prompt / 2) r.rebuilds += added;
      else {
        const tool = p.tools.length > 1 ? 'several tools in one step' : (p.tools[0] ?? NO_TOOL);
        const e = r.tools.get(tool) ?? { tokens: 0, calls: 0 };
        e.tokens += added;
        e.calls++;
        r.tools.set(tool, e);
        r.steps.push({ tokens: added, tool, t: c.t, project: c.project });
      }
    });
  }
  return r;
}

/**
 * Markdown: where the new tokens went, tool results by source, the largest single steps.
 * @param {ReturnType<typeof attribute>} r
 * @param {{since:number, now:number, calib?:{fresh:number}|null}} o calib.fresh: % of a 5-hour window per million new tokens
 */
export function whyReport(r, { since, now, calib }) {
  const day = (/** @type {number} */ t) => new Date(t).toLocaleDateString('sv-SE');
  const lines = ['# limitcast: where your new tokens went', '', `${day(since)} to ${day(now)} · Claude Code only`, ''];
  if (!r.total) return [...lines, 'No Claude Code usage in this period.'].join('\n');
  const toolTokens = [...r.tools.values()].reduce((a, e) => a + e.tokens, 0);
  const windows = (/** @type {number} */ n) => {
    if (!calib) return '';
    const w = ((n / 1e6) * calib.fresh) / 100;
    return ` | ≈${w < 10 ? w.toFixed(1) : Math.round(w)}`;
  };
  const share = (/** @type {number} */ n) => `${Math.round((n / r.total) * 100)}%`;
  const rows = /** @type {[string, number][]} */ ([
    ['Subagents', r.subagents],
    [`Session starts, interactive (${r.sessionsInteractive})`, r.startInteractive],
    [`Session starts, headless runs (${r.sessionsHeadless})`, r.startHeadless],
    ['Cache rebuilds after an idle pause', r.rebuilds],
    ['Tool results', toolTokens],
    ['Model output (generated, then cached on the next call)', r.output],
    ['Other', r.other],
  ])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  lines.push(`${fmt(r.total)} new tokens (input, cache writes and output; cached reads are left out).`, '');
  lines.push(`| where | new tokens | share${calib ? ' | 5-hour windows' : ''} |`, `|---|---:|---:${calib ? '|---:' : ''}|`);
  for (const [k, n] of rows) lines.push(`| ${k} | ${fmt(n)} | ${share(n)}${windows(n)} |`);

  if (r.tools.size) {
    lines.push('', '## Tool results by source', '', '| tool | new tokens | calls | per call |', '|---|---:|---:|---:|');
    for (const [k, e] of [...r.tools].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 8)) {
      lines.push(`| ${k} | ${fmt(e.tokens)} | ${e.calls} | ${fmt(Math.round(e.tokens / e.calls))} |`);
    }
    lines.push('', '## Largest single steps', '', '| new tokens | tool | project | day |', '|---:|---|---|---|');
    for (const s of [...r.steps].sort((a, b) => b.tokens - a.tokens).slice(0, 5)) {
      lines.push(`| ${fmt(s.tokens)} | ${s.tool} | ${s.project.replace(homedir(), '~') || '(unknown)'} | ${day(s.t)} |`);
    }
    const big = r.steps.filter((s) => s.tokens >= BIG_RESULT);
    const tips = [...r.tools]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .filter(([k, e]) => tipFor(k) && e.tokens / e.calls >= TIP_MIN_PER_CALL)
      .slice(0, 3);
    if (big.length || tips.length) {
      lines.push('', '## What to try', '');
      if (big.length) {
        const bigTokens = big.reduce((a, s) => a + s.tokens, 0);
        const by = new Map();
        for (const s of big) by.set(s.tool, (by.get(s.tool) ?? 0) + s.tokens);
        const top = [...by].sort((a, b) => b[1] - a[1])[0][0];
        lines.push(
          `- ${big.length} single steps added over ${fmt(BIG_RESULT)} new tokens each: ${Math.round((bigTokens / toolTokens) * 100)}% of all tool-result tokens, mostly ${top}.`,
        );
      }
      for (const [k, e] of tips) lines.push(`- ${k} (${fmt(e.tokens)}, ${fmt(Math.round(e.tokens / e.calls))} per call): ${tipFor(k)}.`);
    }
  }
  lines.push(
    '',
    '_Estimated from your local transcripts: a step is the new tokens that entered the context after a model call, assigned to the tools that call used._',
  );
  return lines.join('\n');
}

const CACHE_VERSION = 1;
const CACHE_KEEP_MS = 35 * 86400_000;
const cacheFile = () => join(stateDir(), 'where-cache.json');

/** @returns {Record<string, {s:number, m:number, c:Call[]}>} the parsed calls of each transcript, by path */
function loadCache() {
  try {
    const d = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    return d.v === CACHE_VERSION ? d.files : {};
  } catch {
    return {};
  }
}

/**
 * The calls of every Claude Code transcript touched since `since`. Parsed transcripts are cached by size and mtime,
 * so only new or changed ones are read again (a few GB of transcripts took 3 to 43 seconds uncached).
 * @param {string} root
 * @param {number} since
 * @returns {Promise<Call[][]>}
 */
export async function whySessions(root, since) {
  const cache = loadCache();
  /** @type {typeof cache} */
  const next = {};
  const files = jsonlFiles(root, since, () => true);
  for (const f of files) {
    const st = statSync(f);
    const hit = cache[f];
    next[f] = hit && hit.s === st.size && hit.m === st.mtimeMs ? hit : { s: st.size, m: st.mtimeMs, c: await readCalls(f) };
  }
  // Keep entries this run didn't need (another period) while they are recent; drop the rest.
  for (const [f, e] of Object.entries(cache)) if (!next[f] && e.m >= Date.now() - CACHE_KEEP_MS && existsSync(f)) next[f] = e;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ v: CACHE_VERSION, files: next }));
  } catch {
    /* a cache: the next run just reads the transcripts */
  }
  return files.map((f) => next[f].c);
}
