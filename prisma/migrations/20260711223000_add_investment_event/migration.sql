-- Investment Event Foundation (Slice A3-1).
--
-- Purely additive and dark-write: one new enum, one new table, its indexes and
-- FKs, and three back-relations (relation lists only — no column changes on the
-- referenced tables). Nothing reads or writes InvestmentEvent unless
-- INVESTMENT_EVENTS_ENABLED is true. New enum TYPE (not ALTER TYPE ADD VALUE)
-- so the slice is reversible. Raw provider strings live on-row beside the
-- canonical fields (the Transaction.pfc* pattern). See
-- FOURTH_MERIDIAN_A3_INVESTMENT_EVENT_FOUNDATION_INVESTIGATION_2026-07-11.md §4/§9.

-- CreateEnum
CREATE TYPE "InvestmentEventType" AS ENUM ('BUY', 'SELL', 'CONTRIBUTION', 'WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT', 'DIVIDEND', 'INTEREST', 'CAPITAL_GAIN', 'REINVESTMENT', 'FEE', 'TAX', 'SPLIT', 'MERGER', 'SPIN_OFF', 'SYMBOL_CHANGE', 'OPENING_BALANCE', 'CANCEL', 'ADJUSTMENT', 'OTHER', 'UNKNOWN');

-- CreateTable
CREATE TABLE "InvestmentEvent" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "instrumentId" TEXT,
    "type" "InvestmentEventType" NOT NULL,
    "date" DATE NOT NULL,
    "datetime" TIMESTAMP(3),
    "quantity" DOUBLE PRECISION,
    "price" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,
    "fees" DOUBLE PRECISION,
    "currency" TEXT,
    "source" TEXT NOT NULL,
    "externalEventId" TEXT,
    "providerType" TEXT,
    "providerSubtype" TEXT,
    "providerSecurityId" TEXT,
    "description" TEXT,
    "mapperVersion" INTEGER,
    "relatedInstrumentId" TEXT,
    "ratio" DOUBLE PRECISION,
    "importBatchId" TEXT,
    "createdByUserId" TEXT,
    "supersededById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentEvent_source_externalEventId_key" ON "InvestmentEvent"("source", "externalEventId");

-- CreateIndex
CREATE INDEX "InvestmentEvent_financialAccountId_date_idx" ON "InvestmentEvent"("financialAccountId", "date");

-- CreateIndex
CREATE INDEX "InvestmentEvent_financialAccountId_instrumentId_date_idx" ON "InvestmentEvent"("financialAccountId", "instrumentId", "date");

-- CreateIndex
CREATE INDEX "InvestmentEvent_instrumentId_date_idx" ON "InvestmentEvent"("instrumentId", "date");

-- CreateIndex
CREATE INDEX "InvestmentEvent_importBatchId_idx" ON "InvestmentEvent"("importBatchId");

-- AddForeignKey
ALTER TABLE "InvestmentEvent" ADD CONSTRAINT "InvestmentEvent_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentEvent" ADD CONSTRAINT "InvestmentEvent_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentEvent" ADD CONSTRAINT "InvestmentEvent_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
