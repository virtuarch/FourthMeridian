-- D2.x resume — durable "history import incomplete" marker on PlaidItem.
-- Set while an initial/resumed transaction history import is pending or has not
-- confirmed completion; cleared (NULL) by syncTransactionsForItem once a full
-- sync loop finishes. Additive + nullable — existing rows default to NULL,
-- which reads as "complete" (they have been syncing via the daily cron).
ALTER TABLE "PlaidItem" ADD COLUMN "syncIncompleteAt" TIMESTAMP(3);
