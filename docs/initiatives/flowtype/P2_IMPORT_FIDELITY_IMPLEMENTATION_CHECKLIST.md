> **CHECKLIST ONLY — no code, schema, migration, or UI changes were made to produce this document.** Implementation is not authorized by this file; each item is executed only after checklist approval. Governing design: `docs/investigations/FLOWTYPE_FOUNDATION_INVESTIGATION.md`. Prior phase: `docs/initiatives/flowtype/P1_CLASSIFIER_IMPLEMENTATION_CHECKLIST.md` (complete).

# FlowType P2 — Plaid Import Fidelity (Implementation Checklist)

**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion`
**Initiative:** v2.5.5 Financial Intelligence — Transaction Semantics
**Phase:** P2 of the roadmap (foundation §10). Depends on P1 (classifier landed).
**Status:** Checklist prepared — awaiting approval. Stop-after-checklist per instruction.

---

## 0. P2 contract

**Goal:** stop discarding the Plaid signals the classifier needs. Capture `personal_finance_category.detailed` (+ `primary`, `confidence_level`) and the related in-memory inputs (`merchant_name`, `merchant_entity_id`, `counterparties`) on the sync path, thread the classifier-relevant ones into `classifyFlow()` **in memory only**, and observe the result. Persist nothing.

**Resolved design question (#5 — store anything yet?): NO — forward-prep only.** With no schema change there is no column to write; P2 wires and *exercises* the pipeline in shadow so P3 (persistence) lands on proven extraction. Storage is P3.

**In scope**
- Extract Plaid PFC + merchant + counterparty fields into a typed, in-memory struct on the sync path.
- Build a `FlowClassificationInput` from each synced transaction and call `classifyFlow()` in **shadow** (result observed/counted, never written, never used for any decision).
- Deny-list sensitive counterparty sub-fields (`account_numbers`) before they enter any struct or log.
- Aggregate, non-PII observability (flowType distribution, UNKNOWN rate, legacy-vs-classifier bucket agreement) behind a flag.
- Tests for the pure extraction + a pure distribution accumulator.

**Out of scope (hard stops)**
- ❌ Prisma schema changes · ❌ migrations · ❌ persisted `flowType`/metadata · ❌ read cutover · ❌ any change to written `Transaction` fields, totals, or AI assembler behavior · ❌ UI · ❌ Atlas / Liquid / Brief / SpaceDashboard.
- ❌ No change to `lib/transactions/flow-classifier.ts` — P1's tested contract is frozen. New Plaid metadata that the classifier does not yet consume (`confidence_level`, `merchant_entity_id`, `counterparties`) is *captured* into a separate struct, **not** added to `FlowClassificationInput` or fed into classification logic this phase.
- ❌ CSV/manual import path — Plaid-only per the P2 goal; those rows have no PFC and their classifier inputs (category + sign) are unchanged.

---

## 1. Where the fields already exist (investigation #1) and are discarded (#2)

Confirmed against the Plaid SDK type used by `transactionsSync` (`node_modules/plaid/dist/api.d.ts`, `interface Transaction` ≈ `:11325-11439`, `PersonalFinanceCategory` `:41427-41452`, `TransactionCounterparty` `:52505-52545`):

| Plaid field | Type | Present on every synced txn? |
|---|---|---|
| `personal_finance_category.primary` | `string` | Yes (PFC-enabled items) |
| `personal_finance_category.detailed` | `string` | Yes (PFC-enabled items) |
| `personal_finance_category.confidence_level` | `string \| null` | Usually |
| `merchant_name` | `string \| null` | Card/merchant activity; null for payroll/transfers |
| `merchant_entity_id` | `string \| null` | With `merchant_name` |
| `counterparties[]` | `Array<TransactionCounterparty>` `{name, entity_id?, type, website, logo_url, confidence_level?, account_numbers?}` | Card/merchant activity |

**Discard site — `lib/plaid/syncTransactions.ts:218-226`:**
```ts
const amount      = -txn.amount;
const category    = mapPlaidCategory(txn);   // reads PFC, returns ONLY the collapsed enum
const merchant    = txn.merchant_name ?? txn.name;
const description = txn.name;
const fields = { financialAccountId, date, merchant, description, category, amount, pending };
```
`mapPlaidCategory` (`:97-135`) consumes `personal_finance_category` but returns one `TransactionCategory`; `detailed`, `confidence_level`, `merchant_entity_id`, and `counterparties` are read nowhere and never leave the loop. The account resolver (`resolveFinancialAccountId`, `:164-196`) returns only an id — so `accountType`/`debtSubtype` (classifier context) aren't available at the row either.

---

## 2. How to pass these into the classifier in memory now (#3)

Two small, additive seams — no write path changes:

1. **A pure mapper** turns a Plaid txn + the already-computed `category`/`amount` + account context into the classifier input plus a captured-metadata sidecar:
   ```
   buildPlaidFlowInput(txn, { category, amount, accountType, debtSubtype })
     → { input: FlowClassificationInput, captured: CapturedPlaidMetadata }
   ```
   - `input` populates `pfcPrimary`/`pfcDetailed` (which `classifyFlow` already consumes) plus `category`, `amount`, `accountType`, `debtSubtype`, `merchant`.
   - `captured` holds `confidenceLevel`, `merchantEntityId`, and `counterparties` **with `account_numbers` stripped** — captured for P3/observability, not fed to `classifyFlow` this phase.
2. **Account context at the row:** extend the resolver to also surface `{ type, debtSubtype }` (read-only `select` addition; cached like the id) so `input.accountType`/`debtSubtype` are complete. No write change.

The sync loop then, per transaction, builds `input`, calls `classifyFlow(input)` in shadow, and feeds the result to a pure counter. The `fields` object written to the DB is **byte-identical to today**.

---

## 3. What can be safely logged/tested before persistence (#4)

- **Aggregate counters only, no per-row PII in production.** A pure accumulator tallies per sync run: count by `flowType`, count by `reason`, `UNKNOWN` count, and a legacy-vs-classifier **bucket agreement** count (does the classifier's fold land in the same income/expense/transfer/debtPayment bucket the current `category`+sign partition would — the P1 equivalence relationship, now measured on real data). Emitted as one summary log line per run and (additively) on `SyncTransactionsResult`.
- **No merchant names, descriptions, counterparty names, or account numbers in any log.** Loggable fields are limited to non-PII: `flowType`, `flowDirection`, `reason`, `pfcPrimary`, `pfcDetailed`, `confidence_level`. `account_numbers` is deny-listed before capture, so it cannot reach a log.
- **Flag-gated.** `FLOWTYPE_SHADOW` env: `off` (default — pure no-op, honors "do not change existing behavior"), `count` (aggregate summary log only), `debug` (dev-only per-row non-PII line). Default `off`; enable in a dev/staging sync to collect the distribution that de-risks P3.
- **Unit-testable without DB:** the mapper and the accumulator are pure functions; the sync loop itself (Plaid + DB) is not unit-tested here, consistent with the existing suite.

---

## 4. Impact map

### 4.1 Files created

| Path | Purpose |
|---|---|
| `lib/transactions/plaid-flow-input.ts` | Pure mapper `buildPlaidFlowInput(...)` + `CapturedPlaidMetadata` type + `account_numbers` deny-list. Prisma-free (Plaid types are structural). |
| `lib/transactions/plaid-flow-input.test.ts` | Standalone `tsx` tests for the mapper + the pure shadow accumulator. |

### 4.2 Files modified

| Path | Change | Guarantee |
|---|---|---|
| `lib/plaid/syncTransactions.ts` | (a) extend `resolveFinancialAccountId` `select` with `type, debtSubtype` (read-only); (b) build `input` via the mapper; (c) `FLOWTYPE_SHADOW`-gated `classifyFlow` + pure accumulator; (d) additive counters on `SyncTransactionsResult` + one summary log line. | **The `fields` object and every `db.transaction.create/update/deleteMany` call are unchanged.** No write, total, or category value changes. |

### 4.3 Referenced read-only (NOT modified)

`lib/transactions/flow-classifier.ts` (frozen — consumed as-is), `lib/plaid/syncTransactions.ts:mapPlaidCategory` (still produces `category` exactly as today; not rerouted), `lib/ai/assemblers/*`, `lib/data/transactions.ts`, all UI.

### 4.4 Non-impact assertions (must hold after P2)

- No Prisma schema / migration diff.
- `Transaction` rows written by sync are identical (same `fields`, same category, same sign).
- No change to any AI context payload, rollup, or rendered number.
- With `FLOWTYPE_SHADOW=off` (default), the only added cost is building `input` + one classifier call per row whose result is discarded — or, if preferred, gate that too so `off` is a literal no-op (recommended: `off` skips the shadow block entirely).
- KD-17, KD-18, AI-4, P1 classifier suites remain green, unchanged.

---

## 5. Proposed mapper changes (shape — not for merge)

```ts
// lib/transactions/plaid-flow-input.ts  (draft)
import type { Transaction as PlaidTransaction } from 'plaid';
import type { FlowClassificationInput } from './flow-classifier';

export interface CapturedCounterparty {
  name: string; entityId: string | null; type: string;
  website: string | null; logoUrl: string | null; confidenceLevel: string | null;
  // account_numbers deliberately absent — deny-listed, never captured.
}
export interface CapturedPlaidMetadata {
  pfcConfidenceLevel: string | null;
  merchantEntityId:   string | null;
  counterparties:     CapturedCounterparty[];
}

export function buildPlaidFlowInput(
  txn: PlaidTransaction,
  ctx: { category: string; amount: number; accountType?: string | null; debtSubtype?: string | null },
): { input: FlowClassificationInput; captured: CapturedPlaidMetadata } {
  const pfc = txn.personal_finance_category ?? null;
  return {
    input: {
      category:     ctx.category,
      amount:       ctx.amount,             // sign flip stays in syncTransactions
      accountType:  ctx.accountType ?? null,
      debtSubtype:  ctx.debtSubtype ?? null,
      merchant:     txn.merchant_name ?? txn.name ?? null,
      pfcPrimary:   pfc?.primary  ?? null,
      pfcDetailed:  pfc?.detailed ?? null,
    },
    captured: {
      pfcConfidenceLevel: pfc?.confidence_level ?? null,
      merchantEntityId:   txn.merchant_entity_id ?? null,
      counterparties: (txn.counterparties ?? []).map((c) => ({
        name: c.name, entityId: c.entity_id ?? null, type: String(c.type),
        website: c.website ?? null, logoUrl: c.logo_url ?? null,
        confidenceLevel: c.confidence_level ?? null,
        // c.account_numbers intentionally dropped
      })),
    },
  };
}
```
Plus a pure `accumulateShadow(acc, classification, agreesWithLegacyBucket)` counter helper (colocated) for the observability tally.

---

## 6. Tests needed

Standalone `tsx` scripts (repo convention), exit 0/1, no DB:

- **Extraction:** PFC `primary`/`detailed` land on `input`; `confidence_level`/`merchant_entity_id`/`counterparties` land on `captured`; `merchant` falls back `merchant_name ?? name`; `amount`/`category` are passed through unchanged (mapper never flips sign).
- **Deny-list:** given a counterparty carrying `account_numbers`, the captured struct has no account-number field anywhere (`JSON.stringify(captured)` contains no `account_numbers` / routing keys).
- **Null-safety:** `personal_finance_category = null`, empty `counterparties`, missing `merchant_name` → defined output, no throw.
- **Classifier-through-mapper:** feeding `input` into `classifyFlow` yields the PFC-driven flow (e.g. `LOAN_PAYMENTS → DEBT_PAYMENT`, `TRANSFER_IN → TRANSFER/INFLOW`), confirming the wiring reaches the P1 doctrine.
- **Accumulator:** pure counter tallies flowType/reason/UNKNOWN/agreement deterministically over a fixture set.
- **Regression (run on host):** P1 `flow-classifier.test.ts` still green; KD-17 / KD-18 / output-validator still green (additive-only guarantees this by construction).

---

## 7. Validation checklist (run before marking P2 done)

- [ ] `npx prisma generate` — sanity; **no schema diff** (nothing changed).
- [ ] `npx prisma migrate dev` — must be a **no-op**; confirm no migration created.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npx tsx lib/transactions/plaid-flow-input.test.ts` — green.
- [ ] `npx tsx lib/transactions/flow-classifier.test.ts` — green, unchanged.
- [ ] `npx tsx lib/ai/assemblers/transactions.kd17.test.ts` — green, unchanged.
- [ ] `npx tsx app/api/ai/chat/attribution-guardrail.kd18.test.ts` — green, unchanged.
- [ ] `npx tsx lib/ai/output-validator.test.ts` — green, unchanged.
- [ ] **Diff review:** the `fields` object and all `db.transaction.*` calls in `syncTransactions.ts` are unchanged; only additive extraction/observability lines were added.
- [ ] With `FLOWTYPE_SHADOW=off`, a sync produces identical DB rows and identical logs (modulo absence of the summary line) vs. pre-P2.
- [ ] No UI / schema / migration file in the diff.
- [ ] (Optional, staging) `FLOWTYPE_SHADOW=count` sync emits a sane distribution: low UNKNOWN rate, high legacy-bucket agreement — the P3 go/no-go signal.

> Note: the `tsx`-based suites require running on the developer's own machine — the mounted `node_modules` is platform-specific (a Linux CI/sandbox with macOS-built binaries fails at esbuild before any test logic). Pure classifier/mapper suites can alternatively be compiled with `tsc` and run under `node`.

---

## 8. Rollback plan

- **New files:** delete `lib/transactions/plaid-flow-input.ts` and its test — no other file references them.
- **`syncTransactions.ts`:** revert the additive hunks (resolver `select` extension, mapper call, shadow block, counters, summary log). Each is an isolated addition; the write path was never altered, so revert is behavior-neutral.
- **Blast radius:** none — P2 persists nothing and is flag-gated off by default. No data written, so nothing to migrate back. Rolling back leaves the DB and all reads exactly as P1 left them.

---

## 9. Exit criteria

- Plaid PFC (`primary`/`detailed`/`confidence_level`), `merchant_entity_id`, and `counterparties` (minus `account_numbers`) are extracted into memory on the sync path via a pure, tested mapper.
- `classifyFlow` runs in shadow over real Plaid inputs; a flag-gated, non-PII distribution is observable.
- Zero change to written rows, totals, AI behavior, schema, or UI (proven by diff review + unchanged regression suites).
- The staging distribution gives a go/no-go read for P3, where the same extracted inputs are persisted behind the additive `flowType`/`pfcDetailed` columns.
