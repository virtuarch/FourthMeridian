> **CHECKLIST ONLY — no code, schema, or migration changes were made to produce this document.** Implementation is not authorized by this file. Governing design: `docs/initiatives/flowtype/P5_READ_CUTOVER_INVESTIGATION.md` (Slice 0 is the write-completion prerequisite). Prior: P1–P4 complete; DB fully backfilled.

# FlowType P5 Slice 0 — Import Write Completion (Implementation Checklist)

**Date:** 2026-07-04
**Branch:** `feature/v2.5-spaces-completion`
**Goal:** every transaction the CSV/Excel/QuickBooks import path *creates* (and any it *updates on match*) carries a current-version FlowType classification — so `flowType` becomes a trustworthy non-null invariant before any P5 reader depends on it.
**Status:** Checklist prepared — awaiting approval. Stop-after-checklist per instruction.

---

## 0. Contract

**In scope:** populate the FlowType columns on the import route's transaction **create** site, and re-classify on the **update-on-match** site (required — see §1.3), using the exact Phase B contract (`classifyFlow` + `buildFlowWriteFields`).

**Out of scope (hard stops):** ❌ read cutover · ❌ UI · ❌ AI assembler/dashboard changes · ❌ schema/migration · ❌ any change to import parsing, fingerprinting, counters, audit, or batch status. Only the transaction `data` objects gain flow columns.

**Confirmed scope boundary:** a full `transaction.create`/`createMany` sweep shows **only three** writers — `lib/plaid/syncTransactions.ts` (done in P3B), `app/api/accounts/[id]/import/route.ts` (this slice), and `prisma/seed.ts` (dev-only, out of scope). There is **no separate "manual add transaction" endpoint**; "manual" rows enter via this import route. So this slice closes the last production write gap.

---

## 1. The write sites (investigation #1)

`app/api/accounts/[id]/import/route.ts`, inside the per-row loop (`:305-372`). The whole batch targets one `financialAccountId` (an existing FinancialAccount — imports never target a legacy `Account`).

### 1.1 CREATE (`:323-337`) — the primary target
```ts
if (result.outcome === "CREATE") {
  await db.transaction.create({
    data: { financialAccountId, date, merchant, description, category, amount,
            pending: false, externalTransactionId, importBatchId: batch.id },
  });
  created++;
}
```
Currently writes **no** flow columns → new imported rows are null-`flowType`.

### 1.2 Inputs available here (investigation #2)
| Classifier input | Source at the create site |
|---|---|
| `category` | `row.category` (`NormalizedTransaction`, `TransactionCategory`) |
| `amount` | `row.amount` (non-null — guarded at `:308`) |
| `merchant` | `row.merchant` (non-null — guarded at `:308`) |
| `description` | `row.description` |
| `accountType` | `FinancialAccount.type` — **not currently loaded**; add a single lookup (§2.1) |
| `debtSubtype` | `FinancialAccount.debtSubtype` — same lookup |
| `pfcPrimary`/`pfcDetailed`/`pfcConfidenceLevel` | **none** — CSV/Excel/QuickBooks carry no Plaid PFC → `null` (investigation #4: yes, null) |
| `merchantEntityId` | **none** → `null` (investigation #4: yes, null) |

### 1.3 UPDATE-on-match (`:344-361`) — required for correctness, not optional
The QuickBooks update-on-match path applies `computeQuickBooksUpdateDiff` when an exact `externalId` match's `date/amount/merchant/description/category` changed. **If this path does not re-classify, a re-import that changes `category`/`amount` leaves `flowType` permanently stale** — and the P4 backfill will **not** fix it, because the row's `classifierVersion` stays current (backfill only re-selects `null`/`< version`). So the update must recompute flow columns whenever it applies a diff. This preserves the "`flowType` always matches the row's current `category`/`amount`" invariant that P5 readers rely on.

> **Decision point:** treat CREATE + UPDATE together as Slice 0 (recommended — the invariant needs both), or split UPDATE into Slice 0b. Recommendation: **together**, since the read cutover's correctness depends on no stale rows existing.

---

## 2. Exact write-field changes (investigation #3)

### 2.1 Load account context once (before the row loop)
```ts
const acctMeta = await db.financialAccount.findUnique({
  where: { id: financialAccountId },
  select: { type: true, debtSubtype: true },
});
const acct = { accountType: (acctMeta?.type as string | null) ?? null,
               debtSubtype: acctMeta?.debtSubtype ?? null };
```
One query per batch (all rows share the account). No new query per row.

### 2.2 CREATE — reuse the Phase B contract verbatim
```ts
const { input, captured } = buildFlowInputFromRow(
  { category: row.category, amount: row.amount, merchant: row.merchant,
    description: row.description, pfcPrimary: null, pfcDetailed: null,
    pfcConfidenceLevel: null, merchantEntityId: null },
  acct,
);
const flowFields = buildFlowWriteFields(classifyFlow(input), input, captured, FLOW_CLASSIFIER_VERSION);

await db.transaction.create({
  data: { financialAccountId, date: row.date, merchant: row.merchant,
          description: row.description, category: row.category, amount: row.amount,
          pending: false, externalTransactionId: row.externalTransactionId,
          importBatchId: batch.id, ...flowFields },
});
```
The 9 existing fields are byte-identical; `...flowFields` adds the 10 flow columns (`counterpartyAccountId: null`, `pfc*: null`, `merchantEntityId: null`, `classifierVersion = 1`).

### 2.3 UPDATE-on-match — recompute from incoming values, preserve existing PFC
Extend the existing `existing` select (`:347`) to also read `pfcPrimary, pfcDetailed, pfcConfidenceLevel, merchantEntityId`, then, when a `diff` is produced:
```ts
const { input, captured } = buildFlowInputFromRow(
  { category: row.category, amount: row.amount, merchant: row.merchant,
    description: row.description,
    pfcPrimary: existing.pfcPrimary, pfcDetailed: existing.pfcDetailed,
    pfcConfidenceLevel: existing.pfcConfidenceLevel, merchantEntityId: existing.merchantEntityId },
  acct,
);
const flowFields = buildFlowWriteFields(classifyFlow(input), input, captured, FLOW_CLASSIFIER_VERSION);
await db.transaction.update({ where: { id: result.transactionId }, data: { ...diff, ...flowFields } });
```
Re-feeding the existing PFC (rather than nulling it) means a matched row **never loses** provider hints while `flowType` is recomputed from the new `category`/`amount`. (In practice import-created rows have null PFC, but this is safe against any cross-source match.) The update stays gated on a non-empty `diff`, so an unchanged row is not touched.

### 2.4 Imports (module)
Add to the route: `buildFlowInputFromRow, buildFlowWriteFields` from `@/lib/transactions/plaid-flow-input`; `classifyFlow, FLOW_CLASSIFIER_VERSION` from `@/lib/transactions/flow-classifier`. No new helper is needed — `buildFlowInputFromRow` already accepts exactly this row shape.

---

## 3. Investigation answers

- **#4 — pfc*/merchantEntityId null for import-created rows?** **Yes** for CREATE (no provider taxonomy exists in CSV/Excel/QuickBooks). For UPDATE-on-match, **preserve** whatever the existing row had (re-fed), never force-null.
- **#5 — proving no behavior change except flow columns:** the create/update `data` objects gain *only* the flow columns; all import mechanics (parse, `resolveFingerprintOutcome`, counters `created/matched/updated/skipped/failed`, `errors`, audit entry, `ImportBatch` status) are untouched. Proof method: diff review + a fixture import asserting identical counts and identical non-flow columns pre/post (§5).
- **#6 — re-run P4 dry-run:** after the change, `npx tsx scripts/backfill-flowtype.ts` reports **0** to classify (all rows current); importing a fresh CSV then re-running still reports **0**; `--apply` also finds 0. This is the invariant proof.

---

## 4. Impact map

| Path | Change |
|---|---|
| `app/api/accounts/[id]/import/route.ts` | Load `acct` once (§2.1); add `...flowFields` to the CREATE `data` (§2.2); extend the update-on-match `existing` select + add `...flowFields` to the update `data` (§2.3); add 2 imports (§2.4). |

**Untouched:** parsing (`lib/imports/*`), fingerprinting, provider capabilities, `ImportBatch` counters/status, audit, rollback, reconcile, seed, schema, all readers, all UI, the classifier, and `buildFlowWriteFields`.

**Non-impact assertions:** import counts and outcomes identical; no read path reads the new columns; only the two `data` objects change.

---

## 5. Tests

- **Pure (reuse/extend):** a CSV-shaped case through `buildFlowInputFromRow` → `buildFlowWriteFields` asserting `flowType` set, `pfc*`/`merchantEntityId` null, `counterpartyAccountId` null, `classifierVersion = 1`. Largely covered by `flow-row-input.test.ts` / `plaid-flow-write.test.ts`; add one explicit CSV/null-PFC case.
- **Integration (host — needs DB):**
  - Import a fixture CSV → created rows have non-null `flowType`/`flowDirection`/`classifierVersion=1`, null `pfc*`/`merchantEntityId`.
  - **Behavior-invariance:** same `created/matched/skipped/failed` counts and identical `category/amount/merchant/date/pending/externalTransactionId/importBatchId` as a pre-Slice-0 baseline.
  - **Update-on-match re-classify:** a QuickBooks re-import that changes a row's `category` updates `flowType` accordingly; one that changes nothing writes nothing.
- **Regression:** existing import-route tests; P1–P4 pure suites; KD-17/KD-18/output-validator (unaffected — no read/AI change).

---

## 6. Validation checklist

- [ ] `npx prisma generate` — no schema change; client unchanged.
- [ ] `npx prisma migrate dev` — **no-op**; confirm no migration.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] Pure flow suites green (`flow-row-input`, `plaid-flow-write`, classifier, input).
- [ ] **Diff review:** only the two `data` objects gained flow columns; no other import logic changed.
- [ ] **Fixture import (host):** new rows have flow columns; import counts identical to baseline; non-flow columns identical.
- [ ] **Update-on-match (host):** category change re-classifies; no-op change writes nothing.
- [ ] **Invariant proof:** `npx tsx scripts/backfill-flowtype.ts` → 0 to classify; import a CSV → re-run → still 0; `--apply` → 0.
- [ ] KD-17/KD-18/output-validator suites green, unchanged.

---

## 7. Rollback plan

- **Code-only.** Revert the import-route hunks (the `acct` lookup, the two `...flowFields` additions, the extended select, the 2 imports). New imports revert to null-`flowType` rows — **harmless pre-read-cutover** (nothing reads the column yet), and a later backfill `--apply` would re-fill them.
- **No schema/migration to reverse.** **Blast radius:** confined to what the import route writes into existing nullable columns; existing rows and all other behavior untouched.

---

## 8. Exit criteria

- The import route populates flow columns on create and re-classifies on applied update-on-match, via the same `classifyFlow` + `buildFlowWriteFields` contract as the sync path.
- `pfc*`/`merchantEntityId` null for created rows; preserved on matched rows; `counterpartyAccountId` null throughout.
- Import behavior (counts, fingerprinting, audit, status) byte-identical except the new columns (proven by diff + fixture).
- P4 dry-run reports **0** remaining after a fresh import — the "every row has current `flowType`" invariant holds, unblocking the P5 reader migration (Slice 1+).
