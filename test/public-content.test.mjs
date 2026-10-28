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
    const text = readFileSync(path, 'utf8');
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

test('owner-authored commits use the public project contact or GitHub privacy address', () => {
  const [name, author, committer] = execFileSync('git', ['log', '-1', '--format=%an%n%ae%n%ce'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  if (name !== 'Sam Stull') return;
  for (const email of [author, committer]) assert.ok(ownerEmail(email), 'Owner commit contact must use a public project/privacy address');
});
