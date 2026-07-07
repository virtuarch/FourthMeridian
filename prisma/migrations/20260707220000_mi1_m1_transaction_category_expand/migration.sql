-- MI1 M1 — TransactionCategory expansion (own migration file; the one
-- irreversible statement in M1). Six committed spend categories that rescue PFC
-- spend primaries currently collapsing to `Other`; each has a committed producer
-- in MI M2's resolution stack. Isolated in its own migration so that later
-- migrations may reference the new values (Postgres forbids using an enum value
-- added in the same transaction). Additive only — no rows are written here.
-- See docs/initiatives/mi1/MI1_M0_RATIFICATION_2026-07-07.md and the readiness
-- investigation §4.

-- AlterEnum
ALTER TYPE "TransactionCategory" ADD VALUE 'Medical';
ALTER TYPE "TransactionCategory" ADD VALUE 'Entertainment';
ALTER TYPE "TransactionCategory" ADD VALUE 'Transport';
ALTER TYPE "TransactionCategory" ADD VALUE 'PersonalCare';
ALTER TYPE "TransactionCategory" ADD VALUE 'Services';
ALTER TYPE "TransactionCategory" ADD VALUE 'Education';
