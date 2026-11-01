-- COMMS CENTER B2 (2026-10-31) — controlled AUTOMATIONS: definitions, runs and
-- the per-recipient claim/schedule rows (docs/plans/COMMS-CENTER-API-CONTRACT-
-- v1.1-DELTA-2026-10-31.md §6, §8.4, §8.6; v1 §5, §6.3).
--
-- ADDITIVE ONLY: three NEW tables, their indexes, grants and RLS, plus TWO
-- columns on CommsDelivery (one with a default, one nullable) and an index. No
-- existing row, policy or grant changes. Nothing is seeded: no automation
-- exists after this migration, so nothing can send.
--
--   AutomationDefinition  an operator-built rule over the CODE trigger catalog
--                         (typed trigger, closed predicate set, resolver,
--                         channels, catalog definition). No copy. Never deleted:
--                         DISABLED is terminal and the row is kept for audit.
--   AutomationRun         one LIVE trigger evaluation or one DRY_RUN replay —
--                         counts only. `liveKey` (unique) makes a LIVE run
--                         once-per-trigger-fact-per-activation.
--   AutomationRunItem     the per-(recipient, channel) CLAIM and SCHEDULE row.
--                         `idempotencyKey` (unique) IS the claim: a replayed
--                         trigger or a duplicate wake inserts nothing.
--   CommsDelivery.mode    LIVE | TEST (test sends, excluded from analytics).
--   CommsDelivery.automationRunItemId  soft ref; = messageKey for automation sends.
--
-- AUTHORITY (least privilege; the house pattern of 20261031200000 / 20261031210000):
--   AutomationDefinition  fm_system  SELECT, INSERT, UPDATE           (no DELETE: kept for audit)
--   AutomationRun         fm_system  SELECT, INSERT, UPDATE, DELETE   (DELETE = retention)
--   AutomationRunItem     fm_system  SELECT, INSERT, UPDATE, DELETE   (cascade with the run)
--   all three             fm_app     nothing  (operators and the engine use fm_system)
--                         fm_auth    nothing
--                         fm_backup  SELECT   (complete dumps)
-- CommsDelivery keeps SELECT, INSERT, DELETE for fm_system (append-only); a
-- table-level INSERT grant covers the new columns.
--
-- ROLLBACK (not applied anywhere by this PR): DROP TABLE "AutomationRunItem",
-- "AutomationRun", "AutomationDefinition"; DROP INDEX
-- "CommsDelivery_automationRunItemId_idx"; ALTER TABLE "CommsDelivery" DROP
-- COLUMN "automationRunItemId", DROP COLUMN "mode". No other table refers to them.

-- ── 1. Tables + indexes ──────────────────────────────────────────────────────
CREATE TABLE "AutomationDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "triggerKey" TEXT NOT NULL,
    "definitionKey" TEXT NOT NULL,
    "definitionVersion" INTEGER NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'default',
    "customerFacing" BOOLEAN NOT NULL,
    "channels" TEXT[],
    "conditions" JSONB NOT NULL,
    "recipient" JSONB NOT NULL,
    "delayMinutes" INTEGER,
    "dedupeKeyTemplate" TEXT NOT NULL,
    "frequencyCapMax" INTEGER NOT NULL,
    "frequencyCapHours" INTEGER NOT NULL,
    "retryPolicy" TEXT NOT NULL DEFAULT 'STANDARD',
    "maxRecipientsPerRun" INTEGER NOT NULL DEFAULT 50,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "activatedVersion" INTEGER,
    "autoPausedReason" TEXT,
    "ownerApprovedVersion" INTEGER,
    "ownerApprovedDefinitionVersion" INTEGER,
    "ownerApprovedAt" TIMESTAMP(3),
    "ownerApprovedById" TEXT,
    "lastDryRunId" TEXT,
    "triggerCursorAt" TIMESTAMP(3),
    "triggerCursorId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "automationVersion" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "triggerKey" TEXT NOT NULL,
    "triggerRef" TEXT,
    "liveKey" TEXT,
    "status" TEXT NOT NULL,
    "counts" JSONB NOT NULL,
    "haltReason" TEXT,
    "dedupedCount" INTEGER NOT NULL DEFAULT 0,
    "windowFrom" TIMESTAMP(3),
    "windowTo" TIMESTAMP(3),
    "jobRunId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationRunItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "automationVersion" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "recipientUserId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "triggerRef" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "lastDeliveryStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRunItem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CommsDelivery" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'LIVE';
ALTER TABLE "CommsDelivery" ADD COLUMN "automationRunItemId" TEXT;

CREATE INDEX "AutomationDefinition_state_triggerKey_idx" ON "AutomationDefinition"("state", "triggerKey");
CREATE INDEX "AutomationDefinition_definitionKey_idx" ON "AutomationDefinition"("definitionKey");
CREATE UNIQUE INDEX "AutomationRun_liveKey_key" ON "AutomationRun"("liveKey");
CREATE INDEX "AutomationRun_automationId_startedAt_idx" ON "AutomationRun"("automationId", "startedAt");
CREATE INDEX "AutomationRun_status_startedAt_idx" ON "AutomationRun"("status", "startedAt");
CREATE UNIQUE INDEX "AutomationRunItem_idempotencyKey_key" ON "AutomationRunItem"("idempotencyKey");
CREATE INDEX "AutomationRunItem_status_notBefore_idx" ON "AutomationRunItem"("status", "notBefore");
CREATE INDEX "AutomationRunItem_status_nextAttemptAt_idx" ON "AutomationRunItem"("status", "nextAttemptAt");
CREATE INDEX "AutomationRunItem_runId_idx" ON "AutomationRunItem"("runId");
CREATE INDEX "AutomationRunItem_automationId_dedupeKey_idx" ON "AutomationRunItem"("automationId", "dedupeKey");
CREATE INDEX "AutomationRunItem_recipientUserId_createdAt_idx" ON "AutomationRunItem"("recipientUserId", "createdAt");
CREATE INDEX "CommsDelivery_automationRunItemId_idx" ON "CommsDelivery"("automationRunItemId");

ALTER TABLE "AutomationRunItem" ADD CONSTRAINT "AutomationRunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. Grants + RLS — the system principal only ──────────────────────────────
REVOKE ALL ON TABLE public."AutomationDefinition" FROM fm_app;
REVOKE ALL ON TABLE public."AutomationDefinition" FROM fm_auth;
REVOKE ALL ON TABLE public."AutomationDefinition" FROM fm_system;
GRANT SELECT ON TABLE public."AutomationDefinition" TO fm_backup;
GRANT SELECT, INSERT, UPDATE ON TABLE public."AutomationDefinition" TO fm_system;

REVOKE ALL ON TABLE public."AutomationRun" FROM fm_app;
REVOKE ALL ON TABLE public."AutomationRun" FROM fm_auth;
REVOKE ALL ON TABLE public."AutomationRun" FROM fm_system;
GRANT SELECT ON TABLE public."AutomationRun" TO fm_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."AutomationRun" TO fm_system;

REVOKE ALL ON TABLE public."AutomationRunItem" FROM fm_app;
REVOKE ALL ON TABLE public."AutomationRunItem" FROM fm_auth;
REVOKE ALL ON TABLE public."AutomationRunItem" FROM fm_system;
GRANT SELECT ON TABLE public."AutomationRunItem" TO fm_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."AutomationRunItem" TO fm_system;

ALTER TABLE public."AutomationDefinition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AutomationDefinition" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."AutomationDefinition" FOR ALL TO fm_system USING (true) WITH CHECK (true);

ALTER TABLE public."AutomationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AutomationRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."AutomationRun" FOR ALL TO fm_system USING (true) WITH CHECK (true);

ALTER TABLE public."AutomationRunItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AutomationRunItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."AutomationRunItem" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- Belt and braces (as migration 20261002000100 §19): never reachable by the Data API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."AutomationDefinition" FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE ALL ON TABLE public."AutomationRun" FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE ALL ON TABLE public."AutomationRunItem" FROM anon, authenticated, service_role';
  END IF;
END $$;
