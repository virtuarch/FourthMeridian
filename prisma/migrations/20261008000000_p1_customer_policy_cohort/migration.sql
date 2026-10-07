-- P1 HUMAN OPERABILITY — customer Policy Group / cohort ASSIGNMENTS and the two
-- wallet refresh guards. Additive, no backfill, compatible with the running
-- application (no existing row is touched; the new tables have no reader until
-- this slice's code; the two Connection columns are nullable).
--
-- Definitions stay in code (lib/entitlements/catalogue.ts). A user with no
-- assignment row resolves to the catalogue default and is REPORTED as
-- unassigned — nothing here fabricates a history that did not happen.

-- ── 1. CustomerPolicyAssignment ──────────────────────────────────────────────
CREATE TABLE "CustomerPolicyAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyGroup" TEXT NOT NULL,
    "overlay" TEXT,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPolicyAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerPolicyAssignment_userId_key" ON "CustomerPolicyAssignment"("userId");
CREATE INDEX "CustomerPolicyAssignment_policyGroup_idx" ON "CustomerPolicyAssignment"("policyGroup");
ALTER TABLE "CustomerPolicyAssignment" ADD CONSTRAINT "CustomerPolicyAssignment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. CustomerCohort ────────────────────────────────────────────────────────
CREATE TABLE "CustomerCohort" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cohort" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "assignedById" TEXT,

    CONSTRAINT "CustomerCohort_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CustomerCohort_userId_cohort_key" ON "CustomerCohort"("userId", "cohort");
CREATE INDEX "CustomerCohort_cohort_idx" ON "CustomerCohort"("cohort");
ALTER TABLE "CustomerCohort" ADD CONSTRAINT "CustomerCohort_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. RLS — user-scoped READ for the customer, writes by operators and the
--       registration redemption only ─────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['CustomerPolicyAssignment', 'CustomerCohort'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM fm_app', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM fm_auth', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO fm_app', t);
    EXECUTE format('GRANT INSERT ON TABLE public.%I TO fm_auth', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_system', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO fm_backup', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY fm_app_sel ON public.%I FOR SELECT TO fm_app
                      USING ("userId" = current_fm_user_id())$f$, t);
    EXECUTE format('CREATE POLICY fm_auth_ins ON public.%I FOR INSERT TO fm_auth WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY fm_system_all ON public.%I FOR ALL TO fm_system USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ── 4. Connection — the wallet refresh guards ────────────────────────────────
ALTER TABLE "Connection" ADD COLUMN "syncLockedAt" TIMESTAMP(3);
ALTER TABLE "Connection" ADD COLUMN "lastManualRefreshAt" TIMESTAMP(3);
