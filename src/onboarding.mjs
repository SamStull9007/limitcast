// @ts-check

/** Read-only guidance; installation and cuts always remain explicit commands.
 * @param {{checks:{ok:boolean,line:string}[], features:{statusLine:boolean,guard:boolean,alerts:boolean}, contextTokens:number|null, providers:string[]}} r
 */
export function onboardingReport({ checks, features, contextTokens, providers }) {
  const out = [
    '# Get started with limitcast',
    '',
    `Found local setup/logs for: ${providers.join(', ') || 'none yet'}.`,
    'Free and open source (MIT License). All features are available without an account, license key or trial.',
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
  if (!features.guard || !features.alerts)
    out.push(
      '3. Run limitcast install --guard --alerts to configure protection and weekly summaries. Restart; approve the Codex hook if asked. Run limitcast doctor to check configuration.',
    );
  else
    out.push(
      'Protection is configured. Configuration is not proof of a live block: confirm the hook is loaded in your coding tool; review real events with `limitcast results`.',
    );
  out.push(
    '',
    '## Stay in control',
    '- Inspect first. Add essential servers/skills with `limitcast trim keep <name>` before choosing `trim --apply`. Undo with `limitcast trim --undo` (add `--codex` or `--grok` for that tool).',
    '- The guard holds new spawns; it does not cancel existing agents or guarantee no lockouts. `LIMITCAST_ALLOW=1` bypasses a hold for a command/session; unset it to restore protection.',
    '- Grok needs an explicit dollar cap for blocking: `limitcast budget grok <usd>`. Claude model defaults/budgets and cold-cache notices do not have identical support in every host.',
    '- In a week, run `limitcast results`. It separates usage, estimated context reduction, applied controls and historical previews. Share totals voluntarily with `limitcast results --share`.',
    '- Nothing here changes settings or uploads usage. `limitcast uninstall` restores the recorder setup; trim changes have their own undo.',
  );
  return out.join('\n');
}
