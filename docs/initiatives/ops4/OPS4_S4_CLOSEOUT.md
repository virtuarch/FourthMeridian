# OPS-4 — S4 Notification Retry Consumer · Closeout

**Status:** COMPLETE — 2026-07-07. S5 NOT started.
**Authority:** `docs/initiatives/ops4/OPS4_BACKGROUND_JOBS_INVESTIGATION_2026-07-07.md` §6 S4 · `OPS4_S0_RULINGS.md` (R6's "retries later" arrives; F16's substrate consumed) · S2/S3 closeouts.

## What shipped

**`jobs/retry-notifications.ts`** — the single consumer of the OPS-3 `NotificationDelivery` outbox, registered as `"notification-retry"` on the 07:30 slot (no new cron; the existing dispatcher expression covers it), sequenced **after** `notification-cleanup` so aged-out notifications are closed as obsolete rather than re-mailed. Executes through dispatcher → `runJob()`; count-only summary.

## Retry policy (frozen)

The actual state model has four statuses (`sent | captured | skipped | error` — EmailResult verbatim; the generic PERMANENT_FAILURE/CANCELLED states do not exist here, and EmailResult carries no transient-vs-permanent signal), so the smallest safe interpretation is:

- **Retry:** `status = "error"` AND `attempts < 3` (1 create-time attempt + up to 2 retries). Fixed cadence = the daily dispatcher run; **no backoff** (never approved — R6).
- **Never retry:** `sent`/`captured` (delivered) · `skipped` (deliberate) · `error` at the cap — the terminal, queryable dead-letter state (no DLQ infrastructure, per the investigation ruling).
- **Obsolete:** notification archived, expired, read in-app, or recipient email unresolvable → closed as `"skipped"` (existing vocabulary) with **no** attempt increment and no send; original error text preserved for forensics. Deleted notifications need nothing — deliveries ride the FK cascade.

**Duplicate-send prevention — claim-first:** a conditional `updateMany({id, status:"error", attempts:<observed>}, {attempts: +1})` claims the row *before* the send; zero rows updated = a concurrent/prior pass already claimed it → skip. Residual window, accepted and written down: a crash between a successful provider send and the outcome write leaves the row `"error"` with the attempt burned → one possible duplicate email on the next daily run, bounded by the cap — preferred over the inverse failure (marking sent without sending).

**Row semantics preserved:** attempts progress on the same row (the outbox model — one row per channel, not per attempt); `status`/`deliveredAt`/`provider`/`providerMessageId`/`error` updated from the `ChannelResult` verbatim, `deliveredAt` only on `"sent"` — field-for-field the `create.ts` bookkeeping. Delivery goes through the **same** `emailNotificationAdapter` `create.ts` uses — no second email path. Notification rows and dedupe guarantees untouched (the consumer never writes `Notification`).

## Deliberately NOT in S4

Dead-job detection/alerting (S5) · key-rotation runbook (S6) · digests, quiet hours (deferred, S3 closeout) · SMS/push · queues (BullMQ/SQS/EventBridge) · generic retry framework · telemetry/dashboards · AI scheduling.

## Gates

`lib/jobs/notification-retry.test.ts` (25 checks, pure — injected fake store applying Prisma's predicates including the claim race, scripted fake adapter): eligibility filtering, success/failure outcomes, claim-before-send increment, max-attempt stop across runs, obsolete closures (×4), lost-claim → zero sends, idempotent re-runs after success and exhaustion, registration + ordering, and source scans (single consumer, shared adapter, no queue/backoff constructs, no new substrate). Registry tripwires updated: `dispatch.test.ts` (7 jobs; retry removed from the deferred-list check, ordering check added), `s3-workloads.test.ts` (scan rescoped to S3 surfaces).
