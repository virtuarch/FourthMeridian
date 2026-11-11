-- PLATFORM AI PER-OPERATOR CAP (D5 PR3, S2-approved plan 09fb).
--
-- ADDITIVE ONLY: one NEW table, its index, two foreign keys to "User", one
-- CHECK, grants and RLS. No existing table, row, column or policy changes
-- (the two FKs take a brief SHARE ROW EXCLUSIVE lock on "User", bounded by
-- lock_timeout). No backfill. NOTHING READS THIS TABLE YET: the caps resolver
-- keeps resolving from the platform setting / ENV until a later PR wires it.
--
-- ONE ROW PER OPERATOR ("userId" is the primary key): a whole-USD daily
-- Platform AI spend cap. CHECK 0 <= "dailyUsd" <= 20 = the S2 R4 ceiling
-- (PLATFORM_AI_OPERATOR_CAP_CEILING_USD in lib/platform/ai/platform-ai-spend.core.ts;
-- the parse test lib/platform/ai/operator-cap-migration.test.ts pins both).
--
-- PURGE: "userId" ON DELETE CASCADE (the cap dies with the account);
-- "updatedById" ON DELETE SET NULL (an admin's purge leaves the caps they set,
-- anonymised) — the PlatformGrant.grantedById pattern.
--
-- AUTHORITY (least privilege; the BetaBlockedIdentifier pattern, 20261101120000 §2):
--   PlatformAiOperatorCap  fm_system  SELECT, INSERT, UPDATE, DELETE
--                          fm_backup  SELECT (complete dumps)
--                          fm_app     nothing (operators read and write through fm_system)
--                          fm_auth    nothing

SET LOCAL lock_timeout = '5s';

-- ── 1. Table + index + constraints ────────────────────────────────────────────
CREATE TABLE "PlatformAiOperatorCap" (
    "userId" TEXT NOT NULL,
    "dailyUsd" INTEGER NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAiOperatorCap_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "PlatformAiOperatorCap_dailyUsd_range" CHECK ("dailyUsd" >= 0 AND "dailyUsd" <= 20)
);

CREATE INDEX "PlatformAiOperatorCap_updatedById_idx" ON "PlatformAiOperatorCap"("updatedById");

ALTER TABLE "PlatformAiOperatorCap" ADD CONSTRAINT "PlatformAiOperatorCap_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlatformAiOperatorCap" ADD CONSTRAINT "PlatformAiOperatorCap_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. Grants + RLS — operators (fm_system) only ─────────────────────────────
REVOKE ALL ON TABLE public."PlatformAiOperatorCap" FROM fm_app;
REVOKE ALL ON TABLE public."PlatformAiOperatorCap" FROM fm_auth;
REVOKE ALL ON TABLE public."PlatformAiOperatorCap" FROM fm_system;
GRANT SELECT ON TABLE public."PlatformAiOperatorCap" TO fm_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."PlatformAiOperatorCap" TO fm_system;

ALTER TABLE public."PlatformAiOperatorCap" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PlatformAiOperatorCap" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."PlatformAiOperatorCap" FOR ALL TO fm_system USING (true) WITH CHECK (true);

-- Belt and braces (as migration 20261002000100 §19): never reachable by the Data API roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."PlatformAiOperatorCap" FROM anon, authenticated, service_role';
  END IF;
END $$;
