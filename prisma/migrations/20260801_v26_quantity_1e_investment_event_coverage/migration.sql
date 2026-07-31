-- CreateEnum
CREATE TYPE "InvestmentCoverageOutcome" AS ENUM ('COMPLETE', 'PARTIAL', 'FAILED', 'DISABLED', 'CONSENT_REQUIRED', 'NOT_READY');

-- CreateTable
CREATE TABLE "InvestmentEventCoverage" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "requestedFromDate" DATE NOT NULL,
    "requestedToDate" DATE NOT NULL,
    "outcome" "InvestmentCoverageOutcome" NOT NULL,
    "reportedTotal" INTEGER,
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestmentEventCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvestmentEventCoverage_financialAccountId_outcome_requeste_idx" ON "InvestmentEventCoverage"("financialAccountId", "outcome", "requestedFromDate");

-- CreateIndex
CREATE INDEX "InvestmentEventCoverage_plaidItemId_attemptedAt_idx" ON "InvestmentEventCoverage"("plaidItemId", "attemptedAt");

-- CreateIndex
CREATE INDEX "InvestmentEventCoverage_attemptId_idx" ON "InvestmentEventCoverage"("attemptId");

-- AddForeignKey
ALTER TABLE "InvestmentEventCoverage" ADD CONSTRAINT "InvestmentEventCoverage_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentEventCoverage" ADD CONSTRAINT "InvestmentEventCoverage_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

