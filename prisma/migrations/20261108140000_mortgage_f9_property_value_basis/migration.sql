-- Mortgage F9 (owner decision 2026-11-08 — HOME VALUATION) — ManualAssetProfile
-- gains what a property's value IS and which secured debts it backs.
--
-- ADDITIVE AND CATALOG-ONLY. One new enum type and three new columns on
-- ManualAssetProfile. Every default is a constant, so on PG11+ ADD COLUMN ...
-- DEFAULT is a catalog change: no table rewrite, no backfill, no UPDATE, no lock
-- beyond the brief ACCESS EXCLUSIVE of ALTER TABLE ... ADD COLUMN.
--
--   assetKind              TEXT, NULL      — the kind chosen at entry; NULL = not
--                                            recorded (every pre-F9 asset).
--   valueBasis             enum, UNKNOWN   — MARKET_VALUE | EQUITY_ENTERED |
--                                            UNKNOWN. Every existing row reads
--                                            UNKNOWN: nothing is inferred and no
--                                            recorded value is restated.
--   securedDebtAccountIds  TEXT[], ARRAY[] — the mortgage / HELOC / home-equity
--                                            debt accounts the USER linked. Empty
--                                            for every existing row (no auto-link).
--
-- NET WORTH IS UNTOUCHED: the property still counts at its recorded value and
-- the debt as a liability. Equity (value − linked secured debt) is a derived
-- display computed at read time by lib/assets/property-equity.ts.
--
-- NO FK on securedDebtAccountIds (a Postgres array cannot carry one). Integrity is
-- enforced at read AND write time: every id is re-checked against the caller's
-- visible, same-Space, secured-kind, non-deleted debts (checkSecuredDebtLink), so
-- a deleted, unshared or re-typed debt simply stops counting.
--
-- GRANTS / RLS. ManualAssetProfile carries TABLE-level grants and row policies
-- only (20261015120000_rls_asset_valuations: fm_app CRUD on the visible-or-owned
-- account-subtree predicate; fm_system all; fm_backup SELECT). New columns are
-- covered by those table grants; no policy or grant changes. The enum type gets
-- PostgreSQL's default PUBLIC USAGE, like every other enum in this schema.

-- CreateEnum
CREATE TYPE "PropertyValueBasis" AS ENUM ('MARKET_VALUE', 'EQUITY_ENTERED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "ManualAssetProfile" ADD COLUMN     "assetKind" TEXT,
ADD COLUMN     "securedDebtAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "valueBasis" "PropertyValueBasis" NOT NULL DEFAULT 'UNKNOWN';
