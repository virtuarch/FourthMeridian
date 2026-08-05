-- L8 — EVENT IDENTITY. ADDITIVE ONLY.
--
-- A pending transaction and its posted successor become two OBSERVATIONS of one
-- logical economic event. Nothing existing is altered: `Transaction` gains one
-- nullable FK, and two new tables plus one enum appear beside it.
--
-- SCOPE. Banking only. Crypto/on-chain rows are deliberately excluded — a wallet
-- transaction has no pending↔posted lifecycle of this shape, and forcing it in
-- would model a state no provider attests. Crypto shares the abstraction later
-- through its own domain implementation.
--
-- CENSUS THIS FITS (whole corpus, tombstones included, 4,447 rows):
--   38    pending→posted chains, every pending row already tombstoned
--    7    withdrawn pending (tombstoned, no successor)
--   15    live pending, in flight
-- 4,326   first-observed-posted
--   23    posted rows whose pendingTransactionRef DANGLES (predecessor absent)
--    0    live pending + live posted for one event  ⇒ no double-count exists today
--    0    fan-in (one pending claimed by two posted rows)
--    0    amount / account / economicDate changes across a chain
--
-- NOTHING READS THIS YET. L8 establishes identity + dual-write; the reader
-- cutover is a separate slice, and a standing probe enforces the separation.
--
-- PRODUCTION NOTE: the CREATE INDEX statements take brief locks. Trivial here;
-- on a large table issue them CONCURRENTLY as a separate operational step.

-- CreateEnum
CREATE TYPE "TransactionEventLifecycle" AS ENUM ('PENDING', 'POSTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "transactionEventId" TEXT;

-- CreateTable
CREATE TABLE "TransactionEvent" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "lifecycle" "TransactionEventLifecycle" NOT NULL,
    "economicDate" DATE NOT NULL,
    "currentAmount" DOUBLE PRECISION NOT NULL,
    "currentTransactionId" TEXT,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "firstPendingObservedAt" TIMESTAMP(3),
    "postedObservedAt" TIMESTAMP(3),
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionObservation" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "transactionId" TEXT,
    "financialAccountId" TEXT NOT NULL,
    "provider" "ProviderType" NOT NULL,
    "providerRowId" TEXT,
    "providerPendingRef" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifecycle" "SettlementState" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "postingDate" DATE NOT NULL,
    "economicDate" DATE NOT NULL,
    "authorizedAt" DATE,
    "observationKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TransactionEvent_currentTransactionId_key" ON "TransactionEvent"("currentTransactionId");

-- CreateIndex
CREATE INDEX "TransactionEvent_financialAccountId_economicDate_idx" ON "TransactionEvent"("financialAccountId", "economicDate");

-- CreateIndex
CREATE INDEX "TransactionEvent_lifecycle_idx" ON "TransactionEvent"("lifecycle");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionObservation_observationKey_key" ON "TransactionObservation"("observationKey");

-- CreateIndex
CREATE INDEX "TransactionObservation_eventId_idx" ON "TransactionObservation"("eventId");

-- CreateIndex
CREATE INDEX "TransactionObservation_transactionId_idx" ON "TransactionObservation"("transactionId");

-- CreateIndex
CREATE INDEX "TransactionObservation_providerRowId_idx" ON "TransactionObservation"("providerRowId");

-- CreateIndex
CREATE INDEX "TransactionObservation_financialAccountId_economicDate_idx" ON "TransactionObservation"("financialAccountId", "economicDate");

-- CreateIndex
CREATE INDEX "Transaction_transactionEventId_idx" ON "Transaction"("transactionEventId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_transactionEventId_fkey" FOREIGN KEY ("transactionEventId") REFERENCES "TransactionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionEvent" ADD CONSTRAINT "TransactionEvent_financialAccountId_fkey" FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionObservation" ADD CONSTRAINT "TransactionObservation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "TransactionEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


