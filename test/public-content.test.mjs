import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const privateFiles = [
  'scripts/metrics.mjs',
  'scripts/launch-reminders.mjs',
  'scripts/pilot-metrics.mjs',
  'scripts/issue-license.mjs',
  'scripts/keygen.mjs',
  'docs/pilot.md',
  'docs/market-positioning.md',
  'docs/pilot-participants.example.json',
];
const ownerEmail = (email) =>
  email.toLowerCase() === 'support@limitcast.dev' || email === 'noreply@github.com' || email.endsWith('@users.noreply.github.com');
const allowedEmail = (email) => ownerEmail(email) || email === 'a@b.co' || /@example\.(com|org|net|test)$/i.test(email);

function issues(text) {
  const found = [];
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  if (emails.some((email) => !allowedEmail(email))) found.push('unreviewed contact email');
  if (/https?:\/\/claude\.ai\/(artifact|public\/artifacts|share)\//i.test(text)) found.push('private artifact link');
  if (/\bLAUNCH\d{2}\b/.test(text)) found.push('internal campaign code');
  if (/\/Users\/(?!me\/|you\/|user\/|test\/|example\/)[^/\s"']+\//.test(text)) found.push('personal filesystem path');
  for (const action of ['find', 'add']) {
    if (text.includes([action, 'generic', 'password'].join('-'))) found.push('operator Keychain command');
  }
  return found;
}

function publicText(data) {
  if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return data.toString('utf8');
  // PNG pixels and provenance are binary; textual metadata requires explicit review.
  let offset = 8;
  let type;
  while (offset < data.length) {
    assert.ok(offset + 12 <= data.length, 'Truncated PNG chunk');
    const length = data.readUInt32BE(offset);
    type = data.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + length + 12 <= data.length, 'Truncated PNG payload');
    assert.ok(!['tEXt', 'zTXt', 'iTXt'].includes(type), 'Review textual PNG metadata before publication');
    offset += length + 12;
    if (type === 'IEND') break;
  }
  assert.equal(type, 'IEND', 'Missing PNG end chunk');
  assert.equal(offset, data.length, 'Unreviewed data after PNG end');
  return '';
}

test('private operator tools and research cannot reenter the tracked public tree', () => {
  assert.deepEqual(
    tracked.filter((name) => privateFiles.includes(name) || name.startsWith('private/')),
    [],
  );
});

test('tracked public content contains no unreviewed personal contact or operational details', () => {
  for (const name of tracked) {
    const path = resolve(root, name);
    if (!existsSync(path)) continue;
    const text = publicText(readFileSync(path));
    // Print only the category and file, never the private value, in public CI logs.
    assert.deepEqual(issues(text), [], `Review public content in ${name}`);
    assert.equal(text.includes(`${homedir()}/`), false, `Personal home path in ${name}`);
  }
});

test('privacy checks catch representative spills and permit public support and fixture contacts', () => {
  assert.ok(issues(['person', 'gmail.com'].join('@')).includes('unreviewed contact email'));
  assert.ok(issues('https://' + 'claude.ai/' + 'artifact/' + 'example-id').includes('private artifact link'));
  assert.ok(issues('LAUNCH' + '30').includes('internal campaign code'));
  assert.deepEqual(issues('support@limitcast.dev buyer@example.com a@b.co noreply@github.com'), []);
});

test('PNG pixels do not produce false contacts, while metadata and appended text require review', () => {
  const png = readFileSync(resolve(root, 'docs/assets/emblem.png'));
  assert.equal(publicText(png), '');
  assert.throws(() => publicText(Buffer.concat([png, Buffer.from('unreviewed')])), /after PNG end/);
  for (const type of ['tEXt', 'zTXt', 'iTXt']) {
    const chunk = Buffer.alloc(12);
    chunk.write(type, 4);
    assert.throws(() => publicText(Buffer.concat([png.subarray(0, 8), chunk, png.subarray(8)])), /textual PNG metadata/);
  }
  assert.ok(issues(publicText(Buffer.from(['person', 'gmail.com'].join('@')))).includes('unreviewed contact email'));
});

test('owner-authored commits use the public project contact or GitHub privacy address', () => {
  const [name, author, committer] = execFileSync('git', ['log', '-1', '--format=%an%n%ae%n%ce'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  if (name !== 'Sam Stull') return;
  for (const email of [author, committer]) assert.ok(ownerEmail(email), 'Owner commit contact must use a public project/privacy address');
});
