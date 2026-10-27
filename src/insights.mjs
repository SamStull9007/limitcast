// @ts-check
import { fmtBig, valuePeriod } from './value.mjs';

const DAY = 86400_000;
const ACTIONS = {
  hold: 'Forecast holds',
  budget: 'Subagent-budget holds',
  today: 'Daily-share holds',
  switch: 'Tight-window model changes',
  default: 'Per-type model choices',
  cold: 'Cold-cache holds',
};

/** Totals without prompts, projects, paths, account names or session IDs.
 * @param {{value:import('./value.mjs').Value, usage:import('./usage.mjs').Usage[], blocks:import('./results.mjs').Block[], since:number, until:number}} r
 */
export function periodInsights({ value, usage, blocks, since, until }) {
  const current = usage.filter((u) => u.t >= since && u.t < until);
  const providers = ['claude', 'codex', 'grok'].map((src) => {
    const mine = current.filter((u) => u.src === src);
    return {
      src,
      calls: mine.length,
      activeDays: new Set(mine.map((u) => new Date(u.t).toISOString().slice(0, 10))).size,
      fresh: mine.reduce((n, u) => n + u.input + u.cacheWrite, 0),
      read: mine.reduce((n, u) => n + u.cacheRead, 0),
      output: mine.reduce((n, u) => n + u.output, 0),
    };
  });
  const seen = new Set();
  const actions = Object.fromEntries(Object.keys(ACTIONS).map((kind) => [kind, { actual: 0, preview: 0 }]));
  let attempts = 0;
  for (const b of blocks.filter((b) => b.t >= since && b.t < until)) {
    const kind = b.kind ?? 'hold';
    if (!actions[kind]) continue;
    // Older hooks have no operation ID: retain and label their attempts instead of guessing duplicates.
    const key = b.operation ? JSON.stringify([b.src, b.sid, b.operation, Boolean(b.shadow)]) : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    else attempts++;
    actions[kind][b.shadow ? 'preview' : 'actual']++;
  }
  const previous = valuePeriod(value, since - (until - since), since);
  const context = valuePeriod(value, since, until);
  const comparison =
    value.contextSince && value.contextSince <= since - (until - since) && !context.legacy && !previous.legacy ? previous.tokens : null;
  return {
    since,
    until,
    days: (until - since) / DAY,
    providers,
    actions,
    attempts,
    context,
    contextAvailable: Number.isFinite(value.contextSince),
    previousContext: comparison,
  };
}

/** @param {ReturnType<typeof periodInsights>} r @param {boolean} pro */
export function insightsReport(r, pro) {
  const out = [
    '## Your capacity report',
    '',
    `${new Date(r.since).toISOString()} to ${new Date(r.until).toISOString()} (UTC; activity timestamps).`,
    '',
    '| Tool | New input + cache writes | Cached reads | Output | Active days |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const p of r.providers) out.push(`| ${p.src} | ${fmtBig(p.fresh)} | ${fmtBig(p.read)} | ${fmtBig(p.output)} | ${p.activeDays} |`);
  out.push('', 'Usage above is recorded consumption, not savings. No recorded activity does not prove a tool was unused.');
  if (pro) {
    if (r.contextAvailable)
      out.push(
        '',
        `Claude context reduction: **estimated ${fmtBig(r.context.tokens)} input tokens not re-sent** across ${r.context.calls} calls in this period, relative to your first recorded starting context (characters / 4).`,
      );
    else out.push('Claude context reduction: unavailable. Run `limitcast trim` to record a baseline before estimating avoided input.');
    out.push(
      'This estimate can include project or manual configuration changes. It is not proof that Limitcast caused the reduction. Codex/Grok context savings: unavailable.',
    );
    if (r.context.legacy) out.push(`${r.context.legacy} legacy session record(s) lack timestamps and are excluded from this period estimate.`);
    if (r.previousContext !== null)
      out.push(`Previous equal period: estimated ${fmtBig(r.previousContext)} context tokens not re-sent. Neither figure measures cash savings.`);
    else out.push('Previous-period comparison: unavailable until two complete periods have been observed.');
  }
  out.push('', '| Protection event | Applied | Free preview: would have acted |', '|---|---:|---:|');
  for (const [kind, label] of Object.entries(ACTIONS)) out.push(`| ${label} | ${r.actions[kind].actual} | ${r.actions[kind].preview} |`);
  out.push(
    '',
    `Operation IDs deduplicate retries when supplied. ${r.attempts} older/unidentified event(s) are recorded attempts. Holds and warnings are not measured saved tokens or proven prevented interruptions.`,
  );
  out.push('', '### What to do next');
  const claude = r.providers[0];
  const held = Object.values(r.actions).reduce((n, a) => n + a.actual, 0);
  const previewed = Object.values(r.actions).reduce((n, a) => n + a.preview, 0);
  if (!r.providers.some((p) => p.calls)) out.push('- Run `limitcast onboard` to check setup and the next useful step.');
  else if (r.actions.cold.actual || r.actions.cold.preview)
    out.push('- Before resuming a long idle Claude session, consider `/compact`; a warning alone does not reduce its input.');
  else if (claude.fresh > 0)
    out.push('- Run `limitcast report --why` (Pro) to find the largest sources of new Claude tokens before changing a budget or model.');
  else out.push('- Check `limitcast status` before a heavy run; each provider has its own limits.');
  if (!held && !previewed)
    out.push('- No protection actions recorded. `limitcast onboard` distinguishes missing setup from a period that needed no intervention.');
  if (!pro && previewed)
    out.push(
      `- Pro would have acted on ${previewed} recorded event(s). Try it with limitcast trial (7 days, no card), then limitcast install --guard --alerts.`,
    );
  out.push('- Share voluntarily with `limitcast results --share`; nothing is uploaded automatically.');
  return out.join('\n');
}

/** @param {ReturnType<typeof periodInsights>} r @param {boolean} pro */
export function insightsShare(r, pro) {
  const parts = r.providers
    .filter((p) => p.calls)
    .map(
      (p) =>
        `${p.src}: ${p.activeDays} UTC active days, ${fmtBig(p.fresh)} new input/write, ${fmtBig(p.read)} cached, ${fmtBig(p.output)} output tokens`,
    );
  const actual = Object.values(r.actions).reduce((n, a) => n + a.actual, 0);
  const preview = Object.values(r.actions).reduce((n, a) => n + a.preview, 0);
  parts.push(`${actual} applied protection events; ${preview} free-preview events (${r.attempts} unidentified attempts)`);
  if (pro && r.contextAvailable) parts.push(`estimated ${fmtBig(r.context.tokens)} Claude context tokens not re-sent this period vs baseline`);
  if (pro && !r.contextAvailable) parts.push('Claude context estimate unavailable');
  return `Voluntary capacity check-in, ${r.days} days: ${parts.join('; ')}. No prompts, project names or account IDs. https://limitcast.dev`;
}
