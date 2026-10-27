// @ts-check
const DAY = 86400_000;

/** Local operator-entered evidence only. Missing follow-up is unknown, never invented churn.
 * @param {unknown} input
 * @param {number} now
 */
export function pilotMetrics(input, now) {
  if (!Array.isArray(input) || !Number.isFinite(now)) throw new Error('Expected a participant array and a valid as-of timestamp.');
  const ids = new Set();
  const date = (value, field) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value)))
      throw new Error(`Invalid UTC timestamp: ${field}`);
    const parsed = Date.parse(value);
    if (new Date(parsed).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error(`Invalid UTC timestamp: ${field}`);
    return parsed;
  };
  const people = [];
  for (const p of input) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || ids.has(p.id))
      throw new Error('Each participant needs a unique nonempty id.');
    ids.add(p.id);
    if (p.consent !== true) continue;
    const invited = date(p.invitedAt, 'invitedAt');
    if (invited === null) throw new Error('A consenting participant needs invitedAt.');
    const activated = date(p.activatedAt, 'activatedAt');
    const paid = date(p.paidAt, 'paidAt');
    const due = date(p.renewalDueAt, 'renewalDueAt');
    const renewed = date(p.renewedAt, 'renewedAt');
    if (activated !== null && activated < invited) throw new Error('activatedAt precedes invitedAt.');
    if (due !== null && (paid === null || due <= paid)) throw new Error('renewalDueAt needs an earlier paidAt.');
    if (renewed !== null && (due === null || renewed < due)) throw new Error('renewedAt needs a reached renewalDueAt.');
    if (p.checkIns !== undefined && !Array.isArray(p.checkIns)) throw new Error('checkIns must be an array.');
    const checks = (p.checkIns ?? [])
      .map((c) => {
        if (!c || typeof c !== 'object' || typeof c.active !== 'boolean' || typeof c.protectionEnabled !== 'boolean' || typeof c.useful !== 'boolean')
          throw new Error('Each check-in needs active, protectionEnabled and useful booleans.');
        const at = date(c.at, 'checkIns.at');
        if (at === null || activated === null || at < activated) throw new Error('A check-in needs an activation and a later timestamp.');
        return { ...c, at };
      })
      .filter((c) => c.at <= now)
      .sort((a, b) => b.at - a.at);
    if (invited <= now)
      people.push({
        activated: activated !== null && activated <= now ? activated : null,
        paid: p.paymentVerified === true && paid !== null && paid <= now,
        due,
        renewed: p.renewalVerified === true && renewed !== null && renewed <= now,
        checks,
      });
  }
  const retention = (day) => {
    const eligible = people.filter((p) => p.activated !== null && now >= p.activated + day * DAY);
    let retained = 0;
    let inactive = 0;
    for (const p of eligible) {
      const c = p.checks.find((c) => c.at >= p.activated + day * DAY && c.at < p.activated + (day + 7) * DAY);
      if (c?.active === true) retained++;
      if (c?.active === false) inactive++;
    }
    return {
      eligible: eligible.length,
      retained,
      inactive,
      unknown: eligible.length - retained - inactive,
      confirmedFraction: eligible.length ? retained / eligible.length : null,
    };
  };
  const recent = people.flatMap((p) => (p.checks[0]?.at >= now - 7 * DAY ? [p.checks[0]] : []));
  const renewals = people.filter((p) => p.paid && p.due !== null && p.due <= now);
  return {
    asOf: new Date(now).toISOString(),
    consentingInvited: people.length,
    activated: people.filter((p) => p.activated !== null).length,
    verifiedPaid: people.filter((p) => p.paid).length,
    day7: retention(7),
    day30: retention(30),
    recentCheckIns: {
      observed: recent.length,
      protectionEnabled: recent.filter((c) => c.protectionEnabled).length,
      useful: recent.filter((c) => c.useful).length,
    },
    renewals: {
      eligible: renewals.length,
      verified: renewals.filter((p) => p.renewed).length,
      unconfirmed: renewals.filter((p) => !p.renewed).length,
    },
    note: 'Operator-recorded, consenting cohort only. Unknown follow-up is not churn; unconfirmed renewal is not a verified cancellation. Small cohorts do not establish market-wide demand.',
  };
}
