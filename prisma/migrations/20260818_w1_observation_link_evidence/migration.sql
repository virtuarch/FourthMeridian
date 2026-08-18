-- W1 (D6) — TransactionObservation evidence ledger: persist the event-link
-- basis and refusal the identity authority already computes (and previously
-- dropped). Additive and backfill-safe: both columns are nullable, existing
-- rows keep NULL ("written before the ledger existed"), no data rewrite, no
-- default. Rides the pending production deploy train with the other L8
-- migrations; nothing here requires ordering beyond "after the L8 tables".
ALTER TABLE "TransactionObservation" ADD COLUMN "linkBasis" TEXT;
ALTER TABLE "TransactionObservation" ADD COLUMN "linkRefusal" TEXT;
