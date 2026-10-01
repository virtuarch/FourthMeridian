-- CRYPTO-FRESHNESS-1 — per-facet success clocks on Connection.
--
-- `lastSyncedAt` means "a provider sync succeeded", and for a WALLET that is
-- specifically "the BALANCE was read". The Connections card was reading it for
-- three different claims, so a BTC refresh whose transaction import had ABORTED
-- still rendered "Transactions: Updated today" (incident 2026-10-01).
--
-- Both columns are written ONLY on the success of the facet they name. NULL
-- means "never successfully established" — never "unknown", and never "fall
-- back to the balance clock".
--
-- Additive and nullable, so every existing row reads NULL and no backfill is
-- performed: inventing a success date for a facet whose history we do not have
-- is the exact dishonesty this migration removes.
ALTER TABLE "Connection" ADD COLUMN "transactionsSyncedAt" TIMESTAMP(3);
ALTER TABLE "Connection" ADD COLUMN "historyRebuiltAt" TIMESTAMP(3);
