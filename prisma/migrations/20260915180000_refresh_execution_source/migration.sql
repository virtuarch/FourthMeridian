-- PLATFORM OPS OBSERVABILITY — generic execution source identity + verdict on
-- the refresh ledger, so wallet refreshes can enter the same ledger as Plaid
-- items. Additive and nullable throughout; existing rows read as Plaid items.

-- AlterTable
ALTER TABLE "RefreshExecution" ALTER COLUMN "plaidItemId" DROP NOT NULL;
ALTER TABLE "RefreshExecution" ADD COLUMN     "sourceKind" TEXT NOT NULL DEFAULT 'PLAID_ITEM',
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "network" TEXT,
ADD COLUMN     "failureStage" TEXT,
ADD COLUMN     "failureCategory" TEXT,
ADD COLUMN     "outcome" TEXT;

-- CreateIndex
CREATE INDEX "RefreshExecution_sourceKind_startedAt_idx" ON "RefreshExecution"("sourceKind", "startedAt");

-- CreateIndex
CREATE INDEX "RefreshExecution_sourceRef_startedAt_idx" ON "RefreshExecution"("sourceRef", "startedAt");
