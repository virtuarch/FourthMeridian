> **CHECKLIST ONLY — no code, schema, or migration changes were made to produce this document.** Implementation is not authorized by this file. Governing design: `docs/investigations/FLOWTYPE_FOUNDATION_INVESTIGATION.md`, `docs/initiatives/flowtype/P3_SCHEMA_DESIGN_INVESTIGATION.md`. Prior: P1 (classifier), P2 (shadow), P3 Phase A (schema), P3 Phase B (write-time population — committed).

# FlowType P4 — Historical Backfill (Implementation Checklist)

**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion`
**Initiative:** v2.5.5 Financial Intelligence — Transaction Semantics
**Phase:** P4 (classify existing rows). Depends on P3 Phase A + B.
**Status:** Checklist prepared — awaiting approval. Stop-after-checklist per instruction.

---

## 0. P4 contract

**Goal:** give every historical `Transaction` the same flow columns Phase B now writes for new Plaid syncs — using the **exact same classifier + write-field contract**, sourced from the row's own stored columns instead of a live Plaid payload. Reads, totals, AI, and the KD-18 guardrail stay untouched; this only fills already-existing inert columns.

**In scope**
- A re-runnable backfill script over existing `Transaction` rows.
- One small pure helper to assemble classifier inputs *from a DB row* (the only new logic — §2.2).

**Out of scope (hard stops)**
- ❌ Read cutover / assembler / dashboard totals / KD-18 relaxation (P5) · ❌ UI · ❌ schema/migration · ❌ new *classification* logic in `flow-classifier.ts` (frozen; the helper only assembles inputs) · ❌ counterparty inference (leave `counterpartyAccountId` null — §4) · ❌ touching `category`/`amount`/`merchant`/`date`/account FKs (§5).

**Reused unchanged from Phase B:** `classifyFlow`, `buildFlowWriteFields`, `FLOW_CLASSIFIER_VERSION`, `NULL_FLOW_WRITE_FIELDS`. The backfill and the sync write therefore classify identically — the whole point of P4.

---

## 1. Which rows need classification (investigation #1)

**Selection predicate (idempotent + resume-safe + version-aware):**
```
flowType IS NULL
  OR flowDirection IS NULL
  OR classifierVersion IS NULL
  OR classifierVersion < FLOW_CLASSIFIER_VERSION
```
Prisma form:
```ts
where: {
  OR: [
    { flowType: null },
    { flowDirection: null },
    { classifierVersion: null },
    { classifierVersion: { lt: FLOW_CLASSIFIER_VERSION } },
  ],
}
```
- **Idempotency:** a row already classified at the current version fails every clause → skipped. A second full run finds **0 rows**.
- **Resume safety:** a crash mid-run leaves completed rows at the current version; re-running continues on the remainder only.
- **Future version bumps:** when the classifier improves and `FLOW_CLASSIFIER_VERSION` increments, the `< version` clause re-selects stale rows automatically — no separate migration.
- **`deletedAt` rows:** included by default (the columns are inert and classifying them keeps the table uniform); may be excluded to save work — a documented toggle, default include.

---

## 2. Required inputs (investigation #2) and the one new helper

### 2.1 Inputs, all already on the row or its account
| Classifier input | Source |
|---|---|
| `category`, `amount`, `merchant`, `description` | `Transaction` columns (always present) |
| `accountType` | `Transaction.financialAccount.type` (FK path) **or** `Transaction.account.type` (legacy path) |
| `debtSubtype` | `Transaction.financialAccount.debtSubtype` (FinancialAccount only; **null** for legacy `Account` — it has no such column) |
| `pfcPrimary` / `pfcDetailed` | `Transaction.pfcPrimary` / `pfcDetailed` (present on P2-forward rows; null on historical) |
| `pfcConfidenceLevel`, `merchantEntityId` | `Transaction.pfcConfidenceLevel` / `merchantEntityId` (present P2-forward; null historical) |

Historical rows have null pfc/merchant → **coarse** classification from `category`+sign+`accountType` (correct-by-design, foundation §6.1). P2-forward rows selected by a future version bump re-feed their stored pfc → **finer** classification. Either way, the stored pfc/merchant values are **preserved** (read from the row, written back identical).

### 2.2 The one small helper (justified per scope)
Phase B builds classifier inputs from a *Plaid txn* (`buildPlaidFlowInput`). The backfill has **no Plaid txn** — it must build the same `FlowClassificationInput` + `CapturedPlaidMetadata` from *DB columns*. This is the single new piece:

```ts
// lib/transactions/plaid-flow-input.ts (additive; pure; classifier untouched)
export function buildFlowInputFromRow(
  row: { category: string; amount: number; merchant: string | null; description: string | null;
         pfcPrimary: string | null; pfcDetailed: string | null;
         pfcConfidenceLevel: string | null; merchantEntityId: string | null },
  acct: { accountType: string | null; debtSubtype: string | null },
): { input: FlowClassificationInput; captured: CapturedPlaidMetadata } {
  return {
    input: {
      category: row.category, amount: row.amount, merchant: row.merchant,
      description: row.description, accountType: acct.accountType, debtSubtype: acct.debtSubtype,
      pfcPrimary: row.pfcPrimary, pfcDetailed: row.pfcDetailed,
    },
    captured: {
      pfcConfidenceLevel: row.pfcConfidenceLevel,
      merchantEntityId:   row.merchantEntityId,
      counterparties:     [], // never persisted (deny-listed in P2); nothing to reconstruct
    },
  };
}
```
It contains **no classification logic** — it only marshals stored fields into the shapes `classifyFlow` + `buildFlowWriteFields` already consume. The classifier and write-field builder are reused verbatim.

---

## 3. Backfill strategy (investigation #3)

### 3.1 Script shape (mirrors `scripts/backfill-provider-account-identity.ts`)
`scripts/backfill-flowtype.ts`, standalone `tsx`, `new PrismaClient({ log: ["error","warn"] })`, `main().catch(...)`.

Flags:
- `--dry-run` (**default behavior**, see §3.2) — compute + report, **zero writes**.
- `--apply` — actually write. Required to mutate.
- `--verbose` — per-row `id → flowType/reason` only (no merchant/amount/PII).
- `--batch=N` — batch size (default 500).
- `--limit=N` — cap rows processed this run (for staged rollout).

Optionally add `"backfill:flowtype": "tsx scripts/backfill-flowtype.ts"` to `package.json` scripts (matches `backfill:ai-agents`).

### 3.2 Dry-run default (deliberate safety divergence)
The provider-identity backfill defaults to LIVE; for the highest-write table, P4 **defaults to dry-run** and requires `--apply` to write. Rationale: a table-wide pass deserves an explicit write opt-in after the operator reviews the distribution. (Documented divergence, not an oversight.)

### 3.3 Batching, idempotency, resume
- **Keyset pagination** by `id` (not offset): `where: { AND: [ <§1 predicate>, { id: { gt: lastId } } ] }, orderBy: { id: "asc" }, take: BATCH`. Resume-safe and drift-free even as rows are updated out from under the cursor (an updated row no longer matches the predicate but keyset still advances by id).
- **Idempotency** from the §1 version predicate — re-runs converge to 0.
- **Per-batch progress log**: `[batch k] scanned=… classified=… (running total …)`.

### 3.4 Report + unknown-rate (reuse the P2 shadow accumulator)
Both dry-run and `--apply` feed each classification into the existing `createShadowStats`/`accumulateShadow`/`summarizeShadow` helpers, then print at the end:
- rows matched / would-update (dry-run) or updated (`--apply`),
- `flowType` distribution, `flowDirection` distribution, `reason` distribution,
- **UNKNOWN count + rate**,
- **legacy-bucket agreement %** (same metric P2 shadow emitted — the sanity check that historical classification matches the assembler's current partition),
- count of rows classified from pfc (fine) vs. coarse.
All aggregate, **non-PII** (§5). Compare the dry-run distribution to the P2 `FLOWTYPE_SHADOW=count` numbers before approving `--apply`.

### 3.5 Before/after comparison
A companion read-only reporter `scripts/verify-flowtype-backfill.ts` (mirrors `verify-provider-account-identity-backfill.ts`) prints current column-fill state: total rows, classified vs. null, `classifierVersion` histogram, UNKNOWN count. Run it **before** and **after** `--apply` to confirm the delta equals the backfilled count and null-count drops to zero (modulo any excluded set). (Alternatively a `--verify` flag on the main script.)

---

## 4. Counterparty strategy (investigation #4)

- `counterpartyAccountId` is written **null** for every backfilled row — `buildFlowWriteFields` already hard-codes null; the backfill does not override it.
- **No card-destination inference from merchant names.** Deterministic destination attribution is a read-side rollup (the card leg already sits on its own account); it is *not* a stored pointer to fabricate here.
- **No source-side transfer attribution invented.** Left null and honest, per KD-18 doctrine ("do not invent data").
- Destination attribution therefore requires **zero backfill** — the data was never missing from the DB, only from the (P5) rollup.

---

## 5. Safety (investigation #5)

- **Writes only the flow columns.** The update `data` is exactly `buildFlowWriteFields(...)` output — the 10 flow columns and nothing else. `category`, `amount`, `merchant`, `date`, `pending`, `accountId`, `financialAccountId`, `importBatchId`, timestamps are **never** in the update payload.
- **Re-runnable** (§1 predicate) and **crash-safe** (keyset resume).
- **No writes in dry-run** (the default) — writes happen only under `--apply`.
- **Aggregate logs only, no PII** — the report uses `summarizeShadow` (counts only); `--verbose` prints `id + flowType + reason`, never merchant/amount/description/counterparty.
- **Determinism = idempotency:** `classifyFlow` is pure, so re-classifying an unchanged row yields identical columns.

---

## 6. Update query design (investigation, §3/§5)

Per batch:
1. **Select** (keyset, §3.3) with the account join:
   ```ts
   select: {
     id: true, category: true, amount: true, merchant: true, description: true,
     pfcPrimary: true, pfcDetailed: true, pfcConfidenceLevel: true, merchantEntityId: true,
     account:          { select: { type: true } },              // legacy path
     financialAccount: { select: { type: true, debtSubtype: true } }, // canonical path
   }
   ```
2. **Classify** per row: resolve `accountType`/`debtSubtype` from whichever relation is set → `buildFlowInputFromRow` → `classifyFlow` → `buildFlowWriteFields(…, FLOW_CLASSIFIER_VERSION)`.
3. **Write** (only under `--apply`): `db.transaction.update({ where: { id }, data: flowWriteFields })` — data limited to the 10 flow columns.
   - **Optimization (later, not first slice):** group rows by identical classification and `updateMany({ where: { id: { in } }, data })` to cut round-trips. First slice uses per-row `update` for correctness clarity.

---

## 7. Tests (investigation #6)

Pure `tsx` scripts, no DB:
- **`buildFlowInputFromRow`** (`lib/transactions/flow-row-input.test.ts` or extend `plaid-flow-input.test.ts`): correct input/captured; pfc/merchant preserved from row; `counterparties === []`; legacy account (debtSubtype absent) → `debtSubtype: null`; FinancialAccount → debtSubtype passed; null-safety on all-null pfc.
- **Composed backfill unit** (helper → classify → write-fields): representative rows (a spending debit, a Payment, a historical row with null pfc, a P2-forward row with pfc) produce the expected `flowType`, `counterpartyAccountId === null`, and `classifierVersion === FLOW_CLASSIFIER_VERSION`.
- **Idempotency/version:** assert the §1 predicate excludes a row already at current version (extract the predicate as a pure builder to test it), and that `buildFlowWriteFields` output is byte-identical across two calls (determinism).
- **Regression (host):** P1/P2/P3B suites, KD-17, KD-18, output-validator — green, unchanged.
- **Script behavior** (manual/staging): dry-run writes nothing (row-count of classified rows unchanged); `--apply` fills all matched rows; immediate re-run reports 0 to do.

---

## 8. Impact map & exact files

| Path | Change |
|---|---|
| `lib/transactions/plaid-flow-input.ts` | **Add** pure `buildFlowInputFromRow(...)` (§2.2). No change to existing exports/classifier. |
| `scripts/backfill-flowtype.ts` | **New** — the backfill script (§3, §6). |
| `scripts/verify-flowtype-backfill.ts` | **New** (optional) — read-only state reporter (§3.5). |
| `lib/transactions/flow-row-input.test.ts` | **New** — helper + composed-unit tests (§7). |
| `package.json` | **Optional** — add `backfill:flowtype` script entry. |

**Untouched:** `flow-classifier.ts` (logic), `syncTransactions.ts`, assemblers, `annotations.ts`, `lib/data/transactions.ts`, all UI, KD-18 guardrail, schema/migrations.

**Non-impact assertions:** no read path change; reads/totals/AI byte-identical; only flow columns on existing rows are written; `counterpartyAccountId` stays null.

---

## 9. Dry-run / report output design (§3.4)

```
[DRY RUN] FlowType backfill — no writes
Selection: flowType/flowDirection/classifierVersion null OR classifierVersion < 1
Scanned:                 42,318
Would classify:          42,318   (already current: 0)
  from PFC (fine):        1,204
  coarse (category+sign): 41,114
flowType {SPENDING=28,110, TRANSFER=5,902, INCOME=3,880, DEBT_PAYMENT=2,301, REFUND=1,447, FEE=402, INTEREST=196, INVESTMENT=51, ADJUSTMENT=15, UNKNOWN=? }
UNKNOWN:                 ?  ( ?% )
legacyBucketAgreement:   41,9xx / 42,318  ( 99.x% )
counterpartyAccountId:   null for all (by design)
Dry run only — re-run with --apply to write.
```
`--apply` prints the same with "Updated:" and drops the "Dry run only" line.

---

## 10. Rollback plan

- **Preferred: nothing to roll back.** Backfilled values are inert pre-P5 and are the correct classifier output. A classifier fix ships as a `FLOW_CLASSIFIER_VERSION` bump + a re-run (which re-classifies stale rows) — not a rollback.
- **Hard clear (if ever needed):** a one-statement `UPDATE "Transaction" SET "flowType"=NULL, "flowDirection"=NULL, "classificationConfidence"=NULL, "classificationReason"=NULL, "classifierVersion"=NULL, "pfcPrimary"=NULL, ... WHERE "classifierVersion" = <N>` reverts a specific version's output. Optional; not part of normal operation.
- **Code rollback:** delete the script(s) + helper; no runtime path depends on them. **Blast radius:** none to reads/totals/AI/UI/schema (pre-P5).

---

## 11. Validation checklist

- [ ] `npx prisma generate` — no schema change; client unchanged.
- [ ] `npx prisma migrate dev` — **no-op**; confirm no migration.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npx tsx lib/transactions/flow-row-input.test.ts` — green.
- [ ] P1/P2/P3B, KD-17, KD-18, output-validator suites — green, unchanged.
- [ ] **Dry-run on a prod snapshot:** zero writes (classified-row count unchanged); distribution printed; UNKNOWN-rate + legacy-bucket-agreement consistent with the P2 shadow numbers.
- [ ] **`--apply` on snapshot:** matched rows filled; **immediate re-run reports 0 to do** (idempotent).
- [ ] **Immutable-field proof:** checksum/sample `category,amount,merchant,date,accountId,financialAccountId` for a row set before and after `--apply` → identical.
- [ ] `counterpartyAccountId` null for every backfilled row.
- [ ] `verify-flowtype-backfill.ts` before/after: null-count delta equals backfilled count.
- [ ] Read side unaffected: an AI answer + dashboard totals byte-identical pre/post (nothing reads flow columns yet).

---

## 12. Recommended first implementation slice

1. **`buildFlowInputFromRow` + its tests** — pure, mergeable on its own, fully verifiable without a DB. Establishes the row→classifier contract.
2. **`scripts/backfill-flowtype.ts` in dry-run-default** with the §9 report (keyset scan, shadow-accumulator distribution) — but do **not** run `--apply` yet.
3. **Operational step (separate approval):** run dry-run on a prod snapshot, review the distribution against the P2 shadow baseline, then run `--apply` in `--batch`/`--limit` stages, with `verify-flowtype-backfill.ts` before/after.

Slice 1 is the safe, self-contained merge; slices 2–3 gate the actual data write behind a reviewed dry-run. This keeps P4 correctness-first and reversible, and leaves the write path and the backfill sharing one classification contract for P5's read cutover.
