# KD-10 — Two Competing "Monthly Expense" Figures in One Prompt

**Status:** Investigation only. No code changes. No files edited. STATUS.md untouched. KD-7 files untouched.
**Branch:** `feature/phase-2-architecture`
**Date:** 2026-07-02
**Related:** KD-7 (transaction fetch cap / monthly rollup correctness) — running in another thread; KD-2 (output validator).

---

## 1. Executive summary

A single Space system prompt emits the monthly-expense figure **twice, computed two different ways**, and the two can legitimately disagree:

- **Assessment block** (`=== FINANCIAL ASSESSMENT ===`) prints `Est. monthly expenses` using a **window-normalized estimate**: `expenseTotal ÷ windowDays × 30`. This appears **twice** inside the assessment (CASH FLOW and LIQUIDITY), both from the same formula.
- **Context block** (`=== SPACE CONTEXT ===`) prints `AVERAGE MONTHLY SPENDING` using a **complete-calendar-month average**: `sum(expenseTotal of complete months) ÷ completeMonthCount`, excluding partial months.

Both are labeled authoritatively ("Use this exact figure…"), both land in the same prompt, and the KD-2 output validator treats **both as reconcilable** (membership-based), so it cannot catch the model quoting either one. The assistant can therefore answer "what are my monthly expenses?" with two different numbers across turns, each "grounded."

**Root cause:** an incomplete migration. The context block was deliberately moved off the window-normalized estimate to complete-month averaging (D6.3 Part B) — its own comment says *"The prior window-normalized estimate (total ÷ windowDays × 30) is gone."* But the assessment block (`computeAssessment` in `annotations.ts`) was never migrated and still computes the old window-normalized figure.

**Recommended minimal fix:** collapse to one source — have the assessment reuse the same complete-month average the context block already derives (single source of truth), so all three emissions print the identical number and liquidity coverage stays consistent. **Sequence after KD-7 lands**, because KD-7 redefines which months count as reliable/complete, and the fix must filter on KD-7's final predicate to avoid re-diverging.

**Do not implement yet.** Investigation only.

---

## 2. Impact map

| Consumer | File / lines | What it emits | Formula |
|---|---|---|---|
| CASH FLOW → `cashFlow.estimatedMonthlyExpenses` | `lib/ai/intelligence/annotations.ts` L1781–1783 (computed), L1814 (assigned) | `Est. monthly expenses: $X/mo` | `round(expenseTotal / windowDays × 30)` — **window-normalized** |
| LIQUIDITY → `liquidity.estimatedMonthlyExpense` | `lib/ai/intelligence/annotations.ts` L1940–1942 (computed), L1970 (assigned) | `Est. monthly expenses: $X/mo` | `round(expenseTotal / windowDays × 30)` — **duplicate of the above** |
| Liquidity coverage (depends on the figure) | `annotations.ts` L1950 | `Coverage: N months → CLASSIFICATION` | `totalLiquid / estimatedMonthlyExpense` |
| AVERAGE MONTHLY SPENDING | `app/api/ai/chat/route.ts` L647–665 | `AVERAGE MONTHLY SPENDING … $Y/month` | `sum(complete-month expenseTotal) / completeCount` — **complete-month avg** |
| Assessment emission (both `Est.` lines) | `app/api/ai/chat/route.ts` L1180–1181 (cash flow), L1234–1238 (liquidity) | the two `$X/mo` lines above | — |
| Prompt assembly (both blocks in ONE prompt) | `app/api/ai/chat/route.ts` `buildSpaceSystemPrompt` L1524–1531 | ASSESSMENT + CONTEXT concatenated | — |
| Master (cross-Space) prompt — same defect per Space | `app/api/ai/chat/route.ts` `buildMasterSystemPrompt` L1560–1575 | ASSESSMENT + CONTEXT per Space block | — |
| KD-2 output validator (cannot disambiguate) | `lib/ai/output-validator.test.ts` L34–36, L101–105 | treats **both** `$X` and `$Y` as reconcilable | membership, not provenance |

Data source for both paths is the **same** `TransactionsSummaryData` object (`getTxnData(ctx)` in the assessment; `getTransactionsSummary(ctx)` in the context). No new query is involved — this is a pure derivation/labeling divergence.

---

## 3. Exact conflicting fields / prompts

Two `estimatedMonthlyExpense(s)` fields on the assessment, identical formula, both window-normalized:

```
// annotations.ts L1781 (cashFlow)
const estimatedMonthlyExpenses = txn && windowDays > 0 && expenseTotal > 0
  ? Math.round((expenseTotal / windowDays * 30) * 100) / 100 : null;

// annotations.ts L1940 (liquidity)  — byte-identical formula, second copy
const estimatedMonthlyExpense = txn && windowDays > 0 && expenseTotal > 0
  ? Math.round((expenseTotal / windowDays * 30) * 100) / 100 : null;
```

Context block, different formula:

```
// chat/route.ts L657–658
const totalSpend = completeMonths.reduce((s, m) => s + m.expenseTotal, 0);
const avgSpend   = Math.round((totalSpend / completeCount) * 100) / 100;
```

Prompt strings that collide (all in one prompt):

- Assessment, L1181: `  Est. monthly expenses: ${fmtMoney(cashFlow.estimatedMonthlyExpenses)}/mo`
- Assessment, L1238: `  Est. monthly expenses: ${fmtMoney(liquidity.estimatedMonthlyExpense)}/mo`
- Context, L660–664: `AVERAGE MONTHLY SPENDING (deterministic …): ${fmtMoney(avgSpend)}/month. Use this exact figure for "average monthly spending". Do NOT recompute it from a window total…`

The test fixture already encodes the divergence as expected behavior:
`'Est. monthly expenses (assessment): $1,850.00/mo'` vs `'Est. monthly expenses (context): $2,100.00/mo'` — both asserted reconcilable (L101–105).

---

## 4. Root cause

**Incomplete D6.3 Part B migration.** The context block was intentionally moved from the window-normalized estimate to a complete-calendar-month average, explicitly to make month-by-month, average, and category figures reconcile against one set of `monthlyBreakdown` rows (see the comment at `chat/route.ts` L633–640). The assessment block (`computeAssessment`) was left on the old formula and still ships the very estimate the context block declares "gone."

The two figures diverge for two independent reasons, which generically do **not** cancel:

1. **Numerator:** assessment uses `txn.expenseTotal` (entire window, **including** partial/clipped months); context sums **only complete months'** `expenseTotal`.
2. **Denominator:** assessment divides by `windowDays / 30` (fractional months, including partial-coverage days); context divides by the **integer count of complete calendar months**.

Secondary contributor: the assessment computes the figure **twice** (cashFlow + liquidity), duplicated code that guarantees future drift risk even within the assessment.

Amplifier: the KD-2 validator is membership-based, so it green-lights both values and provides no backstop.

---

## 5. Which figure should be authoritative

**The context block's complete-month average** (`sum(complete-month expenseTotal) / completeCount`). Rationale:

- It is the declared **single source of truth** for spending (D6.3 Part B) and reconciles with the per-month `MONTHLY SPENDING BY MONTH` rows and the category averages already printed in the same block.
- It excludes partial/clipped months, so a partial July can't dilute a Jan–Jun figure — the window-normalized estimate has no such guard.
- Integer month denominator matches how a user reads "monthly."

Implication: liquidity **coverage months** (`totalLiquid / estimatedMonthlyExpense`, L1950) must be recomputed against the authoritative figure so coverage and the printed expense figure stay internally consistent.

Edge case to preserve: when there is **no complete month** in the window, the context block deliberately declines to assert a monthly average (L702–712). The assessment fix must mirror that — emit `null` (no `Est. monthly expenses` line, and coverage → `UNKNOWN`) rather than falling back to the window-normalized number.

---

## 6. Recommended minimal fix (spec only — do not implement)

Single source of truth, computed once, consumed everywhere:

1. Derive the complete-month average **once** (in the transactions assembler alongside `monthlyBreakdown`, or a small shared helper both `annotations.ts` and `chat/route.ts` import). Preferred: assembler, so it travels on `TransactionsSummaryData` and both prompt blocks read the identical field.
2. In `computeAssessment`, replace **both** window-normalized computations (L1781, L1940) with that shared figure. Delete the duplicate.
3. Coverage (L1950) then divides by the same figure automatically.
4. Preserve the "no complete month → no average" contract: figure is `null`; suppress the `Est. monthly expenses` line; coverage → `UNKNOWN`.
5. Optional labeling hardening: rename the assessment line to match ("Average monthly spending") or add a one-line note that it equals the context figure, so the model never treats them as two sources.

This is additive-then-subtractive (add shared field, repoint consumers, remove dead formula) and matches the project's "keep changes additive before subtractive" rule.

---

## 7. Collision risk with KD-7

**Moderate — shared files and a shared dependency. Sequence KD-10 after KD-7.**

- **Same files.** KD-7's fix touches `lib/ai/intelligence/annotations.ts` (`computeSpendingTrends`), `app/api/ai/chat/route.ts` (prompt "exact/only valid" language), and `lib/ai/assemblers/transactions.ts` (adds `truncated` / `coverageStartDate`, marks boundary months). KD-10 edits `annotations.ts` (the two expense computations) and `chat/route.ts` (assessment lines). Overlap in both files → merge-conflict risk if done concurrently.
- **Shared dependency — the reliable-month predicate.** KD-10's fix filters "complete months" via `!m.partial`. KD-7 introduces a **new** notion of unreliable months (truncated by the 5,000-row cap, not flagged `partial` today). After KD-7, the correct filter becomes "complete **and** not truncated." If KD-10 lands first on `!partial` alone, it will average over months KD-7 will later declare hollow, re-introducing a silent error.
- **Same authoritative source.** If KD-7 relocates or reshapes `monthlyBreakdown`/aggregation, KD-10's shared helper should be built on top of KD-7's final shape, not the current one.

**Recommendation:** do not implement KD-10 until KD-7 merges. Then implement KD-10 as a thin layer that (a) reuses whatever reliable-month predicate KD-7 finalizes and (b) routes both blocks through one shared field — which also prevents a future third divergence.

---

## 8. Validation checklist (for the eventual fix, after KD-7)

- [ ] `npx prisma generate` — clean (no schema change expected).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] Unit: assessment `estimatedMonthlyExpense(s)` equals context `avgSpend` for the same `TransactionsSummaryData` (property test over several windows).
- [ ] Unit: no-complete-month window → both suppressed; coverage = `UNKNOWN` (no window-normalized fallback).
- [ ] Unit: coverage months = `totalLiquid / authoritativeFigure`.
- [ ] Update `lib/ai/output-validator.test.ts` L34–36 / L101–105: the fixture no longer needs two competing figures; assert a single monthly-expense figure reconciles (the KD-10 dual-figure carve-out can be removed once the prompt emits one).
- [ ] Prompt snapshot: exactly one monthly-expense value appears across ASSESSMENT + CONTEXT for a fixed input (grep the rendered prompt for `/mo` and `/month`).
- [ ] Regression: confirm KD-7's truncated/partial months are excluded from the averaged figure.
- [ ] Master prompt path (`buildMasterSystemPrompt`) exhibits the same single-figure behavior per Space.

---

## 9. Final recommendation

Confirmed defect: the assessment block ships a window-normalized monthly-expense estimate (`expenseTotal / windowDays × 30`, duplicated in cash-flow and liquidity) while the context block ships a complete-month average — both in one prompt, both labeled authoritative, and the KD-2 validator green-lights either, so the assistant can state two different "monthly expenses." Root cause is an incomplete D6.3 Part B migration. The complete-month average is the correct authority; the fix is to make the assessment reuse it via a single shared field and recompute coverage against it. **Hold implementation until KD-7 lands** (shared files + shared reliable-month predicate), then implement KD-10 as a thin single-source-of-truth alignment on top of KD-7's coverage model.
