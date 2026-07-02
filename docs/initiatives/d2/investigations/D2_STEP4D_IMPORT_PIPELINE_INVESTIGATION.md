> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D — Import Pipeline Investigation

Status: **read-only investigation. No file other than this one was created or modified to produce this report.** No code, schema, migration, route, or UI change. Per the task's constraint — stricter than every prior D2 investigation, including 4C's ("do not modify code, schema, migrations, routes, UI, or documentation") — this is an absolute, unqualified "do not modify any file," so even `D2_ROADMAP.md` is left untouched here, exactly as it was for 4A and 4C's investigations. Any roadmap update reflecting this report's existence is deferred to whenever 4D's own implementation checklist is requested and approved.

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`. Builds on `docs/initiatives/d2/D2_STEP4A_IMPORT_HISTORY_FOUNDATION_INVESTIGATION.md` (current-state inventory), `D2_STEP4B_IMPORTBATCH_FOUNDATION_INVESTIGATION.md`/`_IMPLEMENTATION_VALIDATION.md` (schema, now migrated), and `D2_STEP4C_TRANSACTION_FINGERPRINTING_INVESTIGATION.md`/`_IMPLEMENTATION_VALIDATION.md` (shared fingerprint helper, now extracted into `lib/transactions/fingerprint.ts`).

---

## 1. Current transaction-creation paths

Repo-wide search (`db.transaction.create` / `createMany` / `upsert` across `app/` and `lib/`, plus `prisma/seed.ts` separately) finds **exactly one production write path** for `Transaction` rows, plus one fixture-only path. There is no manual-transaction-entry route and no wallet-transaction-sync job anywhere in the codebase today.

### 1a. Plaid sync — the only production write path

`lib/plaid/syncTransactions.ts`, four `db.transaction.*` call sites (line numbers as of the 4C extraction):

- **Line 224** — `findUnique({ where: { plaidTransactionId } })`: exact-id lookup.
- **Line 230** — `update`: exact `plaidTransactionId` match found → update in place. Counted as `updatedByPlaidId`.
- **Line 238** — `findByFingerprint(...)` (now `lib/transactions/fingerprint.ts`, per 4C): no exact-id match → fingerprint fallback on `(financialAccountId, date, amount, normalizedMerchant, pending)`.
- **Line 241** — `update`: fingerprint match found → update in place **and overwrite `plaidTransactionId`** with the new id. Counted as `updatedByFingerprint`. This silent-overwrite-on-match behavior is the one piece of existing behavior 4D should *not* blindly copy for file-based sources — see §4.
- **Line 253** — `create`: no match by either method → genuinely new row, `plaidTransactionId` set. Counted as `created`.
- **Line 264** — `deleteMany({ where: { plaidTransactionId: { in: ids } } })`: Plaid's `removed` array — hard delete, not the 4B `deletedAt` soft-delete. (4B's `deletedAt` column is unused by any existing code path; it was added for the future rollback use case 4D is now investigating.)

### 1b. Manual transaction creation — does not exist

Grepped for any `POST`/`PUT`/`PATCH` handler under any `app/api/**transaction**` path: **zero matches.** The only existing transaction-related route is `app/api/accounts/[id]/transactions/route.ts`, and it is `GET`-only (reads by `accountId` OR `financialAccountId`, no write handler in the file at all).

What *does* exist is manual **account** creation — `app/api/accounts/manual/route.ts` (`POST`) — which creates a `FinancialAccount` (type `other`, `syncStatus: "manual"`, a single user-supplied `balance`) plus `AccountConnection`/`WorkspaceAccountShare`/`SpaceAccountLink` rows and one `AuditLog` row (`"MANUAL_ASSET_ADD"`). It creates **zero** `Transaction` rows — manual assets have no transaction-history concept today, only a point-in-time balance. This is a distinct, already-shipped feature from the "manual transaction entry" idea 4D's prompt gestures at; the two should not be conflated. If a "manually add a transaction to an existing account" UX is ever wanted, it doesn't exist yet and is not part of this investigation's scope (it wasn't asked for, and CSV/Excel/QuickBooks import covers the bulk-entry case).

### 1c. Wallet transaction creation — does not exist; no sync mechanism exists at all

`app/api/accounts/wallet/route.ts` (`POST`) creates a self-custodied crypto `FinancialAccount` (`walletAddress`/`walletChain`/`nativeBalance`), `AccountConnection`/`WorkspaceAccountShare`/`SpaceAccountLink` rows, and `AuditLog` rows (`ACCOUNT_RESTORE`, `"WALLET_ADD"`). Balance starts at `0` with an inline comment: *"the sync job will populate it on next run."* That sync job does not exist: `lib/crypto-apis.ts` — the only plausible home for it — is a one-line stub, `export {}`. **Zero** `Transaction` rows are created by this route, and there is no other code path that creates one for a wallet account. Wallet accounts are balance-only today, and even the balance is only as fresh as whatever was typed in at creation time — this is a pre-existing gap unrelated to 4D, surfaced here only because the task asked to trace every creation path.

### 1d. `prisma/seed.ts` — fixture-only, identity-free, unguarded

Nine `prisma.transaction.createMany` calls, all writing the legacy `accountId` field only — no `financialAccountId`, no `plaidTransactionId`, no `externalTransactionId`. This is a one-time local-fixture path, structurally unrelated to any of Plaid sync, manual entry, wallet sync, or the future import pipeline. Not a production concern, but worth naming so it isn't mistaken for a fourth "real" creation path.

### Summary table

| Path | Exists today? | Creates `Transaction` rows? | Sets `financialAccountId`? | Sets any external id? |
|---|---|---|---|---|
| Plaid sync | ✅ | ✅ | ✅ | `plaidTransactionId` |
| Manual transaction entry | ❌ (no route) | — | — | — |
| Wallet sync | ❌ (stub only) | — | — | — |
| `seed.ts` fixtures | ✅ (dev-only) | ✅ | ❌ (legacy `accountId` only) | ❌ |
| **CSV/Excel/QuickBooks import** | ❌ (this is 4D) | — | — | — |

The practical implication for 4D: there is exactly one existing pattern to learn from (Plaid sync), and it has one behavior — silent overwrite-on-fingerprint-match — that the 4C investigation already flagged as Plaid-appropriate but not necessarily import-appropriate. 4D is not retrofitting a second source onto a mature multi-source dedupe system; it is building the *second* source onto a system designed around exactly one.

---

## 2. ImportBatch schema sufficiency

Current shape (`prisma/schema.prisma`, 4B, migrated):

```
model ImportBatch {
  id, financialAccountId (required FK), createdByUserId (nullable FK),
  connectionId (nullable FK, unpopulated seam), source (CSV|EXCEL|QUICKBOOKS),
  originalFilename, status (PENDING|PROCESSING|COMPLETED|COMPLETED_WITH_ERRORS|ROLLED_BACK|FAILED),
  rowCount, importedCount, skippedCount, errorSummary (Json?),
  createdAt, updatedAt, completedAt, transactions Transaction[]
}

Transaction { ...existing fields..., importBatchId (nullable FK), externalTransactionId (nullable, no unique constraint), deletedAt (nullable) }
```

**Import tracking (aggregate level): sufficient.** `rowCount`/`importedCount`/`skippedCount` plus `status`/`completedAt` are enough to answer "how did batch X go" at a glance — this is the same level of granularity the Plaid sync's own `SyncTransactionsResult` counters provide today, and it has been adequate for that for the whole life of the Plaid integration.

**Import tracking (per-row / per-outcome): insufficient as currently named.** The aggregate counters only distinguish *imported* vs *skipped*. §4 below establishes that import rows need a four-way outcome (CREATED / MATCHED / SKIPPED / FAILED), and there is currently no slot for "matched an existing row" or "failed to parse" as distinct from "skipped." This is a smaller gap than the rollback one below — it's a missing counter or two, not a missing relation — but it is a real gap, addressed in §7.

**Rollback: insufficient — this is the central finding of this investigation.** `Transaction.importBatchId` is a single nullable FK. Nothing in the schema says whether a given row's `importBatchId` means *"this batch created this row"* or *"this batch merely matched/touched a pre-existing row."* Both are plausible behavioral choices for the same column, and the schema cannot distinguish them after the fact.

This is not a hypothetical gap — it is the **most likely failure mode if 4D's implementation reuses the Plaid pattern verbatim**, which is exactly what reusing `lib/transactions/fingerprint.ts` invites. Plaid's own matched-row branch (line 241) overwrites `plaidTransactionId` on the existing row. A naive direct translation to import would do the analogous thing — overwrite/set `importBatchId` on the matched row too, "for completeness." If that happens, a later rollback that does `UPDATE "Transaction" SET "deletedAt" = now() WHERE "importBatchId" = X` would soft-delete a row that **already existed before this batch ran** — silently destroying data the import never created and has no right to remove. This is precisely the CREATED-vs-MATCHED ambiguity the 4C report flagged as an open question for 4D (§9 of that report); this investigation confirms it is not just open but actively dangerous if the Plaid pattern is copied without modification.

**Audit history: partially sufficient, with a caveat.** The generic `AuditLog` model (`id`, `userId`, `spaceId`, `action`, `metadata Json?`, `ipAddress`, `userAgent`, `performedByAdminId`, `createdAt`) already exists and is already used for exactly this class of event — `manual/route.ts` writes `"MANUAL_ASSET_ADD"`, `wallet/route.ts` writes `"WALLET_ADD"`/`ACCOUNT_RESTORE`. The same convention extends cleanly to import: one `AuditLog` row per batch lifecycle event (e.g. future constants `IMPORT_BATCH_CREATED`, `IMPORT_BATCH_COMPLETED`, `IMPORT_BATCH_ROLLED_BACK` in `lib/audit-actions.ts`), with `metadata` carrying `{ importBatchId, source, rowCount, createdCount, matchedCount, skippedCount, failedCount }`. This answers "what happened and who did it" for an admin-facing timeline — the same job it already does for every other audited action in the app.

What `AuditLog` does **not** solve is the rollback discriminator. `AuditLog.metadata` is an opaque, unindexed `Json` blob — recording the full list of affected `Transaction.id`s in it is *possible* but is not how any existing `AuditLog` entry in this codebase is used (every existing one is small, structured, summary-shaped metadata, not a row-id manifest), and querying "which transactions did batch X create" back out of a Json array is not something Postgres/Prisma does efficiently or safely compared to a real column/relation. **AuditLog and the rollback discriminator are solving two different problems** — one is a human-facing log, the other is a system-facing, must-be-precise, must-be-queryable fact about specific rows. Treat them as complementary, not substitutes for each other.

---

## 3. Rollback analysis

### Requirements

A rollback must: (a) never touch a `Transaction` row that pre-existed the batch (a row the batch only matched), (b) be expressible as a single, indexed, efficient query (not an N+1 walk), (c) use the existing soft-delete (`Transaction.deletedAt`, 4B) rather than a hard delete — consistent with the standing "do not remove ... prematurely" / additive-before-subtractive rules — and (d) not require a second migration to be usable on Day 1 of 4D, if that can be avoided.

### Options considered

**Option A — add a discriminator column.** `Transaction.importMatchType: CREATED | MATCHED_EXISTING` (nullable enum, only ever set alongside `importBatchId`). Rollback becomes `WHERE importBatchId = X AND importMatchType = 'CREATED'`. Pro: explicit, self-documenting, and it also preserves a full link from *every* row a batch touched (created or matched) back to that batch, which Option B gives up. Con: one new schema field, i.e. another migration before 4D's first code lands — and it only solves row-level "can I delete this," not field-level "can I undo the overwrite this batch made to a matched row's category/description" (no option here solves that without a before/after snapshot, which none of the options below attempt — flagged as a known, deliberately out-of-scope limitation, same spirit as 4C declining to solve `fingerprintHash` 's harder edge cases).

**Option B — only ever set `importBatchId` on genuinely created rows.** Behavioral discipline, not a schema change: matched rows are looked up and possibly have non-identity fields updated (or, per §4's recommendation, not updated at all), but `importBatchId` is left alone if the row already existed. Rollback becomes `WHERE importBatchId = X` — same query Option A reduces to, with no enum needed. Con: a matched row carries no link back to the batch that touched it, so "show me everything batch X did" can't be answered from the `Transaction` table alone (the aggregate `matchedCount` on `ImportBatch`, per §7, gives a *number* but not a *list*). Pro: **zero schema change** beyond what 4B already shipped — implementable in 4D's very first code slice.

**Option C — a row-level table** (`ImportBatchRow`/`ImportMatch`): one row per imported file-row, recording `importBatchId`, `rowNumber`, an outcome enum (`CREATED|MATCHED|SKIPPED|FAILED`), a nullable `transactionId` FK (the resulting or matched row), and an error message for `FAILED`. This gives complete per-row audit and debuggability ("which row 47 failed and why") independent of what happens in `Transaction`, and is the natural home for a future "what did this import do" UI. It is also the most schema-impactful option, and most of what it provides (full row-level history) is not something either D2's prior steps or this prompt's stated Day-1 need actually require yet — no UI requirement for a per-row import log has been stated anywhere in the Phase 2 docs or this task.

### Recommendation

**Option B for the first 4D implementation slice; revisit Option A/C later only if a real product requirement for per-row audit emerges.** This matches the precedent already set twice in Step 4: 4C explicitly deferred a persisted `fingerprintHash` column rather than bundling it into the helper extraction, and D2 broadly defers WALLET identity work rather than guessing at unresolved semantics. Option B requires a behavioral rule, not a migration, to be safe — "matched rows never get `importBatchId` set or changed" — which costs nothing schema-wise and is easy to get right in a single, small `findByFingerprint`-adjacent function, the same size of surface 4C already proved out. If product later wants a real "view this import" timeline, that is the moment to add Option C — additive, non-breaking, and informed by which of 4D-1/4D-2/4D-4 (see §8) actually shipped and what users asked for after using them, rather than guessed at now.

Either way, **a discriminator decision is a precondition for 4D writing a single row** — it should be the first line item on 4D's own implementation checklist, not something that gets implicitly decided by whatever the first PR happens to do.

### Does rollback need `ImportBatchRow` / `ImportMatch` / `ImportBatchTransaction` / another structure?

**Not for Day 1**, per the recommendation above. They become relevant only if/when: per-row debugging UI is requested, field-level undo of a matched-row overwrite is requested (none of the three options above solve this without a values-snapshot, which is its own, larger design question), or QuickBooks's update-on-match behavior (§6) is implemented and someone needs to audit exactly what got overwritten on a re-import.

### The read-path audit (a precondition for shipping rollback regardless of which option)

Repo-wide search of every `db.transaction.findMany`/`findFirst`/`findUnique`/`count` call site (5 found, all read-only, all production) shows **none of them filter on `Transaction.deletedAt`** today:

| Call site | Filters today |
|---|---|
| `lib/data/transactions.ts` `getTransactions()` | `financialAccount.deletedAt` (the *account's* soft-delete) — not `Transaction.deletedAt` |
| `lib/data/transactions.ts` `getDebtTransactions()` | same — account-level only |
| `lib/data/transactions.ts` `getInvestmentTransactions()` | same — account-level only |
| `app/api/accounts/[id]/transactions/route.ts` | none |
| `lib/accounts/reconcile.ts` `count()` (used in account-merge decisions) | none |

If rollback ships before every one of these five sites adds a `deletedAt: null` filter, a rolled-back transaction reappears immediately in the dashboard, the debt view, the investment view, the account-detail modal, and even silently skews `reconcile.ts`'s "does this account have transaction history" check used during duplicate-account merges. This is exactly the same shape of risk Step 3A's investigation-before-cutover handled for `ProviderAccountIdentity` reads, and it should be treated the same way: **its own explicit checklist item, completed and validated before the rollback route is wired up** — not assumed to be a free side effect of adding the soft-delete write.

---

## 4. Duplicate handling

Using the shared `findByFingerprint`/`normalizeMerchantKey` helper (4C) as the building block, an imported row should classify into one of four outcomes:

- **CREATED** — no exact `externalTransactionId` match (mirroring Plaid's exact-`plaidTransactionId` check) and no fingerprint match → new `Transaction` row, `importBatchId` set (per §3's Option B), `externalTransactionId` set if the source file provided one.
- **MATCHED** — an exact `externalTransactionId` match, or a fingerprint match, against an *existing* row. This existing row may itself be Plaid-sourced — a case that has never existed before, since Plaid sync only ever matches against other Plaid-sourced rows. **Recommendation: default to no-op on match for CSV/Excel** — record the outcome, link nothing new onto the `Transaction` row, leave its fields untouched. This deliberately differs from Plaid's own overwrite-on-match behavior, for two reasons: (1) overwriting a Plaid-sourced row's fields with potentially-stale CSV data is a data-quality regression for the higher-trust source, and (2) the 4C investigation report already recommended exactly this — "flag and skip, surfaced to user" for CSV collisions rather than Plaid's silent reuse — so this is confirming prior guidance, not relitigating it. QuickBooks is the one source where update-on-match has a real argument; see §6.
- **SKIPPED** — distinct from MATCHED: a row the pipeline declined to act on, e.g. an *ambiguous* fingerprint match (the `matches.length > 1` branch `findByFingerprint` already logs a warning for, today silently picking the first one — for an import, "skip and surface to the user" is the safer default than guessing, per 4C's recommendation), or a row identified as a duplicate of another row *within the same file*.
- **FAILED** — parse-level failure (malformed row, missing required field, unparseable date/amount). Never reaches the fingerprint stage.

### Persistence (Day 1)

Aggregate counters on `ImportBatch` only — no row-level table, consistent with §3's recommendation. This requires expanding the current `rowCount`/`importedCount`/`skippedCount` trio (see §7's schema impact assessment) since "matched" and "failed" are not currently distinguishable from "skipped." Per-row detail beyond the aggregate (which row, which file line, why) is deferred to the same future `ImportBatchRow` decision point as §3 — `errorSummary` (`Json?`, already on `ImportBatch`) is sufficient for Day 1 to capture a short list of `{ row, reason }` failure entries without a new relation.

---

## 5. Import lifecycle

**Upload.** User selects an existing `FinancialAccount` (required — no fingerprint-based auto-account-creation from file contents, confirmed as the standing design in 4A §5 and unchanged here) and a file. An `ImportBatch` row is created immediately, `status: PENDING`, `source` set from the upload context, `originalFilename` recorded. **Infrastructure gap, not a schema gap:** no file-upload or blob-storage mechanism exists anywhere in this repo today (`grep -ri upload app/api` returns nothing). Where the uploaded file itself is held — local temp storage vs. an external bucket — is a real dependency 4D needs resolved before the Upload stage can be implemented, and is explicitly out of scope for this investigation to decide.

**Parse.** Format-specific. No parsing library for any of the three formats is currently a dependency (`package.json` has no `papaparse`/`csv-parse`, no `xlsx`/`exceljs`, nothing QuickBooks-related) — all three need a library added at implementation time. `status` → `PROCESSING`.

**Normalize.** Map the source's column layout to the canonical shape `Transaction` already expects (`date`, `merchant`, `description`, `category`, `amount`, `pending`). Sign convention is the one normalization step that cannot be assumed uniform: Plaid's own header comment documents that Plaid uses positive-for-debit while this schema's convention is positive-for-credit, and that flip is hand-coded for Plaid specifically. A bank CSV export's sign convention varies by bank and has no universal rule — this needs to be a per-source (or per-import, user-confirmed) setting, not a hard-coded assumption the way Plaid's single flip is.

**Fingerprint.** `externalTransactionId` exact-match check first (the import-side analog of Plaid's `plaidTransactionId` check) for sources that carry one — QuickBooks reliably does (see §6); plain bank CSV exports often don't. Fall through to `findByFingerprint` (4C) exactly as Plaid does today.

**Match.** Classify CREATED/MATCHED/SKIPPED/FAILED per §4.

**Create/Skip.** Write the `Transaction` (CREATED) or no-op (MATCHED/SKIPPED per §4's recommendation), incrementing the corresponding `ImportBatch` counter.

**Finalize.** `status` → `COMPLETED` or `COMPLETED_WITH_ERRORS` (both already in the `ImportBatchStatus` enum from 4B — unused by any code today, now with a clear purpose) depending on whether any row FAILED; `completedAt` set.

**Rollback.** Per §3: soft-delete every `Transaction` where `importBatchId = batch.id` (Option B makes this exact set == "rows this batch created"), set `ImportBatch.status = ROLLED_BACK`. Gated on the read-path audit in §3 being done first, as its own checklist item — not bundled silently into the same PR that adds the soft-delete write.

---

## 6. QuickBooks compatibility

**Identifiers.** QuickBooks — whether a Desktop/Online file export or the live Online Accounting API — carries its own stable transaction id (`TxnID` in QBXML/the API; export formats carry an equivalent reference). This is a materially better fit for the exact-id-match path than a typical bank CSV, and closer in spirit to Plaid's `transaction_id` than to an identity-free CSV row — except that, unlike Plaid's `transaction_id` (documented in this codebase as *not* stable across separate sync runs for the same real transaction), QuickBooks' id is genuinely stable across re-exports of the same company file. QuickBooks should therefore lean on the exact-`externalTransactionId`-match path far more than CSV/Excel ever will.

**Update behavior.** QuickBooks transactions can be edited, voided, or reclassified after the fact inside QuickBooks; a later re-import of the same period would carry the same id with changed fields. This is the one source where **update-on-match (mirroring Plaid's own behavior) has a real argument** — unlike a CSV re-upload, which is far more likely to be an accidental duplicate of the same one-time export than an intentional edit-propagation event. This means the Match/Create-or-Skip stage needs a per-`ImportSource` branch, not one universal rule across CSV/EXCEL/QUICKBOOKS: CSV/Excel default to no-op-on-match (§4); QuickBooks update-on-match. This fork should be made explicit in whichever implementation checklist covers QuickBooks, not left to be discovered mid-implementation.

**Reconciliation.** QuickBooks has its own bank-reconciliation status per transaction with no analog anywhere in this schema (no `reconciledAt`/`reconciliationStatus` field exists, and none has been requested). This is a known, named gap — not a blocker. Plaid sync already ignores plenty of Plaid-side metadata (e.g. categorization-confidence scores) without issue; QuickBooks' reconciliation flag can be ignored the same way until something downstream actually needs it.

**Special handling, and a scope fork worth surfacing now.** "QuickBooks import" can mean two different things with very different shapes: (a) the user exports a file from QuickBooks Desktop/Online and uploads it — this fits the existing `ImportBatch`/file-upload model exactly, no different in kind from CSV/Excel; or (b) a live, OAuth-connected QuickBooks Online API integration that pulls transactions on an ongoing basis — this looks much more like a **sync provider** (Step 5's Adapter Interface, the same shape as Plaid) than a one-time import batch, and would need its own `Connection` row and OAuth credential storage. `ImportBatch.connectionId`'s nullable FK seam (added in 4B specifically as a forward-compatible hook, per that model's own schema comment) already anticipates this fork without committing to it. **Recommendation: scope 4D's "QuickBooks" to the file-export case only**; treat live QuickBooks Online API sync as a Step 5/6 sync-adapter candidate, not 4D file-import scope. This mirrors how D2 already narrows "ProviderCatalog polished UI" out of its own foundation work — a scope-narrowing call this report is surfacing now so 4D's own checklist doesn't have to relitigate it.

One small, harmless inconsistency worth flagging for whoever eventually wires `Connection` to `ImportBatch`: `ProviderType` (the `Connection`-level enum, from Step 1A) currently has `CSV` but not `EXCEL` or `QUICKBOOKS`, while `ImportSource` (the `ImportBatch`-level enum, from 4B) has all three. Not a bug today — `connectionId` is unpopulated for every `ImportBatch` row that exists (none do yet) — just a future TODO to keep in mind if/when QuickBooks's file-export case is ever upgraded to a live `Connection`.

---

## 7. Deliverables

**Current-state analysis.** One production `Transaction`-write path exists (Plaid sync, now via the 4C shared helper) plus one dev-fixture-only path (`seed.ts`). Manual transaction entry and wallet transaction sync do not exist anywhere in the codebase — manual and wallet accounts are balance-only, and the wallet "sync job" referenced in `wallet/route.ts`'s own comment is an unimplemented stub (`lib/crypto-apis.ts`). 4D is building the second-ever transaction-creation source onto a system whose only precedent is Plaid-specific in places (overwrite-on-fingerprint-match) that should not be copied uncritically.

**Rollback architecture recommendation.** Do not add a schema discriminator on Day 1. Adopt a behavioral rule instead — `Transaction.importBatchId` is only ever set on rows the batch genuinely creates, never on rows it merely matches — making `WHERE importBatchId = X` a safe, sufficient, already-available rollback query with zero new migration. Revisit a real discriminator column (or a row-level `ImportBatchRow` table) only if a concrete product need for per-row audit/debugging emerges later. Before any rollback route ships, complete a read-path audit: all five existing `Transaction` read call sites (three in `lib/data/transactions.ts`, one in the account-detail route, one in `reconcile.ts`) currently ignore `Transaction.deletedAt` entirely and must be updated first, as its own checklist item.

**Duplicate-handling recommendation.** Four-way classification — CREATED / MATCHED / SKIPPED / FAILED — built on the existing 4C helper (`externalTransactionId` exact match first, fingerprint fallback second, exactly mirroring Plaid's own `plaidTransactionId`-then-fingerprint order). CSV/Excel default to no-op-on-match (do not overwrite an existing row, especially not a Plaid-sourced one); QuickBooks is the one source with a real case for update-on-match, because its identifiers are durable across re-exports in a way neither Plaid's nor a generic CSV's are. Ambiguous fingerprint matches should default to SKIPPED-and-surfaced rather than Plaid's silent first-match-wins.

**Schema impact assessment** (for whenever 4D is implemented — no change made now):
- `Transaction`: likely **zero new columns**, if the Option-B discriminator rule is adopted as a behavioral convention rather than a schema feature.
- `ImportBatch`: likely needs new additive counters — `matchedCount` and `failedCount` alongside the existing `importedCount`/`skippedCount` — since "matched" and "failed" aren't currently distinguishable from "skipped." Additive, not a rename/repurpose of the existing columns (no code reads them yet, but the standing additive-before-subtractive rule argues for new columns over silently changing existing ones' meaning).
- `Connection`/`ProviderType`: no change required; `CSV` already exists there from 1A, `EXCEL`/`QUICKBOOKS` do not — harmless today since no `ImportBatch.connectionId` is populated yet, but a TODO for whoever eventually connects QuickBooks live.
- Non-schema dependencies: a file-upload/storage mechanism (none exists today) and CSV/Excel parsing libraries (none are current dependencies) are real prerequisites, just not Prisma-schema ones.

**Implementation roadmap** (a proposed further sub-split of 4D itself, mirroring how Step 4 was already split into 4A–4D; not an approval of any of these — each still needs its own checklist):
1. **4D-1 — CSV import, create-and-match-only.** Smallest safe slice: Upload → Parse → Normalize → Fingerprint → Create/Match(no-op)/Skip/Fail → Finalize, no rollback yet. Proves the end-to-end pipeline shape against the simplest format.
2. **4D-2 — Excel import.** Reuses 4D-1's pipeline; only the Parse stage differs (different library, same downstream logic).
3. **4D-3 — Rollback.** Gated on the read-path audit (§3/§7) as its own prerequisite checklist item, completed and validated first.
4. **4D-4 — QuickBooks (file-export only).** Its own slice, given the update-on-match behavioral fork (§6) and a likely-different parser; explicitly excludes live API sync, which belongs to Step 5/6 if ever pursued.

**Validation strategy.** No test framework exists in this project (re-confirmed, consistent with every prior step's finding) — recommend fixture-file-based manual validation per format: one genuinely-new row, one exact re-import of the same file (must not double-create), one row that fingerprint-matches an existing *Plaid-sourced* transaction (validates the cross-source no-op behavior specifically), and one malformed row (validates FAILED classification and `errorSummary` capture). `tsc --noEmit`/`npm run lint` as the baseline gate for every slice, same as every prior D2 step. The sandbox's DB-unreachability (`localhost:5432`, confirmed unreachable in every prior step) applies identically here — any live validation run needs to happen locally.

**Rollback strategy** (for the 4D feature itself, distinct from import-rollback above). 4D-1/4D-2 are purely additive — new routes, new parser dependencies, and at most two new `ImportBatch` counter columns, no changes to existing read/write paths outside the new code. Reverting the implementing commit(s) is sufficient; no destructive migration is needed either way, consistent with additive-before-subtractive. If 4D-3 (rollback) ships and the read-path audit later turns out to have missed a site, the safe mitigation is to stop exposing the rollback action (the `deletedAt` write and column are harmless if simply unused) rather than reverting schema.

---

**Stopping here per scope. No implementation. No schema changes. No migrations. No file other than this one touched — verified via `git status --short` below.**
