# OPS-4 — S2 Dispatcher · Closeout

**Status:** COMPLETE — 2026-07-07. S3 NOT started.
**Authority:** `docs/initiatives/ops4/OPS4_BACKGROUND_JOBS_INVESTIGATION_2026-07-07.md` §6 S2 · `docs/initiatives/ops4/OPS4_S0_RULINGS.md` (R5 activated; R7's scheduler decision executed here).

## What shipped

- **Registry** — `lib/jobs/registry.ts`: typed table of scheduled jobs (name · daily UTC half-hour slot · body). Exactly the three pre-S2 jobs at exactly their pre-S2 times (sync-banks 06:00 · fetch-fx-rates 06:30 · process-deletions 07:00). S2 changes orchestration, never timing or business logic.
- **Dispatcher** — `lib/jobs/dispatch.ts`: selects entries due at the invocation's half-hour slot and runs each through `runJob()` (individually ledgered — S1 JobRun names unchanged, so pre/post ledger comparison is direct), sequentially in registry order, each in its own try/catch. A failing job is recorded and never blocks a sibling; `dispatchDueJobs` never throws. **Slot matching, not exact-minute matching** — a cron fired a few minutes late must not silently skip its job.
- **Single cron endpoint** — `app/api/jobs/dispatch/route.ts`, CRON_SECRET-guarded identically to the per-job routes; any job failure → 500 so a bad slot stays visible in Vercel's cron dashboard (the same failure signal the per-job crons produced). `vercel.json` shrinks 3 → **1** entry (`0,30 6-7 * * *`; the 07:30 tick is a logged no-op).
- **Composed process-deletions body single-sited** — `runProcessDeletions()` (purge + OPS-3 cleanup tail, one "process-deletions" JobRun) moved to the registry module; the fallback route and the dispatcher share it verbatim, so the two paths cannot drift. R4/F7 intact: cleanup still consumes no cron slot and still rides process-deletions until S3.
- **`jobs/scheduler.ts` RETIRED (deleted)** — the R7/investigation decision, recorded here: the dormant in-process setInterval scheduler (never invoked since birth) is superseded by the registry + cron-driven dispatcher. This closes the "entrypoint never invoked" limbo half of KD-14; the stub-jobs half (`run-ai-advice`, `sync-crypto`) remains v2.6b-owned and untouched. Stale references cleaned (comment-only edits): `instrumentation.ts`, `jobs/sync-banks.ts`, `jobs/purge-trash.ts`, `lib/plaid/syncTransactions.ts`, `lib/security-surface.test.ts` labels.
- **Revertibility** — the three per-job routes remain deployed and CRON_SECRET-guarded; any job detaches from the dispatcher by pointing a `vercel.json` cron back at its own route, no code change.

## Behavior preservation

Same three job bodies, same UTC fire times, same JobRun ledger names, same idempotency (unchanged bodies), same response shapes on the per-job routes, same failure signal to Vercel. New behavior is orchestration-only: one endpoint, slot selection, per-job isolation, logging.

## Deliberately NOT in S2 (frozen)

S3 workload migration (purge-trash, RateLimit sweep, snapshot cadence, digests, cleanup relocation) · notification retry (S4) · dead-job detection/alerting (S5) · key-rotation runbook (S6) · queues/BullMQ/SQS/EventBridge · distributed coordination/locking · telemetry/metrics/dashboards (PO1) · AI scheduling (v2.6b).

## Gates

- Slot matching, sequencing, isolation, no-op ticks, registry integrity: `lib/jobs/dispatch.test.ts` (pure, injected runner — a deliberately failing job provably cannot block a sibling).
- Structure grep-proofs (in the same suite): exactly one vercel.json cron → `/api/jobs/dispatch`; dispatcher route carries CRON_SECRET; per-job routes retained; `jobs/scheduler.ts` gone; no queue/retry/telemetry constructs in dispatcher code.
- Post-deploy (operational, not code): compare one week of JobRun rows against the pre-S2 pattern — same names, same slots, same outcomes. The 07:30 no-op tick appears only in logs, never in the ledger.
