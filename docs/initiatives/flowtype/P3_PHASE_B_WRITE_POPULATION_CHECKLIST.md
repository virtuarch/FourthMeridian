> **CHECKLIST ONLY — no code, schema, or migration changes were made to produce this document.** Implementation is not authorized by this file. Governing design: `docs/investigations/FLOWTYPE_FOUNDATION_INVESTIGATION.md`, `docs/initiatives/flowtype/P3_SCHEMA_DESIGN_INVESTIGATION.md`. Prior: P1 (classifier), P2 (import fidelity/shadow), P3 Phase A (additive schema — applied).

# FlowType P3 Phase B — Write-Time Population (Implementation Checklist)

**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion`
**Initiative:** v2.5.5 Financial Intelligence — Transaction Semantics
**Phase:** P3 Phase B (persist classifier output on new Plaid writes). Depends on P3 Phase A.
**Status:** Checklist prepared — awaiting approval. Stop-after-checklist per instruction.

---

## 0. Phase B contract

**Goal:** promote the P2 *shadow* classification into a *real* write. Every transaction the Plaid sync creates or updates from now on carries its `flowType` classification in the Phase-A columns. Reads, totals, AI, and the KD-18 guardrail are all untouched — this only starts *filling* the columns going forward.

**In scope**
- Populate the FlowType columns on the Plaid sync **create** and **update** paths.
- Compute the classification unconditionally (it feeds the write now, not just observability).

**Out of scope (hard stops)**
- ❌ Historical backfill (P4) · ❌ read cutover / assembler / dashboard totals / KD-18 relaxation (P5) · ❌ UI · ❌ CSV/manual import population (Plaid-only this phase; those paths get the same treatment in a sibling step) · ❌ schema/migration changes (Phase A is done) · ❌ changes to classification *logic* in `flow-classifier.ts` (only an additive version constant — §3).
- ❌ `counterpartyAccountId` population — deliberately left null this phase (§5).

**Guiding invariant:** the 7 pre-existing `fields` values (`financialAccountId, date, merchant, description, category, amount, pending`) and all matching/dedup logic remain byte-identical; Phase B only *adds* columns to the same write.

---

## 1. Investigation findings

### 1.1 The three write sites all derive from one `fields` object (`syncTransactions.ts`)
- `:261` builds `fields`.
- `:289` exact-plaidId update → `data: fields`.
- `:300-303` fingerprint-match update → `data: { ...fields, plaidTransactionId }`.
- `:312` create → `data: { ...fields, plaidTransactionId }`.

**Consequence:** adding the flow columns to `fields` once populates **all three** paths (create + both updates) automatically. This is the single point of change.

### 1.2 The P2 shadow block already computes exactly what Phase B must write
`:266-279` already resolves account meta, calls `buildPlaidFlowInput`, and runs `classifyFlow` — but only when `FLOWTYPE_SHADOW` is enabled, and discards the result. Phase B **moves this computation above `fields`, makes it unconditional, and merges its output into `fields`**. The `FLOWTYPE_SHADOW` flag's role shrinks to optional summary logging only.

### 1.3 `modified` transactions reclassify for free
Plaid's `modified` array flows through the same create/update loop. Because `fields` (now carrying flow columns) is used on the update paths, a `modified` row that changed `category`/`amount` is **re-classified on update** — the desired behavior, no special handling.

---

## 2. Impact map

### 2.1 Files modified

| Path | Change |
|---|---|
| `lib/plaid/syncTransactions.ts` | Move classification above `fields`, make it unconditional (was shadow-gated); build flow write-fields via a pure helper and spread into `fields`; rename `resolveAccountMetaForShadow`→`resolveAccountMeta` (now always used); keep the `FLOWTYPE_SHADOW=count` summary log as optional observability; wrap classification in try/catch so a failure writes null flow columns and never blocks the row. Add `@prisma/client` enum imports. |
| `lib/transactions/plaid-flow-input.ts` | Add a pure `buildFlowWriteFields(classification, input, captured, version)` returning the Prisma-typed column subset, with compile-time enum-parity mapping records (§4). No change to existing exports. |
| `lib/transactions/flow-classifier.ts` | **Additive only** — `export const FLOW_CLASSIFIER_VERSION = 1;` (§3). No classification logic touched. (Decision point — see §3 for the alternative location.) |

### 2.2 Files created

| Path | Purpose |
|---|---|
| `lib/transactions/plaid-flow-write.test.ts` | Pure tests for `buildFlowWriteFields` + enum-parity guards (§7). (Could instead extend `plaid-flow-input.test.ts`; new file keeps Phase B isolated.) |

### 2.3 Untouched (explicit)
`lib/ai/assemblers/*`, `lib/ai/intelligence/annotations.ts`, `lib/data/transactions.ts`, all dashboards/UI, the KD-18 guardrail (`app/api/ai/chat/*`), CSV/manual import paths, and `prisma/schema.prisma`.

### 2.4 Non-impact assertions
- The 7 original `fields` values and every `db.transaction.create/update/deleteMany` **call shape** are unchanged; only `fields` gains keys.
- No read path reads the new columns (still Phase A-inert on the read side).
- Reads/totals/AI output byte-identical; KD-17/KD-18/AI-4/P1/P2 suites green.

---

## 3. `classifierVersion` value

- **Value:** `1` — the P1/P3B ruleset. A monotonic Int (per P3 design §2.2); the human-readable mapping (1 = P1 rules) lives in the module doc, not the DB.
- **Where defined:** recommend `export const FLOW_CLASSIFIER_VERSION = 1;` in `lib/transactions/flow-classifier.ts` — the version is a property *of the classifier*, and P4/P5 re-classification will compare `classifierVersion < FLOW_CLASSIFIER_VERSION`. This is an **additive constant, not a logic change**; the P1 test suite is unaffected.
- **Alternative (if `flow-classifier.ts` must stay byte-frozen):** define the constant in `plaid-flow-input.ts` instead. Functionally identical; slightly less semantically located. **Recommendation: define in `flow-classifier.ts`.**
- **Bump discipline:** any future change to classification *logic* increments this constant so backfill/re-classification can target stale rows. Documented next to the constant.

---

## 4. Exact columns to write + enum mapping

`buildFlowWriteFields(...)` returns this object, spread into `fields`:

| Column | Source | Notes |
|---|---|---|
| `flowType` | `classification.flowType` | mapped to Prisma `FlowType` (§4.1) |
| `flowDirection` | `classification.flowDirection` | mapped to Prisma `FlowDirection` |
| `classificationConfidence` | `classification.confidence` | `Float` 0..1 |
| `classificationReason` | `classification.reason` | mapped to Prisma `FlowClassificationReason` |
| `classifierVersion` | `FLOW_CLASSIFIER_VERSION` | `1` |
| `pfcPrimary` | `input.pfcPrimary` | `string \| null` (from `personal_finance_category.primary`) |
| `pfcDetailed` | `input.pfcDetailed` | `string \| null` |
| `pfcConfidenceLevel` | `captured.pfcConfidenceLevel` | `string \| null` |
| `merchantEntityId` | `captured.merchantEntityId` | `string \| null` |
| `counterpartyAccountId` | **`null`** | deliberately null this phase — §5 |

### 4.1 How classifier output maps to Prisma enum values
The classifier's TS unions (`FlowType`, `FlowDirection`, `FlowReason`) were promoted 1:1 into the Phase-A Postgres enums (`FlowType`, `FlowDirection`, `FlowClassificationReason`) — **identical member names**. The mapping is therefore identity, but it must be made **drift-proof at compile time**, not assumed:

```ts
import { FlowType as PFlowType, FlowDirection as PFlowDirection,
         FlowClassificationReason as PReason } from "@prisma/client";
import type { FlowType, FlowDirection, FlowReason } from "./flow-classifier";

// Exhaustive Record<classifierUnion, prismaEnum> — adding a classifier value
// without updating this map is a COMPILE ERROR.
const FLOW_TYPE_TO_PRISMA: Record<FlowType, PFlowType> = {
  SPENDING: PFlowType.SPENDING, INCOME: PFlowType.INCOME, REFUND: PFlowType.REFUND,
  DEBT_PAYMENT: PFlowType.DEBT_PAYMENT, TRANSFER: PFlowType.TRANSFER,
  INVESTMENT: PFlowType.INVESTMENT, FEE: PFlowType.FEE, INTEREST: PFlowType.INTEREST,
  ADJUSTMENT: PFlowType.ADJUSTMENT, UNKNOWN: PFlowType.UNKNOWN,
};
// …and FLOW_DIRECTION_TO_PRISMA, REASON_TO_PRISMA likewise.
```

This gives a two-way guarantee: the `Record<Union, …>` key set forces every classifier value to be mapped, and `PFlowType.X` forces the target to exist in the Prisma enum. Drift in either direction fails `tsc`.

---

## 5. Columns deliberately left null in Phase B

- **`counterpartyAccountId` → `null`.** Rationale (P3 design §6, foundation §5): the *deterministic* destination attribution (a card-side payment leg already sits on its own liability account) is a **read-side rollup**, not a stored pointer — nothing to write here. The *source-side* pointer (checking→which card) is heuristic and is deferred to P4/P5. Writing a guessed value now would violate "do not invent data." Null is the correct, honest Phase-B value.
- **`pfc*` / `merchantEntityId`** are written **when Plaid supplies them** and left null otherwise (payroll/transfers often have no merchant entity; that is expected, not a gap).

---

## 6. Update vs. create & pending behavior

- **Create + both update paths** all write the flow columns (they share `fields`). Updates re-classify — correct for Plaid `modified` rows whose `category`/`amount` changed.
- **Pending transactions** are classified and written **identically** — `flowType` does not depend on `pending`. When a pending row later posts, the update path (or a new row) re-classifies it. No special handling; the assembler's separate pending/settled treatment is read-side and unchanged.
- **`deleteMany` (removed) path** is untouched — deletes remove the row (and its flow columns) as before.
- **Classification failure is non-fatal:** the compute is wrapped so an exception yields all-null flow columns and the row still writes with its original 7 fields — sync robustness is never reduced.

---

## 7. Tests

Pure, standalone `tsx` scripts (repo convention), no DB:

- **`buildFlowWriteFields` shape:** returns all 10 flow columns; `counterpartyAccountId === null`; `classifierVersion === FLOW_CLASSIFIER_VERSION`; pfc/merchant fields pass through from input/captured; confidence/reason/type/direction come from the classification.
- **Enum parity (drift guard):** every classifier `FlowType`/`FlowDirection`/`FlowReason` value maps to a defined Prisma enum member, and the maps are total (a runtime assertion that iterates the Prisma enum objects and confirms round-trip). Adding a classifier value without a map entry must fail `tsc` (compile guard) — documented in the test header.
- **Null-through:** a Plaid txn with `personal_finance_category = null` yields null `pfc*`/`merchantEntityId` but a defined `flowType` (from category+sign).
- **Regression (host):** P1 `flow-classifier.test.ts`, P2 `plaid-flow-input.test.ts`, KD-17, KD-18, output-validator — all green, unchanged.

> Note: `tsx`-based suites and any `prisma` command must run on the developer's Mac — the sandbox `node_modules` ships macOS-only native binaries. Pure suites can alternatively be `tsc`-compiled and run under `node`.

---

## 8. Validation checklist

- [ ] `npx prisma generate` — client already carries Phase-A fields; confirm no schema diff (Phase B is code-only).
- [ ] `npx prisma migrate dev` — **no-op**; confirm no migration created.
- [ ] `npx tsc --noEmit` — clean (the enum-parity maps compile; the new `fields` keys typecheck against the generated client).
- [ ] `npm run lint` — clean.
- [ ] `npx tsx lib/transactions/plaid-flow-write.test.ts` — green.
- [ ] `npx tsx lib/transactions/plaid-flow-input.test.ts` / `flow-classifier.test.ts` — green, unchanged.
- [ ] KD-17 / KD-18 / output-validator suites — green, unchanged.
- [ ] **Diff review:** the 7 original `fields` values and all `db.transaction.*` call shapes are unchanged; `fields` only gains keys; `counterpartyAccountId` is `null` in the written object.
- [ ] **Confirm no read path** reads the new columns (grep) — Phase B is write-only.
- [ ] **Staging sync smoke test:** run one real Plaid sync; spot-check that new/updated rows have non-null `flowType`/`flowDirection`/`classifierVersion=1`, null `counterpartyAccountId`, and that `category`/`amount`/dedup behavior is identical to pre-Phase-B (compare a diff of a re-synced item).
- [ ] Confirm dashboard totals and an AI answer are byte-identical pre/post (read side unaffected).

---

## 9. Rollback plan

- **Code-only rollback.** Revert the `syncTransactions.ts` hunk (restore the shadow-gated block and the original `fields`), the `buildFlowWriteFields` helper, and the version constant. New rows immediately stop carrying flow columns.
- **Already-written values are inert.** Because no read path consumes the columns (pre-P5), any `flowType` values written before rollback are harmless nullable data — no cleanup required. If desired, a one-line `UPDATE Transaction SET flowType = NULL, …` script can clear them, but it is optional and not part of rollback.
- **No schema/migration to reverse** (Phase A stays). **Blast radius:** none to reads, totals, AI, or UI — the change is confined to what the Plaid sync writes into already-existing nullable columns.

---

## 10. Exit criteria

- New and updated Plaid-synced transactions persist `flowType`, `flowDirection`, `classificationConfidence`, `classificationReason`, `classifierVersion=1`, and the pfc/merchant fields; `counterpartyAccountId` is null by design.
- Enum parity is compile-guarded; classification failure is non-fatal.
- Zero change to reads, totals, AI, UI, schema, or the 7 original write fields (proven by diff review + unchanged regression suites + staging smoke test).
- Ready for P4 (historical backfill over the same `buildFlowWriteFields` path) — the write path and the backfill will share one classification contract.
