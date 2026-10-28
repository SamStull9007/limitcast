> Status update, 2026-10-27: Limitcast 0.15.0 is free under MIT. This earlier commercial assessment/pilot is retained as research history; paid-plan, trial and renewal targets are superseded. Current community feedback is voluntary and does not require payment.

# Founding-user pilot

Owner: Sam. Begin with ten observed installations, then recruit toward fifty heavy agent users with recurring capacity pain.

## Evidence boundary

No external interviews, retention or renewal results have been established by this implementation. Website/download metrics do not prove successful installs; anonymous CLI trials and ongoing local use are not visible to Polar subscriptions.

## Run without adding telemetry

1. Obtain follow-up consent and assign a pseudonymous ID. Keep contacts separately and privately; never commit them.
2. Observe `limitcast onboard`, installation, restart/trust steps and a normal work session. Activation means a useful personal result; copying a command is intent.
3. Request voluntary `limitcast results --share` check-ins at day 3, 7 and 30. Output is participant-supplied evidence, not authenticated telemetry; active-day counts use UTC.
4. Ask whether protection stayed enabled, which holds were unnecessary/overridden, whether model changes affected quality and what was useful. Record negative feedback.
5. Offer the actual current subscription; verify payments and renewals in Polar. A website success event or no-card CLI trial is not payment.
6. Obtain separate permission for public quotes. Stop follow-ups when consent is withdrawn. Do not automate unsolicited messages.

The CLI no-card trial is seven days. The fourteen-day checkout trial is separate and bills afterward. Do not promise a fourteen-day no-card entitlement unless it is separately implemented and verified.

## Private local cohort file

Copy `docs/pilot-participants.example.json` to a private path outside the repo. It starts empty intentionally. Schema example only; these are not customer results:

```json
[
  {
    "id": "participant-001",
    "consent": true,
    "invitedAt": "2026-10-27T18:00:00.000Z",
    "activatedAt": "2026-10-27T18:15:00.000Z",
    "checkIns": [
      {"at": "2026-11-03T19:00:00.000Z", "active": true, "protectionEnabled": true, "useful": true}
    ],
    "paidAt": null,
    "paymentVerified": false,
    "renewalDueAt": null,
    "renewedAt": null,
    "renewalVerified": false
  }
]
```

Use missing/null for evidence not obtained. The verification booleans mean the operator checked billing. Use the real renewal date, including annual dates when applicable.

```sh
node scripts/pilot-metrics.mjs /absolute/private/path/participants.json
node scripts/pilot-metrics.mjs /absolute/private/path/participants.json --as-of 2026-11-10T00:00:00.000Z
```

The script reads the file and emits aggregate JSON only. It does not save contacts, send, access billing or upload. Keep the source file private and delete when no longer needed or consent requires it.

## Metric definitions

- Activation: consenting invitees with a reached activation timestamp.
- Day 7/day 30: eligible after that elapsed time. Latest qualifying check-in in days 7–13 or 30–36 supplies the observation.
- Missing follow-up: unknown, not inactive. `confirmedFraction` divides confirmed retained by all eligible people: a conservative evidence fraction, not a definitive retention estimate.
- Protection/usefulness: latest check-in within seven days, with its observed denominator.
- Paid: only operator-verified, reached payments.
- Renewal: verified payer whose explicit due date has arrived; `unconfirmed` is not proof of cancellation. Annual customers are not treated as monthly churn.

Small samples, incomplete local logs, response bias and participant-supplied evidence limit conclusions. Day-seven activity does not prove daily use or renewal.

## Operating cadence

Week 1: observe ten users; target seven useful activations and resolve recurring setup/protection failures. Weeks 2–4: use the strongest one or two channels toward fifty; target thirty confirmed eligible day-seven active users and five verified payers. These are learning targets, not forecasts. At each renewal date, verify payment and ask what earned it.

Pause acquisition expansion when activation fails, guards are repeatedly disabled, quality suffers or users cannot identify continuing value. Use the existing demo, draft blog workflow and metrics. Sends, publication and ad spend require the relevant authorization; no new marketing platform is needed.

## Permissioned case-study outline

Environment/workflow; concrete prior problem; setup friction/time to value; observed holds/overrides/quality; recorded usage separately from estimates; week-one and renewal outcomes with dates; what the user would miss; permissioned quote. Record zero-benefit results too.
