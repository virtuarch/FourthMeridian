# OPS-4 — S3 Scheduled Workload Migration · Closeout

**Status:** COMPLETE — 2026-07-07. S4 NOT started.
**Authority:** `docs/initiatives/ops4/OPS4_BACKGROUND_JOBS_INVESTIGATION_2026-07-07.md` §6 S3 · `OPS4_S0_RULINGS.md` (R2's retention arrival; R4's promised relocation executed) · `OPS4_S2_DISPATCHER_CLOSEOUT.md`.

## Entry investigation (per-candidate verdicts)

| Candidate | Verdict | Evidence |
|---|---|---|
| purge-trash | **SHIP** | Body exists, idempotent (WHERE-guarded deleteMany, 7-day cutoff), never scheduled anywhere since the v1.0 scheduler that never ran — the goal-trash retention promise was false in production. Zero design questions. |
| notification cleanup relocation | **SHIP** | Both file headers (route + `lib/notifications/cleanup.ts`) explicitly promised this exact move when the dispatcher landed; the function registers unchanged. |
| RateLimit sweep | **SHIP** | Rows were never deleted anywhere (unbounded growth by construction — investigation §4.6); `@@index([windowStart])` exists; the largest window in use is 900s, so a 24h cutoff can never delete a consultable bucket. |
| snapshot cadence | **DEFER** | Stale-balance semantics unresolved: the daily sync refreshes *transactions*, not balances (balance refresh is user-triggered via `lib/plaid/refresh.ts`), so a scheduled `regenerateSnapshot` would stamp days-old balances as fresh daily facts — fabricated continuity, against the facts-first doctrine. Needs a product decision (snapshot-despite-staleness vs skip vs staleness marker) — the entry gate the investigation predicted. |
| digests | **DEFER** | OPS-3 built the *vocabulary* only: `digestable` flags (2 types) and the DIGEST category exist, but there is **no digest email template, no digest-frequency preference storage, no already-digested marker** (without one, every run re-sends the same unread LOW items). That is schema + design surface, not a registration — and a new email producer besides. Stays with its OPS-3 S6 owner, unblocked whenever it's designed (the dispatcher is ready for it). |

## What shipped

Three registrations on the **07:30 UTC slot** — already fired by the existing single cron expression (`0,30 6-7 * * *`), so **zero vercel.json changes**; the previously no-op tick now works for a living. All three: registered in `lib/jobs/registry.ts`, executed through the dispatcher + `runJob()` (own JobRun rows, stable names), sequentially isolated, idempotent, count-only summaries.

1. **`notification-cleanup`** — `cleanupNotifications()` unchanged, relocated off the process-deletions tail. Isolation upgraded from an inline non-fatal wrapper to structure: a cleanup failure is its own failed JobRun and cannot touch the purge run. **process-deletions is single-purpose again** (registry entry + fallback route both call `processDeletions()` only; the S2 composed body `runProcessDeletions` is deleted).
2. **`purge-trash`** — first production scheduling ever; the 7-day goal-trash retention promise is now true. Behavior untouched; the body now returns the count it already computed so the ledger records a meaningful summary.
3. **`rate-limit-sweep`** — new small body `jobs/sweep-rate-limits.ts`: WHERE-guarded `deleteMany` of RateLimit rows with `windowStart` older than 24h (strict `lt`; the cleanup.ts idiom), idempotent, injectable client for pure tests.

## Rulings honored

R1/R9 (single JobRun writer; append-only) — untouched. R2 — retention for *product* tables arrived as promised with S3; JobRun's own retention remains open (a future sweep candidate, deliberately not smuggled in). R4 — relocation executed exactly as written. No new cron entry; no queue; no retries; no telemetry; no digest/snapshot invention.

## Gates

- `lib/jobs/s3-workloads.test.ts`: sweep cutoff/boundary/idempotency/summary-shape against an injected fake; registry facts (three S3 jobs at 07:30; process-deletions single-purpose at both call sites); deferral tripwires (no digest/snapshot job; comment-stripped scan proves no retry consumer / dead-job detection / queue / telemetry in the jobs layer).
- `lib/jobs/dispatch.test.ts` updated: registry = exactly six jobs (S4 tripwire), S3 slot checks, cron expression covers every slot.
- `lib/notifications/cleanup.test.ts` scans updated: cleanup registered as its own dispatcher job; process-deletions route provably free of cleanup calls (F7 intent — no own cron slot — still asserted).
- Post-deploy (operational): tomorrow's ledger should show six JobRun rows across the four slots; the process-deletions row's summary shrinks to deletion counts; three first-ever rows appear at 07:30.
