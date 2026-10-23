-- IDEMP-003 / OPS-005 / OPS-006 (2026-10-22) — one `running` JobRun per job.
--
-- The runtime audit fired two concurrent dispatch wakes and every one of the
-- 11 due jobs ran twice: the dispatcher's overlap guard was a read of the
-- ledger, and both wakes read it before either wrote a `running` row. The
-- fallback per-job routes bypass the guard entirely.
--
-- A PARTIAL UNIQUE INDEX is the claim: the start-ledger write that every job
-- already makes (lib/jobs/run.ts) becomes the lock — the second writer gets
-- 23505 (Prisma P2002) and is refused before its body runs. Chosen over
-- pg_try_advisory_xact_lock because it is DURABLE (a crashed lambda's row is
-- visible and finalised by the next wake), VISIBLE (operators see the claim
-- in the ledger they already read), and has no session-lock semantics —
-- under the Supabase transaction pooler (pgbouncer transaction mode) a
-- session advisory lock can land on, and leak from, a different backend
-- than the one the next statement runs on, and Prisma's single `create` is
-- not a transaction an xact lock could ride on.
--
-- A stale `running` row (older than the dispatcher's in-flight window) would
-- otherwise block its job forever, so the dispatcher finalises them as
-- `failed`/`stale` at every wake and runJob does the same for its own name
-- before claiming (lib/jobs/run.ts finalizeStaleRuns).
--
-- Expand-only for data: no row is deleted. The two UPDATEs below are the
-- one-time version of that finaliser, run here because the index cannot
-- install while a job holds two `running` rows (exactly what a double-run
-- ledger contains today).

-- 1. Any `running` row older than the in-flight window is a crashed run.
UPDATE "JobRun"
   SET "status" = 'failed', "completedAt" = NOW(), "errorSummary" = 'stale'
 WHERE "status" = 'running' AND "startedAt" < NOW() - INTERVAL '6 minutes';

-- 2. Of any remaining duplicates per job, keep only the newest claim.
UPDATE "JobRun" r
   SET "status" = 'failed', "completedAt" = NOW(), "errorSummary" = 'stale'
 WHERE r."status" = 'running'
   AND EXISTS (
     SELECT 1 FROM "JobRun" n
      WHERE n."jobName" = r."jobName" AND n."status" = 'running'
        AND (n."startedAt" > r."startedAt" OR (n."startedAt" = r."startedAt" AND n."id" > r."id")));

CREATE UNIQUE INDEX "JobRun_one_running_per_job"
  ON "JobRun" ("jobName")
  WHERE "status" = 'running';
