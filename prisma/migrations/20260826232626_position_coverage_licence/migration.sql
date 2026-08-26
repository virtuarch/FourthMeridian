-- CreateTable
CREATE TABLE "PositionCoverage" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "coveredFromDate" DATE,
    "coveredToDate" DATE,
    "caveats" TEXT[],
    "source" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PositionCoverage_financialAccountId_idx" ON "PositionCoverage"("financialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "PositionCoverage_financialAccountId_instrumentId_key" ON "PositionCoverage"("financialAccountId", "instrumentId");

-- AddForeignKey
ALTER TABLE "PositionCoverage" ADD CONSTRAINT "PositionCoverage_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionCoverage" ADD CONSTRAINT "PositionCoverage_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
