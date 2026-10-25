// @ts-check
import { createPublicKey, createPrivateKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './store.mjs';
import { loadPolar, polarStatus } from './polar.mjs';

export const UPGRADE_URL = 'https://limitcast.dev/#pricing';
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAG+4c5uaNB7IAZiAxtcyyXBEmmRkmZfWvlEFyvhmDQvA=';
const PREFIX = 'LC1';

/** @typedef {{e:string, p:string, i:number, x:number}} Claims  e: email, p: plan, i: issued, x: expires (epoch s, 0 = never) */

/**
 * Offline license check: Ed25519 signature over the claims, plus expiry. No network.
 * @param {string} key
 * @param {number} now epoch ms
 * @param {string} [publicKey] base64 SPKI (tests pass their own)
 * @returns {{ok:true, claims:Claims} | {ok:false, reason:string}}
 */
export function checkLicense(key, now, publicKey = PUBLIC_KEY) {
  const [prefix, body, sig] = key.trim().split('.');
  if (prefix !== PREFIX || !body || !sig) return { ok: false, reason: 'not a limitcast license key' };
  const pub = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(`${prefix}.${body}`), pub, Buffer.from(sig, 'base64url'))) return { ok: false, reason: 'signature does not match' };
  /** @type {Claims} */
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return { ok: false, reason: 'unreadable claims' };
  }
  if (claims.x && claims.x * 1000 < now) return { ok: false, reason: `expired ${new Date(claims.x * 1000).toISOString().slice(0, 10)}` };
  return { ok: true, claims };
}

/**
 * Sign a license. Used only by scripts/issue-license.mjs with the private key from the Keychain.
 * @param {Claims} claims
 * @param {string} privatePem
 */
export function issueLicense(claims, privatePem) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = sign(null, Buffer.from(`${PREFIX}.${body}`), createPrivateKey(privatePem)).toString('base64url');
  return `${PREFIX}.${body}.${sig}`;
}

const licenseFile = () => join(stateDir(), 'license.key');

/**
 * The active license: LIMITCAST_LICENSE env var, else an activated signed key, else a Polar activation.
 * Never touches the network (hooks call it on every tool use).
 */
export function currentLicense(now = Date.now()) {
  const key = process.env.LIMITCAST_LICENSE ?? (existsSync(licenseFile()) ? readFileSync(licenseFile(), 'utf8') : '');
  if (key) return checkLicense(key, now);
  const polar = loadPolar();
  return polar ? polarStatus(polar, now) : null;
}

/** @param {string} key */
export function activate(key) {
  const res = checkLicense(key, Date.now());
  if (res.ok) {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(licenseFile(), key.trim() + '\n', { mode: 0o600 });
  }
  return res;
}

export const isPro = () => currentLicense()?.ok === true;
