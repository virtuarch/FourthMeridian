# 20261015100000_plaid_item_environment — review notes (BETA C1, W2a)

**Purpose.** Record the Plaid environment (`sandbox` | `development` | `production`)
that minted each `PlaidItem`, so the Platform Ops cost census can exclude sandbox
Items (which Plaid never bills) instead of pricing Preview's sandbox population as
production. The existing `PlaidItem.environment` column is the *Vercel* deployment
and cannot answer this: one deployment can point at any Plaid environment.

**Statement.** `ALTER TABLE "PlaidItem" ADD COLUMN "plaidEnvironment" TEXT;`

**Additivity.** One nullable column, no default, no index, no constraint, no data
change. The table is not rewritten (PostgreSQL adds a nullable column without a
default as a catalog-only change) and no lock beyond the brief `ACCESS EXCLUSIVE`
of the DDL itself is taken.

**Old-client compatibility.** A Prisma client generated before this migration
neither selects nor writes the column; reads and writes continue unchanged. A
client generated after it treats the column as `String?` and writes it only on
`PlaidItem` create in `lib/plaid/exchangeToken.ts`.

**Backfill.** NONE, deliberately. Nothing on a legacy row records which Plaid
environment minted it (not the row, not the CH-2 transition ledger, not the
audit row). Inferring it from a cutover date or from today's `PLAID_ENV` would
assign every historical Item to whichever environment ran the query and could
zero real production charges. Legacy rows stay `NULL` = unknown, and the cost
model prices unknown as billable (a floor), never as free.

**RLS / grants.** `PlaidItem` policies are row predicates on `"userId"` and name
no columns; `fm_app` / `fm_system` hold table-level grants, so the new column is
readable and writable by the roles that already reach the table. No policy,
grant or `scripts/audit-db-authority.ts` / `scripts/rls-*-acceptance.ts` change
is needed for a column add (the acceptance scripts select by model, not by a
column list).

**Rollback.** `ALTER TABLE "PlaidItem" DROP COLUMN "plaidEnvironment";` — then
regenerate the client from the previous schema. Nothing else depends on the
column: the cost census treats a missing value as unknown.

**Apply.** Coordinator only, Dev then Preview, with `db:migrate:safe` after review.
Never Production during the beta implementation.
