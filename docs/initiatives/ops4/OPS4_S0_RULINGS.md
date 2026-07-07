# OPS-4 — S0 Ratification & Architectural Rulings

**Status:** RATIFIED — OPS-4 is active; S0 (this document) and S1 (JobRun ledger + runJob wrapper) are the approved scope. S2+ is NOT approved by this document.
**Date:** 2026-07-07
**Authority:** `docs/initiatives/ops4/OPS4_BACKGROUND_JOBS_INVESTIGATION_2026-07-07.md` (source of truth for the full initiative shape). This document freezes the rulings S1 implements against.
**Doctrine (inherited, binding):** smallest implementation satisfying approved scope · preserve existing architecture · surgical edits only · no opportunistic refactors.

## Frozen rulings

| # | Ruling | Consequence |
|---|---|---|
| R1 | **JobRun is append-only.** One row created at run start (`status: "running"`); exactly ONE completion write (status/completedAt/durationMs/summary/errorSummary). No update after completion, ever. No deletes. | The ledger inherits the AuditLog/FxRate/SyncIssue fact-table idiom. History is never rewritten. |
| R2 | **No retention policy yet.** No sweep, no compaction, no TTL in S1. | Retention arrives as a registered job in S3 (with the dispatcher), not before. Daily volume (~3 rows/day) makes deferral safe. |
| R3 | **Existing cron routes remain unchanged** beyond the minimal body wrap. Each route keeps its own CRON_SECRET check, `maxDuration`, and response shape. | Deliberate deviation from the investigation's S1 note that the wrapper "also owns the CRON_SECRET check" — auth de-triplication is deferred (S2 territory, where the dispatcher route subsumes it). The wrapper is observational only. |
| R4 | **Notification cleanup continues riding process-deletions** (OPS-3 F7 stands). The combined purge + cleanup tail is ledgered as ONE JobRun (`process-deletions`) — the ledger records what the cron actually does. | The cleanup relocates to its own registration in S3, when the dispatcher exists, exactly as the OPS-3 file headers promise. |
| R5 | **Dispatcher is deferred to S2.** `vercel.json` keeps its three entries; no fan-out route, no registry. | F7's "no new cron slots" constraint remains in force until S2. |
| R6 | **Retry framework belongs later.** No generic retry/backoff; `withPlaidRetry` remains the only bounded retry, correctly scoped. The notification retry consumer (investigation S4) is not started. | `NotificationDelivery.attempts` stays recorded-never-incremented (OPS-3 F16). |
| R7 | **AI scheduling remains out of scope.** `run-ai-advice.ts` / `sync-crypto.ts` / `take-snapshot.ts` stubs and `jobs/scheduler.ts` are untouched — the scheduler's retire-or-adopt decision is S2's, and AiAdvice is v2.6b's (D5/KD-14). | No stub gains a body in OPS-4 S1. |
| R8 | **Telemetry belongs to PO1.** JobRun is a fact ledger, not a metrics system: no counters, no rollups, no dashboards, no emission seam. `summary` carries counts/kinds/dates/IDs only — never user content, merchant strings, or monetary values (OPS-3 F14 / PO1 no-content doctrine). | A metric field creeping into JobRun is the drift signal named in the investigation's risks. |
| R9 | **Single writer chokepoint.** All JobRun writes go through `lib/jobs/run.ts`'s `runJob()` — grep-enforced (`.jobRun.` appears in exactly one production module, the `lib/notifications/create.ts` idiom). Ledger writes are best-effort and non-throwing: a ledger failure must never break the job it observes. | Jobs behave byte-identically with or without a working ledger. |

## S1 delivered surface (for the ledger row)

- `prisma/schema.prisma` — additive `JobRun` model (strings not enums; `@@index([jobName, startedAt])`, `@@index([status, startedAt])`, unique `executionId`).
- `prisma/migrations/20260707223000_ops4_s1_jobrun_ledger/` — hand-authored additive migration (house precedent).
- `lib/jobs/run.ts` — `runJob(name, fn, { trigger })`: start row → timed execution → single completion write; returns result / rethrows unchanged; narrow injected-client typing (compile-independent of client regeneration).
- Three cron routes wrap their bodies in `runJob(...)`; nothing else about them changes.
- `lib/jobs/run.test.ts` — pure unit suite (injected fake client) + source scans proving R3/R4 and the absence of banned infrastructure.

## Exit criteria for S0/S1

- Every invocation of the three production crons leaves a JobRun row; a forced failure leaves a `failed` row with a truncated error summary.
- "Did last night's sync run, and how did it go?" is answerable as a query for the first time.
- Runtime behavior of all three crons is unchanged (same responses, same error propagation, same side effects).
- Grep-provable: no dispatcher, no scheduler invocation, no queue, no retry framework, no telemetry/dashboard code shipped.
