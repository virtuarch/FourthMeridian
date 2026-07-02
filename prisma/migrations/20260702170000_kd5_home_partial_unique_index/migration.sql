-- KD-5 — enforce "exactly one HOME SpaceAccountLink per FinancialAccount".
--
-- Prisma's schema language cannot express a partial (filtered) unique index,
-- so this migration is hand-written and added via the
-- `prisma migrate dev --create-only` workflow. It is purely additive: no
-- column, table, enum, or data change. HOME/SHARED assignment semantics in
-- lib/accounts/space-account-link.ts (computeLinkKind) are unchanged; this
-- index only makes the invariant a database truth so a concurrent HOME race
-- (two transactions both counting zero rows under Read Committed) can no
-- longer produce two HOME rows.
--
-- Predicate is status-agnostic (all HOME rows, ACTIVE or REVOKED) to match
-- computeLinkKind's status-agnostic count.
--
-- Pre-flight: this statement FAILS if any FinancialAccount already has more
-- than one HOME row. Run scripts/verify-space-account-link-backfill.ts
-- (CHECK 2) first; if non-zero, run scripts/dedupe-home-links.ts before
-- applying. See docs/investigations/KD5_HOME_UNIQUENESS_CONCURRENCY_INVESTIGATION.md.
--
-- Rollback: DROP INDEX "SpaceAccountLink_one_home_per_account";

CREATE UNIQUE INDEX "SpaceAccountLink_one_home_per_account"
    ON "SpaceAccountLink" ("financialAccountId")
    WHERE "kind" = 'HOME';
