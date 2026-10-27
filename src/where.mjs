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

/** @typedef {{t:number, input:number, cacheWrite:number, cacheRead:number, output:number, tools:string[], side:boolean, entry:string, project:string, model?:string, prompt?:string, agentType?:string}} Call
 *  prompt: first words of the session's first message, on its first main-thread call; agentType: a subagent transcript's type, on its first call */

const COLD_MIN = 100_000; // prompt size from which a missed cache is called a rebuild after idle
const NO_TOOL = '(your messages)';
const TIP_MIN_PER_CALL = 2000; // a tip is only worth showing for a source whose results average at least this many new tokens

/**
 * The first words of a transcript line that is the session's own first message, else undefined.
 * @param {string} line
 */
function firstPrompt(line) {
  try {
    const ev = JSON.parse(line);
    if (ev?.type !== 'user' || ev.isSidechain || ev.isMeta) return undefined;
    const c = ev.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : '')).join(' ') : '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 80) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * One transcript's model calls in order. A call's usage repeats on every content block it streamed, so calls are
 * merged by message id and their tool_use names collected. The first main-thread call also carries the session's
 * first words (`prompt`), which tell a scheduled job's runs apart.
 * @param {string} file
 * @returns {Promise<Call[]>}
 */
export async function readCalls(file) {
  /** @type {Map<string, Call>} */
  const calls = new Map();
  /** @type {string|undefined} */
  let prompt;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (prompt === undefined && line.includes('"type":"user"')) prompt = firstPrompt(line);
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
        model: String(m.model ?? ''),
      };
      calls.set(id === ':' ? `line${calls.size}` : id, c);
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'tool_use' && typeof b.name === 'string' && !c.tools.includes(toolKey(b.name))) c.tools.push(toolKey(b.name));
    }
  }
  const all = [...calls.values()];
  const first = all.find((c) => !c.side);
  if (first && prompt) first.prompt = prompt;
  // A subagent's transcript has its type in a file next to it: agent-<id>.jsonl and agent-<id>.meta.json.
  if (all.length && file.includes('/subagents/')) {
    try {
      const type = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')).agentType;
      if (typeof type === 'string') all[0].agentType = type;
    } catch {
      /* no meta file: the type stays unknown */
    }
  }
  return all;
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
    /** @type {{t:number, tokens:number, size:number, calls:number, prompt:string, project:string, entry:string}[]} headless session starts: when, new tokens, and the whole starting prompt (cached or not) */
    starts: [],
    /** @type {Map<string, number>} every new token, by model */
    byModel: new Map(),
    /** @type {Map<string, {type:string, model:string, tokens:number, runs:number}>} subagent new tokens, by type and model */
    subagentsBy: new Map(),
  };
  /** @param {Call} c */
  const byModel = (c) => {
    const k = c.model || '(unknown)';
    r.byModel.set(k, (r.byModel.get(k) ?? 0) + c.input + c.cacheWrite + c.output);
  };
  for (const calls of sessions) {
    const main = calls.filter((c) => !c.side);
    const type = calls.find((c) => c.agentType)?.agentType ?? '(unknown)';
    const counted = new Set(); // one run per transcript for each type and model
    for (const c of calls.filter((x) => x.side && x.t >= since)) {
      const n = c.input + c.cacheWrite + c.output;
      r.total += n;
      r.subagents += n;
      byModel(c);
      const k = `${type}\0${c.model || '(unknown)'}`;
      const e = r.subagentsBy.get(k) ?? { type, model: c.model || '(unknown)', tokens: 0, runs: 0 };
      e.tokens += n;
      if (!counted.has(k)) {
        counted.add(k);
        e.runs++;
      }
      r.subagentsBy.set(k, e);
    }
    main.forEach((c, i) => {
      if (c.t < since) return;
      r.total += c.input + c.cacheWrite + c.output;
      byModel(c);
      r.output += c.output;
      if (i === 0) {
        const interactive = c.entry === 'cli';
        r[interactive ? 'startInteractive' : 'startHeadless'] += c.input + c.cacheWrite;
        r[interactive ? 'sessionsInteractive' : 'sessionsHeadless']++;
        if (!interactive) {
          r.starts.push({
            t: c.t,
            tokens: c.input + c.cacheWrite,
            size: c.input + c.cacheWrite + c.cacheRead,
            calls: main.filter((x) => x.t >= since).length,
            prompt: c.prompt ?? '',
            project: c.project,
            entry: c.entry,
          });
        }
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
  if (r.starts.length) lines.push('', 'Headless runs by job: `limitcast report --jobs`.');

  if (r.subagentsBy.size) {
    lines.push(
      '',
      '## Subagents by type and model',
      '',
      '| type | model | runs | new tokens | share of subagent tokens | per run |',
      '|---|---|---:|---:|---:|---:|',
    );
    for (const e of [...r.subagentsBy.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8)) {
      lines.push(
        `| ${e.type} | ${e.model} | ${e.runs} | ${fmt(e.tokens)} | ${Math.round((e.tokens / r.subagents) * 100)}% | ${fmt(Math.round(e.tokens / e.runs))} |`,
      );
    }
  }
  if (r.byModel.size > 1) {
    lines.push('', '## New tokens by model', '', '| model | new tokens | share |', '|---|---:|---:|');
    for (const [k, n] of [...r.byModel].sort((a, b) => b[1] - a[1]).slice(0, 6)) lines.push(`| ${k} | ${fmt(n)} | ${share(n)} |`);
    lines.push(
      '',
      'Models may count differently against your limit; limitcast cannot tell them apart, so these are token counts, not window shares.',
    );
  }

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

/**
 * A start is cold when most of its prompt was new tokens, so the prompt cache did not have it.
 * @param {{tokens:number, size:number}} s
 */
const isCold = (s) => s.tokens * 2 > s.size;

const GAPS = /** @type {[string, number][]} */ ([
  ['within 5 min', 5],
  ['5 to 60 min', 60],
  ['over 60 min', Number.POSITIVE_INFINITY],
]);

/**
 * "Cold starts": how many runs started without the cache, what that cost beyond the same job's warm runs, and how
 * the gap since the job's previous run decides it (so you can see how close together runs must be).
 * @param {number} runs
 * @param {{runs:number, tokens:number, size:number, cold:number, coldTokens:number, warmTokens:number, starts:{t:number, tokens:number, size:number}[]}[]} jobs
 */
function coldSection(runs, jobs) {
  const cold = jobs.reduce((a, j) => a + j.cold, 0);
  const lines = ['', '## Cold starts', ''];
  // Only a job with both kinds of start can say what a cold one costs extra: cold runs times the difference.
  const extra = jobs.reduce((a, j) => {
    const warm = j.runs - j.cold;
    return j.cold && warm ? a + j.cold * Math.max(0, j.coldTokens / j.cold - j.warmTokens / warm) : a;
  }, 0);
  const newTokens = jobs.reduce((a, j) => a + j.tokens, 0);
  const prompts = jobs.reduce((a, j) => a + j.size, 0);
  lines.push(
    `${cold} of ${runs} runs (${Math.round((cold / runs) * 100)}%) started cold: more than half of their starting prompt was new tokens, not served from the prompt cache. ` +
      `On average ${Math.round((1 - newTokens / prompts) * 100)}% of a starting prompt came from the cache.` +
      (extra >= 1000 ? ` Against the warm runs of the same jobs, the cold ones cost about ${fmt(Math.round(extra))} more new tokens.` : ''),
  );
  const bucket = GAPS.map(() => ({ runs: 0, cold: 0 }));
  for (const j of jobs) {
    const sorted = [...j.starts].sort((a, b) => a.t - b.t);
    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i].t - sorted[i - 1].t) / 60_000;
      if (!Number.isFinite(gap)) continue;
      const b = bucket[GAPS.findIndex(([, max]) => gap <= max)];
      b.runs++;
      if (isCold(sorted[i])) b.cold++;
    }
  }
  if (bucket.some((b) => b.runs)) {
    lines.push('', '| time since the same job last ran | runs | started cold |', '|---|---:|---:|');
    GAPS.forEach(([label], i) => {
      if (bucket[i].runs) lines.push(`| ${label} | ${bucket[i].runs} | ${Math.round((bucket[i].cold / bucket[i].runs) * 100)}% |`);
    });
    const near = bucket[0];
    if (near.runs >= 5) {
      lines.push(
        '',
        near.cold / near.runs > 0.5
          ? "Even runs within 5 minutes of the same job's previous run mostly started cold, so running them closer together is unlikely to help: the cached prompt is not being reused between runs. Look for anything near the start of a run's prompt that changes every time, such as hook output with a date or counts."
          : "Runs close behind the same job's previous run mostly started warm, so running a job's work in batches lets later runs reuse the first one's cached prompt.",
      );
    }
  }
  return lines;
}

/**
 * Markdown: the scheduled (headless) jobs whose runs spent the most new tokens just starting. A run's start is what
 * it loads before reading its prompt: settings, plugins, hooks, MCP servers, skills and instruction files.
 * @param {ReturnType<typeof attribute>} r
 * @param {{since:number, now:number}} o
 */
export function jobsReport(r, { since, now }) {
  const day = (/** @type {number} */ t) => new Date(t).toLocaleDateString('sv-SE');
  const lines = [
    '# limitcast: heaviest scheduled-job starts',
    '',
    `${day(since)} to ${day(now)} · headless runs (started by scripts and tools, not from the CLI) · Claude Code only`,
    '',
  ];
  if (!r.starts.length) return [...lines, 'No headless runs in this period.'].join('\n');
  /** @type {Map<string, {runs:number, tokens:number, size:number, calls:number, cold:number, coldTokens:number, warmTokens:number, starts:typeof r.starts}>} */
  const jobs = new Map();
  for (const s of r.starts) {
    const k = s.prompt.slice(0, 45) || s.project || '(unknown)';
    const j = jobs.get(k) ?? { runs: 0, tokens: 0, size: 0, calls: 0, cold: 0, coldTokens: 0, warmTokens: 0, starts: [] };
    j.runs++;
    j.tokens += s.tokens;
    j.size += s.size;
    j.calls += s.calls;
    if (isCold(s)) {
      j.cold++;
      j.coldTokens += s.tokens;
    } else j.warmTokens += s.tokens;
    j.starts.push(s);
    jobs.set(k, j);
  }
  const share = (/** @type {number} */ n) => `${Math.round((n / r.total) * 100)}%`;
  lines.push(
    `${r.starts.length} headless runs spent ${fmt(r.startHeadless)} new tokens just starting: ${share(r.startHeadless)} of all new tokens.`,
    '',
  );
  lines.push(
    '| job (first words of its prompt) | runs | new tokens at start | starting prompt | total start | share of all new | cold starts | calls per run |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  );
  const ranked = [...jobs].sort((a, b) => b[1].tokens - a[1].tokens);
  const avg = (/** @type {number} */ n, /** @type {{runs:number}} */ j) => fmt(Math.round(n / j.runs));
  for (const [k, j] of ranked.slice(0, 10)) {
    lines.push(
      `| ${k.replace(/\|/g, '/')} | ${j.runs} | ${avg(j.tokens, j)} | ${avg(j.size, j)} | ${fmt(j.tokens)} | ${share(j.tokens)} | ${Math.round((j.cold / j.runs) * 100)}% | ${(j.calls / j.runs).toFixed(1)} |`,
    );
  }
  lines.push(...coldSection(r.starts.length, [...jobs.values()]));
  const [leanJob, lean] = [...jobs].sort((a, b) => a[1].size / a[1].runs - b[1].size / b[1].runs)[0];
  lines.push(
    '',
    '## Why a run starts this big',
    '',
    `Every run loads your settings, plugins, hooks, MCP servers, skills and instruction files before it reads its prompt. "New tokens at start" is what counts against your limit; "starting prompt" is the whole context, cached or not. The smallest starting prompt among these jobs averages ${avg(lean.size, lean)} (${leanJob.replace(/\|/g, '/')}); the heaviest job's averages ${avg(ranked[0][1].size, ranked[0][1])}.`,
    '',
    'A job that does not need all of that can leave it out: launch it with `claude -p --setting-sources "" --strict-mcp-config`, plus `--mcp-config` for the servers it uses. That also drops hooks, plugins and permission rules, so pass `--model` and `--permission-mode` and check the job still does what it should.',
    '',
    '_Estimated from your local transcripts. A job is its first 45 characters of prompt, so runs of the same job group together._',
  );
  return lines.join('\n');
}

const CACHE_VERSION = 3; // 2: the first call carries the session's first words; 3: model per call, subagent type
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
