-- MC1 Phase 3 — reporting-currency ownership (Slice 1). Additive only: two
-- defaulted columns; NOT NULL DEFAULT 'USD' is a true statement for every
-- existing row (the platform has only ever reported in USD), so no backfill
-- is needed. Space is authoritative; User is a copy-once default for new
-- Spaces. Nothing reads these columns until the Phase 3 flip slices.
-- See docs/initiatives/mc1/MC1_PHASE3_REPORTING_CURRENCY_PLAN.md §2/§6.

-- AlterTable
ALTER TABLE "Space" ADD COLUMN "reportingCurrency" TEXT NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "reportingCurrency" TEXT NOT NULL DEFAULT 'USD';
