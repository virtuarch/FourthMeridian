> **CHECKLIST ONLY — no code, schema, migration, or UI changes were made to produce this document.** Implementation is not authorized by this file; each item is executed only after checklist approval. For governing design see `docs/investigations/FLOWTYPE_FOUNDATION_INVESTIGATION.md`. For project state see `STATUS.md`.

# FlowType P1 — Shared Deterministic Flow Classifier (Implementation Checklist)

**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion`
**Initiative:** v2.5.5 Financial Intelligence — Transaction Semantics
**Phase:** P1 of the ratified roadmap (§10 of the foundation investigation)
**Status:** Checklist prepared — awaiting approval. Stop-after-checklist per instruction.

---

## 0. P1 contract (what this phase is and is not)

**Goal:** a single pure, deterministic, in-memory flow classifier module + tests. It becomes the seed source of truth for later phases; it changes **no numbers** any user or the AI currently sees.

**In scope**
- One pure classifier module (no I/O, no DB, no side effects).
- Classify from **existing in-memory fields only**: `category`, `amount`, `accountType`/`debtSubtype` when available, `merchant`/`description` when needed, Plaid PFC fields **only if already in memory** (i.e. the sync path) — never a new fetch, never a new stored column.
- Return `flowType`, `flowDirection`, `confidence`, `reasonCode`.
- A characterization/equivalence harness proving the classifier reproduces each existing ad-hoc definition.
- Tests for classifier behavior.

**Out of scope (hard stops)**
- ❌ Prisma schema changes · ❌ migrations · ❌ persisted `flowType`/`flowDirection` · ❌ read cutover of money totals · ❌ any UI · ❌ Atlas / Liquid / Brief / SpaceDashboard / visual components · ❌ changing any rollup math.
- ❌ The Banking `totalCredit` bug is **identified, not touched** (UI; needs explicit approval — §7).

**Routing posture (the "only where safe" decision):** the money-total partition sites (`assemblers/transactions.ts` main loop `:282-317` and monthly loop `:749-767`) are pinned by the KD-17 checked invariant and the KD-18 guardrail tests and feed the AI-4 validator's reconciliation. **Rerouting them is the P5 read cutover, not P1** — they stay byte-identical here. The single low-risk routing candidate is the boolean `SPENDING_EXCLUDED` set in `annotations.ts:755` (it gates expense-opportunity *classification*, not a displayed money total). It is routed **only if** the equivalence harness proves identical output across the full category set; otherwise it, too, is left untouched. Default recommendation: **ship the module + tests + equivalence proof; make the `annotations.ts` reroute a gated, reversible sub-step.**

---

## 1. Impact map

### 1.1 Files created (P1)

| Path | Purpose |
|---|---|
| `lib/transactions/flow-classifier.ts` | The pure classifier + TS-only enums/types + reason codes. Sits beside existing `lib/transactions/fingerprint.ts`, `merchant.ts`. Follows the `lib/account-classifier.ts` "single source of truth" precedent. |
| `lib/transactions/flow-classifier.test.ts` | Unit tests + the equivalence/characterization harness. Colocated, matching repo convention (`lib/perspectives.test.ts`, `lib/ai/assemblers/transactions.kd17.test.ts`). |

### 1.2 Files modified (P1) — at most one, gated

| Path | Change | Gate |
|---|---|---|
| `lib/ai/intelligence/annotations.ts` | Replace the private `SPENDING_EXCLUDED` set (`:755`) with `isSpendingFlow(classifyFlow(...))`. Behavior-preserving only. | **Only if** the equivalence test proves `classifySpendingCategory` output is unchanged for every category. If not green, this file is NOT touched in P1. |

### 1.3 Files referenced read-only (NOT modified in P1)

| Path | Why referenced | Why untouched now |
|---|---|---|
| `lib/ai/assemblers/transactions.ts` (`:98-126, 282-317, 749-767`) | Source of the canonical partition rules the classifier must reproduce. | Money totals pinned by KD-17/KD-18/AI-4 tests → read cutover is P5. |
| `lib/plaid/syncTransactions.ts` (`mapPlaidCategory :97-135`, sign flip `:220`) | Source of the Plaid PFC → flow mapping the classifier must mirror; the in-memory PFC provider for the future write path. | No write-path change until P2/P3; classifier only *reads* the same signals a future caller would pass. |
| `lib/imports/csv.ts` (`normalizeRow`, `mapCategory :412-501`) | Source of the CSV heuristic (sign convention, category aliases) the classifier must reproduce for import rows. | No import-path change in P1. |
| `lib/data/transactions.ts` (`BANKING_CATEGORIES :48-51`, investment split `:133`) | The `category IN (...)` query filters that a future read cutover replaces. | Query-level filter; cannot route per-row without a stored column (P3/P5). |
| `components/dashboard/BankingClient.tsx` (`totalCredit :162-165`) | The identified income bug. | UI — explicitly out of scope; §7. |
| `lib/ai/types.ts` | Where shared context types live. | P1 keeps classifier types local to its own module to stay self-contained; promotion to `types.ts` is deferred to the cutover phase. |

### 1.4 Non-impact assertions (must hold after P1)

- No change to any generated Prisma client (no schema touched).
- No change to any API route response, AI context payload, or rendered number.
- KD-17, KD-18, KD-1, KD-15, AI-4, and perspective-engine suites remain green **unchanged**.

---

## 2. Proposed classifier contract (TS-only — no Prisma in P1)

Enums are TypeScript unions/enums inside the module. No Postgres enum is created in P1 (that is P3). Names are chosen to match the foundation investigation §3 so P3 can promote them 1:1.

```ts
// lib/transactions/flow-classifier.ts  (draft — for review, not merge)

export type FlowType =
  | 'SPENDING'
  | 'INCOME'
  | 'REFUND'
  | 'DEBT_PAYMENT'
  | 'TRANSFER'
  | 'INVESTMENT'
  | 'FEE'
  | 'INTEREST'
  | 'ADJUSTMENT'
  | 'UNKNOWN';

export type FlowDirection = 'INFLOW' | 'OUTFLOW' | 'INTERNAL' | 'UNKNOWN';

/** Stable, testable reason for the decision — never user-facing prose. */
export type FlowReasonCode =
  | 'PLAID_PFC_DETAILED'        // decided from personal_finance_category.detailed
  | 'PLAID_PFC_PRIMARY'         // decided from personal_finance_category.primary
  | 'CATEGORY_FLOW_VALUE'       // category was itself a flow value (Transfer/Payment/Interest/Fee/Income)
  | 'CATEGORY_INVESTMENT_VALUE' // Buy/Sell/Dividend/Split/Fee investment set
  | 'ACCOUNT_TYPE_CONTEXT'      // debtSubtype / accountType disambiguated (e.g. interest on a debt acct)
  | 'SIGN_DEFAULT_SPENDING'     // fell through to negative-amount = SPENDING
  | 'SIGN_DEFAULT_INFLOW'       // positive amount, no stronger signal
  | 'AMBIGUOUS_UNKNOWN';        // below confidence threshold → UNKNOWN, never forced

export interface FlowClassificationInput {
  category:      string;            // TransactionCategory value (string-typed to avoid a Prisma import cycle)
  amount:        number;            // FM sign convention: + into own account, − out
  accountType?:  string | null;     // AccountType where the caller has it
  debtSubtype?:  string | null;     // FinancialAccount.debtSubtype where available
  merchant?:     string | null;
  description?:  string | null;
  pfcPrimary?:   string | null;     // Plaid PFC — ONLY if already in memory (sync path)
  pfcDetailed?:  string | null;     // Plaid PFC — ONLY if already in memory (sync path)
}

export interface FlowClassification {
  flowType:      FlowType;
  flowDirection: FlowDirection;
  confidence:    number;            // 0..1
  reasonCode:    FlowReasonCode;
}

export function classifyFlow(input: FlowClassificationInput): FlowClassification;

/** Convenience predicates for safe call-site routing (P1 §1.2). */
export function isSpendingFlow(c: FlowClassification): boolean; // SPENDING or REFUND
export function isExcludedFromSpending(c: FlowClassification): boolean;
```

**Determinism rules**
- Pure: same input → same output; no `Date.now`, no randomness, no DB, no env reads.
- Precedence: `pfcDetailed` → `pfcPrimary` → `category` flow-value → `accountType/debtSubtype` context → sign default. First rule that fires wins and sets `reasonCode`.
- Graceful degradation: with no PFC (every read-side caller), classification uses `category + sign + accountType` and still returns a defined result — never throws (mirrors `mapPlaidCategory`/`mapCategory` "never block a row" contract).
- Honesty valve: when signals conflict or are insufficient, return `UNKNOWN` + `AMBIGUOUS_UNKNOWN` + low confidence rather than forcing `SPENDING`.

**Confidence tiers (draft)**
- `1.0` — PFC-detailed or an unambiguous flow-value category (e.g. `Transfer`, `Payment` on a debt destination leg).
- `0.7` — PFC-primary or category+accountType agreement.
- `0.5` — sign-default (`amount<0` → SPENDING) with no corroborating signal.
- `≤0.3` — conflicting signals → `UNKNOWN`.

---

## 3. Classification doctrine to encode (from foundation §5)

Each row below is a test case *and* an implementation rule.

| Signal | flowType | flowDirection | reasonCode | confidence |
|---|---|---|---|---|
| PFC `TRANSFER_IN` | TRANSFER | INFLOW (INTERNAL if counterparty owned — unknown in P1 → INFLOW) | PLAID_PFC_PRIMARY | 0.7 |
| PFC `TRANSFER_OUT` | TRANSFER | OUTFLOW | PLAID_PFC_PRIMARY | 0.7 |
| PFC `LOAN_PAYMENTS` | DEBT_PAYMENT | INTERNAL | PLAID_PFC_PRIMARY | 0.7 |
| PFC `*_INTEREST_*` / detailed INTEREST | INTEREST | OUTFLOW (INFLOW if earned on non-debt) | PLAID_PFC_DETAILED | 1.0 |
| PFC `BANK_FEES` | FEE | OUTFLOW | PLAID_PFC_PRIMARY | 0.7 |
| PFC `INCOME` | INCOME | INFLOW | PLAID_PFC_PRIMARY | 0.7 |
| `category = Transfer` (no PFC) | TRANSFER | sign-based | CATEGORY_FLOW_VALUE | 1.0 |
| `category = Payment`, `amount < 0` | DEBT_PAYMENT | INTERNAL | CATEGORY_FLOW_VALUE | 1.0 |
| `category = Payment`, `amount > 0`, `debtSubtype != null` (destination leg) | DEBT_PAYMENT | INFLOW | ACCOUNT_TYPE_CONTEXT | 1.0 |
| `category = Interest` on debt account | INTEREST | OUTFLOW | ACCOUNT_TYPE_CONTEXT | 1.0 |
| `category = Interest` on non-debt account | INCOME | INFLOW | ACCOUNT_TYPE_CONTEXT | 0.7 |
| `category = Fee` | FEE | OUTFLOW | CATEGORY_FLOW_VALUE | 1.0 |
| `category ∈ {Buy,Sell,Split}` | INVESTMENT | INTERNAL | CATEGORY_INVESTMENT_VALUE | 1.0 |
| `category = Dividend` | INCOME | INFLOW | CATEGORY_INVESTMENT_VALUE | 0.7 (doctrine: dividends received = income) |
| `category = Income`, `amount > 0` | INCOME | INFLOW | CATEGORY_FLOW_VALUE | 1.0 |
| `amount > 0` in a spend category (refund) | REFUND | INFLOW | SIGN_DEFAULT_INFLOW | 0.5 |
| `amount < 0`, spend category | SPENDING | OUTFLOW | SIGN_DEFAULT_SPENDING | 0.5 |
| conflicting / unmappable | UNKNOWN | UNKNOWN | AMBIGUOUS_UNKNOWN | ≤0.3 |

> Note: `flowDirection = INTERNAL` for transfers/payments is only *fully* correct once counterparty ownership is known (P3+). In P1, with no counterparty input, INTERNAL is asserted only where the flow kind guarantees it (a debt payment is internal by kind); ambiguous transfer legs use sign-based INFLOW/OUTFLOW. This is a deliberate, documented P1 limitation — not a bug.

---

## 4. Equivalence / characterization harness (the "route only where safe" proof)

Before any call site is rerouted, prove the classifier reproduces existing decisions. These live in the test file and gate §1.2.

1. **Assembler partition equivalence.** For a fixture set covering all 16 `TransactionCategory` values × {amount<0, amount>0}, assert that mapping `classifyFlow(...)` onto the assembler's four buckets (`incomeTotal / expenseTotal / debtPaymentTotal / transferTotal`) reproduces the exact bucket the inline rules (`:282-317`) assign. This proves a *future* cutover is safe; it does **not** reroute the assembler in P1.
2. **`SPENDING_EXCLUDED` equivalence.** Assert `isExcludedFromSpending(classifyFlow({category}))` equals `SPENDING_EXCLUDED.has(category)` for every category. **Green → the `annotations.ts` reroute (§1.2) is authorized. Red → it is not, and the file is left untouched.**
3. **Plaid mapping consistency.** For representative PFC primaries/detaileds, assert the classifier's `flowType` is consistent with `mapPlaidCategory`'s `category` (no contradiction — e.g. `LOAN_PAYMENTS` never yields SPENDING).
4. **CSV heuristic consistency.** For `mapCategory` alias inputs, assert classifier flow is consistent with the imported category.

---

## 5. Test matrix

| Group | Cases | Assertion |
|---|---|---|
| Every flowType | ≥1 canonical input per value (§3 table) | correct `flowType` |
| Direction | INFLOW/OUTFLOW/INTERNAL/UNKNOWN representatives | correct `flowDirection` |
| Sign rules | +/− amount in spend, income, transfer, payment | direction & type follow §5 doctrine, not raw sign |
| Refund vs income | `amount>0` in Dining vs `category=Income` | REFUND (INFLOW, not income) vs INCOME |
| Debt destination leg | `amount>0`, `debtSubtype='credit_card'` | DEBT_PAYMENT / INFLOW / confidence 1.0 |
| Interest polarity | `Interest` on debt vs savings | INTEREST/OUTFLOW vs INCOME/INFLOW |
| Dividend | `category=Dividend` | INCOME (doctrine) |
| PFC precedence | `pfcDetailed` present overrides `category` | `reasonCode=PLAID_PFC_DETAILED` |
| PFC absent | read-side input (no PFC) | still defined result; degrades to category+sign |
| Confidence tiers | PFC vs sign-default vs conflict | 1.0 / 0.7 / 0.5 / ≤0.3 |
| UNKNOWN valve | conflicting signals | `UNKNOWN`, never forced SPENDING |
| Purity/determinism | same input ×2 | identical output; no time/random dependence |
| Never-throws | empty/garbage merchant, `amount=0`, unknown category string | returns a defined classification, no exception |
| Equivalence harness | §4.1–§4.4 | reproduces existing behavior |

Target: classifier suite green; **all pre-existing suites green and unchanged** (KD-17 `transactions.kd17.test.ts`, KD-18 `attribution-guardrail.kd18.test.ts`, AI-4 `output-validator.test.ts`, perspective `*.test.ts`).

---

## 6. Step-by-step execution order (on approval)

1. Create `lib/transactions/flow-classifier.ts` — enums, input/output types, reason codes, `classifyFlow`, predicates. Pure; no imports of `db`/Prisma runtime (category typed as string to avoid a client import cycle).
2. Create `lib/transactions/flow-classifier.test.ts` — §5 matrix.
3. Add the §4 equivalence harness to the test file.
4. Run the harness. **Decision gate:** if §4.2 is green, apply the single `annotations.ts` reroute (§1.2) and re-run its dependent tests; if red, skip the reroute and record it as deferred to P5.
5. Run the full validation checklist (§8).
6. Update `STATUS.md` FlowType initiative line to note "P1 classifier landed (no behavioral change)."

---

## 7. Banking `totalCredit` bug — identified, NOT touched

`components/dashboard/BankingClient.tsx:162-165`: `totalCredit` sums **every** `amount>0` row as "In," so transfers-in, refunds, and investment-sale proceeds inflate the headline (duplicated in `SpaceTransactionsPanel.tsx`). The classifier makes the correct definition available (`flowType=INCOME`, with `REFUND` netted separately), but **fixing it is a UI change and requires explicit approval** — out of P1 scope. Recorded here so it is not lost; proposed as its own gated bugfix (foundation §12), not folded silently into this phase.

---

## 8. Validation checklist (run before marking P1 done)

- [ ] `npx prisma generate` — sanity only; must show **no schema diff** (nothing changed).
- [ ] `npx prisma migrate dev` — **N/A / must be a no-op**; P1 introduces no migration. Confirm none is created.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `flow-classifier.test.ts` — green (full §5 matrix + §4 harness).
- [ ] KD-17 `transactions.kd17.test.ts` — green, **unchanged**.
- [ ] KD-18 `attribution-guardrail.kd18.test.ts` — green, **unchanged**.
- [ ] AI-4 `lib/ai/output-validator.test.ts` — green, **unchanged**.
- [ ] Perspective-engine suites — green, **unchanged**.
- [ ] Grep confirms no import of the classifier from any assembler/data/UI money-total path (proves no read cutover leaked in).
- [ ] If `annotations.ts` was rerouted: its behavior is proven identical by §4.2 and the dependent tests are green.
- [ ] No UI file, no `schema.prisma`, no `prisma/migrations/*` in the diff.

---

## 9. Rollback plan

- **New files only (default P1):** delete `lib/transactions/flow-classifier.ts` and `lib/transactions/flow-classifier.test.ts`. Nothing else references them → zero residue. No schema/migration to reverse.
- **If the `annotations.ts` reroute was applied:** revert that one call site to the inline `SPENDING_EXCLUDED` set (single-hunk revert). Its equivalence proof guarantees the revert is behavior-neutral.
- **Blast radius:** none to data, API, AI output, or UI — P1 changes no persisted value and no rendered number, so rollback is a pure code removal with no data migration.

---

## 10. Exit criteria

- Pure `classifyFlow` exists with the §2 contract and §3 doctrine, fully tested (§5).
- The equivalence harness (§4) demonstrably reproduces the four existing ad-hoc definitions.
- No behavioral change to any money total, AI answer, or UI (all pre-existing suites green and unchanged).
- The Banking bug and the assembler read-cutover are documented as the next gated steps, not started.
- Ready for P2 (import fidelity: capture `pfcDetailed`) — no schema until then.
