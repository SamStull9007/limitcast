import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function carriedContext(entries) {
  let text = '';
  for (const entry of entries) {
    const sections = entry.type === 'compaction' ? entry.systemMessage?.sections : entry.message?.role === 'system' ? entry.message.sections : null;
    if (sections && Object.hasOwn(sections, 'limitcast')) text = sections.limitcast ?? '';
  }
  return typeof text === 'string'
    ? text
        .replace(/^<limitcast>\n/, '')
        .replace(/\n<\/limitcast>$/, '')
        .slice(0, 8000)
    : '';
}

export default function limitcast(pi) {
  let context = '';
  const base = (ctx) => ({ session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd });
  function hook(ctx, event, fields = {}) {
    if (process.env.LIMITCAST_ALLOW === '1' || process.env.LIMITCAST_MODEL_WORKER === '1') return Promise.resolve({});
    return new Promise((resolve) => {
      let out = '';
      const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/limitcast.mjs', import.meta.url)), '_optimize-hook', '--src', 'pi'], {
        cwd: ctx.cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({});
      }, 8000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data) => {
        out += data;
        if (out.length > 32000) child.kill('SIGKILL');
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({});
      });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve({});
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ ...base(ctx), hook_event_name: event, ...fields }));
    });
  }
  pi.on('session_start', async (_, ctx) => {
    const out = await hook(ctx, 'SessionStart');
    const entries = ctx.sessionManager.getBranch?.() ?? [];
    context = entries.some((e) => e.type === 'message') ? carriedContext(entries) : (out.hookSpecificOutput?.additionalContext ?? '');
  });
  pi.on('before_agent_start', async (event, ctx) => {
    await hook(ctx, 'UserPromptSubmit');
    if (context) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, limitcast: context };
  });
  pi.on('tool_result', async (event, ctx) => {
    const out = await hook(ctx, 'PostToolUse', {
      tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: event.input,
      tool_response: { content: event.content, isError: event.isError, exit_code: event.structuredContent?.exit_code },
    });
    const text = out.hookSpecificOutput?.additionalContext ?? out.systemMessage;
    if (text) pi.sendMessage({ customType: 'limitcast', content: text, display: true }, { deliverAs: 'steer' });
  });
  pi.on('agent_end', async (_, ctx) => {
    await hook(ctx, 'Stop');
  });
  pi.on('session_shutdown', async (_, ctx) => {
    await hook(ctx, 'SessionEnd');
  });
}
