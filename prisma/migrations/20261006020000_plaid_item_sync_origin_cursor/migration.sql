-- PlaidItem.syncOriginCursor — where the last COMPLETED /transactions/sync
-- pagination loop ended. Plaid's TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION
-- requires restarting the loop from that cursor; the per-page `cursor` is a
-- mid-loop value that keeps failing (Preview Sandbox, 2026-10-06).
--
-- Additive and nullable, no backfill: null on an Item that has completed a loop
-- falls back to its current cursor (lib/plaid/syncTransactions.ts) and the
-- column is written at the next completed loop. Table-level grants cover it.
ALTER TABLE "PlaidItem" ADD COLUMN "syncOriginCursor" TEXT;
