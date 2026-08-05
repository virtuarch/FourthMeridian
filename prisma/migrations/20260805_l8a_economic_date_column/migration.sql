-- L8-A — the persisted economic chronology. ADDITIVE ONLY.
--
-- Adds `Transaction.economicDate` (nullable) plus the two indexes the read
-- cutover will consume. Nothing reads the column in this migration: L8-A is
-- dual-write only, and the reader cutover is a separate atomic slice.
--
-- WHY A COLUMN. `economicDate` has been derived at read time since v2.6-L4B. The
-- cutover needs to ORDER BY, filter and keyset-paginate on it, and the
-- expression
--     CASE WHEN "authorizedAt" IS NOT NULL AND "authorizedAt" <= date
--           AND (date - "authorizedAt") <= 14 THEN "authorizedAt" ELSE date END
-- is not expressible in Prisma (no previewFeatures ⇒ no fieldRef ⇒ no
-- column-to-column comparison in `where`; `orderBy` takes a field name, never an
-- expression). Measured on the live corpus, ordering by the raw CASE turns an
-- Incremental Sort with Presorted Key: date (35 buffers, cost 13) into a full
-- top-N heapsort over every row (232 buffers, cost 470).
--
-- NULLABLE, deliberately: null means "not yet backfilled", never "same as
-- posting". A NOT NULL column defaulted to `date` would make an unbackfilled row
-- indistinguishable from a genuinely same-day one, and the backfill could never
-- prove it had finished.
--
-- `date` is UNTOUCHED and remains the POSTING date — the historical engine's
-- input, whose immutability is load-bearing.
--
-- ⚠️ PRODUCTION NOTE: both CREATE INDEX statements take a brief ACCESS SHARE-
-- blocking lock. Trivial at this corpus size. On a large table these should be
-- issued as CREATE INDEX CONCURRENTLY outside a transaction — which Prisma's
-- migration runner cannot do, so a production rollout should apply the ALTER
-- here and create the indexes concurrently as a separate operational step.

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "economicDate" DATE;

-- CreateIndex
CREATE INDEX "Transaction_financialAccountId_economicDate_idx" ON "Transaction"("financialAccountId", "economicDate");

-- CreateIndex
CREATE INDEX "Transaction_economicDate_idx" ON "Transaction"("economicDate");
