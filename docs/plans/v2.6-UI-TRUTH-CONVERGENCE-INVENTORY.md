# Financial Truth — UI Convergence Inventory

**Status:** INVENTORY ONLY. Nothing implemented, nothing written, no schema change.
**Corpus:** `Chris' Space`, 4,053 banking rows, measured 2026-08-05.
**Probe:** `npm run audit:ui-truth` (`scripts/audit-ui-truth-convergence.ts`, commit `e86e435`) — read-only.

The probe runs the canonical projection (`serializeTransactionRow`) and the real
widget predicates over the live corpus, so every number below is measured rather
than reasoned about.

> ⚠️ `getTransactions` cannot run under `tsx` — its import graph reaches
> `server-only`, which only Next resolves. The probe therefore calls the same
> projection the read boundary calls, over the same rows and the same
> `bankingTransactionWhere` shape. It is the boundary's DTO, not a second
> derivation.

---

## 1. The three reported symptoms, measured

### ✅ Symptom 2 — CONFIRMED, and root-caused

`MICROSOFT#G174400309`, +$280.45, 2026-08-03, on `CREDIT CARD` (a liability).

| Authority | Verdict |
|---|---|
| Income Authority (`income-source.ts`, via the serializer) | `incomeSubtype = ISSUER_CREDIT` ✅ correct |
| Issuer-Credit Authority (`liability-inflow.ts`) | consulted, verdict `NO` ✅ correct |
| Liquidity Authority (`liquidity.ts`) | `NEUTRAL / OTHER_INCOME` ❌ **wrong** |
| Transaction drawer | renders `humanize(flowType)` → **"Income"** ❌ **wrong** |

**The authorities already got this right.** The read boundary emits
`incomeSubtype` on the DTO (`types/index.ts:285`). The defect is downstream:

- **`components/transactions/TransactionDetailDrawer.tsx:165`** renders
  `humanize(detail.flowType)`. It never reads `incomeSubtype`.
- **No `.tsx` file anywhere reads `incomeSubtype`.** It is emitted by the
  boundary and consumed by nothing. `incomeClass` is read by Cash Flow and the AI
  assembler only.
- `classifyLiquidity` does not consult the income taxonomy, so it independently
  labels the same row `OTHER_INCOME`.

All four rows in this state:

| Date | Amount | Merchant | Account | DTO subtype | Drawer shows |
|---|---|---|---|---|---|
| 2026-08-03 | $280.45 | MICROSOFT#G174400309 | CREDIT CARD | `ISSUER_CREDIT` | Income |
| 2026-06-01 | $18.38 | HUNGERSTATION LLC | CREDIT CARD | `ISSUER_CREDIT` | Income |
| 2025-07-17 | $151.73 | EasyTime | CREDIT CARD | `ISSUER_CREDIT` | Income |
| 2025-05-04 | $45.09 | Uber | CREDIT CARD | `ISSUER_CREDIT` | Income |

### ⚠️ Symptom 1 — NOT REPRODUCED as described

The row is `cms98o4rp005u2bihex0q0loq`, +$4,000, 2026-07-31, into
`High Yield Savings Account` (American Express, `ins_10`).

It is **correctly classified end to end**: `flowType = TRANSFER`,
`counterpartyAccountId → CHASE COLLEGE (checking)`, `transferEvidenceConfidence = 1`,
`transferVenueClass = DEPOSITORY`. `classifyLiquidity` returns
`NEUTRAL / INTERNAL_TRANSFER`.

Neither debt surface counts it:

- `DebtPaymentsWidget` — 120 rows, **all** `DEBT_PAYMENT`, **zero** `TRANSFER`.
- `DebtClient` (`/dashboard/credit`) — scoped by `getDebtTransactions` (debt
  accounts only) and `accounts.filter(a => a.type === "debt")`. A savings row
  cannot enter.

**Two things I did find that could produce the appearance you saw:**

1. The HYSA is an **American Express** account — the same institution as
   `Platinum Card®`. Any surface grouping or labelling by institution will place
   this savings transfer beside Amex debt.
2. `SpaceDashboard.tsx:659` calls the Debt Space preview *"the PAYMENTS story"*
   but filters only `a.type === "debt"` — it shows **every** row on a debt
   account, including **65 `TRANSFER` rows totalling $5,000.43**, under a
   payments heading.

I'd rather flag this than fabricate a reproduction. **Tell me which screen you
saw it on and I'll pin it exactly.**

### ✅ Symptom 3 — CONFIRMED, but not where expected

Zero `TRANSFER` rows enter the Debt Payments widget total. The real defect is a
**cross-surface parity break** — two surfaces answer "how much did I pay toward
debt?" with different numbers:

| Surface | Method | Total | Rows |
|---|---|---|---|
| `DebtPaymentsWidget` | `classifyLiquidity` → `CASH_OUT/DEBT_PAYMENT` (cash leg) | **$245,592.37** | 120 |
| `DebtClient` | `isDebtPayment(flowType)` on debt-account rows (liability leg) | **$239,592.37** | 118 |
| **divergence** | | **$6,000.00** | 2 |

The corpus holds **238 `DEBT_PAYMENT` legs = 120 cash-side + 118 liability-side** —
the two legs of the same payments. `lib/debt.ts` `totalDebtPaid` sums
`Math.abs` over whatever it is handed, so **any caller that passes both legs
reports $485,184.74** — an exact double count. Today's callers happen to be
scoped correctly; nothing in the function's contract enforces that.

---

## 2. Reader inventory — every consumer, by authority

Legend: ✅ consumes the authority · ⚠️ partial · ❌ bypasses

| # | Surface | Transfer | Debt Payment | Income | Refund / Issuer Credit | Economic Date | Event Identity |
|---|---|---|---|---|---|---|---|
| 1 | Transaction list (`SpaceTransactionsPanel`) | ❌ | ⚠️ | ❌ | ❌ | ✅ | n/a |
| 2 | Transaction drawer (`TransactionDetailDrawer`) | ❌ | ⚠️ | ❌ | ❌ | ✅ | ⚠️ |
| 3 | Cash Flow (`cash-flow-space-data`, `CashFlowWorkspace`) | ✅ | ✅ | ✅ | ⚠️ | ✅ | n/a |
| 4 | Debt Payments widget | ✅ | ✅ | n/a | n/a | ✅ | n/a |
| 5 | Debt workspace (`DebtClient`) | ❌ | ❌ | n/a | ❌ | ⚠️ | n/a |
| 6 | Debt Space preview (`SpaceDashboard`) | ❌ | ❌ | n/a | n/a | ✅ | n/a |
| 7 | Transfers (`QuickFlowPills`, slice drawer) | ❌ | ❌ | n/a | n/a | ✅ | n/a |
| 8 | Spending (`CashFlowCategoryLedger`) | ✅ | ✅ | ✅ | ⚠️ | ✅ | n/a |
| 9 | Income (Cash Flow income card) | ✅ | n/a | ✅ | ✅ | ✅ | n/a |
| 10 | AI payloads (`lib/ai/assemblers/transactions.ts`) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| 11 | AI debt intelligence (`lib/ai/intelligence/debt-payments.ts`) | ❌ | ❌ | n/a | n/a | ✅ | n/a |
| 12 | Exports (`lib/export/csv.ts`) | n/a | n/a | ❌ | ❌ | ✅ | ❌ |
| 13 | Insights (`cash-flow-insights.ts`) | ✅ | ✅ | ✅ | ⚠️ | ✅ | n/a |
| 14 | Slice drawer (`TransactionSliceDrawer`) | ❌ | ❌ | ❌ | ❌ | ✅ | n/a |

**Authority adoption, counted:**

```
flow-predicates      10 consumers      transfer-maturation   3
liquidity            13                economic-date         4
income-rollup         3                debt-payments         2
income-source         2  ← serializer + rollup only
liability-inflow      2  ← serializer + transfer-maturation only
transfer-resolution   1
event-identity        1  ← writers only; ZERO readers
```

---

## 3. Findings, ranked

### F1 — `incomeSubtype` is emitted and read by nothing *(the Microsoft bug)*

The canonical income taxonomy runs at the boundary and its verdict is discarded
by every presentation surface. Four rows currently display as earned income when
the authority has already classified them `ISSUER_CREDIT`.

**Surfaces:** transaction drawer, transaction list, slice drawer, exports.

### F2 — Three independent FlowType label maps

| Location | Map |
|---|---|
| `lib/transactions/flow-predicates.ts` | `FLOW_TYPE_LABEL` — canonical, 10 entries |
| `components/space/widgets/TransactionSliceDrawer.tsx:69` | `FLOW_GROUP_LABEL` — a second copy |
| `components/transactions/TransactionDetailDrawer.tsx:66` | `humanize()` — mechanical `_`→space |

Only two files consume the canonical map (both filter chips). The drawer — the
surface a user opens to ask "what *is* this?" — uses the weakest of the three.

### F3 — Two debt-payment totals, $6,000 apart

`lib/debt.ts` computes from `flowType` alone (liability leg); `DebtPaymentsWidget`
computes from `classifyLiquidity` (cash leg). Neither is wrong in isolation;
there is no single authority that says which leg is *the* debt payment. The
$485k double-count is one unscoped caller away.

### F4 — `classifyLiquidity` does not consult the income or issuer-credit authorities

It re-derives `OTHER_INCOME` for a row the income taxonomy already called
`ISSUER_CREDIT`. Two authorities, same question, different answers — the exact
shape this arc has been removing.

### F5 — The transaction list has no refund/credit vocabulary

`SpaceTransactionsPanel.tsx:528`: `const isCredit = tx.amount > 0 && !isTransfer`.
A refund, an issuer credit, a salary deposit and a rewards redemption all render
identically. 22 `REFUND` rows and 4 `ISSUER_CREDIT` rows are indistinguishable
from income in the list.

### F6 — `DebtClient` filters by the legacy `category` string

`DebtClient.tsx:486`: `if (catFilter && tx.category !== catFilter) return false`.
The file's own comment (line 501) notes that `totalDebtPaid` *"replaces the
`category === 'Payment'` string heuristic"* — the total was converted, the filter
beside it was not.

### F7 — `SpaceDashboard`'s "PAYMENTS story" shows non-payments

65 `TRANSFER` rows ($5,000.43) appear under a payments heading because the filter
is `a.type === "debt"` rather than a payment predicate.

### F8 — Event identity has zero readers

4,025 of 4,053 rows carry a `transactionEventId`. No surface reads it. Expected —
the reader cutover is L8 Phase B — recorded here for completeness.

### F9 — Exports carry no financial taxonomy

`lib/export/csv.ts` is correctly on the economic date (`date` economic,
`posting_date` provenance) but emits the legacy `category` string and no
`flowType`, income subtype, or transfer counterparty. A user's exported ledger
cannot distinguish a refund from income.

---

## 4. Scope note

`economicDate` is the one authority in good shape: 4,053/4,053 rows carry it,
every surface reads it through the DTO, and the export layer distinguishes it
from posting date. **2,817 of 4,053 rows (69.5%) have an economic date that
differs from their posting date** — so this was load-bearing, and the L8-B cutover
holds.

---

## 5. Proposed polish slice (not started)

Ordered by dependency, not by size:

1. **One label authority.** Delete `FLOW_GROUP_LABEL` and `humanize()`; every
   surface reads `FLOW_TYPE_LABEL`. (F2)
2. **Presentation reads the income taxonomy.** Drawer, list, slice drawer and
   export render `incomeSubtype` where it exists. Fixes the Microsoft row. (F1, F5)
3. **`classifyLiquidity` consults the income/issuer-credit authorities** instead
   of re-deriving `OTHER_INCOME`. (F4)
4. **One debt-payment authority** that names the counted leg, with both surfaces
   reading it; `totalDebtPaid` refuses double legs rather than trusting callers. (F3)
5. **Retire the legacy `category` filter** in `DebtClient`; rename the Debt Space
   preview to match what it shows, or filter it to what it claims. (F6, F7)
6. **Export the taxonomy** — flow type, income subtype, transfer counterparty. (F9)

Every step is presentation-layer. **No classification changes, no writes, no
schema.** The authorities are already correct; this slice makes the UI read them.
