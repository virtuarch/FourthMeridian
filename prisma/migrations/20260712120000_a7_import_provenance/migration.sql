-- A7-1 — Historical Investment Import provenance spine.
--
-- Purely additive and reversible. One new enum plus five nullable/defaulted
-- columns, one index, and one SetNull foreign key — no existing column or
-- constraint is altered. Nothing writes any of these fields yet (the manual
-- assertion writer is A7-2; the import commit path is A7-4), so this migration
-- changes zero behavior on its own:
--
--   * ImportBatch.kind defaults to TRANSACTIONS, so every existing (banking)
--     batch stays honestly classified with no backfill.
--   * PositionObservation.importBatchId / deletedAt and InvestmentEvent.importedRaw
--     and ImportBatch.userDecisions are all NULL on existing rows — MC1 doctrine:
--     null means never provided, never inferred.
--   * The observation read paths (reconstruction-runner, reconstruction-read,
--     position-capture) now filter `deletedAt: null`; with every existing row's
--     deletedAt NULL, that filter is a no-op until an import is rolled back.
--
-- Reversible by dropping the FK + index, the five columns, and the enum TYPE
-- (a new CREATE TYPE, never an ALTER TYPE ADD VALUE). See
-- FOURTH_MERIDIAN_A7_HISTORICAL_INVESTMENT_IMPORT_INVESTIGATION_2026-07-12.md §4, §8.2, §14.

-- CreateEnum
CREATE TYPE "ImportBatchKind" AS ENUM ('TRANSACTIONS', 'INVESTMENT_HISTORY');

-- AlterTable
ALTER TABLE "PositionObservation" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "InvestmentEvent" ADD COLUMN     "importedRaw" JSONB;

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "kind" "ImportBatchKind" NOT NULL DEFAULT 'TRANSACTIONS',
ADD COLUMN     "userDecisions" JSONB;

-- CreateIndex
CREATE INDEX "PositionObservation_importBatchId_idx" ON "PositionObservation"("importBatchId");

-- AddForeignKey
ALTER TABLE "PositionObservation" ADD CONSTRAINT "PositionObservation_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
