> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4B — ImportBatch Foundation: Implementation + Validation

Status: **implemented exactly as scoped in `D2_STEP4B_IMPORTBATCH_FOUNDATION_INVESTIGATION.md`. No deviations. No 4C work. No 4D work. No application code.**

## 1. What was implemented

`prisma/schema.prisma` only — additive, schema-only, matching the investigation report's proposal verbatim (including the `createdByUserId` nullability correction flagged in that report's §2):

- `enum ImportSource { CSV  EXCEL  QUICKBOOKS }`
- `enum ImportBatchStatus { PENDING  PROCESSING  COMPLETED  COMPLETED_WITH_ERRORS  ROLLED_BACK  FAILED }`
- `model ImportBatch` — `financialAccountId` (required FK, `onDelete: Cascade`), `createdByUserId` (nullable FK, `onDelete: SetNull`), `connectionId` (nullable FK, `onDelete: SetNull`), `source`, `originalFilename`, `status` (default `PENDING`), `rowCount`/`importedCount`/`skippedCount` (default `0`), `errorSummary`, `createdAt`/`updatedAt`/`completedAt`, `transactions` back-relation. Indexes on `financialAccountId`, `createdByUserId`, `connectionId`, `status`.
- `Transaction` — added `importBatchId` (nullable FK, `onDelete: SetNull`) + `importBatch` relation, `externalTransactionId` (nullable, no constraint), `deletedAt` (nullable), `@@index([importBatchId])`.
- Three required Prisma back-relation fields: `FinancialAccount.importBatches`, `User.importBatches`, `Connection.importBatches`.

Nothing else changed. No reads, no writes, no application code references any of the above anywhere in the codebase.

## 2. Exact diff

```
 prisma/schema.prisma | 86 ++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 86 insertions(+)
```

Full diff matches the schema proposal in `D2_STEP4B_IMPORTBATCH_FOUNDATION_INVESTIGATION.md` §3 exactly — same fields, same types, same `onDelete` actions, same indexes, same corrected nullable `createdByUserId`. Zero deletions; purely additive.

## 3. Validation results

| Check | Result |
|---|---|
| `npx prisma generate` | **Could not run.** Sandbox returns `403 Forbidden` fetching the `linux-arm64-openssl-3.0.x` engine binary from `binaries.prisma.sh` — same blocker as every prior schema-touching D2/D1/D3 step in this project (no network egress to that host; only `darwin-arm64` engines are cached on disk, carried over from your Mac's `node_modules`, and won't run in this Linux sandbox). Confirmed with `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1` as well — same result. |
| `npx prisma migrate dev --name d2_4b_importbatch_foundation` | **Could not run** — same root cause; needs the same engine binary. **No migration has been applied to any database.** |
| `npx tsc --noEmit` | **Clean — exit code 0, zero errors.** This is the cleanest possible outcome for this step specifically: because zero application code references `ImportBatch`/`ImportSource`/`ImportBatchStatus`/`importBatchId`/`externalTransactionId`/`Transaction.deletedAt` anywhere, there is nothing for the stale (un-regenerated) Prisma Client to break. (Contrast with D1's implementation, where application code *did* reference the new types and `tsc` correctly flagged the stale client — that scenario doesn't apply here because this step is schema-only by design.) |
| `npm run lint` | **Clean — 0 errors, 4 warnings**, all 4 pre-existing `@next/next/no-img-element` warnings in `AccountModal.tsx`, `TotpSection.tsx`, `CoinIcon.tsx` — none in `prisma/schema.prisma` (not a lintable file) and none newly introduced. |
| `git diff --stat` | `prisma/schema.prisma \| 86 +++...` — **one file, 86 insertions, 0 deletions.** Confirms schema-only, purely additive, no other file touched. |
| `git status --short` | Confirms no other tracked file modified by this change (the pre-existing `M docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` line predates this turn). |
| DB reachability | `DATABASE_URL` points at `localhost:5432` — confirmed unreachable from this sandbox (`Connection refused`). Consistent with every prior DB-dependent step in this project; the live database is on your local machine, not reachable here. |

## 4. What to run locally

The schema change is in place but **not yet migrated against any database.** Run, in order, on your machine (where the `darwin-arm64` engine works):

```
npx prisma generate
npx prisma migrate dev --name d2_4b_importbatch_foundation
npx tsc --noEmit
npm run lint
```

Expected migration output (already previewed and cross-checked in the investigation report against the three most recent D2 migrations' style):

```sql
-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('CSV', 'EXCEL', 'QUICKBOOKS');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'ROLLED_BACK', 'FAILED');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "importBatchId" TEXT,
                          ADD COLUMN "externalTransactionId" TEXT,
                          ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ImportBatch" ( ... see investigation report §5 for full DDL ... );

-- CreateIndex / AddForeignKey statements per investigation report §5.
```

No backfill `UPDATE` statements are needed or expected — every new column/table starts empty/`NULL`, and no existing row's behavior changes.

After migrating, a quick sanity check: `SELECT * FROM "ImportBatch";` should return 0 rows; an existing `Transaction` row's `importBatchId`/`externalTransactionId`/`deletedAt` should all be `NULL`.

## 5. Rollback plan (unchanged from investigation report, restated)

Zero data-loss risk — nothing reads or writes any of this slice's additions (that's 4D). If a rollback is ever needed:

```sql
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_importBatchId_fkey";
ALTER TABLE "Transaction" DROP COLUMN "importBatchId", DROP COLUMN "externalTransactionId", DROP COLUMN "deletedAt";
DROP TABLE "ImportBatch";
DROP TYPE "ImportBatchStatus";
DROP TYPE "ImportSource";
```

No code rollback needed — no application code shipped in this slice.

## 6. Scope discipline confirmed

- No 4C work (fingerprint helper untouched — `lib/accounts/reconcile.ts` and `lib/plaid/syncTransactions.ts` not modified).
- No 4D work (no upload route, no parser, no UI).
- No application code touched anywhere (`app/`, `lib/`, `components/` — zero changes).
- No legacy table/column removed.
- No unrelated UI touched.
- `D2_ROADMAP.md` updated: Step 4 header and the 4B row now read "✅ Schema implemented / ⏳ Migration pending local run," pointing at this report and the investigation report. 4C and 4D rows unchanged (`⏳ Not started`).

---

**Stopping here per scope. 4C and 4D remain not started and not approved.**
