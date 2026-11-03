-- FIN-A2 — FM-AUDIT-023 (new-row half): an UNOBSERVED balance is not $0.
--
-- At token exchange a NEW FinancialAccount whose provider `current` balance
-- was null stored `balance = 0`, because "balance" is Float NOT NULL DEFAULT 0
-- and nothing could say "not observed". That zero then counted in every total.
--
-- 1. "balanceObserved" BOOLEAN NOT NULL DEFAULT true on "FinancialAccount".
--    * Additive and catalog-only: on PostgreSQL 11+ a constant default is
--      stored in the catalog, so there is no table rewrite and no long lock.
--    * NO BACKFILL: every existing row reads true, exactly its current meaning,
--      so no total changes. Only the exchange create site writes false, and only
--      when the balance was not observed. The first observed balance writes true.
--    * "balance" stays NOT NULL, and "balanceLastUpdatedAt" is not reused: it is
--      null on most legacy rows and would pull them out of totals.
--
-- 2. SyncIssueKind gains BALANCE_UNOBSERVED (the condition raised at create and
--    resolved when the first observed balance lands). ADD VALUE references
--    nothing in this migration; the first writer is the application, in a later
--    transaction (see 20260727_ops2d5b1_persistence_taxonomy).
--
-- RLS / GRANTS — nothing to change
--   * Every FinancialAccount grant (fm_app and fm_system SELECT/INSERT/UPDATE/
--     DELETE, 20261002000100_rls_roles_and_policies) is TABLE-level, so it covers
--     the new column. No column-level grant exists on this table. Row policies
--     are predicates over other columns and are unaffected.

ALTER TABLE "FinancialAccount" ADD COLUMN "balanceObserved" BOOLEAN NOT NULL DEFAULT true;

ALTER TYPE "SyncIssueKind" ADD VALUE IF NOT EXISTS 'BALANCE_UNOBSERVED';
