// Weekly launch metrics: node scripts/metrics.mjs [--out DIR] [--notify]
// Writes <DIR>/YYYY-MM-DD.md and appends <DIR>/history.csv. Every source is optional: one that fails is reported, not fatal.
// Optional secrets, read from the macOS Keychain and never printed: limitcast-goatcounter (GoatCounter API token),
// limitcast-polar-oat (Polar organization access token with subscriptions:read and orders:read).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { send } from '../src/notify.mjs';
import { POLAR_ORG_ID } from '../src/polar.mjs';

const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(homedir(), 'Documents', 'Side Business', 'limitcast-metrics');
const day = (d) => d.toLocaleDateString('en-CA'); // local YYYY-MM-DD
const now = new Date();
const weekAgo = new Date(now.getTime() - 7 * 86400_000);
const LAUNCH = '2026-10-25';

const secret = (service) => {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};
const json = async (url, headers = {}) => {
  const r = await fetch(url, { headers: { 'user-agent': 'limitcast-metrics', ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());

/** @type {Record<string, string|number>} */
const row = { date: day(now) };
const lines = [`# limitcast metrics, week to ${day(now)}`, ''];
const section = async (title, fn) => {
  try {
    lines.push(`## ${title}`, ...(await fn()), '');
  } catch (e) {
    lines.push(`## ${title}`, `- not available: ${/** @type {Error} */ (e).message}`, '');
  }
};

await section('npm', async () => {
  const week = await json(`https://api.npmjs.org/downloads/point/${day(weekAgo)}:${day(now)}/limitcast`);
  const total = await json(`https://api.npmjs.org/downloads/point/${LAUNCH}:${day(now)}/limitcast`);
  row.npm_week = week.downloads;
  row.npm_total = total.downloads;
  return [`- downloads this week: ${week.downloads}`, `- since launch (${LAUNCH}): ${total.downloads}`];
});

await section('GitHub', async () => {
  const repo = gh('repos/SamStull9007/limitcast');
  const views = gh('repos/SamStull9007/limitcast/traffic/views');
  const refs = gh('repos/SamStull9007/limitcast/traffic/popular/referrers');
  row.stars = repo.stargazers_count;
  row.forks = repo.forks_count;
  row.views_14d = views.count;
  row.visitors_14d = views.uniques;
  return [
    `- stars ${repo.stargazers_count}, forks ${repo.forks_count}, open issues ${repo.open_issues_count}`,
    `- last 14 days: ${views.count} views from ${views.uniques} visitors`,
    ...refs.slice(0, 5).map((/** @type {any} */ r) => `- referrer ${r.referrer}: ${r.count} views, ${r.uniques} visitors`),
  ];
});

await section('Site (GoatCounter)', async () => {
  const token = secret('limitcast-goatcounter');
  if (!token) throw new Error('add a GoatCounter API token to the Keychain as "limitcast-goatcounter"');
  const auth = { authorization: `Bearer ${token}` };
  const q = `start=${day(weekAgo)}&end=${day(now)}`;
  const total = await json(`https://limitcast.goatcounter.com/api/v0/stats/total?${q}`, auth);
  const refs = await json(`https://limitcast.goatcounter.com/api/v0/stats/toprefs?${q}&limit=8`, auth);
  const hits = await json(`https://limitcast.goatcounter.com/api/v0/stats/hits?${q}&limit=20`, auth);
  const checkout = (hits.hits ?? []).filter((/** @type {any} */ h) => /^checkout-|purchase-success/.test(h.path));
  row.site_visits = total.total;
  return [
    `- visits this week: ${total.total}`,
    ...(refs.stats ?? []).map((/** @type {any} */ r) => `- from ${r.name || '(direct)'}: ${r.count}`),
    ...checkout.map((/** @type {any} */ h) => `- ${h.path}: ${h.count}`),
  ];
});

await section('Polar', async () => {
  const token = secret('limitcast-polar-oat');
  if (!token) throw new Error('add a Polar organization access token to the Keychain as "limitcast-polar-oat"');
  const auth = { authorization: `Bearer ${token}` };
  const subs = await json(`https://api.polar.sh/v1/subscriptions/?organization_id=${POLAR_ORG_ID}&limit=100`, auth);
  // Our own test checkouts stay in Polar after the customer is deleted, so leave them out of the counts.
  const internal = new Set(['support@limitcast.dev', 'sam.stull73@gmail.com']);
  const real = (subs.items ?? []).filter((/** @type {any} */ x) => !internal.has(String(x.customer?.email ?? '').toLowerCase()));
  const count = (/** @type {string} */ s) => real.filter((/** @type {any} */ x) => x.status === s).length;
  row.trialing = count('trialing');
  row.active = count('active');
  row.canceled = count('canceled');
  return [`- trials ${row.trialing}, paying ${row.active}, canceled ${row.canceled}`];
});

await section('Listings', async () => {
  const checks = [
    ['SaaSHub', 'https://www.saashub.com/limitcast'],
    ['ClaudePluginHub', 'https://www.claudepluginhub.com/plugins/samstull9007-limitcast-plugin'],
    ['dev.to article', 'https://dev.to/api/articles/samstull9007/how-many-tokens-is-1-of-your-claude-code-limit-232n'],
  ];
  const out = [];
  for (const [name, url] of checks) {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 limitcast-metrics' } }).catch(() => null);
    const text = r?.ok ? await r.text() : '';
    if (name === 'dev.to article' && text) {
      const a = JSON.parse(text);
      row.devto_reactions = a.public_reactions_count;
      out.push(`- dev.to: ${a.public_reactions_count} reactions, ${a.comments_count} comments`);
    } else out.push(`- ${name}: ${r ? r.status : 'unreachable'}${text.toLowerCase().includes('limitcast') ? ', mentions limitcast' : ''}`);
  }
  out.push('- AlternativeTo, Terminal Trove and claudemarketplaces block scripts: check the approval emails in Gmail.');
  return out;
});

mkdirSync(outDir, { recursive: true });
const report = join(outDir, `${day(now)}.md`);
writeFileSync(report, `${lines.join('\n')}\n`);
const csv = join(outDir, 'history.csv');
const cols = [
  'date',
  'npm_week',
  'npm_total',
  'stars',
  'forks',
  'views_14d',
  'visitors_14d',
  'site_visits',
  'trialing',
  'active',
  'canceled',
  'devto_reactions',
];
if (!existsSync(csv)) writeFileSync(csv, `${cols.join(',')}\n`);
appendFileSync(csv, `${cols.map((c) => row[c] ?? '').join(',')}\n`);
console.log(`Wrote ${report}`);
if (args.includes('--notify')) {
  send(
    `limitcast this week: npm ${row.npm_week ?? '?'}, stars ${row.stars ?? '?'}, trials ${row.trialing ?? '?'}, paying ${row.active ?? '?'}. Report in Side Business/limitcast-metrics.`,
  );
}
