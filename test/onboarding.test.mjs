import './helpers/environment.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onboardingReport } from '../src/onboarding.mjs';

test('new free users get an explicit, read-only path with all features free', () => {
  const text = onboardingReport({
    checks: [],
    features: { statusLine: false, guard: false, alerts: false },
    pro: false,
    contextTokens: null,
    providers: [],
  });
  assert.match(text, /limitcast install --host claude`/);
  assert.match(text, /preview/);
  assert.match(text, /MIT License/);
  assert.doesNotMatch(text, /checkout|bills afterward|Try Pro/);
  assert.match(text, /Configure Claude Code, Codex or Grok/);
  assert.match(text, /Nothing here changes settings or uploads usage/);
});

test('configured users see their personal finding and runtime verification limits', () => {
  const text = onboardingReport({
    checks: [{ ok: true, line: 'setup readable' }],
    features: { statusLine: true, guard: true, alerts: true },
    pro: true,
    contextTokens: 1234,
    providers: ['Claude Code', 'Codex'],
  });
  assert.match(text, /1,234 tokens/);
  assert.match(text, /Configuration is not proof of a live block/);
  assert.match(text, /LIMITCAST_ALLOW=1/);
  assert.match(text, /trim --undo/);
});
