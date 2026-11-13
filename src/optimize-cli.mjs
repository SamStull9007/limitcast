import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { applyCapabilities, capabilityStatus, configuredServers, restoreCapabilities } from './capabilities.mjs';
import { reserveModelJob, startModelWorker } from './model-optimize.mjs';
import { capabilityProposals, changeOptimization, HOSTS, normalizeEvent, processEvent, readOptimization, repository } from './optimize.mjs';
import { installOptimizerHost } from './optimizer-hosts.mjs';
import { repositoryMap } from './repomap.mjs';

export function runOptimizationHook(hook, host) {
  if (process.env.LIMITCAST_MODEL_WORKER === '1') return {};
  if (hook.is_subagent || hook.subagent_id || hook.isSidechain) return {};
  const repo = repository(hook.cwd ?? hook.workdir ?? process.cwd());
  if (host === 'claude' && ['Stop', 'SessionEnd'].includes(hook.hook_event_name) && typeof hook.transcript_path === 'string') {
    hook = { ...hook, tools: transcriptTools(hook.transcript_path) };
  }
  const event = normalizeEvent(hook, host);
  let job;
  const result = changeOptimization(repo, (state) => {
    const result = processEvent(state, event);
    if (result.modelJob) job = reserveModelJob(state, event, result.modelJob);
    return result;
  });
  if (job) startModelWorker(repo, job);
  const context = [result.context, result.map ? repositoryMap(repo) : ''].filter(Boolean).join('\n\n');
  if (host === 'copilot') return context ? { additionalContext: context } : result.notice ? { additionalContext: result.notice } : {};
  return {
    ...(result.notice ? { systemMessage: result.notice } : {}),
    ...(context ? { hookSpecificOutput: { hookEventName: event.event, additionalContext: context } } : {}),
  };
}

export function transcriptTools(path) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(256_000);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const names = [];
    for (const line of buffer.toString('utf8', 0, bytes).split('\n')) {
      try {
        const row = JSON.parse(line);
        if (row.attachment?.type === 'deferred_tools_delta') names.push(...(row.attachment.addedNames ?? []));
        if (row.type === 'system' && row.subtype === 'init') names.push(...(row.tools ?? []));
      } catch {
        /* a partial line is not evidence */
      }
    }
    return [...new Set(names)].filter((n) => typeof n === 'string' && /^[\w:.-]{1,100}$/.test(n)).slice(0, 200);
  } finally {
    closeSync(fd);
  }
}

export function replayOptimization(events, host = 'codex') {
  if (!Array.isArray(events) || events.length > 10000) throw new Error('replay needs an array of at most 10000 hook events');
  const state = { version: 1, hosts: {}, facts: [], receipts: [], config: { learn: true, map: false, keep: [] } };
  const decisions = events.map((hook) => processEvent(state, normalizeEvent(hook, host)));
  return {
    events: events.length,
    redirects: state.receipts.filter((r) => r.kind === 'loop-redirect').length,
    notices: state.receipts.filter((r) => r.kind === 'loop-notice').length,
    facts: state.facts,
    decisions: decisions.map((r, i) => (r.context || r.notice ? { event: i, ...r } : null)).filter(Boolean),
  };
}

export function runOptimize(args, cwd = process.cwd()) {
  if (['--codex', '--grok', '--copilot', '--pi'].filter((f) => args.includes(f)).length > 1) throw new Error('choose one host at a time');
  const action = args[0] ?? 'status';
  const host = args.includes('--codex')
    ? 'codex'
    : args.includes('--grok')
      ? 'grok'
      : args.includes('--copilot')
        ? 'copilot'
        : args.includes('--pi')
          ? 'pi'
          : 'claude';
  if (action === 'install') return installOptimizerHost(host, { undo: args.includes('--undo') });
  if (action === 'replay') {
    if (!args[1] || statSync(args[1]).size > 2_000_000) throw new Error('choose a replay JSON file under 2 MB');
    return replayOptimization(JSON.parse(readFileSync(args[1], 'utf8')), host);
  }
  const repo = repository(cwd);
  if (action === 'map' && !['on', 'off'].includes(args[1])) return { text: repositoryMap(repo, { refresh: args.includes('--refresh') }) };
  if (['map', 'learn', 'model'].includes(action) && ['on', 'off'].includes(args[1])) {
    return changeOptimization(repo, (s) => {
      s.config[action] = args[1] === 'on';
      if (action === 'model' && args[1] === 'off' && s.model) delete s.model.job;
      return { [action]: s.config[action] };
    });
  }
  if (action === 'model') return { enabled: readOptimization(repo).config.model ?? false, ...readOptimization(repo).model };
  if (action === 'learn') return { enabled: readOptimization(repo).config.learn, facts: readOptimization(repo).facts };
  if (action === 'forget') {
    return changeOptimization(repo, (s) => {
      const fact = s.facts.find((f) => f.id === args[1]);
      if (!fact) throw new Error('choose a fact id from optimize learn');
      fact.state = 'retired';
      return { retired: fact.id };
    });
  }
  if (action === 'keep') {
    if (!args[1] || !/^[\w:.,-]{1,300}$/.test(args[1])) throw new Error('supply tool or capability names separated by commas');
    return changeOptimization(repo, (s) => {
      s.config.keep = [...new Set([...s.config.keep, ...args[1].split(',')])];
      return { keep: s.config.keep };
    });
  }
  if (action === 'capabilities') {
    if (args.includes('--undo')) return restoreCapabilities(repo, host);
    const at = args.indexOf('--apply');
    if (at >= 0) {
      const names = args[at + 1];
      if (!names || names.startsWith('--')) throw new Error('name the proposed capabilities to apply, separated by commas');
      return applyCapabilities(repo, host, names.split(','));
    }
    return capabilityStatus(repo, host);
  }
  if (action !== 'status')
    throw new Error('optimize: use status, model [on|off], learn [on|off], forget <id>, map [on|off], keep <names>, capabilities or replay <file>');
  const state = readOptimization(repo);
  return {
    config: state.config,
    facts: state.facts.length,
    hosts: Object.fromEntries(
      HOSTS.map((h) => [h, { completedSessions: state.hosts[h]?.completed ?? 0, proposed: capabilityProposals(state, h, configuredServers(h)) }]),
    ),
    receipts: state.receipts,
    applied: Object.fromEntries(Object.entries(state.applied ?? {}).map(([h, a]) => [h, a.names])),
  };
}
