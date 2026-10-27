// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './store.mjs';

// What your tokens would cost at the API's list prices ("API-equivalent cost"). A subscription is not billed this way:
// it is a yardstick for what the plan covers. Claude models only; any other model is left out, never priced at 0.

/**
 * USD per million tokens. input/output: base prices; readX: cache read as a multiple of input; over: the prices that
 * apply to a call whose whole prompt is above `above` tokens. Cache writes are 1.25x input (5 minutes) or 2x (1 hour).
 * Source: platform.claude.com/docs/en/about-claude/pricing, read 2026-10-26. Override or add models in
 * ~/.local/state/limitcast/prices.json: {"models": {"claude-opus-4-1": {"input": 15, "output": 75, "readX": 0.1}}}.
 * @typedef {{input:number, output:number, readX:number, over?:{above:number, input:number, output:number}}} Price
 * @type {Record<string, Price>}
 */
export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, readX: 0.025 },
  'claude-opus-5-5': { input: 4, output: 20, readX: 0.05 },
  'claude-sonnet-5-5': { input: 2, output: 10, readX: 0.05 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, readX: 0.1, over: { above: 100_000, input: 0.5, output: 2.5 } },
};

const WRITE_5M = 1.25;
const WRITE_1H = 2;

/**
 * The price table with your overrides on top. A bad or missing file changes nothing.
 * @returns {Record<string, Price>}
 */
export function priceTable() {
  try {
    const o = JSON.parse(readFileSync(join(stateDir(), 'prices.json'), 'utf8')).models;
    const good = Object.entries(o ?? {}).filter(([, p]) => p && typeof p === 'object' && Number(p.input) > 0 && Number(p.output) > 0);
    if (!good.length) return PRICES;
    return { ...PRICES, ...Object.fromEntries(good.map(([k, p]) => [k, { readX: 0.1, ...p }])) };
  } catch {
    return PRICES;
  }
}

/**
 * The price of a model id: an exact key, else the longest key it starts with (ids carry a date suffix at times).
 * @param {string|undefined} model
 * @param {Record<string, Price>} table
 */
export function priceFor(model, table) {
  if (!model) return null;
  const key = Object.keys(table)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

/**
 * API-equivalent dollars of one model call, or null when its model has no price.
 * @param {{model?:string, input:number, cacheWrite:number, cacheWrite1h?:number, cacheRead:number, output:number}} u
 * @param {Record<string, Price>} [table]
 */
export function callCost(u, table = priceTable()) {
  const base = priceFor(u.model, table);
  if (!base) return null;
  const p = base.over && u.input + u.cacheWrite + u.cacheRead > base.over.above ? { ...base, ...base.over } : base;
  const w1h = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
  const w5m = u.cacheWrite - w1h;
  return (u.input * p.input + (w5m * WRITE_5M + w1h * WRITE_1H) * p.input + u.cacheRead * p.readX * p.input + u.output * p.output) / 1e6;
}

/**
 * Total API-equivalent dollars of many calls, how many tokens were priced and how many were not, and dollars by model.
 * @param {Parameters<typeof callCost>[0][]} calls
 */
export function costOf(calls) {
  const table = priceTable();
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  /** @type {Map<string, number>} */
  const byModel = new Map();
  for (const u of calls) {
    const n = u.input + u.cacheWrite + u.cacheRead + u.output;
    const c = callCost(u, table);
    if (c === null) {
      unpriced += n;
      continue;
    }
    total += c;
    priced += n;
    const k = u.model ?? '';
    byModel.set(k, (byModel.get(k) ?? 0) + c);
  }
  return { total, priced, unpriced, byModel };
}

/** "$0.42", "$12.34", "$1,234". @param {number} d */
export const fmtUsd = (d) => (d >= 100 ? `$${Math.round(d).toLocaleString('en-US')}` : `$${d.toFixed(2)}`);
