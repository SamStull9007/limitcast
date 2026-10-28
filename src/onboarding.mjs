// @ts-check

/** Read-only guidance; installation and cuts always remain explicit commands.
 * @param {{checks:{ok:boolean,line:string}[], features:{statusLine:boolean,guard:boolean,alerts:boolean}, contextTokens:number|null, providers:string[]}} r
 */
export function onboardingReport({ checks, features, contextTokens, providers }) {
  const claude = providers.includes('Claude Code');
  const host = claude ? 'claude' : providers.includes('Grok') ? 'grok' : 'codex';
  const trim = `limitcast trim${host === 'claude' ? '' : ` --${host}`}`;
  const out = [
    '# Get started with limitcast',
    '',
    `Found local setup/logs for: ${providers.join(', ') || 'none yet'}.`,
    'Free and open source (MIT License). All features are available without an account, license key or trial.',
    '',
    '## Your next step',
  ];
  if (!providers.length)
    out.push('Configure Claude Code, Codex or Grok, then run `limitcast onboard` again. For a new Claude setup: `limitcast install --host claude`.');
  else if (claude && !features.statusLine)
    out.push(
      'Run `limitcast install --host claude` to back up settings and add the Claude recorder. Restart Claude Code, then run `limitcast doctor`.',
    );
  else if (host === 'grok' && checks.some((c) => !c.ok && c.line.startsWith('Grok status-line')))
    out.push('Run `limitcast install --host grok` to wrap the Grok status line. Restart Grok, then run `limitcast doctor`.');
  else out.push('Run `limitcast status` for your current windows. No readings yet? Complete one normal turn in your coding tool, then check again.');
  if (providers.length) {
    out.push('', '## Your first finding');
    if (claude && contextTokens !== null)
      out.push(
        `Your latest Claude starting context contains about ${Math.round(contextTokens).toLocaleString('en-US')} tokens of controllable setup.`,
      );
    out.push(`Run \`${trim}\` to inspect context and unused items. Doctor checks setup; Trim analyzes context.`);
    out.push('', '## Optional protection');
    if (claude && features.guard && features.alerts)
      out.push(
        'Protection is configured. Configuration is not proof of a live block: confirm the hook is loaded in your coding tool; review real events with `limitcast results`.',
      );
    else
      out.push(
        `Run \`limitcast install --host ${host} --guard${claude ? ' --alerts' : ''}\` to configure protection. Restart the tool; approve the Codex hook if asked.`,
      );
    if (claude)
      out.push(
        'Claude protection includes subagent receipts, Sonnet switching while capacity is tight, and a one-time hold of the first prompt after a long idle pause. `LIMITCAST_ALLOW=1` overrides a hold or model change.',
      );
    if (providers.includes('Grok'))
      out.push(
        'Grok protection can use real weekly quota readings (`limitcast grok-usage on`, opt-in; reads the login Grok holds), or a spending cap (`limitcast budget grok <usd>`).',
      );
  }
  out.push('', '## Setup checks');
  for (const c of checks) out.push(`- ${c.ok ? 'OK' : 'Needs attention'}: ${c.line}`);
  out.push(
    '',
    '## Stay in control',
    '- Inspect first. Keep essential servers/skills with `limitcast trim keep <name>` before choosing `trim --apply`. Undo with `limitcast trim --undo` (add `--codex` or `--grok` for that tool).',
    '- The guard holds new spawns; it does not cancel existing agents or guarantee no lockouts. Forecasts older than 15 minutes are labeled STALE and do not trigger pace-based holds or model changes. Explicit budgets retain their own rules.',
    '- In a week, run `limitcast results`. It separates usage, estimated context reduction, applied controls and historical previews. Share totals voluntarily with `limitcast results --share`.',
    '- Nothing here changes settings or uploads usage. `limitcast uninstall` restores the recorder setup; trim changes have their own undo.',
  );
  return out.join('\n');
}
