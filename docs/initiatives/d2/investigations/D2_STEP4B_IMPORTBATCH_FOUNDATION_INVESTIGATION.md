> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4B — ImportBatch Foundation Investigation

Status: **read-only investigation complete. No code changes. No schema changes. No migrations.**

Context: D2 Step 3 is complete. Step 4 is formally split into 4A (✅ done) / 4B / 4C / 4D per `docs/initiatives/d2/D2_ROADMAP.md`. 4C and 4D are not approved. This report investigates the smallest safe schema-only slice for 4B — `ImportBatch` plus the three `Transaction` provenance columns.

## 1. Current schema, re-confirmed directly

**`Transaction`** (`prisma/schema.prisma:1089`) — `id`, `accountId`/`account` (legacy, optional), `financialAccountId`/`financialAccount` (canonical, optional, **named relation `"FinancialAccountTransactions"`**), `date`, `merchant`, `description`, `category`, `amount`, `pending`, `plaidTransactionId` (`String? @unique`), `createdAt`/`updatedAt`. Indexes: `accountId`, `[accountId, date]`, `financialAccountId`, `[financialAccountId, date]`, `date`. No `importBatchId`, `externalTransactionId`, or `deletedAt` exist today — confirmed by direct read, not inference.

**`FinancialAccount`** (`:624`) — relations list ends `transactions Transaction[] @relation("FinancialAccountTransactions")`, `holdings Holding[]`, `providerIdentities ProviderAccountIdentity[]`. No `importBatches` relation exists (expected — model doesn't exist yet).

**`Connection`** (`:514`) — `accountConnections AccountConnection[]`, `providerAccountIdentities ProviderAccountIdentity[]`. Both unnamed (single relation each between `Connection` and that model). No `importBatches` relation exists.

**`User`** (`:280`) — relevant existing relations: `connections Connection[]` (unnamed, Step 1A, comment: "additive only, not yet populated"), `financialAccounts FinancialAccount[] @relation("UserOwnedFinancialAccounts")`, `createdFinancialAccounts FinancialAccount[] @relation("FinancialAccountCreator")` (D11). No `importBatches` relation exists.

**D11 precedent, directly relevant to a correction below** — `FinancialAccount.createdByUserId` is `String?` (nullable) with `createdByUser User? @relation(..., onDelete: SetNull)`. Confirmed via the migration that shipped it (`prisma/migrations/20260622150000_d11_holding_financial_account_fk_and_created_by/migration.sql`): `ALTER TABLE "FinancialAccount" ADD COLUMN "createdByUserId" TEXT;` (nullable) + `ON DELETE SET NULL`.

## 2. Correction to the 4A/roadmap draft

4A's draft `ImportBatch` model declared:

```
createdByUserId    String                      // required
createdByUser      User  @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)
```

This is invalid as written: Prisma rejects `onDelete: SetNull` on a relation whose scalar FK field is required (`prisma generate`/`validate` errors — a required column can't be set to null). This wasn't caught in 4A because 4A never ran `prisma generate` against the draft (correctly, per its "investigation only" scope).

The fix, and the one that matches established precedent exactly: make `createdByUserId` **nullable** (`String?` / `User?`), mirroring `FinancialAccount.createdByUserId`'s own D11 pattern above. Same tradeoff D11 already accepted (an `ImportBatch` whose creator-user was later deleted just has a null creator, same as a `FinancialAccount` does today) — no new precedent being set, just following the existing one correctly. Flagging this now so 4B's actual implementation checklist doesn't inherit the bug.

## 3. Exact schema proposal

All additive. No existing column, index, or relation altered.

```prisma
enum ImportSource {
  CSV
  EXCEL
  QUICKBOOKS
}

enum ImportBatchStatus {
  PENDING
  PROCESSING
  COMPLETED
  COMPLETED_WITH_ERRORS
  ROLLED_BACK
  FAILED
}

model ImportBatch {
  id                 String            @id @default(cuid())

  financialAccountId String                                   // required — user always picks the target account first (4A §5)
  financialAccount   FinancialAccount  @relation(fields: [financialAccountId], references: [id], onDelete: Cascade)

  // Corrected from 4A's draft — nullable, mirrors FinancialAccount.createdByUserId (D11).
  createdByUserId    String?
  createdByUser      User?             @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)

  // Mirrors AccountConnection.connectionId / ProviderAccountIdentity.connectionId's
  // already-established additive seam — nullable, unpopulated until D2's later
  // Adapter/ProviderCatalog work exists.
  connectionId       String?
  connection         Connection?       @relation(fields: [connectionId], references: [id], onDelete: SetNull)

  source             ImportSource
  originalFilename   String?
  status             ImportBatchStatus @default(PENDING)
  rowCount           Int               @default(0)
  importedCount      Int               @default(0)
  skippedCount       Int               @default(0)
  errorSummary       Json?

  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt
  completedAt        DateTime?

  transactions       Transaction[]

  @@index([financialAccountId])
  @@index([createdByUserId])
  @@index([connectionId])   // added — not explicitly in the roadmap list, but every other connectionId seam (AccountConnection, ProviderAccountIdentity) is indexed immediately even while unpopulated; matching that precedent.
  @@index([status])
}
```

`Transaction` additions:

```prisma
model Transaction {
  // ...existing fields unchanged...

  importBatchId       String?
  importBatch         ImportBatch?  @relation(fields: [importBatchId], references: [id], onDelete: SetNull)

  externalTransactionId String?     // generic sibling of plaidTransactionId; no unique constraint yet — real shape deferred to 4D (4A §4)

  deletedAt            DateTime?    // net-new; nullable; nothing sets it until 4D's rollback path exists

  // ...existing indexes...
  @@index([importBatchId])
}
```

Back-relation list fields required by Prisma (every FK relation must be declared on both sides):

- `FinancialAccount`: add `importBatches ImportBatch[]` near the existing `transactions`/`holdings`/`providerIdentities` lines.
- `User`: add `importBatches ImportBatch[]` near `connections Connection[]` (same "additive only, not yet populated" comment style).
- `Connection`: add `importBatches ImportBatch[]` near `accountConnections`/`providerAccountIdentities`.

No relation names needed for any of the three — each is the only relation between that model and `ImportBatch`, same as `connections Connection[]` on `User` today. (`Transaction.financialAccount` uses a named relation for unrelated historical reasons; `ImportBatch.financialAccount` doesn't need one.)

## 4. Impact map

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `ImportSource`, `ImportBatchStatus` enums; add `ImportBatch` model; add `importBatchId`/`importBatch`/`externalTransactionId`/`deletedAt` + `@@index([importBatchId])` to `Transaction`; add one back-relation line each to `FinancialAccount`, `User`, `Connection`. |
| `prisma/migrations/<timestamp>_d2_4b_importbatch_foundation/migration.sql` | New, generated by `npx prisma migrate dev` — not hand-written. |

No other file changes. Specifically **zero** application code (`app/`, `lib/`, `components/`) — nothing reads or writes `ImportBatch`, `importBatchId`, `externalTransactionId`, or `deletedAt` in this slice. That wiring is 4D's job. No UI touched, satisfying the standing "don't modify unrelated UI while doing schema work" rule trivially (nothing UI-adjacent is in scope at all).

## 5. Migration preview

Illustrative only — the real file is generated by `prisma migrate dev`, not hand-written, but this is the SQL it should produce given the proposal above (cross-checked against the style of the three most recent D2 migrations: `20260623215751_d2_connection_foundation`, `20260623221124_d2_provider_account_identity`):

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
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "financialAccountId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "connectionId" TEXT,
    "source" "ImportSource" NOT NULL,
    "originalFilename" TEXT,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transaction_importBatchId_idx" ON "Transaction"("importBatchId");

-- CreateIndex
CREATE INDEX "ImportBatch_financialAccountId_idx" ON "ImportBatch"("financialAccountId");
CREATE INDEX "ImportBatch_createdByUserId_idx" ON "ImportBatch"("createdByUserId");
CREATE INDEX "ImportBatch_connectionId_idx" ON "ImportBatch"("connectionId");
CREATE INDEX "ImportBatch_status_idx" ON "ImportBatch"("status");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_importBatchId_fkey"
    FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_financialAccountId_fkey"
    FOREIGN KEY ("financialAccountId") REFERENCES "FinancialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

No `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` statements needed anywhere — every new column on an *existing* table (`Transaction`) is nullable from creation, unlike the `Holding.accountId` precedent which had to loosen an existing required column. No backfill `UPDATE` statements needed — every new column starts `NULL`/default and nothing existing depends on a populated value.

## 6. Rollback plan

Zero data-loss risk: by definition, nothing in this slice is read or written by any application code (that's 4D), so no row will exist in `ImportBatch` and no `Transaction` row will have a non-null `importBatchId`/`externalTransactionId`/`deletedAt` at any point between this migration shipping and a potential rollback.

- **Schema rollback:** `npx prisma migrate resolve` + a down migration, or directly:
  ```sql
  ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_importBatchId_fkey";
  ALTER TABLE "Transaction" DROP COLUMN "importBatchId", DROP COLUMN "externalTransactionId", DROP COLUMN "deletedAt";
  DROP TABLE "ImportBatch";
  DROP TYPE "ImportBatchStatus";
  DROP TYPE "ImportSource";
  ```
- **Code rollback:** none needed — no application code changes ship in this slice to revert.
- Per standing rule, this plan only ever removes what 4B itself adds. It does not touch `plaidTransactionId`, any existing index, or any legacy table/column.

## 7. Validation checklist

| Check | Purpose |
|---|---|
| `npx prisma generate` | Confirms the schema (including the corrected nullable `createdByUserId`) is valid and the client compiles. |
| `npx prisma migrate dev --name d2_4b_importbatch_foundation` | Generates and applies the migration above. |
| `npx tsc --noEmit` | Confirms the regenerated Prisma client doesn't break any existing type usage. |
| `npm run lint` | Standard gate. |
| `git diff --stat` | Confirms only `prisma/schema.prisma` + the one new migration directory changed — zero application code. |
| Spot-check | `SELECT * FROM "ImportBatch";` returns 0 rows; existing `Transaction` row count and a sample row's existing columns unchanged. |

No route or UI testing applicable — nothing is wired up to test yet.

## 8. Proposed Step 4B implementation checklist

(For approval before any code/schema changes — not executed by this investigation.)

1. Add `ImportSource` and `ImportBatchStatus` enums to `prisma/schema.prisma`.
2. Add `ImportBatch` model, with `createdByUserId` nullable (corrected from 4A's draft — see §2).
3. Add `Transaction.importBatchId` (+ relation) and `@@index([importBatchId])`.
4. Add `Transaction.externalTransactionId` (nullable, no constraint).
5. Add `Transaction.deletedAt` (nullable).
6. Add the three back-relation list fields (`FinancialAccount.importBatches`, `User.importBatches`, `Connection.importBatches`).
7. `npx prisma generate`.
8. `npx prisma migrate dev --name d2_4b_importbatch_foundation`.
9. `npx tsc --noEmit`.
10. `npm run lint`.
11. `git diff --stat` — confirm only `prisma/schema.prisma` + the new migration directory.
12. Write the Step 4B implementation + validation report; update `D2_ROADMAP.md`'s 4B row to ✅.

## 9. Smallest safe implementation scope

Exactly what 4A and the roadmap refinement already concluded, unchanged: schema-only, one commit, no reads, no writes, nothing wired up anywhere in application code. This investigation found one correction (createdByUserId nullability) and one minor addition beyond the roadmap's literal list (indexing `connectionId`, matching existing precedent) — neither changes the scope or risk profile; both are still pure additive schema.

## 10. Explicit files expected to change when 4B is implemented

- `prisma/schema.prisma` — modified.
- `prisma/migrations/<new-timestamp>_d2_4b_importbatch_foundation/migration.sql` — new, generated.
- `docs/initiatives/d2/D2_ROADMAP.md` — 4B status flipped to ✅, pointing at the new implementation report (follow-up doc update, same pattern as every prior completed sub-step).
- A new `docs/initiatives/d2/D2_STEP4B_IMPLEMENTATION_VALIDATION.md` (or similarly named) report — implementation + validation record, same pattern as every prior completed step.

No other file changes expected. In particular: no file under `app/`, `lib/`, or `components/` changes.

## Validation (this report)

| Check | Result |
|---|---|
| `git diff --stat` | Only this new file added; zero modifications to any existing file |
| Code changes | None |
| Schema changes | None |
| Migrations | None |

---

**Stopping here per scope. No ImportBatch implementation, no schema changes, no migrations.**
