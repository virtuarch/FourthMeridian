# 20261015120000_rls_asset_valuations — review notes (RWA-2A)

**Purpose.** Two additive tables for manual real-world assets: `ManualAssetProfile`
(1:1 acquisition facts: acquisition date, purchase price, opt-in to use the price as
the starting valuation) and `AssetValuation` (append-only ledger of the user's dated
valuations; modeled values are never stored). Authored by the RWA session, reviewed
and applied by the coordinator.

**Statements.** Two `CREATE TABLE`, their indexes and FKs (`FinancialAccount` ON DELETE
CASCADE; `User` ON DELETE SET NULL), one CHECK (`value >= 0 AND value < Infinity`),
grants and RLS (ENABLE + FORCE; `fm_app` policies on the account-subtree
visible-OR-owned predicate of `20261003000000`, written out per table; `fm_system` all;
`fm_backup` SELECT). `AssetValuation` is append-only BY GRANT: `fm_app` gets SELECT +
INSERT only.

**Additivity.** No existing table, row, column, policy or grant is touched. Nothing reads
the tables until the RWA-2A code ships; an older client is unaffected.

**Old-client compatibility.** Full — new tables only.

**Backfill.** None. A pre-RWA-2 asset's current balance is treated as its one anchor at
read time (`lib/assets/valuation-series.core.ts`) and is written into the ledger only
when the user next records a value (as what it was, dated at `lastUpdated`).

**Verification.** Clean-copy `npm run ci` on `444f296`: `prisma migrate deploy` applied it
to the throwaway `postgres:16`, `audit:ci` (incl. `audit-account-reparenting` with both
FKs registered) and all five RLS acceptance suites green.

**Rollback.**
```sql
DROP TABLE IF EXISTS "AssetValuation";
DROP TABLE IF EXISTS "ManualAssetProfile";
```
then regenerate the client from the previous schema. Nothing else references the tables
(the routes degrade to the pre-RWA-2 balance-only behaviour only with the previous code;
the RWA-2A code requires the tables).

**Apply.** Coordinator only, Dev then Preview, with `db:migrate:safe` after review.
Never Production during the beta implementation.
