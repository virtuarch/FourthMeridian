-- MC1 Phase 1 — FxRate immutable dated FX rate archive. Additive only:
-- one new standalone table, no changes to existing tables. Append-only
-- doctrine is application-enforced (insert-only writes, closed dates only);
-- the unique index is the determinism anchor: one canonical rate per
-- (date, base, quote). See docs/initiatives/mc1/MC1_PHASE1_FX_PROVIDER_LAYER_PLAN.md §3.2.

-- CreateTable
CREATE TABLE "FxRate" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "base" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FxRate_date_base_quote_key" ON "FxRate"("date", "base", "quote");

-- CreateIndex
CREATE INDEX "FxRate_quote_date_idx" ON "FxRate"("quote", "date");
