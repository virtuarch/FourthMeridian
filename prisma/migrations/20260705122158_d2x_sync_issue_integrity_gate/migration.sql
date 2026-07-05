-- CreateEnum
CREATE TYPE "SyncIssueKind" AS ENUM ('MISSING_ACCOUNT', 'UPSERT_ERROR', 'REMOVED_TOMBSTONE', 'BALANCE_TX_MISMATCH', 'REPLAY_ATTEMPTED', 'REPLAY_RECOVERED', 'REPLAY_FAILED');

-- CreateTable
CREATE TABLE "SyncIssue" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PLAID',
    "plaidItemId" TEXT,
    "financialAccountId" TEXT,
    "kind" "SyncIssueKind" NOT NULL,
    "plaidTransactionId" TEXT,
    "plaidAccountId" TEXT,
    "detail" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncIssue_financialAccountId_resolved_idx" ON "SyncIssue"("financialAccountId", "resolved");

-- CreateIndex
CREATE INDEX "SyncIssue_plaidItemId_kind_idx" ON "SyncIssue"("plaidItemId", "kind");
