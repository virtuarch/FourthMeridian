# OPS-4 — S6 Operational Closeout · INITIATIVE COMPLETE

**Status:** S6 COMPLETE — 2026-07-07. **OPS-4 is a finished initiative** (S0–S6). PO1 NOT started.
**Authority:** `OPS4_BACKGROUND_JOBS_INVESTIGATION_2026-07-07.md` §6 S6 (adapted — see the scope note) · `OPS4_S0_RULINGS.md` · S2–S5 closeouts.

## Scope note (recorded)

The investigation's S6 included executing the SEC-1 v1 read-branch removal (a code change) and drilling the rotation. This slice's fence is **documentation only — no runtime, schema, or migration changes** — so those two items are documented as the operator's next actions in the runbook/checklist rather than executed: the v1 read branch stays behind its stated gate (0 v1 rows ✅ + backup window — operator confirms), and the ENCRYPTION_KEY drill (which begins by writing `scripts/rotate-encryption-key.ts` to the runbook's fixed shape) is a checklist item. Neither blocks initiative completion: the OPS-4-owned deliverable in SECURITY_CHECKLIST / INCIDENT_RESPONSE_RUNBOOK was the **runbook**, which now exists.

## What shipped (all documentation)

1. **`docs/operations/BACKGROUND_JOBS_RUNBOOK.md`** — architecture in one paragraph, the 7-job/4-slot schedule and expected daily execution (7 JobRun rows), production verification steps, retry behavior (job-level cadence-is-the-retry + the S4 outbox consumer + dead-letter query), dead-job detection usage, failure-handling table with manual-recovery levers (fallback routes, forced ticks, per-job cron detach), standing limits by ruling.
2. **`docs/operations/KEY_ROTATION_RUNBOOK.md`** — per-secret procedures with rotation order, downtime expectations, and validation: CRON_SECRET (zero impact) · RESEND_API_KEY (create-before-revoke) · PLAID_CLIENT_ID/SECRET (stored tokens unaffected; short API window) · NEXTAUTH_SECRET (global sign-out, by JWT design) · ENCRYPTION_KEY (the heavy path: backup precondition, ciphertext audit, the named re-encryption-script gap with its required shape, both-keys maintenance window, per-purpose validation). Resolves INCIDENT_RESPONSE_RUNBOOK §7.6's forward reference.
3. **`docs/operations/OPS4_PRODUCTION_READINESS_CHECKLIST.md`** — env vars (boot-validated set), migration state, health verification, scheduled-jobs verification (incl. forced tick + 401 checks + duration headroom), retry verification, dead-job verification, end-to-end notification verification, key-rotation readiness.
4. **Reference resolution (surgical doc edits):** INCIDENT_RESPONSE_RUNBOOK §7.6 + roadmap-mapping row → point at the delivered runbooks; SECURITY_CHECKLIST "Key rotation" row + OPS-4 section → runbook delivered, residue named; `lib/env.ts` CRON_SECRET comment ("three jobs" → the single dispatcher cron; comment-only). STATUS OPS-4 row → **Complete**.

## OPS-4 exit criteria — final walk (vs the investigation §11)

- Every scheduled unit leaves a ledger row; "did last night's X run?" is a query ✅ (S1; week-in-prod observation is the operator's post-deploy checklist item).
- `vercel.json` = one cron; adding a job = a registry entry; F7 retired ✅ (S2).
- `jobs/scheduler.ts` gone; no dormant intent ✅ (S2).
- purge-trash + cleanup on their own schedules; process-deletions single-purpose; goal-trash retention true ✅ (S3).
- Failed deliveries retried to a cap; terminal state queryable; no duplicate from one row (claim-first; residual window documented) ✅ (S4).
- A stopped job is detectable within a day ✅ (S5 — detector + CLI; the investigation's *email* leg deliberately re-scoped to detection-only, alerting → PO1).
- Rotation runbook exists; preview/prod separation + drill = named operator residue (this slice's fence) ⚠️→checklist.
- Boundaries grep-proven throughout: single JobRun writer, no user content/monetary values in summaries, CRON_SECRET single pattern ✅.

## Open residue (owned, not blocking)

Operator: ENCRYPTION_KEY rotation script + drill · preview/prod separation confirmation · first-week ledger observation. Future initiatives: JobRun retention sweep (PO1 rollups make raw pruning safe) · alerting over the health helper (PO1 Phase 5) · digests (OPS-3-owned, dispatcher-ready) · snapshot cadence (product decision) · SEC-1 v1 read-branch removal (its own gate).
