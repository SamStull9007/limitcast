// @ts-check
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { windowName } from './forecast.mjs';

/** @typedef {import('./forecast.mjs').Sample} Sample */

/**
 * Samples from the JSON Claude Code pipes to its status line.
 * @param {any} input parsed status-line JSON
 * @param {number} now epoch ms
 * @returns {Sample[]}
 */
export function claudeSamples(input, now) {
  const rl = input?.rate_limits;
  if (!rl || typeof rl !== 'object') return [];
  /** @type {Sample[]} */
  const out = [];
  for (const [key, win] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ]) {
    const w = rl[key];
    const pct = Number(w?.used_percentage);
    const reset = Number(w?.resets_at);
    if (Number.isFinite(pct) && Number.isFinite(reset) && reset > 0) {
      out.push({ t: now, src: 'claude', win, pct, reset, ...(input.session_id ? { sid: String(input.session_id) } : {}) });
    }
  }
  return out;
}

/**
 * Samples from one Codex rollout JSONL line, or [] if it carries no rate limits.
 * @param {string} line
 * @returns {Sample[]}
 */
export function codexSamples(line) {
  if (!line.includes('"rate_limits"')) return [];
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return [];
  }
  const rl = ev?.payload?.rate_limits;
  const t = Date.parse(ev?.timestamp);
  if (!rl || !Number.isFinite(t)) return [];
  /** @type {Sample[]} */
  const out = [];
  for (const w of [rl.primary, rl.secondary]) {
    const pct = Number(w?.used_percent);
    const reset = Number(w?.resets_at);
    const mins = Number(w?.window_minutes);
    if (Number.isFinite(pct) && Number.isFinite(reset) && reset > 0 && mins > 0) {
      out.push({ t, src: 'codex', win: windowName(mins), pct, reset });
    }
  }
  return out;
}

/**
 * All Codex samples from rollout files modified since `since`.
 * @param {number} since epoch ms
 * @param {string} [root]
 * @returns {Promise<Sample[]>}
 */
export async function readCodex(since, root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')) {
  if (!existsSync(root)) return [];
  /** @type {Sample[]} */
  const out = [];
  for (const file of rolloutFiles(root, since)) {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) for (const s of codexSamples(line)) if (s.t >= since) out.push(s);
  }
  return out;
}

/**
 * @param {string} dir
 * @param {number} since
 * @returns {string[]}
 */
function rolloutFiles(dir, since) {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...rolloutFiles(p, since));
    else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= since) out.push(p);
  }
  return out;
}
