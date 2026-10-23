-- CreateTable
CREATE TABLE "AiInvocation" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promptTokens" INTEGER NOT NULL,
    "cachedPromptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "finishReason" TEXT,
    "environment" TEXT NOT NULL,
    "correlationId" TEXT,
    "turnIndex" INTEGER,
    "surface" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiInvocation_occurredAt_idx" ON "AiInvocation"("occurredAt");

-- CreateIndex
CREATE INDEX "AiInvocation_model_occurredAt_idx" ON "AiInvocation"("model", "occurredAt");

-- CreateIndex
CREATE INDEX "AiInvocation_correlationId_turnIndex_idx" ON "AiInvocation"("correlationId", "turnIndex");

-- CreateIndex
CREATE INDEX "AiInvocation_environment_occurredAt_idx" ON "AiInvocation"("environment", "occurredAt");

