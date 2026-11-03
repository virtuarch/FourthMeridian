-- FIN-E part 2 (FIN-005) — SpaceSnapshot.restrictedCash
--
-- The RESTRICTED share (HSA, retirement cash) of the day's `cash + savings`,
-- i.e. classifyAccounts(...).totalRestrictedCash, so the Liquidity history and
-- the AI can present cash history on the "Available now" basis.
--
-- ADDITIVE AND CATALOG-ONLY. A nullable column with no default is a catalog
-- change on PG17: no table rewrite, no backfill, no lock beyond the brief
-- ACCESS EXCLUSIVE of ALTER TABLE ... ADD COLUMN.
--
-- NULL = NOT RECORDED, never 0. Every existing row reads NULL, and readers fall
-- back to the ALL_CASH series (labelled as such) for any window that contains
-- one. Past-row repair is owner-gated (B10.5) and is NOT part of this migration.
--
-- GRANTS. SpaceSnapshot carries TABLE-level grants only (fm_app / fm_system /
-- fm_backup; 20261002000100_rls_roles_and_policies). No column-level grant
-- exists on the table, so the new column is covered by those table grants and
-- no explicit column grant is added. RLS policies are row-level and unaffected.

ALTER TABLE "SpaceSnapshot" ADD COLUMN "restrictedCash" DOUBLE PRECISION;
