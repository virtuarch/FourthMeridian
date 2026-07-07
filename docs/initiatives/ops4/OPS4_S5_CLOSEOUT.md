# OPS-4 — S5 Dead-Job Detection · Closeout

**Status:** COMPLETE — 2026-07-07. S6 NOT started.
**Authority:** `docs/initiatives/ops4/OPS4_BACKGROUND_JOBS_INVESTIGATION_2026-07-07.md` §6 S5 (adapted — see the alerting note) · `OPS4_S0_RULINGS.md` · S2–S4 closeouts.

## What shipped

**`lib/jobs/health.ts`** — the single dead-job detector: a read-only, deterministic pass over the S1 JobRun ledger for every registry entry. `classifyJobHealth` is pure (injected clock + rows); `checkScheduledJobHealth` runs it over the real ledger via a narrow read-client seam. No writes, no second execution-tracking mechanism — JobRun remains the only ledger.

**`ScheduledJob.expectedEveryHours`** (optional, default 24) — per-job cadence for detection only; the dispatcher never reads it (test-enforced).

**`scripts/check-job-health.ts`** — operator CLI: one line per job, nonzero exit when unhealthy. Read-only.

## Detection policy (frozen)

Priority order per job: **never-ran** (zero JobRun rows — no corpse ever) → **overdue** (newest run started more than `expectedEveryHours + GRACE_HOURS(2)` ago — the schedule silently stopped; absence dominates brokenness) → **failing** (last `3` runs all failed; a `"running"` row older than `STALE_RUNNING_HOURS(2)` counts as a crashed run in the streak — the S1 documented crash shape — while a *recent* running row breaks the streak as in-flight) → **healthy**. Overall health = every job healthy. Boundary is strict (> cadence+grace).

## Surfacing decision (recorded)

`/api/health` is **deliberately not extended**: its OPS-1 header freezes "Explicitly NOT exposed: … queue/job state", its test pins the response keys to `commit,db,status,time`, and the endpoint is unauthenticated — publishing job state there would leak operational detail publicly and overturn a frozen design for no operator gain. The prompt's alternative branch ("a narrow internal helper") is what shipped; the script is its CLI face, and a future admin surface (PO1 Phase 4) consumes the same helper unchanged. The investigation's original S5 sketch (operator *email* on absence) is intentionally NOT built here — this slice's scope fence is detect-only; the email leg belongs to whichever slice/initiative wires alerting (PO1 Phase 5 or a future OPS-4 addendum), where it becomes one call over this helper's output.

## Deliberately NOT in S5

Email/Slack/PagerDuty alerting · notification creation · dashboards · telemetry/metrics · queues · retries · cron changes (vercel.json untouched; the detector is not a scheduled job — running it on a cadence would require the alerting decision first) · key rotation · digests · AI.

## Gates

`lib/jobs/job-health.test.ts` (25 pure checks): all four classifications incl. cadence+grace boundary, streak threshold and resets, in-flight vs stale running, per-job cadence override, precedence, full-registry coverage against an injected ledger, aggregation, dispatcher-unchanged and shape-compatibility proofs, and scope-fence source scans (read-only detector; no alerting/queue/telemetry constructs; `/api/health` provably job-state-free; single implementation).
