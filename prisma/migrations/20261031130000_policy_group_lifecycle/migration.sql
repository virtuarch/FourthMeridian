-- BETA LIFECYCLE (L1, owner decisions 2026-10-31) — per-group lifecycle state,
-- per-group cost freeze, and an append-only transition history.
--
-- ADDITIVE ONLY: three NEW enum types, four NEW columns on "PolicyGroup" (each
-- with a default that reproduces today's behaviour: ACTIVE, not frozen, no
-- ended transition, lifecycle version 0), and ONE NEW table with its index,
-- foreign key, grants and RLS. No existing row, column, grant or policy is
-- changed; no assignment is touched.
--
-- Day-one behaviour is unchanged: every existing group (incl. the built-in
-- BETA_FULL_ACCESS_V1) reads ACTIVE and not frozen.
--
-- AUTHORITY (least privilege, mirroring 20261030120000_policy_group_editor):
--   fm_system  PolicyGroupTransition  SELECT, INSERT  (no UPDATE / DELETE — history is APPEND-ONLY)
--              PolicyGroup            unchanged (SELECT, INSERT, UPDATE — the new columns are covered)
--   fm_app     nothing
--   fm_auth    nothing
--   fm_backup  SELECT (complete dumps)

-- ── 1. Enums ─────────────────────────────────────────────────────────────────
CREATE TYPE "PolicyGroupLifecycle" AS ENUM ('ACTIVE', 'PAUSED', 'ENDED');
CREATE TYPE "PolicyGroupEndedTransition" AS ENUM ('READ_ONLY', 'FREE');
CREATE TYPE "PolicyGroupTransitionKind" AS ENUM ('PAUSE', 'RESUME', 'END', 'FREEZE', 'UNFREEZE');

-- ── 2. PolicyGroup — lifecycle columns ───────────────────────────────────────
ALTER TABLE "PolicyGroup" ADD COLUMN "lifecycle" "PolicyGroupLifecycle" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "PolicyGroup" ADD COLUMN "costFrozen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PolicyGroup" ADD COLUMN "endedTransition" "PolicyGroupEndedTransition";
ALTER TABLE "PolicyGroup" ADD COLUMN "lifecycleVersion" INTEGER NOT NULL DEFAULT 0;

-- ── 3. PolicyGroupTransition — append-only history ───────────────────────────
CREATE TABLE "PolicyGroupTransition" (
    "id" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "kind" "PolicyGroupTransitionKind" NOT NULL,
    "fromLifecycle" "PolicyGroupLifecycle" NOT NULL,
    "toLifecycle" "PolicyGroupLifecycle" NOT NULL,
    "costFrozenBefore" BOOLEAN NOT NULL,
    "costFrozenAfter" BOOLEAN NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonNote" TEXT,
    "operatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyGroupTransition_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PolicyGroupTransition_groupKey_createdAt_idx" ON "PolicyGroupTransition"("groupKey", "createdAt");
ALTER TABLE "PolicyGroupTransition" ADD CONSTRAINT "PolicyGroupTransition_groupKey_fkey"
  FOREIGN KEY ("groupKey") REFERENCES "PolicyGroup"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── 4. Grants + RLS — operators (fm_system) only ─────────────────────────────
REVOKE ALL ON TABLE public."PolicyGroupTransition" FROM fm_app;
REVOKE ALL ON TABLE public."PolicyGroupTransition" FROM fm_auth;
REVOKE ALL ON TABLE public."PolicyGroupTransition" FROM fm_system;
GRANT SELECT ON TABLE public."PolicyGroupTransition" TO fm_backup;
ALTER TABLE public."PolicyGroupTransition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PolicyGroupTransition" FORCE ROW LEVEL SECURITY;
CREATE POLICY fm_system_all ON public."PolicyGroupTransition" FOR ALL TO fm_system USING (true) WITH CHECK (true);
DO $$
BEGIN
  -- Belt and braces (as migration 20261002000100 §19): never reachable by the Data API roles.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."PolicyGroupTransition" FROM anon, authenticated, service_role';
  END IF;
END $$;

GRANT SELECT, INSERT ON TABLE public."PolicyGroupTransition" TO fm_system;
