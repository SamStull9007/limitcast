// @ts-check
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { stateDir } from './store.mjs';

// Polar's customer-portal license endpoints need no secret: they are meant for desktop apps and CLIs.
export const POLAR_ORG_ID = 'c8fb2062-7f49-4ef0-927b-32d752e2990a';
const API = 'https://api.polar.sh/v1/customer-portal/license-keys';
const RECHECK_MS = 7 * 86400_000; // re-check with Polar weekly when online
const GRACE_MS = 30 * 86400_000; // keep working offline this long after the last successful check

/** @typedef {{key:string, activationId:string, email:string, status:string, expiresAt:string|null, checkedAt:number}} PolarLicense */

const file = () => join(stateDir(), 'polar-license.json');

/** @returns {PolarLicense|null} */
export function loadPolar() {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {PolarLicense} l */
function savePolar(l) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file(), JSON.stringify(l), { mode: 0o600 });
}

/**
 * Is a stored Polar license usable right now? No network: hooks call this on every tool use.
 * @param {PolarLicense} l
 * @param {number} now
 * @returns {{ok:true, claims:{e:string, p:string, i:number, x:number}} | {ok:false, reason:string}}
 */
export function polarStatus(l, now) {
  if (l.status !== 'granted') return { ok: false, reason: `license ${l.status} at Polar` };
  const exp = l.expiresAt ? Date.parse(l.expiresAt) : 0;
  if (exp && exp < now) return { ok: false, reason: `expired ${new Date(exp).toISOString().slice(0, 10)}` };
  if (now - l.checkedAt > GRACE_MS)
    return { ok: false, reason: 'not checked with Polar for 30 days: connect to the internet and run `limitcast license`' };
  return { ok: true, claims: { e: l.email, p: 'pro', i: Math.floor(l.checkedAt / 1000), x: exp ? Math.floor(exp / 1000) : 0 } };
}

/**
 * @param {string} path
 * @param {object} body
 * @param {typeof fetch} fetchImpl
 */
async function post(path, body, fetchImpl) {
  const res = await fetchImpl(`${API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, data };
}

/** @param {any} data */
const detail = (data) => (typeof data?.detail === 'string' ? data.detail : '');

/**
 * Register this machine with Polar and store the result for offline use.
 * @param {string} key
 * @param {{fetchImpl?:typeof fetch, now?:number, label?:string}} [opts]
 * @returns {Promise<{ok:true, claims:{e:string}} | {ok:false, reason:string}>}
 */
export async function activatePolar(key, { fetchImpl = fetch, now = Date.now(), label = hostname() } = {}) {
  let r;
  try {
    r = await post('activate', { key: key.trim(), organization_id: POLAR_ORG_ID, label }, fetchImpl);
  } catch (e) {
    return { ok: false, reason: `could not reach Polar (${e instanceof Error ? e.message : e}); activation needs the internet once` };
  }
  if (r.status === 404) return { ok: false, reason: 'Polar does not know this license key' };
  if (r.status === 403)
    return {
      ok: false,
      reason: detail(r.data) || 'Polar refused activation (limit reached, revoked or expired). Free a device with `limitcast deactivate` on it.',
    };
  if (r.status !== 200 || !r.data?.id) return { ok: false, reason: `Polar returned ${r.status}${detail(r.data) ? `: ${detail(r.data)}` : ''}` };
  const lk = r.data.license_key ?? {};
  const l = {
    key: key.trim(),
    activationId: r.data.id,
    email: lk.customer?.email ?? '',
    status: lk.status ?? 'granted',
    expiresAt: lk.expires_at ?? null,
    checkedAt: now,
  };
  savePolar(l);
  return { ok: true, claims: { e: l.email } };
}

/**
 * Re-check a stored Polar license if it's due. Offline or Polar down: keep the stored state (grace period).
 * Only a definite answer from Polar (not found, or a non-granted status) turns it off.
 * @param {{fetchImpl?:typeof fetch, now?:number, force?:boolean}} [opts]
 */
export async function refreshPolar({ fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const l = loadPolar();
  if (!l || (!force && now - l.checkedAt < RECHECK_MS)) return l;
  let r;
  try {
    r = await post('validate', { key: l.key, organization_id: POLAR_ORG_ID, activation_id: l.activationId }, fetchImpl);
  } catch {
    return l;
  }
  if (r.status === 404) l.status = 'not found';
  else if (r.status === 200 && r.data) {
    l.status = r.data.status ?? l.status;
    l.expiresAt = r.data.expires_at ?? null;
    l.email = r.data.customer?.email ?? l.email;
    l.checkedAt = now;
  } else return l;
  savePolar(l);
  return l;
}

/**
 * Free this machine's activation at Polar so the key can be used elsewhere, then forget it locally.
 * @param {{fetchImpl?:typeof fetch}} [opts]
 */
export async function deactivatePolar({ fetchImpl = fetch } = {}) {
  const l = loadPolar();
  if (!l) return { ok: false, reason: 'no Polar license is active on this machine' };
  let r;
  try {
    r = await post('deactivate', { key: l.key, organization_id: POLAR_ORG_ID, activation_id: l.activationId }, fetchImpl);
  } catch (e) {
    return { ok: false, reason: `could not reach Polar (${e instanceof Error ? e.message : e})` };
  }
  if (r.status !== 204 && r.status !== 200 && r.status !== 404)
    return { ok: false, reason: `Polar returned ${r.status}${detail(r.data) ? `: ${detail(r.data)}` : ''}` };
  if (existsSync(file())) rmSync(file());
  return { ok: true };
}
