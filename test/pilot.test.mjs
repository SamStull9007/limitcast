import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pilotMetrics } from '../src/pilot.mjs';

const at = (day) => new Date(Date.UTC(2026, 9, 1 + day)).toISOString();
const person = (id, extra = {}) => ({ id, consent: true, invitedAt: at(0), activatedAt: at(1), checkIns: [], ...extra });
const check = (day, active = true) => ({ at: at(day), active, protectionEnabled: active, useful: active });

test('only eligible consenting cohorts count; missing check-ins remain unknown', () => {
  const r = pilotMetrics(
    [
      person('a', { checkIns: [check(8)] }),
      person('b'),
      person('c', { checkIns: [check(8, false)] }),
      person('young', { activatedAt: at(8) }),
      person('out', { consent: false }),
    ],
    Date.parse(at(10)),
  );
  assert.deepEqual(r.day7, { eligible: 3, retained: 1, inactive: 1, unknown: 1, confirmedFraction: 1 / 3 });
  assert.equal(r.day30.eligible, 0);
  assert.equal(r.consentingInvited, 4);
  assert.equal(r.recentCheckIns.observed, 2);
  assert.doesNotMatch(JSON.stringify(r), /"id"/);
});

test('renewal requires a reached due date and verified payment; annual plans are not monthly churn', () => {
  const rows = [
    person('monthly', { paidAt: at(2), paymentVerified: true, renewalDueAt: at(32), renewedAt: at(32), renewalVerified: true }),
    person('annual', { paidAt: at(2), paymentVerified: true, renewalDueAt: at(367) }),
    person('unknown', { paidAt: at(2), paymentVerified: true, renewalDueAt: at(32) }),
    person('browser', { paidAt: at(2) }),
  ];
  const r = pilotMetrics(rows, Date.parse(at(40)));
  assert.equal(r.verifiedPaid, 3);
  assert.deepEqual(r.renewals, { eligible: 2, verified: 1, unconfirmed: 1 });
});

test('malformed records fail clearly without echoing participant content', () => {
  assert.throws(() => pilotMetrics([person('a'), person('a')], Date.now()), /unique/);
  assert.throws(() => pilotMetrics([person('a', { activatedAt: 'bad private value' })], Date.now()), /Invalid UTC timestamp: activatedAt/);
  assert.throws(() => pilotMetrics([person('a', { checkIns: [{ at: at(8) }] })], Date.now()), /booleans/);
  assert.throws(() => pilotMetrics([person('a', { renewalDueAt: at(0) })], Date.now()), /earlier paidAt/);
});
