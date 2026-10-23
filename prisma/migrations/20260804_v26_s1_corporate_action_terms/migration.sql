-- CreateTable
CREATE TABLE "CorporateActionTerms" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "ratio" DOUBLE PRECISION,
    "grade" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidenceRefs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorporateActionTerms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CorporateActionTerms_instrumentId_effectiveDate_idx" ON "CorporateActionTerms"("instrumentId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "CorporateActionTerms_instrumentId_effectiveDate_kind_source_key" ON "CorporateActionTerms"("instrumentId", "effectiveDate", "kind", "source");

-- AddForeignKey
ALTER TABLE "CorporateActionTerms" ADD CONSTRAINT "CorporateActionTerms_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
