-- BETA BLOCKED IDENTIFIERS (owner P2-1, 2026-11-01) — hashed blocked identifiers
-- and preserved abuse evidence
-- (docs/plans/BETA-BLOCKED-IDENTIFIER-DESIGN-2026-11-01.md §2).
--
-- ADDITIVE ONLY: one NEW enum, two NEW tables, their indexes (including ONE
-- PARTIAL unique index), grants and RLS. No existing table, row, column or
-- policy is touched.
--
-- ⚠️ RELEASE ORDER: this migration MUST be applied before the B9 code that reads
-- these tables. The code reads them defensively (Production issuance fails
-- closed with BLOCKLIST_UNAVAILABLE when the table is missing), but the order is
-- the contract.
--
-- NO ADDRESS IS STORED. BetaBlockedIdentifier holds an HMAC-SHA256 of the
-- conservative canonical mailbox under a versioned key that lives OUTSIDE the
-- database (BETA_BLOCKLIST_HMAC_KEY_<V>), plus its key version. BetaAbuseEvidence
-- holds an AES-256-GCM sealed payload under a subkey of ENCRYPTION_KEY (also
-- outside the database). Neither table can be read back into an address without
-- a secret the database never sees.
--
-- SOFT REFERENCES, BY DESIGN: `sourceRequestId` has NO foreign key, so a block
-- (2 years) and its evidence (explicit retainUntil, ≤ 3 years) survive the
-- 180-day retention deletion of the BetaAccessRequest they came from.
--
-- ONE ACTIVE BLOCK PER IDENTIFIER: the partial unique index
-- "BetaBlockedIdentifier_identifierHmac_keyVersion_active_key" allows at most one
-- ACTIVE row per (identifierHmac, keyVersion). Prisma cannot express a partial
-- index, so it is NOT in schema.prisma (tests mirror it with fake.partialUnique).
--
-- AUTHORITY (least privilege):
--   BetaBlockedIdentifier  fm_system  SELECT, INSERT, UPDATE, DELETE
--                                     (UPDATE: remove / expiry correction;
--                                      DELETE: the retention job only)
--   BetaAbuseEvidence      fm_system  SELECT, INSERT, DELETE
--                                     (no UPDATE: there is no edit path;
--                                      DELETE: retention, or the audited
--                                      SYSTEM_ADMIN delete before the deadline)
--   both                   fm_backup  SELECT (complete dumps)
--                          fm_app     nothing (the public intake and operators
--                          fm_auth    nothing  read through fm_system)

-- ── 1. Enum + tables + indexes ───────────────────────────────────────────────
CREATE TYPE "BetaBlockedIdentifierStatus" AS ENUM ('ACTIVE', 'REMOVED');

CREATE TABLE "BetaBlockedIdentifier" (
    "id" TEXT NOT NULL,
    "identifierHmac" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "status" "BetaBlockedIdentifierStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceRequestId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "removalReasonCode" TEXT,
    "removalNote" TEXT,

    CONSTRAINT "BetaBlockedIdentifier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BetaAbuseEvidence" (
    "id" TEXT NOT NULL,
    "sourceRequestId" TEXT NOT NULL,
    "sealedPayload" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedById" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "retainUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BetaAbuseEvidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BetaBlockedIdentifier_status_expiresAt_idx" ON "BetaBlockedIdentifier"("status", "expiresAt");

CREATE INDEX "BetaBlockedIdentifier_sourceRequestId_idx" ON "BetaBlockedIdentifier"("sourceRequestId");

-- At most ONE ACTIVE block per (identifierHmac, keyVersion). Not in schema.prisma (partial).
CREATE UNIQUE INDEX "BetaBlockedIdentifier_identifierHmac_keyVersion_active_key" ON "BetaBlockedIdentifier"("identifierHmac", "keyVersion") WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "BetaAbuseEvidence_sourceRequestId_key" ON "BetaAbuseEvidence"("sourceRequestId");

CREATE INDEX "BetaAbuseEvidence_retainUntil_idx" ON "BetaAbuseEvidence"("retainUntil");

-- ── 2. Grants + RLS — operators (fm_system) only ─────────────────────────────
REVOKE ALL ON TABLE public."BetaBlockedIdentifier" FROM fm_app;
REVOKE ALL ON TABLE public."BetaBlockedIdentifier" FROM fm_auth;
REVOKE ALL ON TABLE public."BetaBlockedIdentifier" FROM fm_system;
GRANT SELECT ON TABLE public."BetaBlockedIdentifier" TO fm_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."BetaBlockedIdentifier" TO fm_system;

ALTER TABLE public."BetaBlockedIdentifier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BetaBlockedIdentifier" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."BetaBlockedIdentifier" FOR ALL TO fm_system USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public."BetaAbuseEvidence" FROM fm_app;
REVOKE ALL ON TABLE public."BetaAbuseEvidence" FROM fm_auth;
REVOKE ALL ON TABLE public."BetaAbuseEvidence" FROM fm_system;
GRANT SELECT ON TABLE public."BetaAbuseEvidence" TO fm_backup;
GRANT SELECT, INSERT, DELETE ON TABLE public."BetaAbuseEvidence" TO fm_system;

ALTER TABLE public."BetaAbuseEvidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BetaAbuseEvidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."BetaAbuseEvidence" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- Belt and braces (as migration 20261002000100 §19): never reachable by the Data API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."BetaBlockedIdentifier" FROM anon, authenticated, service_role';
    EXECUTE 'REVOKE ALL ON TABLE public."BetaAbuseEvidence" FROM anon, authenticated, service_role';
  END IF;
END $$;
