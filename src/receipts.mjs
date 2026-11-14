// @ts-check
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { costOf } from './prices.mjs';
import { codexUsage, grokRoot, grokUsage } from './usage.mjs';

// What a finished Codex or Grok subagent used, for the SubagentStop receipt. Claude's receipt is priced from its own
// transcript in subagents.mjs; the other two hosts keep usage elsewhere (a Codex rollout, a Grok session ledger).

/** @typedef {{calls:number, fresh:number, read:number, usd:number|null}} HostUsage */

/**
 * Which tool sent a SubagentStop payload. Grok writes camelCase fields; Codex and Claude write snake_case, and tell
 * apart by where the transcript lives.
 * @param {any} hook
 * @returns {'claude'|'codex'|'grok'}
 */
export function stopHost(hook) {
  const path = String(hook?.agent_transcript_path ?? hook?.transcriptPath ?? hook?.transcript_path ?? '');
  if (hook?.sessionId !== undefined || hook?.subagentType !== undefined || hook?.transcriptPath !== undefined) return 'grok';
  if (path.includes('/.codex/')) return 'codex';
  if (path.includes('/.grok/')) return 'grok';
  return 'claude';
}

/** @param {import('./usage.mjs').Usage[]} usages @returns {HostUsage} */
function summarize(usages) {
  const cost = costOf(usages);
  return {
    calls: usages.length,
    fresh: usages.reduce((a, u) => a + u.input + u.cacheWrite + u.output, 0),
    read: usages.reduce((a, u) => a + u.cacheRead, 0),
    // A partial dollar figure would read as the whole, so say nothing when any of the tokens had no price.
    usd: usages.length && cost.unpriced === 0 ? cost.total : null,
  };
}

/**
 * A Codex subagent's rollout: its token_count events carry running totals, so each model call is the increase over the last.
 * @param {string} path
 * @returns {HostUsage}
 */
export function codexSubagentUsage(path) {
  const file = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  const st = { prev: null, cwd: '', model: '' };
  /** @type {import('./usage.mjs').Usage[]} */
  const usages = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const u = codexUsage(line, st, '');
    if (u) usages.push(u);
  }
  return summarize(usages);
}

/** A Grok child session is a session of its own: its summary says so, and its usage.json is the ledger. @param {string} dir */
function subagentLedger(dir) {
  try {
    const kind = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'))?.session_kind;
    if (kind !== 'subagent') return null;
    return JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A Grok subagent's session ledger. The hook names the subagent and a transcript; either one leads to the child
 * session directory <root>/<project>/<child id>/. A directory that is not a subagent session (the parent's) is never used.
 * @param {any} hook
 * @param {string} [root]
 * @returns {HostUsage|null}
 */
export function grokSubagentUsage(hook, root = grokRoot()) {
  const ids = [hook?.subagentId, hook?.subagent_id, hook?.agent_id, hook?.sessionId, hook?.session_id].filter((s) => typeof s === 'string' && s);
  const transcript = hook?.transcriptPath ?? hook?.transcript_path;
  const dirs = typeof transcript === 'string' ? [dirname(transcript)] : [];
  try {
    if (existsSync(root)) {
      for (const proj of readdirSync(root, { withFileTypes: true })) {
        if (proj.isDirectory()) for (const id of ids) dirs.push(join(root, proj.name, id));
      }
    }
  } catch {
    /* an unreadable root: no receipt */
  }
  for (const dir of dirs) {
    const ledger = subagentLedger(dir);
    if (ledger) {
      const usages = grokUsage(ledger, '', '');
      if (usages.length) return { ...summarize(usages), calls: Number(ledger?.session?.modelCalls) || usages.length };
    }
  }
  return null;
}

/**
 * Usage of the subagent a SubagentStop payload describes, or null when this host's transcript cannot be read.
 * @param {any} hook
 * @returns {{src:'codex'|'grok', usage:HostUsage}|null}
 */
export function hostSubagentUsage(hook) {
  const src = stopHost(hook);
  try {
    if (src === 'codex') {
      const path = hook?.agent_transcript_path;
      return typeof path === 'string' ? { src, usage: codexSubagentUsage(path) } : null;
    }
    if (src === 'grok') {
      const usage = grokSubagentUsage(hook);
      return usage ? { src, usage } : null;
    }
  } catch {
    /* an unreadable transcript: no receipt */
  }
  return null;
}
