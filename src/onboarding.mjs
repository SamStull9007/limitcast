// @ts-check

/** Read-only guidance; installation, trials and cuts always remain explicit commands.
 * @param {{checks:{ok:boolean,line:string}[], features:{statusLine:boolean,guard:boolean,alerts:boolean}, pro:boolean, contextTokens:number|null, providers:string[]}} r
 */
export function onboardingReport({ checks, features, pro, contextTokens, providers }) {
  const out = [
    '# Get started with limitcast',
    '',
    `Found local setup/logs for: ${providers.join(', ') || 'none yet'}.`,
    `Local entitlement: ${pro ? 'Pro or active trial' : 'Free — protection records previews and never blocks'}.`,
    '',
    '## Setup checks',
  ];
  for (const c of checks) out.push(`- ${c.ok ? 'OK' : 'Needs attention'}: ${c.line}`);
  out.push('', '## Your next step');
  if (!features.statusLine)
    out.push('1. Run `limitcast install` to back up settings and add the recorder. Restart your coding tool, then run `limitcast doctor`.');
  else out.push('1. Run `limitcast status` for your current windows. No readings yet? Restart your tool and complete one normal turn.');
  if (contextTokens !== null)
    out.push(
      `2. Your latest Claude starting context contains about ${Math.round(contextTokens).toLocaleString('en-US')} tokens of controllable setup. Run limitcast trim to inspect unused items.`,
    );
  else
    out.push(
      '2. After a normal session, run `limitcast trim` (Claude), `limitcast trim --codex`, or `limitcast trim --grok` for a personal finding. Doctor checks setup; Trim analyzes context.',
    );
  if (!pro)
    out.push(
      '3. Try Pro explicitly with `limitcast trial`: 7 days, no card. The website also offers a separate 14-day Polar checkout trial that bills afterward.',
    );
  if (!features.guard || (pro && !features.alerts))
    out.push(
      `${pro ? '3' : '4'}. Run limitcast install --guard${pro ? ' --alerts' : ''} to configure protection${pro ? ' and weekly summaries' : ' preview'}. Restart; approve the Codex hook if asked. Run limitcast doctor to check configuration.`,
    );
  else
    out.push(
      'Protection is configured. Configuration is not proof of a live block: confirm the hook is loaded in your coding tool; review real events with `limitcast results`.',
    );
  out.push(
    '',
    '## Stay in control',
    '- Inspect first. Add essential servers/skills with `limitcast trim keep <name>` before choosing Pro `trim --apply`. Undo with `limitcast trim --undo` (add `--codex` or `--grok` for that tool).',
    '- The guard holds new spawns; it does not cancel existing agents or guarantee no lockouts. `LIMITCAST_ALLOW=1` bypasses a hold for a command/session; unset it to restore protection.',
    '- Grok needs an explicit dollar cap for blocking: `limitcast budget grok <usd>` (Pro). Claude model defaults/budgets and cold-cache notices do not have identical support in every host.',
    '- In a week, run `limitcast results`. It separates usage, estimated context reduction, applied controls and free previews. Share totals voluntarily with `limitcast results --share`.',
    '- Nothing here starts a trial, changes settings, or uploads usage. `limitcast uninstall` restores the recorder setup; trim changes have their own undo.',
  );
  return out.join('\n');
}
