-- MC1 Phase 0 — Currency Provenance. Additive only; no backfill in-migration.
-- See docs/initiatives/mc1/MC1_PHASE0_CURRENCY_PROVENANCE_PLAN.md §3.
-- Transaction.currency / Holding.currency: nullable, no default — null means
-- "denomination never recorded" (D4 precedent), never "assumed USD".
-- SpaceSnapshot.reportingCurrency: NOT NULL DEFAULT 'USD' — a true statement
-- about how every historical snapshot's totals were computed and presented.

ALTER TABLE "Transaction"   ADD COLUMN "currency" TEXT;
ALTER TABLE "Holding"       ADD COLUMN "currency" TEXT;
ALTER TABLE "SpaceSnapshot" ADD COLUMN "reportingCurrency" TEXT NOT NULL DEFAULT 'USD';
