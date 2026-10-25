// Issue a Pro license after a sale: node scripts/issue-license.mjs buyer@example.com [lifetime|annual]
// Signs with the private key in the macOS Keychain; prints only the license key.
import { execFileSync } from 'node:child_process';
import { checkLicense, issueLicense } from '../src/license.mjs';

const [email, term = 'annual'] = process.argv.slice(2);
if (!email?.includes('@') || !['annual', 'lifetime'].includes(term)) {
  console.error('usage: node scripts/issue-license.mjs <email> [annual|lifetime]');
  process.exit(1);
}
const raw = execFileSync('security', ['find-generic-password', '-s', 'limitcast-license-signing', '-w']).toString().trim();
// `security -w` hex-encodes secrets that contain newlines, like a PEM.
const pem = /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, 'hex').toString() : raw;
const now = Math.floor(Date.now() / 1000);
const key = issueLicense({ e: email, p: 'pro', i: now, x: term === 'lifetime' ? 0 : now + 366 * 86400 }, pem);
const check = checkLicense(key, Date.now());
if (!check.ok) throw new Error(`issued key failed verification: ${check.reason}`);
console.log(key);
