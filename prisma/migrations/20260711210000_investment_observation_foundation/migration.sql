-- Investment Observation Foundation (Slice A1).
--
-- Purely additive and dark-write: two enums, three tables, one new SyncIssueKind
-- value, and their indexes. Nothing reads or writes any of this unless
-- INVESTMENT_OBSERVATIONS_ENABLED is true; `Holding` and every existing read
-- path are untouched. Instruments are deployment-global public identity facts
-- (like Merchant); visibility gating stays on positions via financialAccountId.
-- FIGI intentionally absent — plaid@42.2.0 Security does not expose it. See
-- FOURTH_MERIDIAN_INVESTMENT_HISTORY_PROGRESSIVE_EVIDENCE_IMPLEMENTATION_PLAN_2026-07-11.md.

-- AlterEnum
ALTER TYPE "SyncIssueKind" ADD VALUE 'INSTRUMENT_IDENTITY_CONFLICT';

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('EQUITY', 'ETF', 'MUTUAL_FUND', 'FIXED_INCOME', 'OPTION', 'CRYPTO', 'CASH', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PositionOrigin" AS ENUM ('OBSERVED', 'IMPORTED', 'DERIVED', 'USER_ASSERTED');

-- CreateTable
CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL,
    "cusip" TEXT,
    "isin" TEXT,
    "sedol" TEXT,
    "tickerSymbol" TEXT,
    "name" TEXT,
    "assetClass" "AssetClass" NOT NULL DEFAULT 'UNKNOWN',
    "securityType" TEXT,
    "securitySubtype" TEXT,
    "marketIdentifierCode" TEXT,
    "currency" TEXT,
    "sector" TEXT,
    "industry" TEXT,
    "cfiCode" TEXT,
    "isCashEquivalent" BOOLEAN,
    "isHoldable" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "optionMeta" JSONB,
    "fixedIncomeMeta" JSONB,
    "underlyingInstrumentId" TEXT,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstrumentAlias" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstrumentAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionObservation" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "origin" "PositionOrigin" NOT NULL,
    "source" TEXT NOT NULL,
    "institutionPrice" DOUBLE PRECISION,
    "institutionValue" DOUBLE PRECISION,
    "institutionPriceAsOf" DATE,
    "costBasis" DOUBLE PRECISION,
    "vestedQuantity" DOUBLE PRECISION,
    "currency" TEXT,
    "isCash" BOOLEAN NOT NULL DEFAULT false,
    "reconstructionVersion" INTEGER,
    "completeness" TEXT,
    "unexplainedQuantity" DOUBLE PRECISION,
    "evidenceRefs" JSONB,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_cusip_key" ON "Instrument"("cusip");

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_isin_key" ON "Instrument"("isin");

-- CreateIndex
CREATE INDEX "Instrument_tickerSymbol_idx" ON "Instrument"("tickerSymbol");

-- CreateIndex
CREATE INDEX "Instrument_assetClass_idx" ON "Instrument"("assetClass");

-- CreateIndex
CREATE UNIQUE INDEX "InstrumentAlias_provider_externalId_key" ON "InstrumentAlias"("provider", "externalId");

-- CreateIndex
CREATE INDEX "InstrumentAlias_instrumentId_idx" ON "InstrumentAlias"("instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "PositionObservation_financialAccountId_instrumentId_date_ori_key" ON "PositionObservation"("financialAccountId", "instrumentId", "date", "origin", "source");

-- CreateIndex
CREATE INDEX "PositionObservation_financialAccountId_instrumentId_date_idx" ON "PositionObservation"("financialAccountId", "instrumentId", "date");

-- CreateIndex
CREATE INDEX "PositionObservation_financialAccountId_date_idx" ON "PositionObservation"("financialAccountId", "date");

-- AddForeignKey
ALTER TABLE "InstrumentAlias" ADD CONSTRAINT "InstrumentAlias_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionObservation" ADD CONSTRAINT "PositionObservation_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionObservation" ADD CONSTRAINT "PositionObservation_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
