// @ts-check
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { fmt } from './report.mjs';
import { jsonlFiles } from './usage.mjs';

// `limitcast report --why` (Pro): where the new tokens went, which is what moves the limit (cached reads barely count).
// A model call's new tokens are input + cache writes + output. The input of call i is what entered the context since
// call i-1: its own output (written to the cache) plus the tool results it asked for plus your messages. So the input
// of call i, less call i-1's output, is attributed to the tools call i-1 used. Claude Code transcripts only.

/** @typedef {{t:number, input:number, cacheWrite:number, cacheRead:number, output:number, tools:string[], side:boolean, entry:string, project:string}} Call */

const COLD_MIN = 100_000; // prompt size from which a missed cache is called a rebuild after idle
const NO_TOOL = '(your messages)';

/** @param {string} name */
const toolKey = (name) => (name.startsWith('mcp__') ? `mcp:${name.split('__')[1]}` : name);

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
  }
  lines.push(
    '',
    '_Estimated from your local transcripts: a step is the new tokens that entered the context after a model call, assigned to the tools that call used._',
  );
  return lines.join('\n');
}

/**
 * Read every Claude Code transcript touched since `since` and sort its calls into categories.
 * shortcut: re-reads the transcripts on every run (no cache); add one like readUsage's if this gets slow.
 * @param {string} root
 * @param {number} since
 */
export async function whySessions(root, since) {
  /** @type {Call[][]} */
  const sessions = [];
  for (const f of jsonlFiles(root, since, () => true)) sessions.push(await readCalls(f));
  return sessions;
}
