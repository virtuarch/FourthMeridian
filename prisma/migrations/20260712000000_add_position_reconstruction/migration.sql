-- Position Reconstruction summary (Slice A4-2).
--
-- Purely additive and dark-write: one new enum, one new table, its indexes and
-- FKs, and two back-relations (relation lists only — no column changes on the
-- referenced tables). Nothing reads or writes PositionReconstruction unless
-- INVESTMENT_RECONSTRUCTION_ENABLED is true. New enum TYPE (not ALTER TYPE ADD
-- VALUE) so the slice is reversible by dropping the table + type. The DERIVED
-- position rows live in PositionObservation(origin: DERIVED); this table is the
-- per-position reconciliation summary. `reconciliation` is a job outcome;
-- `completeness` is the separate canonical A5-S1 trust tier. See
-- FOURTH_MERIDIAN_INVESTMENT_HISTORY_PROGRESSIVE_EVIDENCE_IMPLEMENTATION_PLAN §7.3/§7.4
-- and FOURTH_MERIDIAN_A5_A4_P1-P4_PARALLELIZATION_INVESTIGATION §4.

-- CreateEnum
CREATE TYPE "ReconstructionStatus" AS ENUM ('COMPLETE', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "PositionReconstruction" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "earliestDefensibleDate" DATE NOT NULL,
    "observedCurrentQuantity" DOUBLE PRECISION NOT NULL,
    "openingQuantity" DOUBLE PRECISION NOT NULL,
    "unexplainedOpeningQuantity" DOUBLE PRECISION NOT NULL,
    "reconciliation" "ReconstructionStatus" NOT NULL,
    "failureReason" TEXT,
    "completeness" TEXT NOT NULL,
    "conflicted" BOOLEAN NOT NULL DEFAULT false,
    "reconstructionVersion" INTEGER NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "evidenceRefs" JSONB,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionReconstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PositionReconstruction_financialAccountId_idx" ON "PositionReconstruction"("financialAccountId");

-- CreateIndex
CREATE INDEX "PositionReconstruction_instrumentId_idx" ON "PositionReconstruction"("instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "PositionReconstruction_financialAccountId_instrumentId_key" ON "PositionReconstruction"("financialAccountId", "instrumentId");

-- AddForeignKey
ALTER TABLE "PositionReconstruction" ADD CONSTRAINT "PositionReconstruction_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionReconstruction" ADD CONSTRAINT "PositionReconstruction_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
