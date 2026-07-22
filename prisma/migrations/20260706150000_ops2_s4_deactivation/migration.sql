-- OPS-2 S4 — account deactivation / reactivation.
-- Additive only: one nullable column on "User".
--
-- No backfill: null = active for every existing user. A timestamp (not an
-- enum) per the S4 investigation — matches the emailVerifiedAt convention,
-- records WHEN for free, and composes with a future pending-deletion
-- timestamp (OPS-2 S7) without a premature state machine.
--
-- No index: only ever read via the unique user row (login / pre-login /
-- deactivate route) or as a relation filter on the bank-sync cron.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deactivatedAt" TIMESTAMP(3);
