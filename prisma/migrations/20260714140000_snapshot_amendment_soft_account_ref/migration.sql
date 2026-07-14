-- Wealth-timeline amendment system — make SnapshotAmendment.financialAccountId a
-- SOFT reference (drop the FK). An onDelete: Cascade FK destroyed the amendment
-- and its whole stored per-day breakdown (via SnapshotAmendmentDay's cascade) the
-- moment the account was hard-deleted — contradicting the table's purpose (a
-- stored delta must survive the account's deletion; ACCOUNT_HARD_DELETED is a
-- first-class kind). The account is now referenced by id only, mirroring
-- MerchantMergeDecision's soft refs. spaceId/requestedByUserId keep their FKs.
-- Non-destructive: only a constraint is dropped; the column + its index remain.

-- DropForeignKey
ALTER TABLE "SnapshotAmendment" DROP CONSTRAINT "SnapshotAmendment_financialAccountId_fkey";
