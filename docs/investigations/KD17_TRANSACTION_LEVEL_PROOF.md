# KD-17 — Transaction-Level Proof: January 2026 "Other" ($6,529.45) vs Total Spending ($5,848.70)

**Status:** Investigation complete — root cause proven at transaction level. No implementation.
**Date:** 2026-07-02
**Predecessor:** `KD17_JANUARY_OTHER_CATEGORY_ANOMALY_INVESTIGATION.md` (code-level trace, same day)
**Evidence source:** `scripts/kd17-audit-jan-other.ts` (read-only, mirrors `lib/ai/assemblers/transactions.ts` exactly) → output archived at `docs/investigations/kd17-audit-output.md`, run 2026-07-02T14:34Z against local dev DB.
**Scope of defect:** AI-context pipeline only. UI verified clean (`BankingClient.tsx:177-179` computes spend debit-only, credits separately; no `abs(signed net)` rollup exists outside `lib/ai/assemblers/transactions.ts`).

---

## 1. Reproduction — exact

Space **"Chris's Dashboard"** (`cmqdwrv8s00047ple3s5ytesi`), January 2026, 147 settled rows, 0 pending:

| Figure | Observed in app | Recomputed from raw rows | Match |
|---|---|---|---|
| Monthly "Other" category line | $6,529.45 | $6,529.45 | ✅ |
| Monthly expenseTotal ("total January spending") | $5,848.70 | $5,848.70 | ✅ |
| Drilldown "Other" matchedTotal (third figure, debits only) | — | $2,970.55 | (predicted by prior investigation §3 Step 6) |

The second Space ("Retire by 35") shows no anomaly (no Other rows in window). The defect is data-dependent, not Space-dependent.

## 2. The causal rows — exactly four

January 2026 has **44** settled `Other` transactions: **40 debits** (Σ = $2,970.55) and **4 credits** (Σ = $9,500.00). The four credits are the entire mismatch:

| Date | Merchant | Amount | Flow type | Provenance | Account |
|---|---|---|---|---|---|
| 2026-01-01 | Payment Thank You-Mobile | +$1,500.00 | **payment** (credit-card payment received) | plaid | CREDIT CARD |
| 2026-01-04 | Payment Thank You-Mobile | +$3,500.00 | **payment** | plaid | CREDIT CARD |
| 2026-01-16 | Payment Thank You-Mobile | +$500.00 | **payment** | plaid | CREDIT CARD |
| 2026-01-30 | Payment Thank You-Mobile | +$4,000.00 | **payment** | plaid | CREDIT CARD |

All four are the **inflow leg of credit-card payments** (Chase "Payment Thank You") landing on the card account. They are not refunds, income, or imported data. Every one of the 44 rows is Plaid-synced (`plaidTransactionId` set); `importBatchId` is null on all rows — **imported historical data is ruled out**.

The 40 debit rows classify as: 39 ordinary debits (Uber ×31, Western Governors $1,081.25, Gathern $852.73 + $284.26, Corporate Filings $125 + $149, Hello Klean $125, Vercel $20, YouTube Premium $13.99) and 1 fee-pattern debit (NBS-WGU service fee $30.82). None is anomalous.

## 3. Which totals each row feeds

| Row set | monthly expenseTotal | monthly category total (prompt line) | drilldown matchedTotal |
|---|---|---|---|
| 40 Other debits (−$2,970.55) | ✅ counted | ✅ counted (signed) | ✅ counted |
| 4 Other credits (+$9,500.00) | ❌ **skipped** — positive rows fall through every branch of `buildMonthlyBreakdown` (`transactions.ts:694-702`) | ✅ **counted (signed)** — added to `categoryAgg` before the branch chain (`:689-692`) | ❌ **skipped** — `amount: { lt: 0 }` filter (`:862`) |

Three surfaces, three populations, three answers for "January Other": $6,529.45 (monthly line), $2,970.55 (drilldown), $2,970.55 (contribution to expenseTotal).

## 4. Reconciliation

```
Other credits (C)                      +$9,500.00
Other debits  (D)                      −$2,970.55
Signed net                             +$6,529.45
Monthly line prints |net|         →     $6,529.45   ← "Other"

expenseTotal = Σ debits by branch:
  Other      $2,970.55
  Shopping   $1,119.01
  Dining       $756.70
  Utilities    $192.06
  Interest     $810.38   (interest CHARGES — see side finding §6)
             ─────────
             $5,848.70   ← "total January spending"

Excess: $6,529.45 − $5,848.70 = $680.75
      = |C − D| − expenseTotal (no deeper meaning; two unrelated populations compared)
```

The monthly "Other" figure is not an inflated spend number — it is the **absolute value of a net inflow**. $9,500 of payment credits minus $2,970.55 of real spending nets to +$6,529.45, and `Math.abs()` at output (`transactions.ts:724`) erases the sign that would have revealed it.

## 5. Prior hypothesis — confirmed, with one refinement

The predecessor investigation's mechanism is **proven exactly**: category totals aggregate `|Σ signed amounts|` over all rows; `expenseTotal` aggregates debit rows only; positive rows in a spending category inflate the former and never touch the latter.

Refinement: the prior doc conjectured "a single ~$6.5k credit with D ≈ 0". Reality is **four credits totaling $9,500 netted against $2,970.55 of genuine debits**. Same mechanism, messier arithmetic — which also means the drilldown discrepancy ($2,970.55 vs $6,529.45) is user-visible today.

## 6. Root-cause attribution (task 5 of the brief)

| Candidate cause | Verdict | Evidence |
|---|---|---|
| Incorrect aggregation | **YES — primary defect** | §3/§4: same concept computed over three different populations; sign erased at output |
| Incorrect categorization | **YES — amplifier** | 4 credit-card payment credits carry category `Other`, not `Payment`. Notably a fifth, identical "+$4,000 Payment Thank You-Mobile" row IS in `Payment` (Payment credits = $4,000 in the same month) — Plaid's PFC tagging of the *same merchant string* is inconsistent, and `mapPlaidCategory`'s `default: → Other` absorbs whatever PFC didn't match. (Raw PFC is not persisted on `Transaction`, so this is inferred from the mapper's structure: only unmatched primaries can land in `Other`.) |
| Imported historical data | **NO** | All 44 rows Plaid-synced; `importBatchId` null throughout |
| Plaid mapping | **YES — same amplifier** | The mapper default routes unrecognized credit-side rows into a spending category instead of a non-spending one |
| Multiple issues | **YES** | One code defect (aggregation semantics) + one data-quality amplifier (inconsistent PFC → mapper default). Fixing categorization alone is insufficient: blast radius shows 59 positive `Other` rows (Σ $95,797.69), 12 positive `Travel` rows (Σ $4,518.58), 7 `Shopping`, 1 `Dining` — any future refund/reimbursement in any spending category re-triggers the impossibility. Fixing aggregation alone is sufficient to restore mathematical consistency. |

**New side finding (not in predecessor doc):** `Interest` **debits** (interest charges, $810.38 in January) are counted in `expenseTotal` (they fail the `INCOME_CATEGORIES && amount > 0` branch and fall to the `amount < 0` accumulator) but `Interest` is name-filtered from the prompt's categories line (`NON_SPENDING`). The categories line therefore sums to strictly *less* than expenseTotal by the interest-charge amount even after the KD-17 fix. This does not violate the "≤" invariant; log with the §6 side findings owned by v2.5.5.

## 7. Recommended fix (smallest, architecture-preserving)

Align the **population**, not the architecture: spending-category totals in the AI pipeline aggregate **debit rows only** — the same population `expenseTotal` and the drilldown already use. Credits per category are disclosed, not netted. All three surfaces then agree ($2,970.55) and the "≤ expenseTotal" invariant becomes checkable. No schema change, no migration, no UI change, no new tables, additive types only. Full plan: `docs/initiatives/kd17/KD-17_IMPLEMENTATION_CHECKLIST.md`.
