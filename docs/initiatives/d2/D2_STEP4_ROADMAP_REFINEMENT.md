# D2 Step 4 — Roadmap Refinement

Status: **investigation/planning only. No code changes. No schema changes. No migrations. Step 4B implementation not started.**

Context: builds directly on `docs/initiatives/d2/D2_STEP4A_IMPORT_HISTORY_FOUNDATION_INVESTIGATION.md`. This report does not re-derive those findings — it uses them to decide whether Step 4 should be formally split before any implementation checklist is requested.

## 1. Is the proposed split architecturally cleaner than the current Step 4 definition?

Yes. The current single "Step 4 — Import & History Foundation" entry in `D2_ROADMAP.md` bundles three kinds of work with materially different risk profiles:

- pure additive schema (new table + nullable columns, nothing reads/writes them yet)
- a behavior-preserving refactor of code that has already been through three read-cutover steps (3D, 3F)
- net-new feature work with real product decisions (account-matching UX, file parsing, rollback UX)

Collapsing those into one step would mean one checklist, one impact map, and one validation pass covering work that doesn't share a failure mode. It also conflicts with the standing rule "do not implement all decisions in one branch or one commit." Splitting into 4A (done) / 4B / 4C / 4D mirrors exactly how Step 1 was split into 1A/1B/1C-A/1C-B/1C-C for the same reason. Recommend adopting the proposed structure.

## 2. Should 4C happen before any CSV import work?

Yes, and it should happen before 4D writes any CSV-specific dedupe logic — not necessarily before 4B.

4A already flagged that a third independent fingerprint implementation (after `reconcile.ts` and `syncTransactions.ts`) would be undesirable. If 4D built CSV dedupe first, it would either become that third implementation, or it would have to be rewritten the moment 4C lands. Sequencing 4C first means 4D's CSV dedupe is written once, against the shared helper, never as a throwaway.

4C and 4B are otherwise independent: 4C is a refactor of existing `reconcile.ts`/`syncTransactions.ts` code and touches no `ImportBatch`/`Transaction.importBatchId` surface at all. 4B is pure schema addition and doesn't touch the fingerprint helpers. Neither blocks the other — both must land before 4D, in either order or in parallel.

## 3. Are there additional schema fields required in 4B beyond what 4A proposed?

One concrete addition, two confirmed non-additions:

- **Addition:** `@@index([importBatchId])` on `Transaction`. 4A's design relies on "`ImportBatch.status = ROLLED_BACK` + `Transaction.importBatchId` makes undo a scoped query" — that scoped query (`WHERE importBatchId = ?`) needs an index to be safe at scale; 4A's draft listed the column but not this index. Recommend adding it to 4B's scope now rather than discovering the gap during 4D.
- **Not adding:** a `Transaction.source` enum (PLAID/MANUAL/IMPORT). Already flagged as deferred in 4A — provenance is inferable from which nullable field is populated. No new information from this review changes that; still recommend deferring, since adding it now would force a backfill-value decision for every existing row for no current consumer.
- **Not adding:** a DB-level unique constraint on `[financialAccountId, externalTransactionId]`. 4A flagged this as "decide at implementation time" because the real uniqueness shape depends on what actual CSV/QuickBooks exports look like — information 4D's design work will surface, not something to guess at in 4B. Leave `externalTransactionId` as a plain nullable column for now.

## 4. Should ImportBatch remain completely decoupled from ProviderCatalog and provider onboarding?

Yes, for all of 4B/4C/4D. `ImportBatch`'s only forward-compatible seam toward that world should be the nullable `connectionId` field already proposed in 4A's draft — mirroring the established `AccountConnection.connectionId` precedent (additive, nullable, unpopulated). That gives a future `Connection(provider=CSV)` + `ImportConnectionDetail` a place to attach without `ImportBatch` ever depending on either existing.

Coupling them now would block Step 4 on two things that aren't even scheduled: D2's own Step 5 (Adapter Interface) and the separate top-level D6/D7 ProviderCatalog decision. `ImportBatch` answers "what happened in this one upload"; `ImportConnectionDetail`/`ProviderCatalog` answer "what is this CSV source, as an institution choice." Keeping the layers decoupled is consistent with 4A's finding and nothing here changes that conclusion.

## 5. Are there risks in introducing `deletedAt` to `Transaction`?

The column itself, added in isolation in 4B, is low-risk: nothing will set it to non-null until a rollback path exists (4D), so no existing row's behavior changes the moment the column is added.

The risk is deferred, not eliminated, and needs to be someone's explicit job before 4D ships rollback:

- **Read-path audit.** Once something actually writes non-null `deletedAt` values, every existing `Transaction` read path needs to be checked for whether it should filter `deletedAt: null` — the transactions `GET` route, any net-worth/snapshot aggregation, `reconcile.ts`'s re-pointing of `Transaction` rows during an account merge. None of these need to change in 4B (nothing sets the column yet), but this audit should be an explicit early item inside 4D's own checklist, the same way Step 3A was an investigation-before-cutover step for `ProviderAccountIdentity`. Recommend not skipping straight to "add rollback" without it.
- **Dedupe-vs-soft-delete interaction.** If a rolled-back (soft-deleted) transaction's fingerprint/external-id would still match on re-import, the importer could perpetually treat the file as "already imported" and refuse to recreate rows the user explicitly restored via re-upload. Whichever of 4C/4D implements the dedupe lookup should filter `deletedAt: null` in that lookup once the column is in active use. Flagging now so it isn't missed later; not a 4B blocker since 4B doesn't wire up any lookup.

No risk to current Plaid sync, reconcile, or any other existing behavior from adding the column in 4B alone — confirmed nothing in `syncTransactions.ts` or `reconcile.ts` needs to change for the column to exist.

## 6. What is the smallest safe implementation slice after 4A?

Unchanged from 4A's recommendation, with the one addition from §3: **4B — schema only.** `ImportBatch` model, `Transaction.importBatchId` (+ index), `Transaction.externalTransactionId`, `Transaction.deletedAt`. No reads, no writes, nothing wired up anywhere. Validate with `prisma generate` / `migrate dev` / `tsc --noEmit` / `lint` only — same shape as Step 1A/1B's validation.

## Recommendation on roadmap structure

Adopt the proposed split. Replace the current single Step 4 entry in `D2_ROADMAP.md` with 4A (done)/4B/4C/4D as their own tracked sub-steps, each requiring its own implementation checklist and approval before work starts — consistent with how Step 1 is already broken out in that document. **Not applying this edit to `D2_ROADMAP.md` in this pass** — delivering it here as a draft for approval first, per "investigation only / stop after report."

## Proposed Step 4 section (draft — not yet applied to D2_ROADMAP.md)

```
## Step 4 — Import & History Foundation

### Step 4A — Investigation
✅ Complete. See docs/initiatives/d2/D2_STEP4A_IMPORT_HISTORY_FOUNDATION_INVESTIGATION.md.

### Step 4B — ImportBatch Foundation (schema only)
⏳ Planned. Not started.
- `ImportBatch` model (financialAccountId required FK, createdByUserId,
  nullable connectionId seam, source/status enums, rowCount/importedCount/
  skippedCount/errorSummary).
- `Transaction.importBatchId` (nullable FK) + `@@index([importBatchId])`.
- `Transaction.externalTransactionId` (nullable, no unique constraint yet).
- `Transaction.deletedAt` (nullable — net new column).
- No reads, no writes, nothing wired up. Validate via prisma generate /
  migrate dev / tsc / lint only.

### Step 4C — Shared Fingerprint Engine
⏳ Planned. Not started. Independent of 4B — may land before, after, or
   alongside it, but must land before 4D.
- Inventory lib/accounts/reconcile.ts and lib/plaid/syncTransactions.ts's
  existing, independently-implemented fingerprint logic.
- Extract one shared, normalized transaction-fingerprint helper
  (financialAccountId + date + amount + normalized merchant).
- Re-point syncTransactions.ts (and reconcile.ts's account-level fingerprint,
  if useful for symmetry) onto the shared helper — behavior-preserving,
  no new CSV behavior in this step.
- Goal: prevent a third independent fingerprint implementation from ever
  being written for CSV import.

### Step 4D — Import Pipeline
⏳ Planned. Not started. Depends on 4B and 4C both being complete.
- CSV / Excel / QuickBooks-export upload and parsing.
- User selects existing FinancialAccount before import (no fingerprint-
  based auto-account-creation from file contents — see 4A §5).
- Imported-row dedupe via the Step 4C shared helper (externalTransactionId
  exact match first, fingerprint fallback) — filtering deletedAt: null once
  rollback exists (see roadmap-refinement report §5).
- Rollback: ImportBatch.status = ROLLED_BACK, soft-delete via
  Transaction.deletedAt; read-path audit (which existing Transaction
  queries need a deletedAt: null filter) is its own checklist item inside
  this step, done before rollback ships.
- Optional create-new-account-from-import flow — explicitly optional/later,
  not Day-1.
- Historical backfill beyond Plaid's API retention window.
- Will likely need its own sub-lettering (4D-1/4D-2/...) once its
  implementation checklist is requested — biggest, most decision-laden
  piece of Step 4.
```

## Risks (consolidated)

- **4B:** none beyond the standard additive-schema risk already accepted for every prior D2 table — no backfill needed, rollback is a straight migration-down.
- **4C:** refactor risk on code already cut over three times (3D/3F); mitigate by keeping it behavior-preserving and its own commit, with no new CSV behavior riding along.
- **4D:** fingerprint over-merge (same caveat `reconcile.ts` already carries) — recommend skip-and-report over silent-merge for fingerprint-matched CSV duplicates; deletedAt/dedupe interaction (§5); read-path audit for deletedAt (§5); on-chain/crypto transaction import remains explicitly out of scope and unresolved, same as 4A noted.

## Suggested implementation order

4A (done) → 4B and 4C (either order, independent) → 4D (requires both).

## Suggested commit boundaries

One commit per sub-step, each with its own checklist/impact-map/rollback-plan/validation pass per standing working style:

- 4B: schema migration only.
- 4C: refactor only, zero behavior change, zero new tables/columns touched.
- 4D: will need further splitting into its own sub-steps when that checklist is requested (upload/parse, account-matching, dedupe wiring, rollback) — not decided in this report.

## Validation

| Check | Result |
|---|---|
| `git diff --stat` | Only this new file added; zero modifications to any existing file |
| Code changes | None |
| Schema changes | None |
| Migrations | None |

---

**Stopping here per scope. No edits to D2_ROADMAP.md, no Step 4B implementation, no schema changes, no migrations.**
