import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { currentLicense } from '../src/license.mjs';
import { activatePolar, deactivatePolar, loadPolar, POLAR_ORG_ID, polarStatus, refreshDue, refreshPolar } from '../src/polar.mjs';

const fresh = () => {
  process.env.LIMITCAST_STATE = mkdtempSync(join(tmpdir(), 'lc-polar-'));
  delete process.env.LIMITCAST_LICENSE;
};
const DAY = 86400_000;
/** A fake fetch that records calls and answers from a table keyed by endpoint. */
const fakeFetch = (answers, calls = []) =>
  Object.assign(
    async (url, init) => {
      const path = url.split('/').pop();
      calls.push({ path, body: JSON.parse(init.body) });
      const a = typeof answers[path] === 'function' ? answers[path]() : answers[path];
      if (a instanceof Error) throw a;
      return { status: a.status, json: async () => a.body };
    },
    { calls },
  );
const activated = {
  status: 200,
  body: { id: 'act-1', license_key: { status: 'granted', expires_at: null, customer: { email: 'buyer@example.com' } } },
};

test('activate stores the activation; the license then works offline', async () => {
  fresh();
  const calls = [];
  const res = await activatePolar('LIMITCAST-ABC', { fetchImpl: fakeFetch({ activate: activated }, calls), now: 1000, label: 'mac' });
  assert.deepEqual(res, { ok: true, claims: { e: 'buyer@example.com' } });
  assert.deepEqual(calls[0], { path: 'activate', body: { key: 'LIMITCAST-ABC', organization_id: POLAR_ORG_ID, label: 'mac' } });
  assert.equal(loadPolar().activationId, 'act-1');
  assert.equal(currentLicense(1000 + DAY).ok, true);
});

test('activate explains Polar refusals and network failures', async () => {
  fresh();
  assert.match((await activatePolar('X', { fetchImpl: fakeFetch({ activate: { status: 404, body: {} } }) })).reason, /does not know/);
  assert.match(
    (
      await activatePolar('X', {
        fetchImpl: fakeFetch({ activate: { status: 403, body: { error: 'NotPermitted', detail: 'activation limit reached' } } }),
      })
    ).reason,
    /activation limit reached/,
  );
  assert.match((await activatePolar('X', { fetchImpl: fakeFetch({ activate: new Error('ENOTFOUND') }) })).reason, /could not reach Polar/);
  assert.match((await activatePolar('X', { fetchImpl: fakeFetch({ activate: { status: 429, body: null } }) })).reason, /wait a minute/);
  assert.equal(loadPolar(), null);
});

test('refreshDue: only when the weekly check is due, at most one attempt an hour', async () => {
  fresh();
  assert.equal(refreshDue(10 * DAY), false); // no Polar license
  await activatePolar('K', { fetchImpl: fakeFetch({ activate: activated }), now: 0 });
  assert.equal(refreshDue(DAY), false); // checked yesterday
  const t = 8 * DAY;
  assert.equal(refreshDue(t), true);
  assert.equal(refreshDue(t + 60_000), false); // just attempted
  assert.equal(refreshDue(t + 2 * 3600_000), true);
  // A rate-limited re-check keeps the stored license untouched.
  await refreshPolar({ fetchImpl: fakeFetch({ validate: { status: 429, body: null } }), now: 8 * DAY });
  assert.equal(loadPolar().checkedAt, 0);
});

test('status: expiry, revocation and the 30-day offline grace period', () => {
  const base = { key: 'k', activationId: 'a', email: 'e', status: 'granted', expiresAt: null, checkedAt: 0 };
  assert.equal(polarStatus(base, 29 * DAY).ok, true);
  assert.match(polarStatus(base, 31 * DAY).reason, /not checked with Polar for 30 days/);
  assert.match(polarStatus({ ...base, status: 'revoked' }, 1).reason, /revoked/);
  assert.match(polarStatus({ ...base, status: 'not found' }, 1).reason, /no longer active.*Resubscribe/);
  assert.match(polarStatus({ ...base, expiresAt: new Date(DAY).toISOString() }, 2 * DAY).reason, /expired/);
  assert.equal(polarStatus({ ...base, expiresAt: new Date(400 * DAY).toISOString() }, 2 * DAY).claims.x, 400 * 86400);
  assert.equal(polarStatus(base, DAY).claims.p, 'polar');
});

test('refresh: weekly re-check updates status; offline keeps the license; not-found turns it off', async () => {
  fresh();
  await activatePolar('K', { fetchImpl: fakeFetch({ activate: activated }), now: 0 });
  const calls = [];
  // Not due yet: no network call.
  await refreshPolar({ fetchImpl: fakeFetch({}, calls), now: DAY });
  assert.equal(calls.length, 0);
  // Due, but offline: unchanged and still valid within the grace period.
  await refreshPolar({ fetchImpl: fakeFetch({ validate: new Error('offline') }), now: 8 * DAY });
  assert.equal(currentLicense(8 * DAY).ok, true);
  // Due and online: subscription renewed with a new expiry.
  const renewed = {
    status: 200,
    body: { status: 'granted', expires_at: new Date(400 * DAY).toISOString(), customer: { email: 'buyer@example.com' } },
  };
  await refreshPolar({ fetchImpl: fakeFetch({ validate: renewed }, calls), now: 9 * DAY });
  assert.deepEqual(calls[0].body, { key: 'K', organization_id: POLAR_ORG_ID, activation_id: 'act-1' });
  assert.equal(loadPolar().checkedAt, 9 * DAY);
  // Refunded / revoked: Polar no longer finds it.
  await refreshPolar({ fetchImpl: fakeFetch({ validate: { status: 404, body: {} } }), now: 20 * DAY });
  assert.equal(currentLicense(20 * DAY).ok, false);
});

test('deactivate frees the seat and forgets the license locally', async () => {
  fresh();
  await activatePolar('K', { fetchImpl: fakeFetch({ activate: activated }) });
  const calls = [];
  assert.deepEqual(await deactivatePolar({ fetchImpl: fakeFetch({ deactivate: { status: 204, body: null } }, calls) }), { ok: true });
  assert.deepEqual(calls[0].body, { key: 'K', organization_id: POLAR_ORG_ID, activation_id: 'act-1' });
  assert.equal(loadPolar(), null);
  assert.equal(currentLicense(), null);
});
