> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-1 — CSV Import MVP Investigation

Status: **read-only investigation. No code, schema, migration, route, or UI change.** Per scope, this report is the one exception to "do not update documentation" — no other file was created or modified. `D2_ROADMAP.md` and `D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` are left untouched; any roadmap update reflecting 4D-1's existence is deferred to whenever this slice's own implementation is requested and approved.

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`. This is the first of the four sub-slices `D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` §7 proposed (4D-1 CSV create/match-only → 4D-2 Excel → 4D-3 rollback → 4D-4 QuickBooks). Builds directly on 4B (`ImportBatch`/`Transaction.importBatchId`/`externalTransactionId`/`deletedAt`, migrated) and 4C (`lib/transactions/fingerprint.ts`). Scope for this slice only: CSV, create+match, no rollback, no live provider sync, no UI polish — Excel and QuickBooks are explicitly out of scope here.

---

## 1. Where the CSV upload route should live

Inventory of every existing `app/api/**/route.ts` shows a consistent nesting convention: account-scoped sub-resources live under `app/api/accounts/[id]/<action>/route.ts` — siblings already present include `transactions` (GET), `restore` (POST), `debt-profile` (PATCH-shaped). Account-*type*-specific creation flows that aren't scoped to an existing account id instead live as their own top-level segment (`accounts/manual`, `accounts/wallet`).

CSV import is scoped to an **existing** `FinancialAccount` — the user picks the target account before uploading (confirmed standing design since 4A §5, restated in the 4D report: no fingerprint-based auto-account-creation from file contents) — so it fits the `[id]/<action>` shape, not the `accounts/manual`-style top-level shape.

**Recommendation: `app/api/accounts/[id]/import/route.ts`, `POST`.** Authorization should mirror `app/api/accounts/[id]/transactions/route.ts`'s existing lookup exactly: resolve `[id]` via an `ACTIVE` `SpaceAccountLink` in the caller's current space, falling back to the legacy `Account` table for pre-migration rows — the same dual-path check already proven out for reads on this exact resource. No new authorization pattern needs inventing.

One deliberate non-restriction worth stating explicitly: the route should **not** reject Plaid-synced accounts as import targets. Historical backfill of transactions that predate a Plaid connection (or predate Plaid's own retention window) is one of the two use cases the original 4A/D2 roadmap blurb names for CSV import — restricting import to manual-only accounts would quietly break that use case before it's ever tried.

---

## 2. Parser dependency

No CSV/Excel/QuickBooks parsing library is a current dependency (`package.json` checked directly — `dependencies/devDependencies` contain none). Hand-rolling a comma-split parser is explicitly the wrong call for financial data: real bank-export CSVs routinely quote fields containing commas (merchant names like `"SHELL OIL, INC"`), and a naive split silently corrupts those rows rather than failing loudly.

Two real options:
- **papaparse** — zero runtime dependencies of its own, runs synchronously or streamed, works in Node without a DOM, broadly the most common choice for this exact job, simple `Papa.parse(text, { header: true })` call for a file of a few thousand rows (the realistic size of a bank/CSV transaction export).
- **csv-parse** (the `csv` package family) — Node-native, streaming-first, a better fit if very large files or true streaming ever become a requirement.

**Recommendation: papaparse**, for the smallest-safe-slice the same way 4C picked extraction over a bigger rewrite — synchronous, in-memory parsing is sufficient for a single-file MVP upload, and `csv-parse`'s streaming strength isn't a requirement this slice has. Revisit if/when file sizes or a background-job model make streaming necessary (a later slice's problem, not 4D-1's).

---

## 3. Required CSV columns

`Transaction.merchant` is **non-nullable** in the schema — every row needs at least one text field that can populate it. Required, by header-name match (case-insensitive, common synonyms accepted):

- **Date** (`Date`, `Transaction Date`, `Posted Date`) → `Transaction.date`
- **Amount**, *or* a **Debit**/**Credit** column pair (see §5) → `Transaction.amount`
- **Description** or **Merchant** (at least one of the two must be present) → `Transaction.merchant` (and `description` if a separate column exists — see §6)

A file missing any of these for a given row produces a FAILED row (§8), not a thrown error for the whole batch — consistent with how `mapPlaidCategory()` already treats an unrecognized category as "fall back, don't abort" rather than fatal.

## 4. Optional CSV columns

- **Category** (free text) → mapped via a small alias table to `TransactionCategory`, falling back to `Other` for anything unrecognized or absent (mirrors `mapPlaidCategory()`'s own fallback philosophy in `syncTransactions.ts` — never block an import on an unmapped category).
- **Reference / Transaction ID / Check Number** → `Transaction.externalTransactionId`.
- **Pending / Status** → for this slice, recommend **ignoring this column and hardcoding `pending: false`** for every CSV row. CSV exports are near-universally posted/historical transactions; "pending" is a meaningfully Plaid-specific concept (an in-flight authorization), and inventing CSV semantics for it now is unforced scope growth. Revisit only if a real CSV with a meaningful pending concept shows up.

---

## 5. Sign-convention strategy

The 4D investigation flagged this as the one normalization step that can't be hard-coded the way Plaid's single fixed flip is — sign convention varies by bank/export, with no universal rule. Two unambiguous input shapes cover the overwhelming majority of real exports, and a CSV import MVP should support both:

1. **Separate Debit/Credit columns.** Unambiguous by construction — `amount = (credit ?? 0) - (debit ?? 0)`. No user input needed; this layout removes the sign question entirely when detected.
2. **Single signed Amount column.** Ambiguous on its own — recommend an explicit, batch-level, user-confirmed setting at upload time (one choice covering the whole file: "this file's positive numbers mean money in" vs. "...mean money out"), applied uniformly to every row. **Do not** attempt to infer the convention heuristically (e.g. from a running-balance comparison) — Fourth Meridian's `FinancialAccount.balance` is a current snapshot, not a point-in-time historical balance, so there's no reliable signal to infer from, and a wrong silent guess produces exactly-backwards financial data, the worst class of silent error here. An explicit, file-level, user-confirmed toggle is simple, correct by construction, and is the only piece of this slice that needs any UI input beyond "pick an account and a file" — everything else can run with zero additional user input.

---

## 6. Mapping rows to Transaction fields

| Transaction field | Source |
|---|---|
| `financialAccountId` | route's `[id]` param (validated per §1) |
| `date` | Date column; accept ISO (`YYYY-MM-DD`) and US (`MM/DD/YYYY`) explicitly; a row with an unparseable date is FAILED rather than guessed (ambiguous `DD/MM` vs `MM/DD` formats are never silently resolved) |
| `merchant` | Merchant column if present, else Description column (required — see §3) |
| `description` | Description column, only if a *separate* Merchant column was also present; otherwise left `null` |
| `category` | Category column via alias table, default `Other` |
| `amount` | Per §5 |
| `pending` | hardcoded `false` (§4) |
| `plaidTransactionId` | never set — CSV rows are not Plaid rows |
| `externalTransactionId` | Reference/Transaction ID column if present, else `null` |
| `importBatchId` | **only** on rows this batch creates — see the critical behavioral rule below |

---

## 7. Using `lib/transactions/fingerprint.ts`

Two-stage check per row, mirroring Plaid sync's own exact-id-then-fingerprint order:

1. **Exact `externalTransactionId` match**, scoped to `financialAccountId` (no unique constraint exists on `externalTransactionId` today — 4B's own schema comment notes it's "only guaranteed unique within that one file/institution, not globally," so the lookup must filter by `financialAccountId` too, not query `externalTransactionId` alone).
2. **Fingerprint fallback** — call `findByFingerprint(financialAccountId, date, amount, merchant, false)` exactly as-is, the same five-argument call Plaid sync already makes. No changes to `fingerprint.ts` are required to consume it this way.

**An open decision worth surfacing rather than silently resolving:** `findByFingerprint` already swallows its own ambiguous-match case internally — if more than one existing row matches, it logs a warning and returns the first one, the same as Plaid's behavior. Item 8 below (and the 4D report's duplicate-handling recommendation) wants CSV's ambiguous case classified as **SKIPPED**, not silently matched — but the helper's current return shape (`{ id, plaidTransactionId } | null`) gives the caller no way to tell "one unambiguous match" apart from "several, picked the first." Two ways to proceed, presented as a fork for the implementation checklist to pick, not resolved here:

- **(i) Pure reuse, Day-1 simplification.** Treat any non-null return as MATCHED, accepting Plaid's existing ambiguous-pick-first behavior for CSV too. Zero changes to `fingerprint.ts` — the literal smallest slice, true "consume the existing helper, change nothing."
- **(ii) Small, additive extension.** Add a way for `fingerprint.ts` to expose match-count (e.g. a `matchCount` field alongside the existing return, or a small sibling export) so CSV import can classify ambiguous matches as SKIPPED per the 4D report's recommendation. Low risk — purely additive, nothing existing reads a new field, Plaid sync's behavior is unaffected — but it is a real code change to a module Plaid sync also depends on, not a pure consumption.

This investigation recommends **(ii)** if SKIPPED-on-ambiguous is wanted from Day 1 (it's a small, low-risk addition, and "ambiguous fingerprint match" silently picking a winner is exactly the kind of thing a financial-data import should not do by default) — but flags **(i)** as the honestly-smaller slice if the checklist prefers to defer even that. Either way, this is a one-line decision the checklist should make explicit before implementation starts, not something that gets implicitly decided by whichever way the first PR happens to call the helper.

A second, related effect worth naming: because `findByFingerprint` queries the database live and CREATE happens synchronously per row (processed sequentially, not via `Promise.all` — see §11), a **duplicate row appearing twice within the same uploaded file** is handled for free: the first occurrence is CREATED and committed before the second occurrence's fingerprint check runs, so the second occurrence naturally finds the first as a DB match and is classified MATCHED. No separate "within-file duplicate" detection logic needs to be written — it falls out of doing the lookup-then-write per row in order. This is also precisely why rows **must** be processed sequentially rather than concurrently for this slice — concurrent processing would let two identical rows race past the fingerprint check before either commits, recreating the exact kind of race `dualWriteSpaceAccountLink`'s sequential-not-`Promise.all` fix (documented in `D3_STEP4C_REGRESSION_ROOT_CAUSE.md`) already had to fix once in this codebase for a different table.

---

## 8. CREATED / MATCHED / SKIPPED / FAILED behavior

- **CREATED** — no exact `externalTransactionId` match, no fingerprint match → `db.transaction.create()`. `importBatchId` set to this batch's id. `externalTransactionId` set if the row provided one.
- **MATCHED** — exact `externalTransactionId` match, or a fingerprint match → **no write at all** to the existing row. No field overwritten, no `importBatchId` set or touched. This is a deliberate departure from Plaid's own overwrite-on-fingerprint-match behavior (Plaid overwrites `plaidTransactionId` on match) — per the 4D report's recommendation, CSV defaults to no-op-on-match specifically because the matched row may be Plaid-sourced, and overwriting higher-trust synced data with CSV data is a regression, not an improvement.
- **SKIPPED** — only reachable if fingerprint-helper option (ii) from §7 is taken: an ambiguous match (more than one existing candidate). No write.
- **FAILED** — a parse-level problem: missing required column for that row (§3), unparseable date/amount, or a header-only/empty file. No write. Reason recorded for the batch summary (§9).

## 9. ImportBatch status/counter updates

- **On upload acceptance:** create the `ImportBatch` row — `status: PENDING`, `source: CSV`, `originalFilename`, `financialAccountId`, `createdByUserId`.
- **Before the row loop:** `status: PROCESSING`, `rowCount` set to the parsed data-row count (post-header).
- **During the loop:** accumulate counters in memory only — mirrors how `syncTransactionsForItem` accumulates `created`/`updatedByPlaidId`/`updatedByFingerprint`/`skippedMissingAccount` in memory across an entire sync run and persists nothing until the very end. Only the per-row `Transaction.create()` calls (CREATED rows) touch the database inside the loop.
- **Finalize, one update:** `importedCount`, `skippedCount`, `completedAt`, plus the two counters in §10 (`matchedCount`, `failedCount`), `errorSummary` (a short JSON array of `{ row, reason }` for FAILED rows), and `status` → `COMPLETED` if `failedCount === 0` else `COMPLETED_WITH_ERRORS` — both values already exist in the `ImportBatchStatus` enum since 4B, unused by any code until this slice.

## 10. Does ImportBatch need `matchedCount`/`failedCount` before implementation?

**Yes.** Today's columns (`rowCount`/`importedCount`/`skippedCount`) have no slot for "matched an existing row" or "failed to parse" as their own concept — distinct from "skipped," which item 8 needs to mean something narrower (an ambiguous match the system declined to act on, if §7's option (ii) is taken; if option (i) is taken, `skippedCount` may end up at a permanent 0 for this slice, which is fine and harmless, but the column still shouldn't be overloaded to also mean "matched"). Without these two new columns, the only alternatives are conflating MATCHED into the `skippedCount` bucket (loses the distinction item 8 explicitly asks for) or repurposing `errorSummary`'s `Json?` to carry match counts (abuses a field whose name and existing comment both say "errors," not general outcome accounting).

**Recommendation:** add `matchedCount Int @default(0)` and `failedCount Int @default(0)` to `ImportBatch` as part of 4D-1's *implementation* (not this investigation — no schema file was touched to produce this report). Two small, additive, defaulted columns — one migration — consistent with the precedent every prior schema-touching D2 step has already set (1A/1B/4B all added nullable-or-defaulted columns alongside an existing model, never repurposing one).

---

## 11. Manual validation plan

No test framework exists in this project (re-confirmed — consistent with every prior D2 step's finding; no Jest/Vitest/etc., no `test` script, zero `*.test.*` files). Recommend fixture-file-based manual validation:

- **`fixture-basic.csv`** — three genuinely new rows: varied categories, one with a populated reference column, one without. Expect 3 CREATED, `importedCount: 3`.
- **`fixture-duplicate-of-plaid.csv`** — one row whose date/amount/merchant exactly match an existing Plaid-synced transaction in a local dev DB (seeded via `prisma/seed.ts` or a real synced account). Expect MATCHED, and — critically — confirm the existing row's fields and `plaidTransactionId` are **unchanged** after the import (the no-op-on-match behavior is the one piece of this slice most worth a direct before/after diff, since getting it wrong silently corrupts Plaid data rather than just CSV data).
- **Re-uploading `fixture-basic.csv` a second time** — expect all 3 rows MATCHED against the rows the first upload just created (not re-created), confirming the within-file/cross-run dedupe behavior described in §7 holds across two separate `ImportBatch` runs, not just within one file.
- **`fixture-malformed.csv`** — a row missing the amount column, a row with an unparseable date, and a header-only file with zero data rows. Expect FAILED rows recorded in `errorSummary` and `status: COMPLETED_WITH_ERRORS`, never a thrown 500 — confirms a malformed row can't abort an otherwise-good batch, the same per-row try/catch resilience `syncTransactionsForItem` already has (`catch (e) { console.error(...) }` around its own create/update, not a loop-aborting throw).
- **`fixture-debit-credit.csv`** — separate Debit/Credit columns instead of a single signed Amount column, to confirm §5's second supported layout is actually exercised, not just the single-Amount path.

Run each fixture against the route locally (the sandbox's `DATABASE_URL` points at `localhost:5432`, unreachable here — same caveat as every prior step) and confirm: `ImportBatch` counters match expectations by hand-count, no duplicate `Transaction` rows on a second upload of the same file, Plaid-sourced rows are never overwritten, and `npx tsc --noEmit`/`npm run lint` both run clean against the new code.

---

## Deliverables

### Implementation checklist

1. Decide the §7 fingerprint-helper fork — pure reuse (i) or the small additive extension (ii) — before writing the route.
2. Add `matchedCount`/`failedCount` to `ImportBatch` (§10) — schema change + migration, run `npx prisma generate`/`migrate dev` (locally, given the sandbox's DB-reachability limitation already documented in every prior step).
3. Add `papaparse` as a dependency (§2).
4. Write the CSV parsing/normalization helper (date parsing, Debit/Credit-vs-signed-Amount detection, category alias table, required-column validation per row) — recommend a new `lib/imports/` module rather than inlining it in the route, so 4D-2 (Excel) can reuse the normalize/fingerprint/classify logic and only swap the Parse stage, per the 4D report's own roadmap note that 4D-2 "reuses 4D-1's pipeline almost entirely."
5. Write `app/api/accounts/[id]/import/route.ts` (`POST`): auth + account-visibility check (mirrors `[id]/transactions` GET), accept `multipart/form-data` via the Web-standard `Request.formData()` (Next.js 16's App Router route handlers support this natively — no `busboy`/`multer` needed), create the `ImportBatch` row, run the parse → normalize → fingerprint → classify → write loop sequentially (§7's race-condition note), finalize the batch, return a summary.
6. Decide and implement the sign-convention input (§5) — a single field in the upload request (e.g. `signConvention: "creditPositive" | "debitPositive"`), only consulted when no separate Debit/Credit columns are detected.
7. Add an `AuditLog` entry on batch completion (mirrors the existing `MANUAL_ASSET_ADD`/`WALLET_ADD` convention) — small, additive constant(s) in `lib/audit-actions.ts`.
8. Run `npx tsc --noEmit`, `npm run lint`, and the §11 fixture-file validation plan locally.
9. Write the implementation + validation report (same convention as every prior D2 step).

### File list (anticipated, none created by this investigation)

| File | Change |
|---|---|
| `app/api/accounts/[id]/import/route.ts` | New — POST handler |
| `lib/imports/csv.ts` (or similar) | New — parse/normalize/classify helper, designed for 4D-2 reuse |
| `lib/transactions/fingerprint.ts` | Possibly modified — only if §7 option (ii) is chosen; otherwise untouched |
| `lib/audit-actions.ts` | Modified — add import-related `AuditAction` constants |
| `prisma/schema.prisma` | Modified — `ImportBatch.matchedCount`, `ImportBatch.failedCount` |
| `prisma/migrations/<timestamp>_d2_4d1_importbatch_counters/` | New migration |
| `package.json` / `package-lock.json` | Modified — add `papaparse` |

### Schema impact

Two new additive `Int @default(0)` columns on `ImportBatch` (`matchedCount`, `failedCount`). **Zero new columns on `Transaction`** — confirms the 4D report's Option-B recommendation holds for this slice: `importBatchId` is governed by a behavioral rule (set only on CREATED rows), not a new discriminator column.

### Dependency impact

One new production dependency: `papaparse` (plus its types, if not bundled). No file-storage/blob-storage dependency is needed for this slice specifically — narrower than the general concern the 4D report raised. Because this MVP is a synchronous upload → parse → import → respond flow within a single HTTP request (no background job, no "resume a stuck import" requirement), the uploaded file's bytes only need to live in memory for the duration of one request; nothing needs to persist them afterward. The broader file-storage question the 4D report flagged becomes relevant only if a future slice needs async/background processing of large files — not 4D-1.

### Validation plan

See §11.

### Rollback plan (for this implementation step, not import-rollback — which is out of scope for 4D-1 by design)

4D-1 is purely additive: a new route, new `lib/` files, one new dependency, and two new defaulted columns that no existing code reads. Reverting the implementing commit(s) is sufficient to undo the feature; the two new `ImportBatch` columns are harmless if left unused (default `0`, no backfill needed, no existing row affected). No data migration or cleanup is required either way.

---

**Stopping here per scope. No implementation. No schema changes. No migrations. No file other than this one touched — verified via `git status --short` below.**
