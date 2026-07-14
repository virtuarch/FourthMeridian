-- Wealth-timeline amendment system (Phase 2). Purely additive: 2 enums, 1
-- nullable column on SpaceSnapshot (amendedByAmendmentId, SetNull FK), and 2
-- new tables (SnapshotAmendment + its per-day breakdown SnapshotAmendmentDay).
-- No existing row or column is changed; no backfill. See
-- docs/initiatives/wealth-timeline/WEALTH_TIMELINE_AMENDMENT_SYSTEM_PROPOSAL.md.

-- CreateEnum
CREATE TYPE "SnapshotAmendmentKind" AS ENUM ('ACCOUNT_ADDED_RETROACTIVE', 'ACCOUNT_REMOVED_RETROACTIVE', 'ACCOUNT_HARD_DELETED', 'IMPORT_ENRICHMENT');

-- CreateEnum
CREATE TYPE "SnapshotAmendmentStatus" AS ENUM ('PENDING', 'APPLIED');

-- AlterTable
ALTER TABLE "SpaceSnapshot" ADD COLUMN     "amendedByAmendmentId" TEXT;

-- CreateTable
CREATE TABLE "SnapshotAmendment" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "kind" "SnapshotAmendmentKind" NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "SnapshotAmendmentStatus" NOT NULL DEFAULT 'PENDING',
    "consentedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "auditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnapshotAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnapshotAmendmentDay" (
    "id" TEXT NOT NULL,
    "amendmentId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "stocksBefore" DOUBLE PRECISION,
    "stocksAfter" DOUBLE PRECISION,
    "cryptoBefore" DOUBLE PRECISION,
    "cryptoAfter" DOUBLE PRECISION,
    "cashBefore" DOUBLE PRECISION,
    "cashAfter" DOUBLE PRECISION,
    "savingsBefore" DOUBLE PRECISION,
    "savingsAfter" DOUBLE PRECISION,
    "debtBefore" DOUBLE PRECISION,
    "debtAfter" DOUBLE PRECISION,
    "netWorthBefore" DOUBLE PRECISION,
    "netWorthAfter" DOUBLE PRECISION,

    CONSTRAINT "SnapshotAmendmentDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SnapshotAmendment_spaceId_status_idx" ON "SnapshotAmendment"("spaceId", "status");

-- CreateIndex
CREATE INDEX "SnapshotAmendment_financialAccountId_idx" ON "SnapshotAmendment"("financialAccountId");

-- CreateIndex
CREATE INDEX "SnapshotAmendment_requestedByUserId_idx" ON "SnapshotAmendment"("requestedByUserId");

-- CreateIndex
CREATE INDEX "SnapshotAmendmentDay_amendmentId_idx" ON "SnapshotAmendmentDay"("amendmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SnapshotAmendmentDay_amendmentId_date_key" ON "SnapshotAmendmentDay"("amendmentId", "date");

-- AddForeignKey
ALTER TABLE "SpaceSnapshot" ADD CONSTRAINT "SpaceSnapshot_amendedByAmendmentId_fkey" FOREIGN KEY ("amendedByAmendmentId") REFERENCES "SnapshotAmendment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotAmendment" ADD CONSTRAINT "SnapshotAmendment_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotAmendment" ADD CONSTRAINT "SnapshotAmendment_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotAmendment" ADD CONSTRAINT "SnapshotAmendment_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotAmendmentDay" ADD CONSTRAINT "SnapshotAmendmentDay_amendmentId_fkey" FOREIGN KEY ("amendmentId") REFERENCES "SnapshotAmendment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

