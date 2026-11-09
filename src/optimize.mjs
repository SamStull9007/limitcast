import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, updateConfig, writeAtomic } from './store.mjs';

export const digest = (text) => createHash('sha256').update(text).digest('hex');
export const HOSTS = ['claude', 'codex', 'grok'];
export const CORE_TOOLS =
  /^(?:Bash|Read|Edit|Write|Grep|Glob|Skill|WebSearch|WebFetch|AskUserQuestion|exec|exec_command|apply_patch|request_user_input)$/i;
const CAPABILITIES = {
  collaboration: /spawn_agent|spawn_subagent|collab|send_message|followup_task|wait_agent|list_agents|interrupt_agent/,
  goals: /create_goal|get_goal|update_goal/,
  image_media: /view_image|imagegen|image_generation|generatedImage|emitImage/,
};
const validTool = (name) => typeof name === 'string' && /^[\w:.-]{1,100}$/.test(name) && !Object.hasOwn(Object.prototype, name);

export function repository(cwd = process.cwd()) {
  const root = realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000 }).trim());
  return { root, id: digest(root).slice(0, 24) };
}

const location = (repo) => join(stateDir(), 'optimize', `${repo.id}.json`);
export function readOptimization(repo) {
  const path = location(repo);
  if (!existsSync(path)) return { version: 1, hosts: {}, facts: [], receipts: [], config: { learn: false, map: false, keep: [] } };
  if (statSync(path).size > 2_000_000) throw new Error('optimizer state exceeds its size limit');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (
    state.version !== 1 ||
    !state.hosts ||
    Array.isArray(state.hosts) ||
    !Array.isArray(state.facts) ||
    !Array.isArray(state.receipts) ||
    !state.config ||
    !Array.isArray(state.config.keep)
  )
    throw new Error('unsupported optimizer state; inspect before changing it');
  return state;
}

// Reuse the settings lock; callbacks only read/write bounded local JSON and never run a command or model.
export function changeOptimization(repo, change) {
  let result;
  updateConfig((cfg) => {
    const state = readOptimization(repo);
    result = change(state);
    saveOptimization(repo, state);
    return cfg;
  });
  return result;
}

export function saveOptimization(repo, state) {
  const text = JSON.stringify(state);
  if (text.length > 2_000_000) throw new Error('optimizer state exceeds its size limit');
  mkdirSync(join(stateDir(), 'optimize'), { recursive: true, mode: 0o700 });
  writeAtomic(location(repo), text);
}

export function commandShape(command) {
  if (typeof command !== 'string' || command.length > 300 || /[;&|<>`$\n\r]/.test(command)) return null;
  const clean = command
    .trim()
    .replace(/^rtk\s+/, '')
    .replace(/\s+/g, ' ');
  if (/^(?:python3?|\.venv\/bin\/python3?) -m (?:pytest|unittest)$/.test(clean)) return clean;
  if (/^(?:pytest|npm test|node --test|cargo (?:test|check|build)|go test \.\/\.\.\.)$/.test(clean)) return clean;
  if (/^npm run (?:test|build|lint|check|typecheck)$/.test(clean)) return clean;
  if (/^npx (?:tsc|vitest run)$/.test(clean)) return clean;
  return null;
}

function responseText(value) {
  if (typeof value === 'string') return value.slice(0, 16000);
  if (!value || typeof value !== 'object') return '';
  return [
    value.stdout,
    value.stderr,
    value.output_for_prompt,
    value.output,
    typeof value.content === 'string'
      ? value.content
      : value.content
          ?.filter?.((x) => x.type === 'text')
          .map((x) => x.text)
          .join('\n'),
  ]
    .filter((x) => typeof x === 'string')
    .join('\n')
    .slice(0, 16000);
}

export function normalizeEvent(hook, host) {
  if (!HOSTS.includes(host) || !hook || typeof hook !== 'object') throw new Error('unsupported optimizer host or event');
  const sid = String(hook.session_id ?? hook.sessionId ?? '').slice(0, 200);
  if (!sid) throw new Error('optimizer needs a session id');
  const rawEvent = String(hook.hook_event_name ?? hook.hookEventName ?? '');
  const event = rawEvent.includes('_')
    ? rawEvent
        .split('_')
        .map((s) => s[0]?.toUpperCase() + s.slice(1))
        .join('')
    : rawEvent;
  if (!['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'].includes(event))
    throw new Error('unsupported optimizer event');
  const nativeName = String(hook.tool_name ?? hook.toolName ?? '').slice(0, 100);
  const aliases = { run_terminal_command: 'Bash', run_terminal_cmd: 'Bash', search_replace: 'Edit', read_file: 'Read' };
  const name = Object.hasOwn(aliases, nativeName) ? aliases[nativeName] : nativeName;
  let input = hook.tool_input ?? hook.toolInput ?? {};
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      input = { code: input };
    }
  }
  const response = hook.tool_response ?? hook.tool_result ?? hook.toolResult ?? hook.error;
  const text = responseText(response);
  const rawCode = typeof input?.code === 'string' ? input.code : typeof input?.input === 'string' ? input.input : '';
  const nested = [...rawCode.matchAll(/\b(?:cmd|command)\s*:\s*("(?:[^"\\]|\\.)*"|'[^'\\]*')/g)];
  let nestedCommand;
  if (nested.length === 1) {
    try {
      nestedCommand = nested[0][1][0] === '"' ? JSON.parse(nested[0][1]) : nested[0][1].slice(1, -1);
    } catch {
      /* ambiguous command: no learning */
    }
  }
  const command = commandShape(input?.command ?? input?.cmd ?? nestedCommand);
  const reportedCode = /(?:^|\n)(?:Exit code |Process exited with code |exit: )(\d+)\b/i.exec(text)?.[1];
  const status = response?.exit_code ?? response?.exitCode ?? hook.exit_code ?? (reportedCode === undefined ? undefined : Number(reportedCode));
  const failed =
    event === 'PostToolUseFailure' ||
    response?.is_error === true ||
    response?.isError === true ||
    (typeof status === 'number' && status !== 0) ||
    (Boolean(command) && /(?:^|\s)[1-9]\d* failed\b/.test(text));
  const path = String(
    input?.file_path ?? input?.target_file ?? input?.path ?? /\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/.exec(rawCode)?.[1] ?? '',
  );
  const edit = /^(?:Edit|Write|MultiEdit|apply_patch|replace_file_content|write_to_file)$/i.test(name) || /\btools\.apply_patch\s*\(/.test(rawCode);
  const succeeded = Boolean(command) && !failed && (status === 0 || /(?:^|\n)(?:# fail 0|.*\b\d+ passed\b|OK)\s*$/m.test(text));
  const id = hook.tool_use_id ?? hook.toolUseId ?? hook.call_id;
  return {
    host,
    sid: digest(`${host}:${sid}`).slice(0, 24),
    event,
    name,
    command,
    failed,
    succeeded,
    edit,
    environmentFailure: failed && /command not found|No module named|not recognized as an? (?:internal|external) command|ENOENT/.test(text),
    file: path ? digest(path).slice(0, 16) : '',
    // Keep only a digest of failure evidence, never command output, prompts or credentials.
    failure: failed ? digest(text.replace(/0x[\da-f]+|\b\d+\b/gi, '#')).slice(0, 20) : '',
    identity: id ? digest(`${event.replace('PostToolUseFailure', 'PostToolUse')}:${String(id)}`).slice(0, 32) : null,
    capabilities: Object.entries(CAPABILITIES)
      .filter(([, re]) => re.test(`${name} ${JSON.stringify(input).slice(0, 32000)}`))
      .map(([key]) => key),
    tools: Array.isArray(hook.tools)
      ? hook.tools
          .map((t) => (typeof t === 'string' ? t : t?.name))
          .filter(validTool)
          .slice(0, 200)
      : [],
  };
}

const freshTurn = () => ({ calls: 0, errors: 0, repeats: 0, failures: [], edits: {}, green: false, nudged: false, warned: false });

export function loopDecision(turn, productiveLengths = []) {
  const churn = Math.max(0, ...Object.values(turn.edits));
  if (turn.green || turn.calls < 18 || turn.errors < 4 || turn.repeats < 3 || churn < 3) return null;
  const sorted = productiveLengths.slice().sort((a, b) => a - b);
  const normal = sorted.length >= 5 ? sorted[Math.floor((sorted.length - 1) * 0.9)] : 20;
  if (turn.calls < Math.max(18, normal * 1.25)) return null;
  if (!turn.nudged) return 'redirect';
  if (!turn.warned && turn.calls >= turn.nudgeAt + 12 && turn.repeats >= turn.nudgeRepeats + 3) return 'notice';
  return null;
}

function learn(state, session, e) {
  if (!state.config.learn || !e.command) return;
  for (const fact of state.facts) {
    if (fact.to === e.command && e.environmentFailure && fact.state === 'active') fact.state = 'retired';
  }
  if (e.environmentFailure) session.failed = [...new Set([...(session.failed ?? []), e.command])].slice(-6);
  if (!e.succeeded) return;
  for (const from of session.failed ?? []) {
    if (from === e.command) continue;
    if (/test/.test(from) !== /test/.test(e.command)) continue;
    let fact = state.facts.find((f) => f.from === from && f.to === e.command);
    if (!fact) {
      fact = { id: digest(`${from}\0${e.command}`).slice(0, 16), from, to: e.command, state: 'candidate', sessions: [] };
      state.facts.push(fact);
    }
    if (fact.state === 'retired') continue;
    fact.sessions = [...new Set([...fact.sessions, e.sid])].slice(-3);
    if (fact.sessions.length >= 3) fact.state = 'active';
  }
  session.failed = [];
  state.facts = state.facts.slice(-100);
}

export function learnedContext(state) {
  if (!state.config.learn) return '';
  return state.facts
    .filter((f) => f.state === 'active' && commandShape(f.from) && commandShape(f.to))
    .slice(0, 4)
    .map((f) => `Repository evidence: ${f.from} failed and ${f.to} succeeded in three independent sessions. Consider ${f.to} for that check.`)
    .join('\n')
    .slice(0, 1000);
}

export function processEvent(state, e, now = Date.now()) {
  const host = (state.hosts[e.host] ??= {
    sessions: {},
    completed: 0,
    finished: [],
    prompts: 0,
    used: [],
    usedTools: [],
    catalog: {},
    productive: [],
  });
  const old = Object.keys(host.sessions);
  if (!host.sessions[e.sid] && old.length >= 30) delete host.sessions[old[0]];
  const session = (host.sessions[e.sid] ??= { turn: freshTurn(), seen: [], started: now });
  if (e.identity && session.seen.includes(e.identity)) return {};
  if (e.identity) session.seen = [...session.seen, e.identity].slice(-500);
  const receipt = (kind) => {
    state.receipts = [...state.receipts, { kind, host: e.host, session: e.sid, t: now }].slice(-200);
  };
  host.used = [...new Set([...host.used, ...e.capabilities])];
  if (validTool(e.name) && host.usedTools.length < 200) host.usedTools = [...new Set([...host.usedTools, e.name])];
  for (const tool of e.tools) {
    if (Object.keys(host.catalog).length < 200) host.catalog[tool] ??= { used: host.usedTools.includes(tool), sessions: [] };
  }
  if (Object.hasOwn(host.catalog, e.name)) host.catalog[e.name].used = true;
  if (e.event === 'SessionStart' || (e.host === 'grok' && /^PostToolUse(?:Failure)?$/.test(e.event) && !session.injected)) {
    if (e.host === 'grok' && e.event === 'SessionStart') return {};
    if (session.injected) return {};
    session.injected = true;
    const context = learnedContext(state);
    if (context) receipt('facts-injected');
    if (e.host !== 'grok') return { context, map: state.config.map };
    session.pendingContext = context;
    session.pendingMap = state.config.map;
  }
  if (e.event === 'UserPromptSubmit') {
    session.turn = freshTurn();
    session.stopped = false;
    session.failed = [];
    host.prompts++;
  } else if (e.event === 'Stop' || e.event === 'SessionEnd') {
    if (!session.stopped && session.turn.green && session.turn.calls) host.productive = [...host.productive, session.turn.calls].slice(-50);
    session.stopped = true;
    if (!host.finished.includes(e.sid)) {
      host.finished = [...host.finished, e.sid].slice(-1000);
      host.completed++;
      for (const name of e.tools) {
        const tool = host.catalog[name];
        if (tool) tool.sessions = [...new Set([...tool.sessions, e.sid])].slice(-5);
      }
    }
  } else if (/^PostToolUse(?:Failure)?$/.test(e.event)) {
    const turn = session.turn;
    turn.calls++;
    if (e.edit) {
      if (Object.keys(turn.edits).length < 64 || turn.edits[e.file || e.name]) turn.edits[e.file || e.name] = (turn.edits[e.file || e.name] ?? 0) + 1;
      turn.green = false;
    }
    if (e.failed) {
      turn.errors++;
      if (turn.failures.includes(e.failure)) turn.repeats++;
      turn.failures = [...turn.failures, e.failure].slice(-30);
      turn.green = false;
    }
    if (e.succeeded) {
      turn.green = true;
      turn.errors = 0;
      turn.repeats = 0;
      turn.failures = [];
      turn.edits = {};
    }
    learn(state, session, e);
    const decision = loopDecision(turn, host.productive);
    if (decision === 'redirect') {
      turn.nudged = true;
      turn.nudgeAt = turn.calls;
      turn.nudgeRepeats = turn.repeats;
      receipt('loop-redirect');
      return {
        context:
          'Limitcast process check: repeated failures and edits have stopped making progress. Re-read the failing check, form a different root-cause hypothesis, and verify it before editing again. Continue the task; this notice does not stop it.',
      };
    }
    if (decision === 'notice') {
      turn.warned = true;
      receipt('loop-notice');
      return { notice: 'Limitcast: repeated failures continued after a redirect. Review the approach; interrupt the turn if needed.' };
    }
  }
  // Keep ended-session tombstones so replay cannot count the same session twice.
  const ids = Object.keys(host.sessions);
  for (const id of ids.slice(0, Math.max(0, ids.length - 30))) delete host.sessions[id];
  if (session.pendingContext || session.pendingMap) {
    const result = { context: session.pendingContext, map: session.pendingMap };
    delete session.pendingContext;
    delete session.pendingMap;
    return result;
  }
  return {};
}

export function capabilityProposals(state, host) {
  const h = state.hosts[host];
  if (!h || h.completed < 5 || h.prompts < 10) return [];
  const keep = state.config.keep ?? [];
  if (host === 'codex') return Object.keys(CAPABILITIES).filter((c) => !h.used.includes(c) && !keep.includes(c));
  if (host === 'claude')
    return Object.entries(h.catalog)
      .filter(([n, t]) => !CORE_TOOLS.test(n) && !t.used && t.sessions.length >= 5 && !keep.includes(n))
      .map(([n]) => n);
  return [];
}
