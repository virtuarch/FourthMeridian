-- CreateTable
CREATE TABLE "ProviderCall" (
    "id" TEXT NOT NULL,
    "refreshExecutionId" TEXT NOT NULL,
    "endpoint" TEXT,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "providerRequestId" TEXT,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "errorCategory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProviderCall_refreshExecutionId_idx" ON "ProviderCall"("refreshExecutionId");

-- CreateIndex
CREATE INDEX "ProviderCall_provider_operation_idx" ON "ProviderCall"("provider", "operation");

-- CreateIndex
CREATE INDEX "ProviderCall_status_startedAt_idx" ON "ProviderCall"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "ProviderCall" ADD CONSTRAINT "ProviderCall_refreshExecutionId_fkey" FOREIGN KEY ("refreshExecutionId") REFERENCES "RefreshExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
