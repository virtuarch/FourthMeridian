-- COMMS CENTER A-2a (2026-10-31) — the delivery ledger and its daily rollup
-- (docs/plans/COMMS-CENTER-API-CONTRACT-v1-2026-10-31.md §6.1, §6.2).
--
-- ADDITIVE ONLY: two NEW tables, their indexes, grants and RLS. No existing
-- table, row, column or policy is touched.
--
-- WHAT IS STORED: delivery METADATA only — catalog key, versions, channel,
-- status, reason, provider + provider message id, attempt, a closed error code,
-- environment, timestamps. The recipient is a soft userId (no FK), or — only
-- when there is no user — a SALTED HMAC of the address. NEVER an address,
-- subject, body, link, token or payload value. NO open / click fields (owner
-- decision O-13). "ACCEPTED" means the provider accepted the message; nothing
-- here claims "delivered" (that needs verified provider events, Phase C).
--
-- RETENTION (owner decision): CommsDelivery rows live 90 days. The retention
-- job rolls each expired batch into CommsDeliveryDaily and deletes it IN ONE
-- TRANSACTION, so a send is counted in exactly one table and a re-run is a
-- no-op (lib/notifications/delivery/rollup.ts).
--
-- AUTHORITY (least privilege):
--   CommsDelivery       fm_system  SELECT, INSERT, DELETE  (append-only: no UPDATE)
--   CommsDeliveryDaily  fm_system  SELECT, INSERT, UPDATE  (the rollup upsert; no DELETE)
--   both                fm_app     nothing  (operators read through fm_system)
--                       fm_auth    nothing  (sign-in emails are recorded through fm_system)
--                       fm_backup  SELECT   (complete dumps)
-- The account purge (lib/account-deletion/purge.ts) nulls recipientUserId /
-- recipientHash through the migration principal, inside its own transaction.

-- ── 1. Tables + indexes (prisma migrate diff of the schema change, verbatim) ─
CREATE TABLE "CommsDelivery" (
    "id" TEXT NOT NULL,
    "definitionKey" TEXT NOT NULL,
    "definitionVersion" INTEGER NOT NULL,
    "templateVersion" INTEGER,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "errorCode" TEXT,
    "recipientUserId" TEXT,
    "recipientHash" TEXT,
    "notificationId" TEXT,
    "environment" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommsDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommsDeliveryDaily" (
    "day" DATE NOT NULL,
    "definitionKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL,

    CONSTRAINT "CommsDeliveryDaily_pkey" PRIMARY KEY ("day","definitionKey","channel","status","reason")
);

CREATE INDEX "CommsDelivery_createdAt_idx" ON "CommsDelivery"("createdAt");
CREATE INDEX "CommsDelivery_definitionKey_createdAt_idx" ON "CommsDelivery"("definitionKey", "createdAt");
CREATE INDEX "CommsDelivery_recipientUserId_createdAt_idx" ON "CommsDelivery"("recipientUserId", "createdAt");
CREATE INDEX "CommsDelivery_recipientHash_idx" ON "CommsDelivery"("recipientHash");

-- ── 2. Grants + RLS — the system principal only ──────────────────────────────
REVOKE ALL ON TABLE public."CommsDelivery" FROM fm_app;
REVOKE ALL ON TABLE public."CommsDelivery" FROM fm_auth;
REVOKE ALL ON TABLE public."CommsDelivery" FROM fm_system;
GRANT SELECT ON TABLE public."CommsDelivery" TO fm_backup;
GRANT SELECT, INSERT, DELETE ON TABLE public."CommsDelivery" TO fm_system;

REVOKE ALL ON TABLE public."CommsDeliveryDaily" FROM fm_app;
REVOKE ALL ON TABLE public."CommsDeliveryDaily" FROM fm_auth;
REVOKE ALL ON TABLE public."CommsDeliveryDaily" FROM fm_system;
GRANT SELECT ON TABLE public."CommsDeliveryDaily" TO fm_backup;
GRANT SELECT, INSERT, UPDATE ON TABLE public."CommsDeliveryDaily" TO fm_system;

ALTER TABLE public."CommsDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CommsDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."CommsDelivery" FOR ALL TO fm_system USING (true) WITH CHECK (true);

ALTER TABLE public."CommsDeliveryDaily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CommsDeliveryDaily" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."CommsDeliveryDaily" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- Belt and braces (as migration 20261002000100 §19): never reachable by the Data API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."CommsDelivery" FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE ALL ON TABLE public."CommsDeliveryDaily" FROM anon, authenticated, service_role';
  END IF;
END $$;
