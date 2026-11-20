import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { deferReceipt, settleReceipts } from '../src/receipts.mjs';

const worker = promisify(execFile);
const module = new URL('../src/receipts.mjs', import.meta.url).href;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('concurrent receipt defers and settlers preserve every unique completion and ignore replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-receipt-concurrency-'));
  const state = join(dir, 'state');
  const root = join(dir, 'sessions');
  const now = Date.now();
  const env = { ...process.env, LIMITCAST_STATE: state };
  const run = (code) =>
    worker(process.execPath, ['--input-type=module', '-e', `import {deferReceipt,settleReceipts} from ${JSON.stringify(module)}; ${code}`], { env });
  const defer = (i) => `deferReceipt(${now},'explore',{subagentId:'child-${i}',sessionId:'parent'});`;
  await Promise.all(Array.from({ length: 16 }, (_, i) => run(defer(i))));
  assert.equal(read(join(state, 'pending-receipts.json')).length, 16);
  for (let i = 0; i < 16; i++) {
    const child = join(root, 'project', `child-${i}`);
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, 'summary.json'), '{"session_kind":"subagent"}');
    writeFileSync(join(child, 'usage.json'), JSON.stringify({ turns: [{ endedAt: new Date(now).toISOString(), inputTokens: 20, outputTokens: 5 }] }));
  }
  const settle = `settleReceipts(${now},${JSON.stringify(root)});`;
  await Promise.all(Array.from({ length: 8 }, (_, i) => run(i % 2 ? defer(i) : settle)));
  await run(settle);
  const entries = readFileSync(join(state, 'subagents.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 16, 'each completion is appended once despite concurrent settlement');
  assert.equal(new Set(entries.map((e) => e.id)).size, 16);
  assert.equal(read(join(state, 'pending-receipts.json')).length, 0);
  await run(defer(0) + settle);
  assert.equal(readFileSync(join(state, 'subagents.jsonl'), 'utf8').trim().split('\n').length, 16);
});

test('receipt aliases retain identity, duplicates do not evict entries, and stale work expires', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-receipt-alias-'));
  process.env.LIMITCAST_STATE = dir;
  const now = Date.now();
  deferReceipt(now, 'test', { agent_id: 'child', session_id: 'parent', transcript_path: '/missing/transcript' });
  deferReceipt(now, 'test', { subagentId: 'child', sessionId: 'parent', transcriptPath: '/different/transcript' });
  const pending = read(join(dir, 'pending-receipts.json'));
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].hook, { subagentId: 'child', sessionId: 'parent', transcriptPath: '/missing/transcript' });
  assert.equal(settleReceipts(now, join(dir, 'empty')), 0);
  assert.equal(read(join(dir, 'pending-receipts.json')).length, 1);
  assert.equal(settleReceipts(now + 25 * 3600000, join(dir, 'empty')), 0);
  assert.equal(read(join(dir, 'pending-receipts.json')).length, 0);
});
