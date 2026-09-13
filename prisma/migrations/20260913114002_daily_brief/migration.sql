-- CreateTable
CREATE TABLE "DailyBrief" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "briefDay" DATE NOT NULL,
    "content" JSONB,
    "generatedAt" TIMESTAMP(3),
    "balancesAsOf" TIMESTAMP(3),
    "historyThrough" DATE,
    "sourceWatermark" TEXT,
    "materialDigest" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "correlationId" TEXT,
    "generationStartedAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "lastFailureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyBrief_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyBrief_spaceId_ownerUserId_briefDay_key" ON "DailyBrief"("spaceId", "ownerUserId", "briefDay");

-- AddForeignKey
ALTER TABLE "DailyBrief" ADD CONSTRAINT "DailyBrief_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyBrief" ADD CONSTRAINT "DailyBrief_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
