-- OPS-4 S1 — JobRun background-job execution ledger.
-- Frozen design: docs/initiatives/ops4/OPS4_BACKGROUND_JOBS_INVESTIGATION_2026-07-07.md §6 S1;
-- rulings: docs/initiatives/ops4/OPS4_S0_RULINGS.md.
-- Additive only: one new table; no existing object is touched.
-- Hand-authored in Prisma's generated conventions (DB1 / OPS-3 house
-- precedent); validated by `prisma migrate dev` against prisma/schema.prisma.
--
-- Append-only fact table: one row per scheduled unit of work, created at run
-- start ("running") and completed by exactly one completion write. Written
-- ONLY by lib/jobs/run.ts. summary carries counts/kinds/IDs only — never
-- user content or monetary values (OPS-3 F14 / PO1 telemetry doctrine).

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "summary" JSONB,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_executionId_key" ON "JobRun"("executionId");

-- CreateIndex
CREATE INDEX "JobRun_jobName_startedAt_idx" ON "JobRun"("jobName", "startedAt");

-- CreateIndex
CREATE INDEX "JobRun_status_startedAt_idx" ON "JobRun"("status", "startedAt");
