// @ts-check
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { stateDir } from './store.mjs';
import { claudeRoot, codexRoot, grokRoot } from './usage.mjs';

/**
 * limitcast reads Claude Code's, Codex's and Grok's own log formats, which can change in any release.
 * These checks look at your latest real logs and say plainly when the fields limitcast needs are gone.
 * @returns {Promise<{ok:boolean, line:string}[]>}
 */
export async function formatChecks() {
  /** @type {{ok:boolean, line:string}[]} */
  const out = [];

  const feedPath = join(stateDir(), 'last-feed.json');
  if (existsSync(feedPath)) {
    let feed;
    try {
      feed = JSON.parse(readFileSync(feedPath, 'utf8'));
    } catch {
      /* unreadable: reported below */
    }
    const rl = feed?.rate_limits;
    // Claude omits subscription windows before a response, after reset, or without a supported subscription.
    const noWindows = rl == null || (typeof rl === 'object' && !Array.isArray(rl) && !('five_hour' in rl) && !('seven_day' in rl));
    const validFeed = feed && typeof feed === 'object' && !Array.isArray(feed);
    out.push(
      Number.isFinite(rl?.five_hour?.used_percentage ?? rl?.seven_day?.used_percentage)
        ? { ok: true, line: 'Claude Code status-line feed: limit readings present' }
        : validFeed && noWindows
          ? {
              ok: true,
              line: 'Claude Code status-line feed: no subscription limit readings available yet (normal before a response or without a supported subscription)',
            }
          : { ok: false, line: 'Claude Code status-line feed has unreadable rate_limits: the format may have changed, update limitcast' },
    );
  }

  const claude = newest(claudeRoot(), (n) => n.endsWith('.jsonl'));
  if (claude) {
    const found = await findLine(claude, '"usage"', (ev) => ev?.type === 'assistant' && Number.isFinite(ev?.message?.usage?.output_tokens));
    out.push(
      found
        ? { ok: true, line: 'Claude Code transcripts: usage records readable' }
        : !(await findLine(claude, '"assistant"', (ev) => ev?.type === 'assistant'))
          ? { ok: true, line: 'Claude Code: latest session has no assistant usage yet (normal before its first response)' }
          : { ok: false, line: `Claude Code transcript has no readable usage records (${claude}): the format may have changed, update limitcast` },
    );
  }

  const codex = newest(codexRoot(), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
  if (codex) {
    const found = await findLine(codex, '"rate_limits"', (ev) => Number.isFinite(ev?.payload?.rate_limits?.primary?.used_percent));
    out.push(
      found
        ? { ok: true, line: 'Codex session logs: limit readings readable' }
        : { ok: true, line: 'Codex: latest session has no limit readings yet (normal for a very short session)' },
    );
  }

  const grok = newest(grokRoot(), (n) => n === 'usage.json');
  if (grok) {
    let ok = false;
    try {
      const turns = JSON.parse(readFileSync(grok, 'utf8')).turns;
      ok = Array.isArray(turns) && (turns.length === 0 || (Number.isFinite(turns[0].inputTokens) && !!turns[0].endedAt));
    } catch {
      ok = false;
    }
    out.push(
      ok
        ? { ok: true, line: 'Grok usage ledger: readable' }
        : { ok: false, line: `Grok usage ledger is not in the expected format (${grok}): update limitcast` },
    );
  }
  return out;
}

/**
 * Most recently modified file under `dir` (recursive) whose name passes `keep`.
 * @param {string} dir
 * @param {(name:string)=>boolean} keep
 * @returns {string|null}
 */
export function newest(dir, keep) {
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

/**
 * Does any line containing `needle` parse to something `test` accepts?
 * @param {string} file
 * @param {string} needle
 * @param {(ev:any)=>boolean} test
 */
async function findLine(file, needle, test) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes(needle)) continue;
    try {
      if (test(JSON.parse(line))) {
        rl.close();
        return true;
      }
    } catch {
      /* torn line */
    }
  }
  return false;
}
