-- V26-PRE (B4) — active-row identity backstop for provider/import external
-- transaction ids.
--
-- WHY: lib/crypto/btc-sync.ts imports on-chain movements with find-then-
-- createMany and NO lock; the manual sync route and the daily cron can run
-- concurrently against the same wallet, and before this index nothing stopped
-- both writers from creating the same movement twice (duplicated financial
-- rows with no repair job). The CSV/Excel import path already treats
-- (financialAccountId, externalTransactionId) as identity for ACTIVE rows
-- (lib/imports/csv.ts resolveImportMatch — matchedVia: "externalId", scoped
-- deletedAt: null); this index makes the database enforce what the code
-- already assumes.
--
-- SHAPE — PARTIAL unique, active rows only (deletedAt IS NULL):
--   * Enforces the Transaction Identity Doctrine invariant exactly: no two
--     ACTIVE rows may claim the same (account, externalId).
--   * Tombstoned rows are excluded, so an import-batch ROLLBACK (which
--     soft-deletes its rows) followed by a re-import of the same file still
--     creates fresh active rows — the D2 Step 4D-R lifecycle is untouched.
--     Tombstone-wins for BTC re-sync is enforced in code (the dedupe read in
--     btc-sync.ts includes deleted rows), not by this index.
--   * NULL externalTransactionId rows (all Plaid rows, manual rows) are
--     unaffected.
--
-- PRE-CHECK: run `npx tsx scripts/check-external-id-duplicates.ts` against the
-- target database BEFORE deploying. It lists any existing active-row
-- duplicates; this CREATE will fail (cleanly, transactionally) if any exist.
--
-- CAUTION (prisma migrate dev): partial indexes are not representable in
-- schema.prisma (Prisma 5), so a future `migrate dev` diff may propose
-- DROPPING this index as "drift". Do not accept that drop — see the schema
-- comment on Transaction.externalTransactionId.

CREATE UNIQUE INDEX "Transaction_account_externalId_active_key"
ON "Transaction" ("financialAccountId", "externalTransactionId")
WHERE "externalTransactionId" IS NOT NULL AND "deletedAt" IS NULL;
