-- COMMS CENTER C (2026-10-31) — verified provider delivery events and the
-- delivered-vs-accepted reconciliation (docs/plans/COMMS-CENTER-API-CONTRACT-v1-
-- 2026-10-31.md §6.4; v1.1 delta §8.5, §10.1; v1.2 note).
--
-- ADDITIVE ONLY: one NEW table (CommsProviderEvent) with its indexes, grants and
-- RLS, plus one NULLABLE column and one index on CommsDelivery. No existing
-- row, column, grant or policy is changed.
--
-- WHAT IS STORED: for each signature-verified Resend (svix) event of type
-- delivered | bounced | complained | delivery_delayed — the svix id (unique:
-- replay protection), the type, Resend's message id, the provider's instant,
-- the ledger row it matched (soft ref) and the receiver's outcome. NEVER the
-- recipient address, subject, body, link, bounce text or any payload value.
-- Opens and clicks are never stored (owner decision O-13): the receiver drops
-- those events before anything is written.
--
-- THE LEDGER STAYS APPEND-ONLY. A delivered / bounced / complained event
-- APPENDS a CommsDelivery row (same messageKey and attempt, later createdAt),
-- which wins as the message's final status under the v1.0.2 tie rule. fm_system
-- still has no UPDATE on CommsDelivery. "deliveredAt" is set only on such rows.
--
-- RETENTION (owner decision 2026-10-31): CommsProviderEvent rows live 90 days
-- from "receivedAt" (jobs/data-retention.ts).
--
-- AUTHORITY (least privilege):
--   CommsProviderEvent  fm_system  SELECT, INSERT, DELETE  (append-only: no UPDATE)
--                       fm_app     nothing
--                       fm_auth    nothing
--                       fm_backup  SELECT   (complete dumps)
-- The new CommsDelivery column inherits that table's existing table-level grants.

-- ── 1. Columns, table, indexes (prisma migrate diff of the schema change, verbatim) ─
ALTER TABLE "CommsDelivery" ADD COLUMN     "deliveredAt" TIMESTAMP(3);

CREATE TABLE "CommsProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "messageKey" TEXT,
    "outcome" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommsProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommsProviderEvent_providerEventId_key" ON "CommsProviderEvent"("providerEventId");
CREATE INDEX "CommsProviderEvent_receivedAt_idx" ON "CommsProviderEvent"("receivedAt");
CREATE INDEX "CommsProviderEvent_providerMessageId_idx" ON "CommsProviderEvent"("providerMessageId");
CREATE INDEX "CommsDelivery_providerMessageId_idx" ON "CommsDelivery"("providerMessageId");

-- ── 2. Grants + RLS — the system principal only ──────────────────────────────
REVOKE ALL ON TABLE public."CommsProviderEvent" FROM fm_app;
REVOKE ALL ON TABLE public."CommsProviderEvent" FROM fm_auth;
REVOKE ALL ON TABLE public."CommsProviderEvent" FROM fm_system;
GRANT SELECT ON TABLE public."CommsProviderEvent" TO fm_backup;
GRANT SELECT, INSERT, DELETE ON TABLE public."CommsProviderEvent" TO fm_system;

ALTER TABLE public."CommsProviderEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CommsProviderEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."CommsProviderEvent" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- Belt and braces (as migration 20261002000100 §19): never reachable by the Data API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."CommsProviderEvent" FROM anon, authenticated, service_role';
  END IF;
END $$;
