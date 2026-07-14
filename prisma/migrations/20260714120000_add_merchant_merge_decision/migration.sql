-- MI2 S2 — Merchant Merge Review Queue: closes the pre-existing schema drift.
-- MerchantMergeDecision + MerchantMergeVerdict were added to schema.prisma in
-- commit ab04607 (Jul 8) without a migration, then deliberately deferred by
-- 20260710101154_add_transfer_evidence and 20260713150000_po1_0_platform_access
-- (see their headers) rather than bundled into an unrelated slice. This is that
-- dedicated migration. Purely additive: one enum, one table, two indexes. No FK
-- relations (decidedByUserId is a soft ref, keys are canonicalKey strings — a
-- merge deletes the absorbed Merchant, so an FK would dangle). No backfill.

-- CreateEnum
CREATE TYPE "MerchantMergeVerdict" AS ENUM ('MERGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "MerchantMergeDecision" (
    "id" TEXT NOT NULL,
    "pairKey" TEXT NOT NULL,
    "verdict" "MerchantMergeVerdict" NOT NULL,
    "survivorKey" TEXT NOT NULL,
    "absorbedKey" TEXT NOT NULL,
    "evidenceTier" TEXT NOT NULL,
    "evidenceSignal" TEXT,
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantMergeDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantMergeDecision_pairKey_key" ON "MerchantMergeDecision"("pairKey");

-- CreateIndex
CREATE INDEX "MerchantMergeDecision_verdict_createdAt_idx" ON "MerchantMergeDecision"("verdict", "createdAt");
