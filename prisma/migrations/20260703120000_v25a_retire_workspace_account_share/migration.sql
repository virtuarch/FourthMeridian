-- v2.5-A Phase 4c — retire WorkspaceAccountShare.
--
-- Gates satisfied before this migration (docs/investigations/
-- V25A_PHASE0_SEAM_RETIREMENT_READINESS.md §2, scripts/phase0-seam-gates.ts):
--   Gate D: zero WAS rows un-mirrored into SpaceAccountLink, zero drift.
-- Zero runtime readers/writers remained (verified: only seed + verification
-- scripts referenced the model; both retired before this migration).
--
-- Rollback: re-create the table from the down-path in the retirement PR and
-- restore the pre-drop pg_dump. WAS rows are also 1:1 reconstructable from
-- SpaceAccountLink kind=SHARED rows (D3 dual-write provenance).
--
-- Deliberately NOT touched: "Account" table, "Holding"."accountId",
-- "Transaction"."accountId", "VisibilityLevel" enum (SHARED value stays),
-- "ShareStatus" enum (SpaceAccountLink uses it).

-- DropForeignKey
ALTER TABLE "WorkspaceAccountShare" DROP CONSTRAINT "WorkspaceAccountShare_addedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceAccountShare" DROP CONSTRAINT "WorkspaceAccountShare_financialAccountId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceAccountShare" DROP CONSTRAINT "WorkspaceAccountShare_revokedByUserId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceAccountShare" DROP CONSTRAINT "WorkspaceAccountShare_workspaceId_fkey";

-- DropTable
DROP TABLE "WorkspaceAccountShare";
