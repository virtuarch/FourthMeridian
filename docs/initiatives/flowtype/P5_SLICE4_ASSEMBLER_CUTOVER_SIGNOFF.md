> **SIGN-OFF PREPARATION ONLY — no code, schema, migration, or test was changed.** This document specifies the Slice 4 AI-assembler cutover for behavior approval before implementation. Governing design: `FLOWTYPE_FOUNDATION_INVESTIGATION.md`; plan of record: `P5_RESUMPTION_PLAN_2026-07-05.md`. Slices 0–3 complete.

# FlowType P5 Slice 4 — AI Assembler Cutover: Sign-off Package

**Date:** 2026-07-05
**Branch:** `feature/v2.5-spaces-completion`
**Target file:** `lib/ai/assemblers/transactions.ts` (1,025 lines; **0** `flowType` references today)
**Blast radius:** every AI number, the Daily Brief, and all downstream serialization.

---

## 1. Current category/sign logic map (verified line-by-line)

| # | Site | Current logic |
|---|---|---|
| C1 | Query row set (`:231`) | `category: { in: BANKING_CATEGORIES }` — 11 banking categories. **Dividend and Fee rows never enter.** `select` (`:235-241`) does not fetch `flowType`/`flowDirection`. |
| C2 | `transferTotal` (`:291-294`) | `category === Transfer` → Σ\|amount\| (both signs). |
| C3 | `debtPaymentTotal` (`:296-299`) | `category === Payment && amount < 0` → Σ\|amount\| (source-side only). |
| C4 | `incomeTotal` + `largestIncome` (`:301-307`) | `category ∈ {Income, Interest} && amount > 0` → Σ amount. |
| C5 | `expenseTotal` + `largestExpense` (`:310-315`) | Fall-through: everything else with `amount < 0` → Σ\|amount\|. **Interest charges land here.** Positive rows in spend categories (refunds) land **nowhere** (only `byCategory.creditTotal`). |
| C6 | `netCashFlow` (`:317`) | `incomeTotal − expenseTotal − debtPaymentTotal`. |
| C7 | `byCategory` (KD-17, `:283-289`, `:346-353`) | Per-category debit-only `total` + separate `creditTotal` + `count`. Zero-total entries kept at window level (annotations reads Income `count`). |
| C8 | Recurring candidates (`:397-401`) | Excludes `category ∈ {Transfer, Payment}`; Income rows (payroll) included by precedent. |
| C9 | Merchant rollup (`:456-460`) | Skip `category ∈ MERCHANT_EXCLUDED_CATEGORIES` ({Income, Interest, Transfer, Payment}), skip `amount ≥ 0`. |
| C10 | Income-sources rollup (`:537-540`) | `category ∈ {Income, Interest} && amount > 0`, grouped by canonical merchant. |
| C11 | Monthly partition (`buildMonthlyBreakdown`, `:749-768`) | Same rules as C2–C5, per calendar month. |
| C12 | Drilldown default filter (`:925-933`) | No explicit category → `category ∈ SPENDING_CATEGORIES` + `amount < 0`; `includeNonSpending` → `BANKING_CATEGORIES`. |
| C13 | Daily Brief (`app/api/brief/route.ts:386-396`) | Savings rate = `(incomeTotal − expenseTotal) / incomeTotal` — pure consumer of C4/C5. |

Classifier facts the replacement relies on (`lib/transactions/flow-classifier.ts`): `Dividend → INCOME` (always, doctrine §5, `:229-231`); `Fee → FEE` (`:226-227`); interest earned → `INCOME`, interest charged → `INTEREST` (`:210-220`); positive amount in a spend category → `REFUND`, never income (`:244-246`); `Buy/Sell/Split → INVESTMENT`; `Payment → DEBT_PAYMENT` (INTERNAL when negative, INFLOW when positive). P1 test layer 2 proved the classifier reproduces the current 4-bucket partition for every banking category × sign, so **every delta below comes from rows the old filter excluded or ignored — not from reshuffling existing buckets.**

---

## 2. Proposed flowType/flowDirection replacement map

Decision points are labeled **D-1…D-5**; each has a recommendation. Everything not labeled is a mechanical, behavior-neutral re-expression (proven by the P1 equivalence harness).

| Site | Proposed replacement |
|---|---|
| C1 | **D-1.** Query → `flowType: { in: BANKING_FLOWS }` where `BANKING_FLOWS = {SPENDING, REFUND, INCOME, DEBT_PAYMENT, TRANSFER, FEE, INTEREST}`. Excluded: `INVESTMENT` (security activity stays in the Investments view), `ADJUSTMENT` (non-economic artifacts), `UNKNOWN` (0 rows by P4 invariant). Add `flowType`, `flowDirection` to `select` and `TxnRow`. |
| C2 | `flowType === TRANSFER` → Σ\|amount\| (equivalent population). |
| C3 | `flowType === DEBT_PAYMENT && amount < 0` → Σ\|amount\|. The `amount < 0` guard is retained deliberately: destination-side INFLOW legs on debt accounts must not double-count (Slice 3's DebtClient rollup owns that view). |
| C4 | `flowType === INCOME && amount > 0` → Σ amount. **Gains the 9 dividend rows.** |
| C5 | **D-2.** `expenseTotal` = Σ\|amount\| over `flowType ∈ {SPENDING, FEE, INTEREST}` (gross). Rationale: interest charges are in expenseTotal today (parity); FEE is newly reachable; matches the dashboard's Slice-2 `FLOW_COST` set, converging the two authorities. *(Rejected alt: SPENDING-only — silently drops interest charges from expense, diverges from the dashboard, and breaks the KD-17 invariant because Fee debits would count in spendingCategorySum but not expenseTotal.)* |
| C5b | **D-3.** Refund netting: add a new disclosed field `refundTotal` = Σ amount over `flowType === REFUND`; `expenseTotal` stays **gross**. This is the "structural netting" — refunds become a first-class figure instead of invisible, and consumers net explicitly. *(Rejected alt: netting inside expenseTotal like the dashboard chip — breaks the KD-17 debit-only reconciliation between byCategory and expenseTotal.)* |
| C6 | **D-4.** `netCashFlow = incomeTotal + refundTotal − expenseTotal − debtPaymentTotal`. Refunds now offset spend in the net figure (today they vanish). |
| C7 | **Unchanged rule.** `byCategory` stays keyed by category (merchant taxonomy, orthogonal to flow) with KD-17 debit/credit separation. Population changes only via D-1 (new `Dividend` and `Fee` entries appear). |
| C8 | Exclude `flowType ∈ {TRANSFER, DEBT_PAYMENT}` (equivalent). Dividend/Fee rows may now appear as recurring candidates — consistent with payroll already appearing today. |
| C9 | Include only `flowType === SPENDING` (one predicate replaces set + sign check). REFUND excluded as today; FEE/INCOME/dividends structurally cannot surface as "top spending merchants". |
| C10 | `flowType === INCOME && amount > 0`. **Dividend payers (e.g. brokerages) will appear as income sources.** |
| C11 | Identical rule changes as C2–C5b, inside `buildMonthlyBreakdown` (same accumulator structure preserved). |
| C12 | **D-5.** Drilldown default → `flowType: 'SPENDING'`; `includeNonSpending` → `flowType: { in: BANKING_FLOWS }`; an explicitly resolved category keeps its category-equality filter. The existing `amount: { lt: 0 }` sign guard is **kept** (redundant for SPENDING rows but harmless; leaves the KD-17 source tripwire intact). |
| C13 | No code change — Brief auto-benefits through C4/C5. |

`INCOME_CATEGORIES`, `MERCHANT_EXCLUDED_CATEGORIES`, `SPENDING_CATEGORIES` become unreferenced in the assembler but are **NOT deleted** (Slice 7, gated). `BANKING_CATEGORIES` may become unreferenced in the query but stays defined for the same reason.

---

## 3. Expected numeric behavior changes (the sign-off substance)

| # | Figure | Change | Cause |
|---|---|---|---|
| N1 | `incomeTotal` | **Increases** by the sum of the 9 Dividend rows (P4 audit: all 9 legacy disagreements, `CATEGORY_INVESTMENT_VALUE`) | D-1 row set + C4 |
| N2 | `expenseTotal` | **Increases** by previously invisible Fee-category rows; interest charges unchanged (parity by D-2) | D-1 + D-2 |
| N3 | `refundTotal` (new) | Appears; equals Σ of positive rows in spend categories (today only visible as per-category `creditTotal`) | D-3 |
| N4 | `netCashFlow` | Shifts by +dividends +refunds −fees | D-4 |
| N5 | `byCategory` / `transactionCount` / monthly counts | Grow by dividend + fee row counts; new `Dividend` (credit-only) and `Fee` entries | D-1 |
| N6 | `incomeSources` | Dividend payers appear as sources | C10 |
| N7 | `recurringCandidates` | Dividend/fee merchants may appear (≥2 occurrences) | C8 |
| N8 | `largestIncome` / `largestExpense` | May switch rows (a dividend could become largest income; a fee could become largest expense) | D-1 |
| N9 | Daily Brief savings rate | Rises with N1, falls with N2's fee inclusion | C13 |
| N10 | KD-17 January case (+$9,500 card-payment credits categorized `Other`) | Classifier tags them REFUND → they now surface in `refundTotal` and inflate `netCashFlow` via D-4. **Known data-quality caveat:** these are misclassified card-payment credits, not real refunds. Fixing their category is Merchant-Intelligence scope, not Slice 4. If this inflation is unacceptable, D-4 can keep the old formula (refunds disclosed, not netted) — flag at sign-off. |

**Exact dollar values** must be captured on the developer machine before implementation (§5 step 1) — this document intentionally contains the mechanism, the direction, and the causes; the snapshot supplies the magnitudes for approval.

**Residual, accepted divergence:** the dashboard chip nets refunds *inside* Spend (Slice 2); the assembler under D-3 discloses gross + `refundTotal`. Both now derive from `flowType` (single semantic authority achieved); presentation-level equality of the two numbers is not claimed by this slice.

---

## 4. Risks and rollback

- **R1 — Blast radius.** All AI numbers + Brief change at once. *Mitigation:* single-file logic (plus its test); one `git revert` restores every downstream number. No schema, no write path, no data change → no data rollback exists.
- **R2 — KD-17 invariant.** Preserved by construction under D-2/D-3: `byCategory` stays debit-only; spendingCategorySum (Fee included by name, Interest excluded by name) ≤ expenseTotal ({SPENDING, FEE, INTEREST}). Netting inside expenseTotal (rejected D-3 alt) is the only design that breaks it.
- **R3 — Double-counting debt payments.** Prevented by keeping the `amount < 0` source-side guard on C3.
- **R4 — Test tripwires.** `transactions.kd17.test.ts` §5 greps the assembler source. Kept intact by design: `debitTotal: 0, creditTotal: 0` accumulators survive, `amount: { lt: 0 }` survives (D-5), zero-total comment survives. Only the test's *population* fixtures need re-expression (§5).
- **R5 — Serializer name-filters (Slice 6 seam).** `NON_SPENDING` in `chat/route.ts` won't exclude the new `Dividend`/`Fee` category names. Dividend entries are credit-only (debit total 0 → filtered from spending serialization); Fee debits appearing as a visible spending line is *intended* (Fee reachability). No Slice 6 work pulled forward.
- **R6 — Multi-currency (carried).** Totals still sum mixed currencies; not worsened; MC1 owns it.
- **R7 — Prompt copy.** Prose references field *names* (`debtPaymentTotal` etc.) — all names unchanged; `refundTotal` is additive.

**Rollback:** revert the Slice 4 commit (assembler + kd17 test + types). Behavior returns to category+sign wholesale. No other surface touched.

---

## 5. Test plan

1. **Pre-implementation (evidence capture, developer machine):**
   a. `npx tsx scripts/backfill-flowtype.ts` dry-run → **0 to classify** (non-null invariant re-proof).
   b. Capture "before" snapshot: a small throwaway script calling `assembleTransactionsSummary` for the primary Space (90-day window, full scope) → JSON to `docs/initiatives/flowtype/fixtures/slice4-before.json` (no fixture exists today; this creates the baseline).
2. **Unit (updated):** `transactions.kd17.test.ts` — re-express `buildMonthlyBreakdown` fixture rows with explicit `flowType` fields; all existing assertions must stay green (debit-only totals, credit disclosure, pure-credit-month drop, invariant arithmetic, source tripwires).
3. **Unit (new):** partition cases in the kd17 file or a sibling: dividend row → incomeTotal not expenseTotal; fee row → expenseTotal; REFUND row → refundTotal not expenseTotal/incomeTotal; DEBT_PAYMENT INFLOW leg → excluded from debtPaymentTotal; INVESTMENT/ADJUSTMENT rows → excluded from all totals.
4. **Post-implementation diff:** re-run the snapshot script → `slice4-after.json`; diff must show **only** N1–N10 deltas. Any unexplained line = stop, investigate.
5. **Suites:** `npm test` (27/27 + new cases), `npx tsc --noEmit`, `npm run lint`, `npx prisma generate` / `migrate dev` no-op.
6. **Manual:** open Daily Brief (savings-rate copy sane); one chat question ("what did I spend last month?") and one drilldown ("show my largest transactions") return coherent figures.
7. **Sign-off record:** paste the before/after diff into this document's §7 and check every box before merge.

---

## 6. Exact files expected to change (implementation, after approval)

- `lib/ai/assemblers/transactions.ts` — query where/select, `TxnRow`, window partition, `buildMonthlyBreakdown`, merchant/income/recurring rollups, drilldown default filter.
- `lib/ai/assemblers/transactions.kd17.test.ts` — fixture rows gain `flowType`; new partition cases.
- `lib/ai/types.ts` — `TransactionsSummaryData` gains optional `refundTotal` (additive; only if D-3 approved).
- `docs/initiatives/flowtype/fixtures/slice4-before.json` / `slice4-after.json` — snapshot evidence (new).

**Not changed:** schema, migrations, any write path, `annotations.ts`, `chat/route.ts`, Brief route, dashboard components, Merchant Intelligence, AiAdvice.

---

## 7. Human sign-off checklist (all boxes required before implementation)

Decisions:
- [ ] **D-1** Row set = `{SPENDING, REFUND, INCOME, DEBT_PAYMENT, TRANSFER, FEE, INTEREST}`; INVESTMENT/ADJUSTMENT/UNKNOWN excluded.
- [ ] **D-2** `expenseTotal` = gross Σ over `{SPENDING, FEE, INTEREST}` (interest parity kept; fees newly counted; dashboard-aligned).
- [ ] **D-3** Refunds disclosed via new `refundTotal`; `expenseTotal` NOT netted (KD-17 preserved).
- [ ] **D-4** `netCashFlow = income + refunds − expenses − debt payments` — approve formula change, **including** the N10 caveat (misclassified card-payment credits inflate it until Merchant Intelligence fixes their category). Alternative if rejected: keep old formula, refunds disclosed only.
- [ ] **D-5** Drilldown default filter → `flowType: 'SPENDING'` (sign guard retained).

Behavior acceptances:
- [ ] Dividends count as income (9 rows; dollar values from the before-snapshot).
- [ ] Fee rows become reachable and count as expense.
- [ ] Dividend payers may appear in `incomeSources`; dividend/fee merchants may appear in `recurringCandidates`.
- [ ] Daily Brief savings rate will shift accordingly.
- [ ] Dashboard chip (nets refunds) vs assembler (gross + refundTotal) presentation difference accepted for this slice.

Preconditions:
- [x] Backfill dry-run reports 0 to classify (2026-07-05).
- [x] `slice4-before.json` captured and committed.
- [x] Slice 3 merged and validated (done — 27/27, clean tsc/lint).

---

## 8. Post-implementation evidence (2026-07-05)

Snapshot pair: space `cmr4279ig0004d7utc6ta6ecg`, window 2026-04-07..2026-07-05 (90d).
Validation: `npm test` 27/27 (local), `tsc --noEmit` clean, lint 0 errors (4 pre-existing img warnings), prisma no-op.

Complete field-level diff — every changed value, each mapped to a predicted delta:

| Field | Before | After | Prediction |
|---|---|---|---|
| `transactionCount` | 105 | 109 | **N5** — the 4 Dividend rows in this window entered via D-1 (the DB-wide count was 9; this window holds 4). |
| `incomeTotal` | 27,873.90 | 28,036.10 | **N1** — +162.20 = AAPL 22.00 + MSFT 33.60 + QQQ 18.40 + VOO 88.20, exactly the 4 dividends. |
| `refundTotal` | (absent) | 0 | **N3** — new field; no REFUND rows in this window (every spend category shows creditTotal 0). |
| `netCashFlow` | 21,290.79 | 21,452.99 | **N4** — +162.20 = income delta + refund 0. |
| `byCategory` | — | +`Dividend (total 0, creditTotal 162.20, count 4)` | **N5** — window-level zero-debit entry kept per C7; monthly byCategory drops it (credit-only), also per C7. |
| `monthlyBreakdown` 2026-05 | income 8,216.80, count 37 | 8,268.80, 39 | **N1/N5** — 2 dividends (+52.00). |
| `monthlyBreakdown` 2026-06 | income 12,025.90, count 39 | 12,136.10, 41 | **N1/N5** — 2 dividends (+110.20). May+June = 162.20 ✓. |
| `monthlyBreakdown` (all) | — | `refundTotal: 0` | **N3** — new monthly field. |
| `incomeSources` | — | +AAPL, +MSFT, +QQQ, +VOO (1 occurrence each) | **N6** — dividend payers as income sources. |
| Brief savings rate | 81% | 82% | **N9** — (income−expense)/income: 81.41% → 81.51%, crosses the rounding boundary. |

Unchanged, as predicted for this window: `expenseTotal` 5,183.11 (**N2** zero-magnitude — no Fee rows and no interest *charges* in the window; the Interest category's 107.90 is interest *earned*, income under both semantics), `debtPaymentTotal` 1,400, `transferTotal` 6,600, all pending figures, `merchants` rollup byte-identical (the SPENDING one-predicate equivalence), `recurringCandidates` unchanged (each dividend payer has 1 occurrence, below the 2+ threshold — **N7** zero-magnitude), `largestIncome`/`largestExpense` unchanged (**N8** — payroll 3,800 > any dividend; no fee > 820), **N10** zero-magnitude (no misclassified payment credits in this window).

**Result: zero unexplained deltas.** Every changed number is one of N1/N3/N4/N5/N6/N9; every predicted-but-absent delta (N2/N7/N8/N10) is absent because its trigger rows don't exist in this window, not because the logic diverged.
