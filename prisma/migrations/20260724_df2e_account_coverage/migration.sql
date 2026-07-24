-- CreateTable
CREATE TABLE "RefreshEndpointAccountCoverage" (
    "id" TEXT NOT NULL,
    "refreshExecutionId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "freshnessAdvanced" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshEndpointAccountCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RefreshEndpointAccountCoverage_refreshExecutionId_idx" ON "RefreshEndpointAccountCoverage"("refreshExecutionId");

-- CreateIndex
CREATE INDEX "RefreshEndpointAccountCoverage_financialAccountId_endpoint__idx" ON "RefreshEndpointAccountCoverage"("financialAccountId", "endpoint", "createdAt");

-- CreateIndex
CREATE INDEX "RefreshEndpointAccountCoverage_financialAccountId_createdAt_idx" ON "RefreshEndpointAccountCoverage"("financialAccountId", "createdAt");

-- AddForeignKey
ALTER TABLE "RefreshEndpointAccountCoverage" ADD CONSTRAINT "RefreshEndpointAccountCoverage_refreshExecutionId_fkey" FOREIGN KEY ("refreshExecutionId") REFERENCES "RefreshExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
