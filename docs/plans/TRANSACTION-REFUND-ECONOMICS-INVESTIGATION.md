# Transaction refund economics — investigation and REFUND-1

**Date:** 2026-09-20 · **Base:** v2.6 @ 189b6df · **Status:** implemented (code + tests); live rows await an operator-run repair (§11)

The question answered here is general, not about one merchant:

> What economic effect should a refund have on spending, category totals, measured baselines and downstream reasoning?

All live figures below were read READ-ONLY from the dev database on 2026-09-20. None is pinned in a test.

---

## 1. Root cause

The refund model already existed and was mostly right. `REFUND` is a first-class `FlowType`; the one economic fold (`foldEconomicRow` / `clampEconomicSpend`, `lib/transactions/cash-flow.ts`) nets refunds out of spending; `outflowByCategory` nets them per category; a refund is never income.

The reported refund never reached that model. **It was stored as earned income.**

Plaid's `personal_finance_category` models "a merchant paid this person" as `INCOME` and chooses the detail from the **brand**: Airbnb → `INCOME_RENTAL`, Uber → `INCOME_GIG_ECONOMY`. On a depository account that can be right. On a credit card it is a refund.

| date | descriptor | amount | Plaid PFC | stored category / flowType |
|---|---|---|---|---|
| 2026-09-09 | `AIRBNB * HMEZRPZZYQ` | −1,098.88 | `TRAVEL_LODGING` | Travel / SPENDING |
| 2026-09-14 | `AIRBNB * HMEZRPZZYQ` | **+339.96** | `INCOME_RENTAL` (HIGH) | **Income / INCOME** |
| 2026-09-14 | `AIRBNB * HMT3XASAMQ` | −732.48 | `TRAVEL_LODGING` | Travel / SPENDING |
| 2026-09-18 | `AIRBNB * HMT3XASAMQ` | **+521.34** | `INCOME_RENTAL` (HIGH) | **Income / INCOME** |

Both refunds: account `CREDIT CARD` (type `debt`), posted, `counterpartyType MERCHANT`, `paymentChannel OTHER`, same `merchantEntityId` as the charges, each with a tombstoned pending twin linked by `pendingTransactionRef`.

Then a second, subtler failure. The read-time income taxonomy (`lib/transactions/income-source.ts:182`, fed by `serialize.ts:267` and `assemblers/transactions.ts:730`) *already* refuses to count an INCOME-tagged liability inflow as income — it classes it `ISSUER_CREDIT` → `NOT_INCOME`. And `foldEconomicRow` (`cash-flow.ts:321`) does this with it:

```ts
else if (isIncome(flowType)) {
  if (incomeClass === "NOT_INCOME") return;   // named, excluded, never silent
```

So the money landed in **neither** bucket — not income, not a refund. It simply left the economic axis, and Travel stayed gross. Of the nine candidate failure modes: **(3) classified as income** at write time, corrected at read time into **(9) something else: dropped from the fold entirely.** It was not lost in ingestion, not mis-signed, not a transfer, not uncategorised, and the analysis does not aggregate outflows only.

This is not an Airbnb problem. Six live rows have the shape, $1,356.95:

| merchant | amount | Plaid detail |
|---|---|---|
| Airbnb ×2 | +521.34, +339.96 | `INCOME_RENTAL` |
| MICROSOFT#G174400309 | +280.45 | `INCOME_SALARY` |
| EasyTime | +151.73 | `INCOME_CONTRACTOR` |
| Uber | +45.09 | `INCOME_GIG_ECONOMY` |
| HUNGERSTATION LLC | +18.38 | `INCOME_CONTRACTOR` |

For contrast, 21 liability credits Plaid filed in a *spend* family (10 of them earlier Airbnb refunds under `TRAVEL_LODGING`) were already `REFUND` and already netted. The provider is inconsistent about the same merchant's refunds; the platform inherited the inconsistency.

## 2. Provider evidence — what exists and what does not

| evidence | present? |
|---|---|
| explicit "this is a refund" flag | **no** — Plaid has none |
| original-transaction reference | **no** |
| `pending_transaction_id` | yes — links a row to **its own** pending observation, never a refund to its purchase |
| `transaction_code` | captured in memory (`plaid-flow-input.ts:148`); populated for European institutions only; left no trace here (derived `paymentMethod` = UNKNOWN) |
| `merchant_entity_id` | yes on Airbnb / Uber; absent on the other three |
| raw descriptor | yes; Airbnb's embeds a booking code shared by charge and refund, Microsoft's an order number — but HUNGERSTATION's is shared by 14 purchases |
| sign | FM convention `+` = into the row's own account, set at `lib/plaid/syncTransactions.ts:399` (`amount = -txn.amount`) |

**Sign alone establishes nothing.** Of 174 positive rows on liability accounts, 130 are classified card payments and 21 are provider-labelled refunds.

## 3. BEFORE pipeline map

```
Plaid /transactions/sync
  └─ lib/plaid/syncTransactions.ts:399   amount = −txn.amount                      (sign convention)
  └─ :400  mapPlaidCategory(txn)  →  lib/transactions/plaid-category.ts:83
           PFC primary INCOME → "Income"   (account-blind, amount-blind; structural primaries
                                            WIN over merchant rules by design)
  └─ resolveLiabilityPaymentCategory      Other-only rescue → no effect on "Income"
  └─ resolvePayrollIncomeCategory         Other-only rescue → no effect
  └─ :516  classifyFlow(input) → lib/transactions/flow-classifier.ts  case 'INCOME'
           → INCOME / INFLOW / 0.8 / PLAID_PFC_PRIMARY        ✗ WRITE-TIME DEFECT
  └─ persisted: category=Income, flowType=INCOME, categorySource=PLAID_PFC

read
  └─ lib/transactions/serialize.ts:267 · lib/ai/assemblers/transactions.ts:730
           liabilityInflowIsCustomerPayment(family INCOME) = NO → attributeIncome
           → ISSUER_CREDIT → incomeClass NOT_INCOME          (income correctly protected)
  └─ lib/transactions/cash-flow.ts:321  foldEconomicRow: NOT_INCOME → return
           ✗ READ-TIME DEFECT — the magnitude reaches no bucket
  └─ outflowByCategory: flow is INCOME → skipped; category is "Income" anyway
           → Travel reported GROSS                            ← the user-visible symptom

downstream, all over the same persisted flowType
  ├─ Cash Flow workspace / Spending by category   Travel gross
  ├─ AI assembler byCategory                      Travel gross, no creditTotal (the credit sits under "Income",
  │                                               which has no debits and is filtered out)
  ├─ M1 measure_flows(spending, Travel)           gross — and no refund figure for a category AT ALL (§8)
  ├─ Daily Brief recent activity                  lib/ai/brief/recent-activity.ts:78 emits flow "INCOME",
  │                                               category "Income" for a lodging refund
  └─ transaction detail                           labelled "Issuer credit"
```

## 4. Canonical refund semantics

| # | kind | treatment | how it is known |
|---|---|---|---|
| 1 | purchase refund / merchant credit | **REFUND** in the purchase's category; nets that category | provider spend family + positive amount; or §5 |
| 2 | reversal | same as 1; same-day pair nets to exactly 0 | same |
| 3 | card payment | DEBT_PAYMENT — never reduces a category | payment family (`liability-inflow.ts`), descriptor rescue |
| 4 | account transfer | TRANSFER — never | transfer family / transfer authority |
| 5 | cashback / reward / statement credit | **not** a purchase refund. On a card: family OTHER → `Other`/UNKNOWN (the SR-1 valve): out of income *and* refunds | existing semantics, kept |
| 6 | reimbursement | never silently a refund: a friend's Zelle is a TRANSFER, an employer's is INCOME | provider family |
| 7 | chargeback / dispute credit | no provider dispute flag. Filed in the purchase's family ⇒ indistinguishable from, and treated as, a refund of that category; a lost dispute re-bills as a new charge **in its own month**. Filed by the issuer with no family ⇒ UNKNOWN | provider family |
| 8 | partial refund | gross 1,500 / refunds 500 / net 1,000 | |
| 9 | full refund | net 0; category not listed | |
| 10 | refund exceeding same-window purchases | category net floors at 0; the excess is **named** `refundsUnapplied` (§7) | |

## 5. Matching and attribution — category-level, not purchase-level

**Decision: category-level netting. No refund is paired to a purchase.**

The evidence cannot support pairing in general (no provider link; a descriptor that identifies one Airbnb booking identifies fourteen HungerStation orders), and the economics do not need it: a category's cost is `gross − refunds` whichever purchase a refund belonged to.

For the defect population two separate things are decided, with different certainty:

**ESTABLISHED — structural, certain.** A liability account cannot receive earnings. `classifyFlow` now vetoes INCOME on a liability inflow on *both* income paths (provider family and `Income` category) — the mirror of CCPAY-2B's "a liability outflow is never a debt payment". No merchant evidence is involved.

**ATTRIBUTED — evidence, conservative.** *Which* category the credit reverses. The provider's label is void, so the category comes from what the ledger itself knows: the same merchant's **prior purchases on the same account**. Unanimous in one genuine spend category ⇒ that category. Silent, split, or only `Other` ⇒ `Other`, which the classifier sends to the honest UNKNOWN valve.

"Same merchant" is **exact equality** on the provider's merchant entity id, the stored merchant name, or the raw issuer descriptor. The descriptor arm is measured, not speculative: Plaid enriches HungerStation's *purchases* (`Hungerstation LLC`, `Hunger Station`) and leaves the *credit* raw (`HUNGERSTATION LLC`), while the descriptor is identical on all 14.

This is **not** "same merchant + positive amount = refund". Merchant history never decides that a row *is* a refund — account structure and provider family did. History only picks the category, and only unanimously. It is the inference Plaid itself makes for an ordinary refund, applied where Plaid's own label is structurally impossible.

Live outcome (dry run, no writes):

| row | result | basis |
|---|---|---|
| Airbnb +521.34, +339.96 | Travel / REFUND | 10 prior purchases, all Travel |
| Uber +45.09 | Travel / REFUND | 72, all Travel |
| HUNGERSTATION +18.38 | Dining / REFUND | 14, all Dining |
| EasyTime +151.73 | Other / UNKNOWN | 2, both `Other` |
| MICROSOFT +280.45 | Other / UNKNOWN | 1, `Other` |

$924.77 attributed; $432.18 left honestly unattributed. Confidence is recorded: an attributed refund classifies at 0.6 / `ACCOUNT_TYPE_CONTEXT`, below a provider-labelled refund's 0.7 / `PLAID_PFC_PRIMARY`. `categorySource` is left NULL ("provenance not claimed") because the enum has no value for it and adding one needs a migration.

## 6. Where it is implemented

One decision yields both persisted columns, in the layering CCPAY-2C and SR-2 established — **category first, then flow**:

```
mapPlaidCategory → payment rescue → payroll rescue → MERCHANT CREDIT (new) → classifyFlow (veto, new)
```

- `lib/transactions/merchant-credit.ts` — the pure category authority.
- `lib/transactions/merchant-credit-evidence.ts` — the one read, shared by sync and repair.
- `lib/transactions/flow-classifier.ts` — `incomeUnlessLiabilityInflow`, `isGenuineSpendCategory`, `FLOW_CLASSIFIER_VERSION` 4 → 5.
- `lib/plaid/syncTransactions.ts` — the seam; the read is gated to the affected population (~0.1% of rows).

**Nothing in the economic fold changed.** Once the row is `Travel`/`REFUND`, `foldEconomicRow`, `outflowByCategory`, the AI assembler, the annotations net and the Brief all treat it correctly with code that already existed. That is the evidence the layer is the right one.

## 7. Gross / refunds / net, and period semantics

`categorySpendLedger` (`cash-flow.ts`) is now the arithmetic; `outflowByCategory` is its ranking.

```
gross            Σ|amount| of cost flows DATED IN the window
refunds          Σ|amount| of REFUND rows DATED IN the window
net              max(0, gross − refunds)
refundsUnapplied max(0, refunds − gross)
```

**A refund counts in the period it is dated, never the period of the purchase it reverses.** No purchase is looked up, inside or outside the window.

| case | treatment |
|---|---|
| purchase and refund in the window | 1,500 / 500 / 1,000 |
| purchase before, refund inside | gross 0 · refunds 500 · net 0 · **unapplied 500** |
| purchase inside, refund after | this window shows 1,500; the later window carries the refund. Closed periods are **not** rewritten |
| pending refund | The Cash Flow read applies no pending filter, so a live pending refund nets at once; AI money totals are settled-only and wait for posting (both existing policy, not changed here). It is already Travel/REFUND while pending — it never spends a day as income |
| pending purchase | same; pending and posted observations classify identically |
| refund posts | the pending twin is tombstoned, the event's economic date stays pinned to the first observation (L8) — the refund does not change period on posting |
| original disappears / reverses | a withdrawn pending purchase is tombstoned and leaves the fold; a posted reversal is a refund row |

`refundsUnapplied` exists because a category floors at 0 while the headline nets refunds against *all* spending; without it the lines and the headline differ by that amount and nothing says why. Pinned: **Σgross − Σrefunds = Σnet − ΣrefundsUnapplied**.

## 8. Downstream authority

| consumer | basis | changed? |
|---|---|---|
| Cash Flow headline, Spending by category | **NET** | arithmetic unchanged; now shows gross and refunds under a netted category |
| AI `byCategory` | `total` stays GROSS (KD-17); **+ `refundTotal`, `netTotal`** when a category has refunds | yes |
| M1 `measure_flows` spending, total and per category | `total` stays GROSS; **+ `netOfRefunds`**, and **`changeNetOfRefunds`** on comparisons | yes |
| `economicNet`, `netCashFlow`, annotations net | NET (already) | no |
| income totals | refunds excluded (already); stored kind now agrees | via classification |
| Daily Brief recent activity | flow/category as stored | via classification |
| **MEASURED expense baseline**, runway denominator, savings rate | **GROSS — deliberately unchanged** | **no — see below** |
| forecast `spending-baseline.ts` / `observed-spending.ts` | GROSS (SPENDING+FEE, 28-day windows) | no |

Two things found here that are independent of the misclassification:

**M1 had no net for a category.** `measure_flows(spending, category)` returned debit-only gross, `refunds` took no category, and the tool forbids prose subtraction — so a *correctly* classified refund (June's $2,871.20) was unreachable for "how much did I spend on travel". M1 also described `economicNet` as "income − spending" while its own `spending` was gross, so its figures did not satisfy its own identity. `netOfRefunds` uses the same per-month floor `economicNet` uses, so `income − netOfRefunds = economicNet` month by month.

**The measured baseline is gross, and that is material.** June holds a $2,871.20 charge refunded the same day. Over Mar–Aug 2026 the gross mean is **$6,718.67**/month; net of refunds (after the repair in §11) it would be **$6,181.35** — $537/month, 8%. My recommendation is that the baseline become net: a refunded purchase is not a living expense. I did **not** change it. It feeds runway, savings rate, "N months of expenses", the liquid floor and scenario baselines; those carry pins established against a live model that this slice could not re-run; and it is a product decision about a number the user plans against. It is pinned as gross in `refund-economics.test.ts` §22 with the net alternative stated beside it, so the decision is visible rather than accidental.

## 9. UX

Cash Flow ▸ Spending by category. A category with refunds in the window prints one quiet line under its net value: **`$1,500.00 charged · −$500.00 refunded`**. Categories without refunds are unchanged. Both figures are the ledger's; React subtracts nothing. The drill-down already lists the refund rows. At row level a refund reads **Refund**, neutral tone, money in (`flow-presentation.ts`, existing). Nothing is worded as a saving.

Not rendered in a browser — verified by source assertion only.

## 10. Invariants pinned (`lib/transactions/refund-economics.test.ts`, 91 checks)

gross, refunds, net, unapplied ≥ 0 · net = max(0, gross − refunds) · conservation (§7) · full refund ⇒ 0 · partial refund reduces by exactly the refund · card payment, transfer, reward, reimbursement and income never reduce a category · a refund is never income · every row is at most one of spending / refund / income · a liability inflow is never INCOME · the evidence read is exact, account-scoped, purchase-only and never looks forward · the seam runs the chain in order · the widget subtracts nothing.

Mutation check: with the veto disabled, 19 of the 91 fail.

Two standing guards fired during the work, and both were right to:

- `lib/ai/fold-enrolment.test.ts` forbids a re-inlined `refundTotal +=` in the AI assembler. The per-category refund figure is therefore folded through `foldEconomicRow` itself — a better outcome than the first draft.
- `lib/transactions/cash-flow-convergence.test.ts` asserts, by source scan, that the category loop records a row's id *after* the FX skip that governs its value. That loop moved whole into `categorySpendLedger`, so the assertion now targets it, and a new assertion pins that `outflowByCategory` only projects the ledger and folds nothing itself. The property is unchanged; this is the one guard edited.

Verification: full unit suite 557/557; tracked-source typecheck clean; eslint clean on every changed path. No model-sampled `scripts/ai-baseline/*.check.ts` was run — the `measure_flows` description and result shape changed, so those are worth a run before release.

## 11. Operator step — existing rows

The database was read-only for this work. The six stored rows stay `Income`/`INCOME` until repaired, so **the widget does not change on deploy alone**. New and re-delivered rows are correct immediately.

```
npx tsx --require ./scripts/lib/server-only-preload.cjs --env-file=.env.local \
  scripts/repair-liability-income-credits.ts            # dry run (default)
  ... --apply                                           # after a backup
```

Raw UPDATE of category / categorySource / flow columns only; ownership-gated; never touches a user-corrected row; prints a rollback line per row; idempotent. Dry-run output is in §5.

Also: `scripts/backfill-flowtype.ts`'s default predicate is `classifierVersion < current`, so after the bump its dry run will list every v4 row. That is the established version-migration behaviour; for this change only the repair above is needed.

## 12. Live validation (read-only, in-memory re-derivation; includes pending rows)

| September 2026 | before | after |
|---|---|---|
| Airbnb charges | 1,831.36 | 1,831.36 |
| Airbnb refunds recognised | 0.00 | **861.30** |
| Airbnb net | 1,831.36 | **970.06** |
| Travel gross | 4,504.22 | 4,504.22 |
| Travel refunds | 0.00 | **861.30** |
| Travel net | 4,504.22 | **3,642.92** |
| all spending, net | 8,005.18 | **7,143.88** |

June: Dining 1,299.69 → 1,281.31 (HungerStation); Travel unchanged at 549.01 net (its refund was always labelled). August: spending unchanged (Microsoft stays unattributed).

The user's recollection was one refund; the data holds **two**, on two bookings, four days apart. That the credits are Airbnb refunds is supported by: a credit card cannot receive rental income; same account and merchant entity as the charges; and each credit's descriptor carries the booking code of a charge on that card. It is not *proven* by a provider refund flag, because none exists.

## 13. Limitations

1. **The unattributed $432.18.** Microsoft's credit shares an order number with exactly one purchase — but that purchase is itself `Other`, and SR-1 forbids a positive `Other` from being a refund. Fixing the *purchase's* category (a user correction) is what would resolve it.
2. **First-ever refund from a merchant on a card** has no history ⇒ UNKNOWN. A user category correction is the escape hatch and is preserved.
3. **CSV / manual imports** get the veto but not the category attribution (no evidence read on that path): an `Income` row on a card becomes UNKNOWN with its category left as `Income`.
4. **A category refunded in a month with no purchases** is dropped from the AI's monthly `byCategory` (existing filter), so M1 shows net 0 for it without showing the refund. The Cash Flow ledger does show it (`refundsUnapplied`).
5. **Baselines remain gross** (§8).
6. `BANK_FEES_INTEREST_CHARGE` with a positive amount on a card (one live row, +0.35, an interest reversal) classifies INTEREST and is folded as a cost. Out of scope; noted.
7. Rewards deposited to a **depository** account under an INCOME family remain income (existing semantics).

---

## Addendum — NET-BASELINE-1: measured expense baselines use net economic spending

REFUND-1 left the measured expense baseline GROSS and said so (§ "deliberately
unchanged"). This slice closes it. **No refund arithmetic was added**: every
consumer reads the fold's monthly `expenseTotal` / `refundTotal` through the one
clamp (`clampEconomicSpend`) and the one monthly-mean definition
(`meanMonthlyEconomicSpend`, `lib/transactions/cash-flow.ts`).

**Semantics.** "How much do I spend a month" = per WHOLE month, gross charges less
the refunds DATED in that month, floored at 0; then the mean over the window.
- *Period:* a refund counts in the month it is dated. A later refund never
  rewrites the purchase's month; the mean simply holds one higher and one lower
  month, and the window total is conserved.
- *Excess:* a month whose refunds exceed its charges is 0 — never negative
  consumption. The excess is reported (`refundsUnapplied`), not carried into
  another month and not silently dropped. A baseline of 0 is still a refusal
  (`resolveExpenseBaseline`), never infinite runway.
- *Disclosure:* when refunds move the monthly figure by ≥ $1
  (`MATERIAL_MONTHLY_REFUND_EFFECT`) the tool output also carries `gross` and
  `refundEffect`, with `gross − refundEffect = net` exactly, so the model quotes
  the gap and never subtracts. Below that, nothing extra is said.

**Consumer matrix.**

| Consumer | Basis | Why |
|---|---|---|
| `computeAverageMonthlySpending` (assessment, `/api/spaces/[id]/expense-baseline`, Liquidity "months of expenses", Daily Brief `monthlyExpenses`) | **NET** | all ask "how much do I spend" |
| `get_baselines` expense (MEASURED rung) + `measuredSpending.byWindow` | **NET** (+ gross / refundEffect when material) | the figure surplus, savings rate, runway and thresholds divide by |
| monthly surplus · savings rate · runway · N-months-of-expenses thresholds | **NET** (inherited) | arithmetic over the baseline; unchanged code |
| cash projection observed spending rate (`project_cash`, `scenario_projection`, `scenario_crossing`, `scenario_goal_seek`) | **NET** | a refund returns the money; a gross rate drains cash the user still has |
| `liquidFloorMonthsOfExpenses` scenario floor | **NET** (inherited) | multiplies the rate the scenario itself spends at |
| spending TREND metric `expense` | **NET** | so `income − expense = net` reconciles within one table |
| `measure_flows(spending).total` / `perCompleteMonth`, `get_spending`, `byCategory.total`, category `gross` | **GROSS** (unchanged) | "how much was charged"; `netOfRefunds` / `netTotal` ride beside it |
| `measure_flows(economicNet)` | unchanged | already `income − max(0, spending − refunds)` |
| STATED / DECLARED baselines | unchanged | the user's own figure; not a measurement, carries no gross/refund fields |
| population-aware completeness, complete-month rule, window naming | unchanged | the economic definition changed, nothing else |

**Until the six legacy rows are repaired** (`scripts/repair-liability-income-credits.ts
--apply`), the live net baseline understates refunds only by the rows that fall in
complete months inside the window (HungerStation −18.38 in 2026-06); the two
September Airbnb refunds sit in the current, incomplete month and enter a
baseline once September closes.
