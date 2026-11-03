# 20261103150000_fin_a2_balance_observed — review notes (FIN-A2 / FM-AUDIT-023 new-row half)

**Statements.**

1. `ALTER TABLE "FinancialAccount" ADD COLUMN "balanceObserved" BOOLEAN NOT NULL DEFAULT true`.
   Catalog-only (constant default), no backfill. Existing rows keep their meaning.
2. `ALTER TYPE "SyncIssueKind" ADD VALUE IF NOT EXISTS 'BALANCE_UNOBSERVED'`.

**Grants.** FinancialAccount has only table-level grants (`20261002000100`). No column-level
grant exists, so nothing changes.

**Rollback.** Postgres cannot drop an enum value, so the rollback is a forward revert migration
that drops only the column (`ALTER TABLE "FinancialAccount" DROP COLUMN "balanceObserved"`).
`BALANCE_UNOBSERVED` stays in the `SyncIssueKind` type, where it is harmless and unused. Never
use `prisma migrate resolve --rolled-back` on an applied migration.
