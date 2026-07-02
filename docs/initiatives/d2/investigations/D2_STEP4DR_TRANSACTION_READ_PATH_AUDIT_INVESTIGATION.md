> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 4D-R — Transaction Read-Path Audit (Investigation)

Branch: `feature/phase-2-architecture`. Baseline: `v2.3.0`.

**Investigation only. No schema, code, or migration changes in this pass.**

## 0. Why this doc exists

`D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` §3/§7 named a precondition for shipping rollback (`ImportBatch.status = ROLLED_BACK` + `Transaction.deletedAt` soft-delete, tracked as "4D (remainder)" in `D2_ROADMAP.md`): every existing `Transaction` read must be re-checked for a `deletedAt: null` filter before the rollback write path can be trusted not to leave a soft-deleted row visible somewhere. That investigation counted **5** call sites, all read-only, all display-facing. Two more import slices (4D-1 CSV, 4D-2 Excel) have shipped since that count was taken, and this audit redoes the inventory from scratch rather than trusting the stale count. It finds **9** direct `Transaction` read call sites today, not 5 — and, more importantly, finds that the gap is not purely cosmetic: one of the four new sites sits on the **write** path of Plaid sync and CSV/Excel import alike, where an unfiltered match can silently and permanently swallow a real transaction, not just mis-render one. This doc is the gating checklist 4D's rollback sub-step (referred to here as 4D-R, distinct from 4D-3/rollback-itself) needs before that next implementation slice gets proposed.

## 1. Methodology

- Repo-wide search for `db.transaction.(findMany|findFirst|findUnique|count|aggregate|groupBy)` and the write-side equivalents (`update|updateMany|delete|deleteMany|create`), plus `prisma.transaction.` for `prisma/seed.ts`.
- Confirmed no raw SQL touches the `Transaction` table: `$queryRaw`/`$executeRaw` do not appear anywhere against this model (the one `$queryRaw` mention in the repo is a doc reference to D3's dual-write review confirming the *absence* of raw SQL there too).
- Traced every consumer of `lib/data/transactions.ts`'s three exports (`getTransactions`, `getDebtTransactions`, `getInvestmentTransactions`) and of `findByFingerprint`/`resolveFingerprintOutcome`. Consumers outside `lib/`/`app/api/` (`DashboardClient.tsx`, dashboard `page.tsx` files, `RecentTransactionsPanel.tsx`) only render an already-fetched array as props — none issues its own query, so they don't add new call sites.
- Confirmed `app/api/brief/route.ts` (Daily Brief) reads `SpaceAccountLink`/`FinancialAccount`/`SpaceSnapshot`/`AiAdvice`/`SpaceInvite` only — net worth is computed from `FinancialAccount.balance`, not from a `Transaction` aggregate — so it is **not** a Transaction read site and needs no change here.

## 2. Full inventory — 9 direct read call sites

| # | Call site | Purpose | Filters today | Needs `Transaction.deletedAt: null`? |
|---|---|---|---|---|
| 1 | `lib/data/transactions.ts:36` `getTransactions()` | Banking dashboard list | `financialAccount.deletedAt` (account-level only) | **Yes** |
| 2 | `lib/data/transactions.ts:67` `getDebtTransactions()` | Credit page list | same — account-level only | **Yes** |
| 3 | `lib/data/transactions.ts:96` `getInvestmentTransactions()` | Investments page list | same — account-level only | **Yes** |
| 4 | `app/api/accounts/[id]/transactions/route.ts:40` | Account-detail modal list | none at all | **Yes** |
| 5 | `lib/accounts/reconcile.ts:224` `pickCanonicalAndMerge()` → `count()` | "Which duplicate-account candidate has more history" decision during account merge | none | **Yes** |
| 6 | `lib/transactions/fingerprint.ts:62` `findByFingerprint()` | Shared match helper — called by **both** Plaid sync (`syncTransactions.ts:238`) and CSV/Excel import (`csv.ts:319`, via `resolveFingerprintOutcome`) | none | **Yes — highest priority, see §3** |
| 7 | `lib/imports/csv.ts:312` `resolveFingerprintOutcome()` exact-`externalTransactionId` match | CSV/Excel CREATE-vs-MATCH decision | none | **Yes — see §3** |
| 8 | `lib/imports/csv.ts:322` `resolveFingerprintOutcome()` ambiguity-candidates query | CSV/Excel MATCH-vs-SKIPPED decision | none | **Yes — see §3** |
| 9 | `lib/plaid/syncTransactions.ts:224` `findUnique` by `plaidTransactionId` | Plaid sync exact-match decision | none | **No — see §4, confirmed safe by construction** |

Sites 1–4 are exactly the "render this to a user" class of risk the original investigation flagged. Sites 5, 6, 7, 8 did not exist (6–8) or were not enumerated (5) when the original 5-site count was taken — 6–8 are net-new code from 4D-1, and 5 (`reconcile.ts`) was always there but wasn't in the original investigation's literal list. Site 9 is genuinely new analysis, not a gap in the original count — see §4.

Write-side call sites (`reconcile.ts:339` `updateMany`, `syncTransactions.ts:230/241` `update`, `syncTransactions.ts:264` `deleteMany`, `seed.ts:286` `deleteMany`) are out of scope for a *read*-path audit by definition, but one of them (`reconcile.ts:339`) needs an explicit "leave it alone" call-out — see §5.

## 3. The critical finding: `findByFingerprint` is a write-path chokepoint, not just a display gap

The original investigation framed the risk as "a rolled-back transaction reappears in the dashboard." That's true of sites 1–4 and 5. Sites 6–8 carry a worse failure mode, because `findByFingerprint` doesn't just decide what to *show* — it decides whether Plaid sync and CSV/Excel import **reuse an existing row** instead of creating a new one.

Walk the sequence once rollback exists and `findByFingerprint` is still unfiltered:

1. A CSV import creates `Transaction` row `T1` (real bank transaction, no Plaid history yet) with `importBatchId` set.
2. The user rolls back that batch. `T1.deletedAt` is set. `T1.importBatchId` is untouched (rollback doesn't clear it — it's the very column the rollback query keys on).
3. Days later, the real bank posts the same transaction to Plaid, and a normal sync run processes it. `syncTransactions.ts:238` calls `findByFingerprint(financialAccountId, date, amount, merchant, pending)`.
4. Unfiltered, that query's `where: { financialAccountId, date, amount, pending }` matches `T1` — `deletedAt` doesn't exist in the `where` clause, so a soft-deleted row is exactly as eligible as a live one.
5. `syncTransactions.ts:241` runs `db.transaction.update({ where: { id: fingerprintMatch.id }, data: { ...fields, plaidTransactionId: txn.transaction_id } })`. The `data` spread sets `plaidTransactionId` and refreshes `date`/`merchant`/`amount`/etc. — it does **not** clear `deletedAt`, because nothing about this code path knows `deletedAt` is even a concern.
6. Result: `T1` now has `plaidTransactionId` set (so a future Plaid sync will hit the exact-match path at line 224, not the fingerprint path) **and** `deletedAt` still set. The transaction is permanently invisible to every display read path, the sync log reports a clean `updatedByFingerprint++`, and there is no error, warning, or counter anywhere indicating data was lost. The user's real bank transaction silently never appears.

The same mechanism applies in reverse for sites 7–8: if a user rolls back a CSV batch and then **re-uploads the same file** expecting it to recreate the rows, `resolveFingerprintOutcome`'s exact-id check (line 312) or fingerprint fallback (line 319, via the shared helper) finds the soft-deleted row, classifies it MATCHED, and no-ops — the rollback is silently un-doable via the one mechanism (re-import) a user would actually try.

**This makes site 6 (`fingerprint.ts`) the single highest-leverage fix.** Both Plaid sync and CSV/Excel import funnel through it, so one `deletedAt: null` addition to its `where` clause closes the data-loss path for both producers at once. Sites 7 and 8 need the identical filter added to their own independent queries in `csv.ts` — they don't call through `fingerprint.ts` for these two checks, so fixing #6 alone does not fix #7/#8.

## 4. Why site 9 needs no change

`syncTransactions.ts:224`'s `findUnique({ where: { plaidTransactionId: txn.transaction_id } })` only ever matches a row that already carries a `plaidTransactionId`. Could such a row ever be the soft-delete target of an import rollback? No, by construction of the two pipelines' identifier discipline:

- Rollback's adopted design (`D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` §3, Option B) sets `Transaction.importBatchId` **only** on rows an import batch genuinely creates, never on rows it merely matches. Rollback's query is `WHERE importBatchId = batch.id`.
- A row only ever gets `plaidTransactionId` set by Plaid sync's own create/update paths (lines 230, 241, 253) — CSV/Excel import never writes that column.
- Therefore a row with `plaidTransactionId` set was never created by an import batch, never carries `importBatchId`, and can never be the target of an import rollback's soft-delete.

This invariant is load-bearing for §3's fix being sufficient — if a future change ever let an import-created row acquire a `plaidTransactionId` (or vice versa) without going through the fingerprint chokepoint, this exact-match site would need revisiting. Flagging that dependency explicitly rather than leaving it implicit.

## 5. The one site that must NOT get the filter

`reconcile.ts:339`, inside `mergeArchivedDuplicateIntoCanonical()`, re-points **every** transaction on a losing duplicate account to the winning canonical account: `db.transaction.updateMany({ where: { financialAccountId: loserId }, data: { financialAccountId: winnerId } })`. This must keep matching soft-deleted rows too. If it were narrowed to `deletedAt: null`, a soft-deleted transaction would be left behind on the archived loser account when its history migrates — orphaned, and at risk of resurfacing under the wrong account if that loser is ever individually restored. Every *read* site needs the filter; this one *write* site needs to keep ignoring `deletedAt` exactly as it does today. Calling this out by name so the eventual implementation checklist doesn't reflexively grep-and-filter every `db.transaction.*` call it finds.

## 6. Consolidation opportunities (flagged, not implemented)

Per the standing "additive, narrow slices" discipline, the recommendation below (§7) is to add the filter at each of the 8 sites independently rather than refactor now. Three refactor candidates are worth recording for a future cleanup step, not this one:

- **`csv.ts`'s two queries (7, 8) duplicate `fingerprint.ts`'s candidate-query shape** (`financialAccountId, date, amount, pending`/`false`) by design — 4D-1's own report already named this a deliberate clarity-over-micro-optimization tradeoff. Once both need the same `deletedAt: null` filter, a shared "candidates" query that both `findByFingerprint` and `resolveFingerprintOutcome` call would make it structurally impossible for the two to disagree on what counts as a candidate. Not proposed for this fix — would touch `fingerprint.ts`'s public signature, which 4C deliberately kept stable.
- **Sites 1–4 are four independently-maintained near-duplicate `OR`-clause blocks** (three in `lib/data/transactions.ts`, a fourth, simpler one in the account-detail route that doesn't import from `lib/data/transactions.ts` at all). A shared `transactionDeletedAtGuard`/visibility-where builder would reduce the risk of a future fifth call site forgetting the filter. Not proposed now — same reasoning as above.
- **`reconcile.ts`'s `count()` (5) and `updateMany` (write, §5) sit next to each other** in the same function and now need *opposite* `deletedAt` treatment. Worth a code comment at the point of fix making that asymmetry explicit in-line, not just in this doc.

## 7. Recommendation — the actual fix, proposed as its own separate, separately-approved slice

Not implemented in this doc. When approved, the smallest safe slice is: add `deletedAt: null` to the `where` clause of all 8 read sites in §2 (everything except site 9), in this priority order —

1. `lib/transactions/fingerprint.ts` `findByFingerprint()` — closes the data-loss path in §3 for both Plaid sync and CSV/Excel import in one change.
2. `lib/imports/csv.ts` lines 312 and 322 (`resolveFingerprintOutcome`'s own two queries) — closes the re-import-after-rollback gap §3 also describes; not covered by fix #1.
3. `lib/data/transactions.ts`'s three functions — display correctness for banking/credit/investments dashboards.
4. `app/api/accounts/[id]/transactions/route.ts` — display correctness for the account-detail modal; this one currently has no `deletedAt` filter at any level (not even account-level), so it needs the broader fix, not just the `Transaction`-level addition.
5. `lib/accounts/reconcile.ts`'s `count()` — decision-quality fix for account-merge canonical selection, lowest urgency since duplicate-account merges are rarer than dashboard reads or sync runs.

No schema change is required for any of this — `Transaction.deletedAt` already exists (4B). This is a `where`-clause-only diff across 6 files (`fingerprint.ts`, `csv.ts`, `transactions.ts`, the account-detail route, `reconcile.ts`) touching exactly the 8 identified query blocks, nothing else.

**Validation strategy for that future fix:** no test framework exists in this project (consistent with every prior step's finding). Recommend the same fixture/code-trace approach as 4D-1/4D-2, plus one scenario specific to §3's finding: create a transaction via CSV import, roll it back (once rollback itself ships), then run a Plaid-sync code trace against the same fingerprint inputs and confirm the fixed `findByFingerprint` returns `null` (→ CREATE, a new visible row) rather than reusing the dead row. `tsc --noEmit`/`npm run lint` as the baseline gate, same as every prior D2 step.

**Rollback plan for that future fix:** purely additive in the reversibility sense — adding `deletedAt: null` to an existing `where` clause is not a schema or migration change, and reverting each of the 8 edits independently is a normal code revert with zero data-loss risk in either direction (the column already exists and is already nullable/defaulted regardless of which sites read it).

## 8. Status relative to 4D-R / rollback gating

This audit is the "read-path audit" precondition `D2_ROADMAP.md`'s "4D (remainder)" row and `D2_STEP4D_IMPORT_PIPELINE_INVESTIGATION.md` §3/§7 both named as required before rollback ships. It is now complete as an investigation. The fix proposed in §7 is the next checklist item, pending its own approval per the project's working style (checklist → wait for approval → implement only that decision) — it has not been implemented here. Rollback itself (`ImportBatch.status = ROLLED_BACK`, 4D-3) remains gated on that fix landing and being validated first, not on this document alone.

---

**Stopping here per scope. No implementation. No schema changes. No migrations. No file other than this one touched — verify via `git status --short`.**
