# Runbook — proving an alert e-mail reaches a mailbox (Preview / Production)

**Purpose:** the product can observe an e-mail only up to **accepted by the provider** (Resend returned an id). It never sees the mailbox. Before an environment is trusted to page anyone, a human must prove end-to-end delivery once, and re-prove it after any change to `RESEND_API_KEY`, `PLATFORM_ALERTS_EMAIL`, the sending domain or its DNS. **This is an OWNER step.**

**Vocabulary (OBS-003):** queued → attempted → **accepted** (`deliveryStatus: "sent"`) → delivered (only the mailbox can tell you) | failed (`error`). `captured` = the in-memory transport, i.e. no `RESEND_API_KEY`; outside development it is recorded as `skipped` with `undelivered.reason = "NO_EMAIL_TRANSPORT"` and nothing is suppressed.

## 1. Preconditions (configuration, per environment)

In Vercel → Settings → Environment Variables, for the target environment (Production, and separately Preview):

| Variable | Required | Check |
|---|---|---|
| `RESEND_API_KEY` | yes | present (values are Sensitive and cannot be read back; presence is enough). Platform Ops → Environment shows it pass/fail. |
| `PLATFORM_ALERTS_EMAIL` | yes | a mailbox you read, **not** on the platform's own domain if that domain's mail could fail with it |
| `EMAIL_FROM_DEFAULT` / sender identity | if set | the domain is verified in Resend (SPF + DKIM green) |

Platform Ops → Policies → Alerts must show **Destination: configured**. After the next evaluation, the "Latest delivery" line must NOT say *Undelivered — no email transport*.

## 2. Produce one real alert without touching customer data

Pick the least invasive trigger available on that environment:

- **Preferred:** temporarily lower `ai_spend_alert_fleet_usd_24h` (Policies → AI Cost Controls → fleet threshold, CONTROL + reason) to a value at or below the current 24 h estimated fleet spend, so `ai-spend-fleet-high` fires on the next evaluation. If spend is $0, use the per-user rule the same way only when a customer has non-zero spend; otherwise use the next option.
- **Alternative:** temporarily set the `evaluate-alerts` cadence to 1 h and wait for any naturally firing rule (Preview usually has a stale FX/price archive → `resource-stale`).
- **Never** fabricate JobRun, SyncIssue or connection rows on Production to force a breach.

Then run the evaluator: Platform Ops → Jobs → `evaluate-alerts` → **Run Now** (audited), or wait for the next due wake. **Preview never runs crons** — on Preview, Run Now is the only way.

## 3. Verify each stage

1. **Accepted:** Policies → Alerts → "Latest delivery" reads **Accepted by provider** with the breach count; the JobRun summary has `deliveryStatus: "sent"` and `undelivered: null`.
2. **Provider:** Resend dashboard → Emails: the message to `PLATFORM_ALERTS_EMAIL` shows *Delivered* (Resend's own event) — or *Bounced* / *Complained*, which means fix the address or domain.
3. **Mailbox:** the e-mail is in the inbox (check spam). Subject starts with the platform-alert template's subject; the body lists the firing rules, critical first.
4. **No storm:** run the evaluator again immediately — the same breach is now *suppressed* (counts.suppressed ≥ 1, no second e-mail). That proves the suppression ledger is writing.

## 4. Restore and record

1. Reset the threshold / cadence you changed (Policies → Reset to default, with reason). Confirm the rule stops firing on the next run.
2. Record in `STATUS.md`: environment, date, which rule fired, Resend message id (from the dashboard, not the address), and "mailbox confirmed by <owner>".

## 5. If it fails

| Symptom | Meaning | Fix |
|---|---|---|
| Undelivered — no email transport | `RESEND_API_KEY` absent in this environment | set it (Sensitive), redeploy |
| Undelivered — `PLATFORM_ALERTS_EMAIL` not set | no destination | set it, redeploy |
| Delivery error | Resend refused (bad key, unverified domain, rate limit); a Sentry event `area: alert-delivery` carries the provider message | fix in Resend; the next evaluation retries automatically |
| Accepted but never in mailbox | provider-side bounce / spam | Resend event log; SPF/DKIM; try a different mailbox provider |
| Undelivered — ledger write failed | the evaluator's JobRun row cannot be written | `alerting-dead-evaluator.md` §4 |
