# KD-17 — January "Other" Exceeds Monthly Spending Total

**Status:** Investigation complete — defect confirmed in code. **LOGGED** 2026-07-02 as KD-17 in the STATUS.md §7 register, absorbed into v2.4.5 scope (approved roadmap revision). No fix implemented yet.
**Date:** 2026-07-02
**Severity:** High — deterministic pipeline emits mathematically impossible figures; validator cannot catch them.
**Observed:** January 2026 shows `Other: $6,529.45` while total January spending is `$5,848.70`.

---

## 1. Verdict summary

The AI is **not** hallucinating. The deterministic aggregation pipeline produces the impossible figure, serializes it into the prompt as authoritative, instructs the model to use it verbatim, and the membership-based validator then confirms it as reconciled. Every layer behaved as designed; the design contains a sign-handling asymmetry.

**Root cause:** category totals are `|Σ signed amounts|` per category, while the monthly spending total (`expenseTotal`) sums **negative rows only**. A positive-amount (credit/inflow) transaction classified into a spending category — and `Other` is the default landing category for anything Plaid can't classify — inflates that category's total without contributing a cent to `expenseTotal`. A single ~$6.5k credit categorized `Other` fully explains the observation.

## 2. Answers to the seven questions

| # | Question | Answer |
|---|----------|--------|
| 1 | Is the AI incorrect? | **No.** It narrated the exact figure the prompt supplied, as instructed ("use ONLY these values"). |
| 2 | Is category aggregation incorrect? | **Yes — defect locus.** Per-category totals use `abs(signed net)` including credits; `expenseTotal` uses debits only. Two different transaction populations labeled as the same concept. |
| 3 | Is normalization double-counting? | **No.** Each settled row is counted exactly once per rollup; merchant normalization does not feed category totals. |
| 4 | Is "Other" including transactions excluded from monthly totals? | **Yes.** Positive-amount rows in spending categories are counted in the category total but skipped by the expense accumulator. This is the mechanism. |
| 5 | Is there a transaction-classification bug? | **Contributing factor, not the core defect.** `mapPlaidCategory` defaults every unrecognized primary to `Other` (`lib/plaid/syncTransactions.ts:118,134`), so credit-side rows not classified `INCOME`/`TRANSFER_IN` (refunds, reimbursements, misc deposits, CSV imports) accumulate there. Side findings in §6. |
| 6 | Could transfers or debt payments be leaking into category totals? | Not via the `Transfer`/`Payment` categories — the prompt filters those (`NON_SPENDING`). But an inflow **misclassified as `Other`** leaks by definition — classification leakage, not aggregator leakage. |
| 7 | Could KD-7 have exposed a latent bug? | **No.** Truncation is not required for this arithmetic and is orthogonal. Indirectly, KD-10 (not KD-7) made monthly rollups the *sole* authority for monthly figures, giving the corrupted category line more prominence. |

## 3. Evidence — full path trace

Sign convention (established at ingest): app-side **positive = money in, negative = money out** (`lib/plaid/syncTransactions.ts:218-220`, `amount = -txn.amount`).

### Step 1 — Category normalization
`mapPlaidCategory` (`lib/plaid/syncTransactions.ts:97-135`): modern PFC taxonomy with `default: → Other` (line 118); legacy fallback also ends `return Other` (line 134). `Other` is therefore the catch-all for both debit and **credit** rows that match nothing.

### Step 2 — Monthly rollup (`lib/ai/assemblers/transactions.ts`, `buildMonthlyBreakdown`)
- Lines 689-692: per-month `categoryAgg` accumulates the **signed** sum per category — credits and debits net together.
- Lines 696-702: the same loop computes `expenseTotal` from **`txn.amount < 0` rows only** (after excluding Transfer/Payment/Income branches). A positive `Other` row falls through *all* branches — it contributes **zero** to every money total, but was already added to `categoryAgg`.
- Lines 721-728: output `total: Math.round(Math.abs(signed) * 100) / 100`, filtered to `> 0`.

**Arithmetic:** let `D` = Σ|debits| and `C` = Σ credits within `Other` for the month.
Category total = `|C − D|`; contribution to `expenseTotal` = `D`.
With `D ≈ 0` and `C = 6,529.45`, `Other` displays $6,529.45 while January `expenseTotal` = $5,848.70 (from other categories). Any month where a spending-classified category is net-positive can exceed the month's spending total. (Secondary distortion: when `C < D`, credits silently *understate* the category — same root cause, opposite direction.)

### Step 3 — Window-level rollup (same file, lines 274-281, 332-338)
The top-level `byCategory` has the identical flaw: signed accumulation, then `Math.abs(total)`.

### Step 4 — Prompt serialization (`app/api/ai/chat/route.ts`)
- Lines 726-735: the per-month categories line prints these `abs(net)` values labeled as "that month's OWN spending", filtered only by category *name* (`NON_SPENDING` set), never by **sign**.
- Lines 713-716 and 752-757: the prompt *asserts* "the listed categories… always sum to ≤ that month's spending total" and "A single category can never exceed that month's spending total." This is an **unchecked prose invariant** — the serializer never verifies it, and the data violates it. (Exactly the class STATUS.md §6 flags: "invariants still asserted in comments.")
- The model is explicitly ordered to use these values verbatim — so it did.

### Step 5 — Validator (`lib/ai/output-validator.ts`)
Membership-based by design (header, lines 4-16): a reply figure reconciles if it appears **anywhere** in the prompt. `$6,529.45` is in the categories line → reconciled → no annotation. This is the documented KD-2 caveat ("membership-based, not provenance-based") manifesting: the validator cannot catch internally inconsistent *context*, only fabricated numbers.

### Step 6 — Drilldown divergence (third figure for the same concept)
`assembleDrilldown` (`lib/ai/assemblers/transactions.ts:854-862, 911`): for a spending category like `Other`, it applies `amount: { lt: 0 }` and computes `matchedTotal = Σ|amount|` over **debits only**. So "what is Other made up of?" would return a *different, smaller* total (~`D`) than the monthly line (`|C − D|`) — the user can observe the contradiction directly, and neither figure is flagged.

## 4. Defect statement (for the KD register)

> Per-category rollups (window-level and per-month) aggregate the absolute value of the **signed net** of all rows in the category, while `expenseTotal` aggregates **debit rows only**. Positive-amount rows classified into spending categories (systematically concentrated in `Other` via the Plaid mapper's default) therefore inflate or deflate category totals relative to the spending total they are asserted to reconcile with. The prompt's reconciliation invariant is prose-only; the membership validator structurally cannot catch the violation; the drilldown path computes a third, debits-only figure for the same concept.

## 5. Proposed scope (design only — no implementation in this ticket)

1. Decide the semantic: category "spending" totals should aggregate **debit rows only** (mirroring `expenseTotal`'s population), with credits/refunds either surfaced as a separate per-category `creditTotal` or excluded with a disclosed count. Netting (current behavior) should be an explicit, named choice if retained anywhere.
2. Apply one rule to all three surfaces: window `byCategory`, monthly `byCategory`, drilldown `matchedTotal`.
3. Convert the prompt's "≤ spending total" prose invariant into a **checked** invariant at serialization time (fail loud in dev, annotate/log in prod).
4. Regression tests: net-positive category month; mixed credit/debit month; drilldown-vs-monthly agreement for the same category+month.
5. Data audit script: count/flag positive-amount rows in spending categories (quantifies blast radius before semantics change).

## 6. Side findings (out of scope, should be logged separately)

- `BANK_FEES → TransactionCategory.Fee` (`syncTransactions.ts:113`), but `Fee` is **not** in `BANKING_CATEGORIES` (`transactions.ts:83-95`) — fee transactions are invisible to all AI transaction aggregation.
- `TransactionCategory.Groceries` is unreachable from the Plaid mapper (`FOOD_AND_DRINK → Dining`; no primary maps to Groceries).

## 7. Register entry (logged 2026-07-02)

KD-17 · "Category rollup sign asymmetry: credits in spending categories inflate/deflate category totals vs expenseTotal" · **High** · Owner milestone: **v2.4.5** (financial-correctness defect, exactly the class v2.4.5 exists to close — not conversation quality) · Status: Open, investigation complete. Side findings (§6) are owned by v2.5.5 Financial Intelligence.
