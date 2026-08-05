-- L8-B1 — the event's current projection becomes a real relation.
--
-- `currentTransactionId` already existed and was already @unique; this adds only
-- the foreign key, so the read boundary can express "this row IS its event's
-- current projection" as a query instead of relying on superseded rows happening
-- to be tombstoned.
--
-- Measured before applying: 4,372 events have exactly one live row, 7 have none
-- (withdrawn pendings), 0 have two. 0 live rows are superseded. Every non-null
-- currentTransactionId points at an existing Transaction, so the constraint
-- validates without a single row changing.
--
-- Reversible: DROP CONSTRAINT "TransactionEvent_currentTransactionId_fkey".
ALTER TABLE "TransactionEvent"
  ADD CONSTRAINT "TransactionEvent_currentTransactionId_fkey"
  FOREIGN KEY ("currentTransactionId") REFERENCES "Transaction"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
