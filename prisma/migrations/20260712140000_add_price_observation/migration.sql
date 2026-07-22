-- Historical Price Foundation (Slice A8-1).
--
-- Purely additive: one new enum, one new table, its indexes and FK, and one
-- back-relation on Instrument (relation list only — no column change on the
-- referenced table). Nothing reads or writes PriceObservation yet (A8-2 capture,
-- behind SECURITY_PRICES_ENABLED, is the first writer). New enum TYPE (not
-- ALTER TYPE ADD VALUE) so the slice is reversible by dropping the table + type.
--
-- Prices are keyed by Instrument identity, never a ticker. `source` is
-- provenance, not identity — ONE canonical row per (instrument, date, basis).
-- Closed-date, immutable evidence (no updates/deletes at the application layer;
-- lib/prices/archive.ts is insert-only). `currency` is the quote currency; no
-- converted/valuation fields (A8-4 derives valuation at read time). FK RESTRICT
-- mirrors PositionObservation → Instrument: price facts block casual instrument
-- deletion and are never cascade-removed. See
-- FOURTH_MERIDIAN_A6_A7_A8_P5_PARALLELIZATION_INVESTIGATION_2026-07-12 §3 and
-- FOURTH_MERIDIAN_INVESTMENT_HISTORY_PROGRESSIVE_EVIDENCE_IMPLEMENTATION_PLAN §9.

-- CreateEnum
CREATE TYPE "PriceBasis" AS ENUM ('RAW_CLOSE', 'ADJUSTED_CLOSE', 'NAV', 'INTRADAY', 'CRYPTO_DAILY');

-- CreateTable
CREATE TABLE "PriceObservation" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "basis" "PriceBasis" NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceObservation_instrumentId_basis_date_idx" ON "PriceObservation"("instrumentId", "basis", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PriceObservation_instrumentId_date_basis_key" ON "PriceObservation"("instrumentId", "date", "basis");

-- AddForeignKey
ALTER TABLE "PriceObservation" ADD CONSTRAINT "PriceObservation_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
