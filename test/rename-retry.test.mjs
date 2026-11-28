import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameRetrying } from '../src/store.mjs';

const fail = (code) => Object.assign(new Error(code), { code });

test('on Windows a rename another process blocks is retried until it succeeds', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    let calls = 0;
    renameRetrying(
      'a',
      'b',
      () => {
        if (++calls < 3) throw fail(code);
      },
      'win32',
    );
    assert.equal(calls, 3, code);
  }
});

test('on Windows the retry is bounded and the last error is thrown', () => {
  let calls = 0;
  const blocked = () => {
    calls++;
    throw fail('EPERM');
  };
  assert.throws(() => renameRetrying('a', 'b', blocked, 'win32', 30), { code: 'EPERM' });
  assert.ok(calls > 1);
});

test('other errors and other platforms are thrown at once', () => {
  let calls = 0;
  const throwing = (code) => () => {
    calls++;
    throw fail(code);
  };
  assert.throws(() => renameRetrying('a', 'b', throwing('ENOENT'), 'win32'), { code: 'ENOENT' });
  assert.throws(() => renameRetrying('a', 'b', throwing('EPERM'), 'linux'), { code: 'EPERM' });
  assert.equal(calls, 2);
});
