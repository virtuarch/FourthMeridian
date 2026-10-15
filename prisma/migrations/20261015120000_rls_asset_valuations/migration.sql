-- RWA-2A — ASSET VALUATION HISTORY for manual real-world assets
-- (FinancialAccount type=other, syncStatus='manual'). Additive: two new tables,
-- no existing table or row is touched, no backfill. Compatible with the running
-- application (nothing reads these tables until the RWA-2A code ships).
--
--   ManualAssetProfile  1:1 acquisition facts (acquisition date, purchase price,
--                       and the user's opt-in to use the purchase price as the
--                       starting valuation). A purchase price is a FACT, never
--                       a market value unless the user opts in.
--   AssetValuation      APPEND-ONLY ledger of the user's dated valuations.
--                       Modeled / interpolated values are never stored here.
--                       Same-day rule: latest recordedAt per (account, date) wins.
--
-- RLS: the account-subtree pattern of 20261002000100 (ENABLE + FORCE, fm_app
-- policies on fm_account_visible("financialAccountId"), fm_system all, fm_backup
-- read), then the owner arm of 20261003000000 written out per table.
--
-- APPEND-ONLY IS ENFORCED BY GRANT, not only by convention: fm_app may SELECT and
-- INSERT AssetValuation and nothing else, so no tenant request can rewrite or
-- delete a recorded valuation. (A FinancialAccount hard delete still cascades:
-- referential actions run as the table owner and are not subject to fm_app's
-- grants or RLS.) fm_system keeps full access for operator repair.
--
-- Privacy: RLS admits any viewer of an ACTIVE link, including BALANCE_ONLY. The
-- application additionally gates every valuation/profile READ to the owner or a
-- FULL-link viewer (lib/assets/valuations.ts) — the detail route's rule.

-- ── 1. ManualAssetProfile ────────────────────────────────────────────────────
CREATE TABLE "ManualAssetProfile" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "acquisitionDate" DATE,
    "purchasePrice" DOUBLE PRECISION,
    "purchaseCurrency" TEXT,
    "purchasePriceIsStartingValue" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualAssetProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ManualAssetProfile_financialAccountId_key" ON "ManualAssetProfile"("financialAccountId");
CREATE INDEX "ManualAssetProfile_financialAccountId_idx" ON "ManualAssetProfile"("financialAccountId");
ALTER TABLE "ManualAssetProfile" ADD CONSTRAINT "ManualAssetProfile_financialAccountId_fkey"
  FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. AssetValuation ────────────────────────────────────────────────────────
CREATE TABLE "AssetValuation" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'USER_ESTIMATE',
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT,

    CONSTRAINT "AssetValuation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AssetValuation_financialAccountId_effectiveDate_recordedAt_idx"
  ON "AssetValuation"("financialAccountId", "effectiveDate", "recordedAt");
CREATE INDEX "AssetValuation_recordedByUserId_idx" ON "AssetValuation"("recordedByUserId");
ALTER TABLE "AssetValuation" ADD CONSTRAINT "AssetValuation_financialAccountId_fkey"
  FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetValuation" ADD CONSTRAINT "AssetValuation_recordedByUserId_fkey"
  FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- A valuation is a non-negative, finite amount (the manual routes' own rule).
ALTER TABLE "AssetValuation" ADD CONSTRAINT "AssetValuation_value_nonnegative"
  CHECK ("value" >= 0 AND "value" < 'Infinity'::double precision);

-- ── 3. Grants + RLS ──────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ManualAssetProfile', 'AssetValuation'] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM fm_app', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM fm_auth', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO fm_system', t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO fm_backup', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY fm_app_sel ON public.%I FOR SELECT TO fm_app
                      USING (fm_account_visible("financialAccountId"))$f$, t);
    EXECUTE format($f$CREATE POLICY fm_app_ins ON public.%I FOR INSERT TO fm_app
                      WITH CHECK (fm_account_visible("financialAccountId"))$f$, t);
    EXECUTE format('CREATE POLICY fm_system_all ON public.%I FOR ALL TO fm_system USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- ManualAssetProfile is an editable 1:1 fact sheet (the DebtProfile pattern):
-- fm_app gets the full CRUD set.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."ManualAssetProfile" TO fm_app;
CREATE POLICY fm_app_upd ON public."ManualAssetProfile" FOR UPDATE TO fm_app
  USING (fm_account_visible("financialAccountId"))
  WITH CHECK (fm_account_visible("financialAccountId"));
CREATE POLICY fm_app_del ON public."ManualAssetProfile" FOR DELETE TO fm_app
  USING (fm_account_visible("financialAccountId"));

-- AssetValuation is APPEND-ONLY for the tenant: SELECT + INSERT only. No UPDATE
-- or DELETE grant, and no UPDATE/DELETE policy.
GRANT SELECT, INSERT ON TABLE public."AssetValuation" TO fm_app;

-- ── 4. Owner arm (identical construction to 20261003000000) ──────────────────
-- Written out, not a function call (the function form is not inlined), and the
-- outer row is named with the table qualifier — an unqualified column inside the
-- `sal` subquery would make every row visible to everyone.
DO $$
DECLARE t text; visible_arm text; owned_arm text; pred text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ManualAssetProfile', 'AssetValuation'] LOOP
    visible_arm := format($f$EXISTS (SELECT 1 FROM "SpaceAccountLink" sal
                  WHERE sal."financialAccountId" = %1$I."financialAccountId"
                    AND sal.status = 'ACTIVE'
                    AND sal."spaceId" IN (SELECT fm_visible_space_ids()))$f$, t);
    owned_arm := format($f$EXISTS (SELECT 1 FROM "FinancialAccount" fa
                  WHERE fa."id" = %1$I."financialAccountId"
                    AND fa."ownerUserId" = current_fm_user_id())$f$, t);
    pred := '(' || visible_arm || ' OR ' || owned_arm || ')';
    EXECUTE format('ALTER POLICY fm_app_sel ON public.%I USING %s', t, pred);
    EXECUTE format('ALTER POLICY fm_app_ins ON public.%I WITH CHECK %s', t, pred);
  END LOOP;
  t := 'ManualAssetProfile';
  visible_arm := format($f$EXISTS (SELECT 1 FROM "SpaceAccountLink" sal
                WHERE sal."financialAccountId" = %1$I."financialAccountId"
                  AND sal.status = 'ACTIVE'
                  AND sal."spaceId" IN (SELECT fm_visible_space_ids()))$f$, t);
  owned_arm := format($f$EXISTS (SELECT 1 FROM "FinancialAccount" fa
                WHERE fa."id" = %1$I."financialAccountId"
                  AND fa."ownerUserId" = current_fm_user_id())$f$, t);
  pred := '(' || visible_arm || ' OR ' || owned_arm || ')';
  EXECUTE format('ALTER POLICY fm_app_upd ON public.%I USING %s WITH CHECK %s', t, pred, pred);
  EXECUTE format('ALTER POLICY fm_app_del ON public.%I USING %s', t, pred);
END $$;
