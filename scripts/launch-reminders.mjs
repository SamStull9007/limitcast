// Daily launch nudges: node scripts/launch-reminders.mjs [--dry-run]
// Sends a notification for today's launch step (opening the plan page on the key days), and for new dev.to
// comments and GitHub stars or issues since the last run. State: ~/.local/state/limitcast/launch-reminders.json.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { send } from '../src/notify.mjs';
import { stateDir } from '../src/store.mjs';

const PLAN = 'https://claude.ai/artifact/BQrhx5JhKBBXXvj7z98j54';
const DEVTO_ARTICLES = [4918168];
const dry = process.argv.includes('--dry-run');
const today = process.env.LIMITCAST_TODAY ?? new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD; the env var is for testing
const between = (from, to) => today >= from && today <= to;

/** One step per day; `open` is the plan-page section to open with it. */
const steps = [
  { on: '2026-10-27', text: 'Send the 4 creator messages (Sharbel, Povilas, Matt, Ian).', open: '#creators' },
  { on: '2026-10-28', text: 'GitHub: open the 2 awesome-list pull requests and comment on claude-code #24147.', open: '#ready' },
  { on: '2026-10-29', text: 'Hacker News: comment on 2–3 threads so your account is active before launch day.' },
  { on: '2026-11-02', text: 'Tomorrow 7–9am Central: Show HN. Read the fact sheet tonight.', open: '#hn' },
  { on: '2026-11-03', text: 'Launch day: post the Show HN by 9am Central, then r/ClaudeAI and r/ClaudeCode. LAUNCH30 is live.', open: '#hn' },
  { on: '2026-11-04', text: 'The last scheduled X post goes out today. Ask Claude to schedule the next two weeks.' },
  { on: '2026-11-08', text: 'File the awesome-claude-code issue today (the 14-day wait is over).', open: '#ready' },
  { on: '2026-11-09', text: 'LAUNCH30 ends today: last call in your launch threads.' },
  { on: '2026-11-10', text: 'Launch review: read the Monday metrics, then decide pricing and a Claude Pro account for the plugin directory.' },
];
const daily = between('2026-10-26', '2026-11-02')
  ? "Answer replies to today's X post, and 2–3 Claude Code limit questions on Reddit (no links): you need 100 karma for r/ClaudeAI by 3 Nov."
  : between('2026-11-03', '2026-11-09')
    ? 'Launch week: answer every reply on HN, Reddit, X and dev.to today.'
    : null;

const file = join(stateDir(), 'launch-reminders.json');
/** @type {{devto: string[], stars: number|null, issues: number[]}} */
let state = { devto: [], stars: null, issues: [] };
try {
  state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) };
} catch {
  /* first run */
}
const first = !existsSync(file);
const messages = [];

const step = steps.find((s) => s.on === today);
if (step) messages.push(step.text);
if (daily) messages.push(daily);

const ids = (/** @type {any[]} */ list) => list.flatMap((c) => [c, ...ids(c.children ?? [])]);
for (const a of DEVTO_ARTICLES) {
  try {
    const r = await fetch(`https://dev.to/api/comments?a_id=${a}`, { headers: { 'user-agent': 'limitcast-reminders' } });
    const comments = ids(await r.json()).filter((c) => c.user?.username !== 'samstull9007');
    const fresh = comments.filter((c) => !state.devto.includes(c.id_code));
    if (fresh.length && !first) messages.push(`New dev.to comment from ${fresh.map((c) => c.user?.name).join(', ')}: reply today.`);
    state.devto = [...new Set([...state.devto, ...comments.map((c) => c.id_code)])];
  } catch {
    /* offline: try tomorrow */
  }
}

try {
  const gh = (/** @type {string} */ p) => JSON.parse(execFileSync('gh', ['api', p], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  const stars = gh('repos/SamStull9007/limitcast').stargazers_count;
  if (state.stars !== null && stars > state.stars)
    messages.push(`GitHub: ${stars - state.stars} new star${stars - state.stars === 1 ? '' : 's'} (${stars} total).`);
  state.stars = stars;
  const issues = gh('repos/SamStull9007/limitcast/issues?state=open').map((/** @type {any} */ i) => i.number);
  const fresh = issues.filter((/** @type {number} */ n) => !state.issues.includes(n));
  if (fresh.length && !first) messages.push(`GitHub: new issue or pull request #${fresh.join(', #')}.`);
  state.issues = [...new Set([...state.issues, ...issues])];
} catch {
  /* gh missing or offline */
}

if (dry) console.log(messages.length ? messages.join('\n') : '(nothing today)');
else {
  writeFileSync(file, JSON.stringify(state));
  for (const m of messages) send(m);
  if (step?.open) spawn('open', [PLAN + step.open], { detached: true, stdio: 'ignore' }).unref();
}
