import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forTerminal } from '../src/term.mjs';

const md = '# limitcast results\n\n## Limits\n- **2.8M tokens not re-sent.** Calls: 1,069\n| a | b |';

test('piped output stays Markdown', () => {
  assert.equal(forTerminal(md, { tty: false, color: true }), md);
});

test('a terminal gets bold headings and bold text without the markers', () => {
  assert.equal(
    forTerminal(md, { tty: true, color: true }),
    '\x1b[1mlimitcast results\x1b[22m\n\n\x1b[1mLimits\x1b[22m\n- \x1b[1m2.8M tokens not re-sent.\x1b[22m Calls: 1,069\n| a | b |',
  );
});

test('NO_COLOR keeps the cleanup but drops the styling', () => {
  assert.equal(forTerminal(md, { tty: true, color: false }), 'limitcast results\n\nLimits\n- 2.8M tokens not re-sent. Calls: 1,069\n| a | b |');
});
