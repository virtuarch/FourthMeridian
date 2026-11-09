-- Mortgage F1b (S2 ruling 2026-11-08; required before Production and before any
-- Preview regeneration) — SpaceSnapshot records the installment debt each row
-- EXCLUDED from netLiquid, so a row's liquid-net-worth basis is read per row
-- instead of from a date constant.
--
-- ADDITIVE AND CATALOG-ONLY. One nullable DOUBLE PRECISION column (the type of
-- "debt" and "netLiquid"), NO default, NO backfill, NO UPDATE: every existing row
-- reads NULL = "not recorded" (a legacy row). Only the application's snapshot
-- writers fill it, on rows they write from now on.
--
-- GRANTS / RLS. SpaceSnapshot carries table-level grants and row policies; a new
-- column is covered by them. No policy or grant change.

-- AlterTable
ALTER TABLE "SpaceSnapshot" ADD COLUMN     "installmentDebt" DOUBLE PRECISION;
