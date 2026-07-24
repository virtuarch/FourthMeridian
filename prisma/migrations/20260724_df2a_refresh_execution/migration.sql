-- CreateTable
CREATE TABLE "RefreshExecution" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "profile" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "overallStatus" TEXT NOT NULL,
    "parentJobRunId" TEXT,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshEndpointResult" (
    "id" TEXT NOT NULL,
    "refreshExecutionId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "stageKind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "recordsRead" INTEGER,
    "recordsWritten" INTEGER,
    "recordsChanged" INTEGER,
    "coveredAccountIds" TEXT[],
    "freshnessAdvanced" BOOLEAN,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshEndpointResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshExecution_runId_key" ON "RefreshExecution"("runId");

-- CreateIndex
CREATE INDEX "RefreshExecution_plaidItemId_startedAt_idx" ON "RefreshExecution"("plaidItemId", "startedAt");

-- CreateIndex
CREATE INDEX "RefreshExecution_overallStatus_startedAt_idx" ON "RefreshExecution"("overallStatus", "startedAt");

-- CreateIndex
CREATE INDEX "RefreshExecution_parentJobRunId_idx" ON "RefreshExecution"("parentJobRunId");

-- CreateIndex
CREATE INDEX "RefreshEndpointResult_refreshExecutionId_idx" ON "RefreshEndpointResult"("refreshExecutionId");

-- CreateIndex
CREATE INDEX "RefreshEndpointResult_endpoint_status_idx" ON "RefreshEndpointResult"("endpoint", "status");

-- AddForeignKey
ALTER TABLE "RefreshEndpointResult" ADD CONSTRAINT "RefreshEndpointResult_refreshExecutionId_fkey" FOREIGN KEY ("refreshExecutionId") REFERENCES "RefreshExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

