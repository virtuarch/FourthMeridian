# D2 Step 4A — Import & History Foundation Investigation

Status: **read-only investigation complete. No code changes. No schema changes. No migrations.**

Context: D2 Steps 1–3 (Connection model, ProviderAccountIdentity, PLAID dual-write, PLAID read cutover) are complete and audited (Step 3G). WALLET identity remains deferred. This is the design investigation for D2 Step 4, per `docs/initiatives/d2/D2_ROADMAP.md`.

## 1. Current-state inventory

**`Transaction` model** (`prisma/schema.prisma:1089`) — `id`, dual FK (`accountId` legacy / `financialAccountId` canonical, exactly one set), `date`, `merchant`, `description`, `category` (`TransactionCategory`), `amount` (positive = in, negative = out), `pending`, `plaidTransactionId` (nullable, `@unique` — the only dedupe key that exists today), `createdAt`/`updatedAt`. Indexes: `accountId`, `[accountId, date]`, `financialAccountId`, `[financialAccountId, date]`, `date`. **No `deletedAt` column exists** — confirmed directly from schema, not just inferred from the architecture doc.

**`FinancialAccount`** (`:624`) — canonical account row; D11's `createdByUserId` already present; `plaidAccountId`/`walletAddress` are the only provider-identity columns at this layer (generalized by `ProviderAccountIdentity`, D2 Step 1B). Nothing import-related exists on this model.

**`Holding`** (`:1048`) — same dual-FK pattern as `Transaction` (`accountId` legacy / `financialAccountId` canonical), unique on `[accountId, symbol]` and `[financialAccountId, symbol]`. Not directly in scope for CSV transaction import, but the dual-FK precedent is the same one `Transaction` and any new import path would follow.

**`AccountConnection`** (`:747`) and **`Connection`** (`:514`) — `Connection` is the D2 Step 1A model: `provider` (`ProviderType`), `externalConnectionId`, `credential` (nullable), `status`, `cursor`. **`ProviderType` already includes `CSV`** (alongside `PLAID`, `MANUAL`, `WALLET`, `EXCHANGE`, `BROKERAGE`) — added in Step 1A, anticipating exactly this work, but zero rows of any non-PLAID provider exist and nothing writes `Connection` for CSV today. `AccountConnection.connectionId` is the established "additive, nullable, not-yet-populated" seam pattern already used for Plaid.

**Plaid transaction sync** (`lib/plaid/syncTransactions.ts`) — cursor-based (`syncTransactionsForItem`), upserts on `plaidTransactionId` first; on a miss, falls back to `findByFingerprint(financialAccountId, date, amount, merchant, pending)` — an in-memory narrowing by `normalizeMerchantKey()` (trim/collapse whitespace/uppercase) over rows pre-filtered by the indexed `[financialAccountId, date]`. This fallback exists because Plaid has been observed to reissue `transaction_id` across sync runs (`docs/TRANSACTION_DUPLICATION_INVESTIGATION.md`).

**Account-level fingerprinting** (`lib/accounts/reconcile.ts`) — a structurally similar but independently-implemented fingerprint matcher, scoped to mask + institution + name fields rather than date/amount/merchant. `mergeArchivedDuplicateIntoCanonical()` is the only place `DuplicateAccountCandidate` rows get written, and it never hard-deletes.

**No existing import code.** Repo-wide search for `ImportBatch`, `csv`/`CSV`, `xlsx`, `quickbooks` found zero application code. Every match is one of: the `ProviderType.CSV` enum value (schema + its migration, unused by app code), documentation (`D2_PROVIDER_CONNECTION_ARCHITECTURE.md` §8, `D2_ROADMAP.md` Step 4, `DATABASE_ARCHITECTURE_REVIEW.md` §7.2/§8.1, `PHASE_2_DECISION_MATRIX.md`), and two architecture SVGs. No `ImportBatch` table, no upload route, no parser, no UI.

**No manual transaction-entry path exists either.** `app/api/accounts/[id]/transactions/route.ts` is `GET`-only. There is no `POST` anywhere that creates a `Transaction` by hand. So CSV import isn't replacing or competing with an existing manual-entry flow — there isn't one yet at the transaction level (there is one at the account level: `app/api/accounts/manual/route.ts` for manual asset accounts, and `app/api/accounts/wallet/route.ts` for wallets — both reaffirm the "user-initiated create, never auto-matched from file content" posture Step 4 should follow for transactions too).

**No import-related audit actions.** `lib/audit-actions.ts` has `ACCOUNT_ADD`/`ACCOUNT_REMOVE`/`MANUAL_ASSET_ADD`-style constants but nothing for an import batch. Flagged as a gap Step 4's eventual implementation (not this investigation) will need to fill.

**A second, separate design already exists one layer up — do not conflate it with `ImportBatch`.** `DATABASE_ARCHITECTURE_REVIEW.md` §7.2/§8.1 (proposed, unbuilt, part of the later D2 Adapter Interface / D6-D7 ProviderCatalog work) sketches an `ImportConnectionDetail` table and a `ProviderCatalog` row for "CSV Import" as an institution choice. That is the *connection/identity* layer (one `Connection` row per CSV "source," analogous to how one `PlaidItem`/`Connection` covers many accounts). `ImportBatch` (this investigation) is the *event* layer — one row per upload, regardless of whether a `Connection` ever gets created for CSV. The two are complementary and should stay decoupled: `ImportBatch` should not require `ImportConnectionDetail`/`ProviderCatalog` to exist first, the same way Step 4 was deliberately sequenced before D2's own Step 5 (Adapter Interface) in the roadmap.

## 2. Proposed schema additions

All additive, all nullable except where noted, no existing column altered:

- **`ImportBatch`** — new model (design in §3).
- **`Transaction.importBatchId`** — nullable FK to `ImportBatch`, `onDelete: SetNull` (a transaction survives even if its batch row were ever removed, though batches are never hard-deleted per standing rule).
- **`Transaction.externalTransactionId`** — nullable `String`, generic sibling of `plaidTransactionId` for files/exports that carry their own stable row id (e.g. a QuickBooks export id).
- **`Transaction.deletedAt`** — nullable `DateTime`, net-new column (none exists today). Required for rollback to soft-delete rather than hard-delete, consistent with this codebase's one narrowly-scoped hard-delete path (`manual/[id]/permanent`) being the exception, not the norm.

Explicitly **not** proposing here (flagged as open, deferred): a `Transaction.source`/provenance enum. Provenance is already inferable from which nullable FK/id is populated (`plaidTransactionId` set → Plaid; `importBatchId` set → import; neither → manual/legacy). Adding an explicit enum would require deciding a backfill value for every existing row; the minimal slice doesn't need it.

## 3. ImportBatch design

```
model ImportBatch {
  id                 String         @id @default(cuid())
  financialAccountId String                      // required — user always picks the target account first (§5)
  financialAccount   FinancialAccount @relation(fields: [financialAccountId], references: [id], onDelete: Cascade)
  createdByUserId    String
  createdByUser      User           @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)

  // Mirrors AccountConnection's already-established additive seam — nullable,
  // unpopulated until D2's later Adapter/ProviderCatalog work (§1) exists.
  connectionId       String?
  connection         Connection?    @relation(fields: [connectionId], references: [id], onDelete: SetNull)

  source             ImportSource   // CSV | EXCEL | QUICKBOOKS
  originalFilename   String?
  status             ImportBatchStatus @default(PENDING)
  rowCount           Int            @default(0)
  importedCount      Int            @default(0)
  skippedCount       Int            @default(0)
  errorSummary       Json?

  createdAt          DateTime       @default(now())
  updatedAt          DateTime       @updatedAt
  completedAt        DateTime?

  transactions       Transaction[]

  @@index([financialAccountId])
  @@index([createdByUserId])
  @@index([status])
}

enum ImportSource { CSV  EXCEL  QUICKBOOKS }
enum ImportBatchStatus { PENDING  PROCESSING  COMPLETED  COMPLETED_WITH_ERRORS  ROLLED_BACK  FAILED }
```

`rowCount`/`importedCount`/`skippedCount`/`errorSummary` give a replay UI "47 of 50 rows imported, 3 skipped as duplicates" without re-parsing the original file — same rationale §8 already gave.

## 4. Transaction provenance design

Add `importBatchId` (nullable FK), `externalTransactionId` (nullable, unindexed-unique — see note), `deletedAt` (nullable) to `Transaction`. None of the three touches the existing `accountId`/`financialAccountId` dual-FK pattern, `plaidTransactionId`, or any existing index.

Note on `externalTransactionId`: recommend **not** making it `@unique` the way `plaidTransactionId` is — a CSV export's own id is only guaranteed unique within that one file/institution, not globally, so a naive global unique constraint would risk a cross-account collision the moment two different banks both label a row `"1"`. Recommend scoping uniqueness to `[financialAccountId, externalTransactionId]` if a DB-level constraint is wanted at all, decided at implementation time, not assumed here.

## 5. Matching/dedupe strategy

**Account matching — reaffirming §8, not changing it.** The user always selects an existing `FinancialAccount` before uploading. CSV/Excel/QuickBooks exports don't reliably carry Plaid's structured `institution_id`/`mask`/`official_name`, so reusing `reconcile.ts`'s fingerprint approach to auto-create or auto-match an account from file contents would be guessing. An optional create-new-account-from-import flow stays an explicit, separate, later decision — not part of this slice.

**Transaction dedupe.** Two-tier, mirroring the Plaid pattern already established: try `externalTransactionId` exact match first when the file provides one; on a miss (or when no id is present), fall back to the same `date + amount + normalizeMerchantKey(merchant)` fingerprint, scoped to `financialAccountId` — identical shape to `syncTransactions.ts`'s `findByFingerprint()`.

**Consolidation recommendation, called out explicitly because it was already flagged once before (D2 Step 2A investigation's "duplicated responsibilities" finding):** there are currently two independent fingerprint implementations (`reconcile.ts` for accounts, `syncTransactions.ts` for Plaid transactions). Building CSV dedupe as a third independent copy would make that worse. Recommend extracting one shared transaction-fingerprint helper (the existing `findByFingerprint`/`normalizeMerchantKey` shape, generalized to take a `financialAccountId` and not assume a Plaid caller) used by both `syncTransactions.ts` and the future CSV importer — as part of, or immediately before, Step 4's implementation, not retrofitted after.

**Cross-provider dedupe falls out for free.** Because the fingerprint is scoped only by `financialAccountId + date + amount + merchant`, a CSV row that duplicates an already-synced Plaid transaction (or vice versa) is caught by the same check regardless of which path wrote the original row — no provider-specific casing needed, as long as the helper is shared rather than duplicated per source.

## 6. Smallest safe implementation slice

Recommend splitting Step 4 itself into sub-steps, mirroring how Step 1 was split into 1A/1B/1C-A/1C-B/1C-C — **not proposing to do all of this in one branch/commit**, consistent with the standing rule:

- **Step 4B** (next, schema-only): add `ImportBatch` + the three `Transaction` columns above. Purely additive — no reads, no writes, nothing wired up. Validate with `prisma generate` / `migrate dev` / `tsc --noEmit` / `lint` only, same as Step 1A/1B.
- **Step 4C** (later): extract the shared transaction-fingerprint helper, refactoring `syncTransactions.ts` (and, if useful, `reconcile.ts`'s account-level one for symmetry) to use it — behavior-preserving, checked against `scripts/verify-provider-account-identity-backfill.ts` and existing transaction-sync behavior, with no new CSV behavior in the same commit.
- **Step 4D** (later): the actual upload/parse/import route + UI, built on 4B + 4C.

This investigation does not start 4B.

## 7. Risks and rollback plan

- **Schema risk (4B): low.** New nullable columns + one new table; no backfill needed since nothing existing depends on default values for these columns. Rollback is a straight migration-down — nothing reads or writes the new columns yet, so there's no data to lose.
- **Refactor risk (4C): moderate, scoped, and isolated from new behavior.** `syncTransactions.ts` has been through three read-cutover steps already (3F) — recommend the fingerprint-helper extraction be its own commit, verified behavior-unchanged, before any CSV-specific logic touches the file.
- **Dedupe risk (4D, design-time flag only): fingerprint over-merge.** Same caveat `reconcile.ts`'s account fingerprinting already carries — a coincidental date+amount+merchant match isn't guaranteed to be the same real transaction. Recommend treating a fingerprint-matched CSV row the conservative way: skip it and report it in `skippedCount`/`errorSummary`, not silently merge — keeps the "additive, reversible" posture this codebase has used everywhere else at the row level too.
- **Out of scope, not resolved here:** on-chain/crypto transaction import (§7 of the architecture doc flags this as a fully open decision, possibly reusing `ImportBatch` later — not addressed by this investigation). WALLET identity remains deferred per existing decisions, untouched by anything above.

## Validation

| Check | Result |
|---|---|
| `git diff --stat` | Only this new file added; zero modifications to any existing file |
| Code changes | None |
| Schema changes | None |
| Migrations | None |

---

**Stopping here per scope. No ImportBatch implementation, no schema changes, no migrations.**
