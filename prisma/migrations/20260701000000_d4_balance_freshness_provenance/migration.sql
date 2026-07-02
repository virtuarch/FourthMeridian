-- D4 Balance Freshness Provenance
-- Additive only. Adds balanceLastUpdatedAt to FinancialAccount.
-- Distinct from lastUpdated (when FM synced with Plaid); this records
-- when Plaid last fetched the balance from the institution, as reported
-- by AccountBalance.last_updated_datetime. Null for institutions that do
-- not supply this field (currently all except Capital One / ins_128026).

-- AlterTable
ALTER TABLE "FinancialAccount" ADD COLUMN "balanceLastUpdatedAt" TIMESTAMP(3);
