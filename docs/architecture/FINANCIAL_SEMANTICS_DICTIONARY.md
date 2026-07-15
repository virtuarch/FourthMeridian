# Financial Semantics Dictionary

**Status:** architecture doctrine (not API docs). Last updated: P2-1A.

This document is the canonical map of the cash-flow / transaction financial
semantics: what each authority *means*, who is allowed to answer which question,
and — critically — what each surface must **not** be used for. A future engineer
should be able to understand the financial-semantic architecture from this file
alone.

## The one-paragraph model

Every cash-flow number in the product is derived through a single funnel:

```
raw transaction rows
  → FlowType                     (persisted economic KIND of a row)
  → classifyLiquidity            (derived spendable-cash EFFECT of a row)
    + foldEconomicRow            (the economic income/spend/refund fold decision)
  → DayFacts                     (the ONE aggregate fact record — aggregate/day/bucket)
  → pure projections / views     (perspectiveTotals, economicSpend, netOfMeasures,
                                  groupLiquidityByReason, economicTotals, …)
  → widgets / AI / export
```

**There is exactly one aggregate fold — DayFacts.** Everything downstream is a
projection over it (or, for row-level surfaces, a filter over the same
per-row classifiers). Two rules hold everywhere:

1. **Semantics live in exactly one place.** `FlowType` (persisted) and
   `classifyLiquidity` (derived) are the sole per-row authorities;
   `foldEconomicRow` + `clampEconomicSpend` are the sole economic-fold authority.
   Nothing re-decides what a row *is*.
2. **Facts vs presentation.** `DayFacts` holds only summed numeric facts. Labels,
   ordering, sorted lines, and row payloads live in projections/views, never in
   `DayFacts`.

---

## Entries

### FlowType
- **Purpose:** the persisted, stable economic KIND of a transaction (SPENDING, INCOME, REFUND, DEBT_PAYMENT, TRANSFER, INVESTMENT, FEE, INTEREST, ADJUSTMENT, UNKNOWN).
- **Authority:** the write-time classifier `lib/transactions/flow-classifier.ts` is the SOLE writer; membership predicates (`isCostFlow`, `isIncome`, `isRefund`, `isTransfer`, `isDebtPayment`, `isInvestmentFlow`, `COST_FLOWS`, …) live in `lib/transactions/flow-predicates.ts` and are the SOLE readers of "which kinds count as X".
- **Inputs:** provider category/PFC + sign + account context, at write time.
- **Outputs:** one `FlowType` enum value persisted on `Transaction.flowType`.
- **Consumers:** `foldEconomicRow`, `classifyLiquidity`, the transactions Tab, the AI assembler — always via `flow-predicates`, never via inline string comparisons.
- **Must NOT be used for:** deciding whether spendable *cash* moved (that is `classifyLiquidity`, a tier-dependent derivation). Do not re-inline `flowType === 'X'` set checks — extend `flow-predicates` instead.

### classifyLiquidity
- **Purpose:** the derived, tier-dependent LIQUIDITY effect of a single row — did spendable cash move, and why (`effect` ∈ CASH_IN/CASH_OUT/NEUTRAL/UNRESOLVED, `reason` ∈ 15 `LiquidityReason`s).
- **Authority:** `lib/transactions/liquidity.ts` — the single per-row liquidity classifier. Never persisted; derived from (flowType, own-account tier, counterparty tier, transferDisposition) so it self-heals when accounts are reclassified or a counterparty is linked later.
- **Inputs:** a `LiquidityTx` (row + optional counterparty/financial-account ids) and a `LiquidityContext` (tier resolver).
- **Outputs:** `{ effect, reason, confidence, economicKind }` for one row.
- **Consumers:** `foldDayFacts` (the DayFacts fold) is the primary consumer; `groupCashFlowContext` reads `effect` at row level for the "moved, not spent" grouping.
- **Must NOT be used for:** aggregation. Do not write a new loop that sums `classifyLiquidity` over rows — that is DayFacts' job. Do not treat a `reason` as having a single fixed `effect` in aggregate (the four straddle reasons — EARNED_INCOME/REFUND/REAL_COST/DEBT_PAYMENT — are CASH_IN/OUT for a liquid account but NEUTRAL for a non-liquid one).

### foldEconomicRow
- **Purpose:** the SINGLE economic-fold decision — into which economic bucket (income / gross spend / refund) one row's converted magnitude goes.
- **Authority:** `lib/transactions/cash-flow.ts` (with its sibling `clampEconomicSpend`). This is the sole definition of the economic answer; both `economicTotals` and the DayFacts fold call it.
- **Inputs:** an `EconomicAccumulator` (`{income, spendGross, refunds}`; `DayFacts` is a structural superset), a `flowType` string, and a non-negative converted magnitude.
- **Outputs:** mutates the accumulator in place; no return.
- **Consumers:** `economicTotals` and `foldDayFacts` — nowhere else.
- **Must NOT be used for:** liquidity/tier decisions; that split (creditCardSpending vs directSpending) lives in `foldDayFacts` because it needs a `LiquidityContext`. Do not re-inline the `isCostFlow/isRefund/isIncome` 3-way branch anywhere else (pinned by `cash-flow-fold-authority.test.ts`).

### DayFacts
- **Purpose:** the ONE canonical aggregate fact record for a day, a bucket, or a whole period — every summed liquidity + economic fact downstream projections need, computed in a single fold.
- **Authority:** `lib/transactions/cash-flow-projection.ts` (interface + `foldDayFacts`).
- **Inputs:** produced only by the DayFacts fold family (below).
- **Outputs (facts only):** liquidity — `cashIn`, `cashOut`, `unresolved`, `byReason` (effect-partitioned reason sums); economic — `income`, `spendGross`, `refunds`; cross-cutting subsets — `creditCardSpending`, `directSpending`, `cashWithdrawals`.
- **Consumers:** all cash-flow surfaces — Summary, History, Calendar, drawer, compare, insights, and the projections `perspectiveTotals` / `economicSpend` / `netOfMeasures` / `groupLiquidityByReason`.
- **Must NOT be used for / hold:** presentation. NO labels, NO sorted arrays, NO UI ordering, NO row payloads — only numeric facts. `byReason` is EFFECT-PARTITIONED (a reason is recorded only under its canonical CASH_IN/CASH_OUT effect; the three pure-neutral context reasons are recorded; straddle reasons' NEUTRAL legs are deliberately excluded so they can't pollute a measure). Do not flatten `byReason` across effects.

### aggregateDayFacts
- **Purpose:** fold a row set into ONE aggregate `DayFacts` (the Summary headline; the whole-period totals).
- **Authority:** `lib/transactions/cash-flow-projection.ts`.
- **Inputs:** `LiquidityTx[]`, a `LiquidityContext`, an optional `ConversionContext`.
- **Outputs:** a single `DayFacts`.
- **Consumers:** `CashFlowSummaryWidget`, `cash-flow-insights`, `cash-flow-compare`, `liquidity-what-changed`, and any caller that needs both axes over a slice.
- **Must NOT be used for:** per-day or per-bucket work (use `projectDailyFacts` / `bucketDayFacts`). It is the aggregate entry point only.

### bucketDayFacts
- **Purpose:** per-time-bucket `DayFacts` for a period (History), keyed by the period's granularity (day/week/month) with a display `label`.
- **Authority:** `lib/transactions/cash-flow-projection.ts`.
- **Inputs:** `LiquidityTx[]`, `LiquidityContext`, a `CashFlowPeriod` (drives granularity), optional `ConversionContext`.
- **Outputs:** `FactsBucket[]` (each a `DayFacts` + `key` + `label`), chronological.
- **Consumers:** `CashFlowHistoryWidget`.
- **Must NOT be used for:** the aggregate total (sum of buckets == `aggregateDayFacts`, pinned by tests, but call the aggregate directly). The `label` is presentation carried on the bucket wrapper, not on `DayFacts`.

### projectDailyFacts
- **Purpose:** per-calendar-day `DayFacts`, keyed `YYYY-MM-DD` (Calendar heat-map). Every day with activity on EITHER axis is present (card-only days included).
- **Authority:** `lib/transactions/cash-flow-projection.ts`.
- **Inputs:** `LiquidityTx[]`, `LiquidityContext`, optional `ConversionContext`.
- **Outputs:** `Map<string, DayFacts>`.
- **Consumers:** `CashFlowCalendar`.
- **Must NOT be used for:** dropping "liquidity-neutral" days — it deliberately keeps them (the economic perspective needs card-only days). Do not filter days out at this layer.

### economicTotals
- **Purpose:** the economic-axis PROJECTION (income / spend / refunds / net) over a row set, for callers that have rows but NO liquidity/account context.
- **Authority:** `lib/transactions/cash-flow.ts`. **NOT an aggregation authority** — a thin projection over `foldEconomicRow` + `clampEconomicSpend`, byte-identical to `perspectiveTotals(aggregateDayFacts(rows, liqCtx, ctx), "economic")`. (Renamed from `aggregateCashFlow` in P2-1A; the old name wrongly implied a second authority.)
- **Inputs:** `Transaction[]`, optional `ConversionContext`.
- **Outputs:** `CashFlowTotals` (`{income, spend, refunds, net}`).
- **Consumers:** `TransactionSliceDrawer` (arbitrary slice, no accounts) and the income-vs-spending adapter.
- **Must NOT be used for:** any surface that ALSO needs the liquidity axis or per-tier subsets — reach for `aggregateDayFacts` there. It is not a substitute for the DayFacts fold; it is the no-context economic shortcut over the same primitive.

### perspectiveTotals
- **Purpose:** collapse a `DayFacts` to the selected perspective's `{in, out, net}` — LIQUIDITY (Cash In / Cash Out / Net Cash) or ECONOMIC (Income / Spending / Economic net).
- **Authority:** `lib/transactions/cash-flow-projection.ts`. A pure VIEW over `DayFacts` (no fold).
- **Inputs:** a `DayFacts`, a `CashFlowPerspective`.
- **Outputs:** `PerspectiveTotals` (`{in, out, net}`).
- **Consumers:** the Summary/insights/compare headline nets.
- **Must NOT be used for:** conflating the two perspectives' nets. Economic net (sees card purchases) and liquidity net (sees the later debt payment) are DIFFERENT metrics by design — never force them equal.

### economicSpend
- **Purpose:** the clamped economic spend of a `DayFacts` — `max(0, spendGross − refunds)`.
- **Authority:** `lib/transactions/cash-flow-projection.ts`; delegates to the single clamp authority `clampEconomicSpend` (in `cash-flow.ts`).
- **Inputs:** a `DayFacts`.
- **Outputs:** a number (spend, floored at 0).
- **Consumers:** `perspectiveTotals` (economic), the Summary economic tile, parity tests.
- **Must NOT be used for:** re-implementing the clamp elsewhere (`Math.max(0, spendGross − refunds)` must appear only inside `clampEconomicSpend`).

### netOfMeasures
- **Purpose:** the net (`Σ in − Σ out`) of a *selected set* of Calendar measures over one `DayFacts` — the heat-map / filter net.
- **Authority:** `lib/transactions/cash-flow-projection.ts`. A pure VIEW over `DayFacts` + `CALENDAR_MEASURES`.
- **Inputs:** a `DayFacts`, a list of `CalendarMeasureId`s.
- **Outputs:** `PerspectiveTotals`.
- **Consumers:** the Calendar/History measure selector.
- **Must NOT be used for:** summing a measure together with its `subsetOf` parent (that double-counts — the UI enforces the exclusion). It reads facts only; it never re-classifies rows.

### groupLiquidityByReason
- **Purpose:** the effect-split, labeled, sorted reason breakdown of the liquidity axis ("Cash In $16,044 = Earned income $6,000 + Asset liquidation $10,044"), plus context figures (unresolved, credit-card purchases, internal transfers).
- **Authority:** `lib/transactions/liquidity-breakdown.ts`. A **pure PROJECTION over `DayFacts`** (P2-1A) — it holds no fold. Splits `DayFacts.byReason` into sides via the static `LIQUIDITY_REASON_SIDE` map (pinned to `classifyLiquidity` by `liquidity-breakdown.test.ts` + `dayfacts-completeness.test.ts`).
- **Inputs:** a `DayFacts`.
- **Outputs:** `LiquidityBreakdown` (`cashIn[]`/`cashOut[]` labeled lines, totals, `netCash`, `unresolved`, `creditCardPurchases`, `internalTransfers`).
- **Consumers:** `CashFlowSummaryWidget`, `cash-flow-insights`, `liquidity-what-changed`, `cash-flow-adapters` (Cash In by source).
- **Must NOT be used for:** re-summing rows. It must NEVER call `classifyLiquidity` or take `(rows, ctx)` again; feed it a `DayFacts`. It is presentation-facing — its labels/ordering are correct here (not in `DayFacts`).

### groupCashFlowContext  *(review-proposed name: `projectCashFlowContext`)*
- **Purpose:** the row-level "context" grouping — "Moved, not spent" (NEUTRAL/UNRESOLVED transfers by disposition) and "Needs classification" (unidentified inflows), each carrying its exact drill-down rows.
- **Authority:** `lib/transactions/cash-flow-context.ts`. A ROW-LEVEL projection (NOT a DayFacts view) — it needs the individual rows and partitions by `transferDisposition`, so it cannot be derived from an aggregate `DayFacts`. Sits in the same family as `rowsForMeasures`.
- **Inputs:** `LiquidityTx[]`, `LiquidityContext`, optional `ConversionContext`.
- **Outputs:** `CashFlowContext` (`movedNotSpent[]`, `needsClassification[]`, each with label + amount + count + `rows`).
- **Consumers:** `CashFlowSummaryWidget` (the context section).
- **Must NOT be used for:** computing Cash In/Out/Net — it deliberately excludes every row already counted there (zero overlap). It is a review/navigation projection, never a total.
- **Note:** the P2-1 architecture review proposed renaming it `projectCashFlowContext` to signal "row-level projection"; that rename is deferred (not done in P2-1A).

### RelationshipResolver
- **Purpose:** read-time resolution of transaction relationships — most importantly, matching the two legs of a transfer so `classifyLiquidity` can resolve a counterparty tier (turning an UNRESOLVED transfer into Internal transfer / Asset deployment / Asset liquidation).
- **Authority:** `lib/transactions/RelationshipResolver.ts` (`matchTransferCandidate`). Pure, deterministic, zero-import; relationships are NOT persisted (recomputed at read time).
- **Inputs:** a target row + a small set of candidate rows the caller supplies (structural row types).
- **Outputs:** structured relationship facts (ids/roles) — e.g. a resolved `counterpartyAccountId` with a status; never prose.
- **Consumers:** the data layer (feeds the resolved counterparty into the liquidity classifier); the transaction-detail experience.
- **Must NOT be used for:** fuzzy matching or persistence. This slice is deterministic/low-risk only (exact provider match, exact fingerprint, owned-account transfer). A KD-15-invisible match must be hidden (see `chooseCounterpartyId`), never leaked.

### TransferEvidence
- **Purpose:** the provider-neutral, multi-axis TRANSFER evidence contract — the canonical shape every provider adapter (Plaid, exchange, wallet, CSV, manual) normalizes its transfer signal INTO (rail / form / venue axes, orthogonal).
- **Authority:** `lib/transactions/transfer-evidence.ts` (canonical side); provider adapters (e.g. `plaid-transfer-evidence.ts`) produce it. Pure, no imports, no provider strings.
- **Inputs:** a provider-specific transfer signal (in the adapter).
- **Outputs:** a `TransferEvidence` value (a single axis illuminated; others left undefined — "unknown over incorrect").
- **Consumers:** stage 2 (`TransferDisposition` derivation) in the same module.
- **Must NOT be used for:** encoding ownership (a canonical RELATIONSHIP fact from `RelationshipResolver`, not evidence) or purpose (a payment app is HOW, not WHY). Never collapse the orthogonal axes into one "counterparty class".

### TransferDisposition
- **Purpose:** the canonical, single-value classification of a transfer's meaning, derived from `TransferEvidence` + relationship context: `INTERNAL_TRANSFER`, `EXTERNAL_BANK_TRANSFER`, `ASSET_VENUE_TRANSFER`, `CASH_MOVEMENT`, `PAYMENT_APP_MOVEMENT`, `UNKNOWN_MOVEMENT`.
- **Authority:** `lib/transactions/transfer-evidence.ts` (stage 2 derivation). Provider-neutral; "unknown over incorrect".
- **Inputs:** a `TransferEvidence` + `TransferRelationshipContext` (ownership).
- **Outputs:** one `TransferDisposition` value, persisted/threaded on the row and read by the liquidity axis.
- **Consumers:** `classifyLiquidity` (venue/payment-app/cash evidence resolves an otherwise-UNRESOLVED transfer) and `groupCashFlowContext` (the "moved, not spent" labels).
- **Must NOT be used for:** inferring purpose/spending (a rail is not a purpose). `PAYMENT_APP_MOVEMENT` is deliberately ambiguous — never treat it as P2P payment / spending / income.

---

## Invariants (pinned by tests)

- One economic-fold authority — `cash-flow-fold-authority.test.ts` (no re-inlined 3-way branch / clamp; every entry point folds via `foldEconomicRow`).
- DayFacts is the sole production fold — `cash-flow-fold-authority.test.ts` (no production surface calls `deriveCashFlowAxes`, retired in P2-1A).
- DayFacts completeness + `byReason` effect-partition + `LIQUIDITY_REASON_SIDE` — `dayfacts-completeness.test.ts` (Σ byReason[in]==cashIn, Σ byReason[out]==cashOut; straddle NEUTRAL legs excluded; unresolved sums back).
- Summary / History / Calendar / economic-only all derive the same economic semantics — `cash-flow-projection.test.ts` + `cash-flow-fold-authority.test.ts`.
- `groupLiquidityByReason` output matches the old row-fold on real fixtures — `liquidity-breakdown.test.ts`.

---

## Debt semantic family

**Doctrine gate (read first):** debt has TWO independent truths that must never be
conflated. **Flow truth** (what cash/spending moved this window) comes from
`FlowType` → `classifyLiquidity` → DayFacts — the same funnel as everything above.
**Balance truth** (what is owed at a point in time) comes from account balances /
`SpaceSnapshot.debt` and is NOT derivable by subtracting period flows (money is
fungible; charges predate the window; payments settle earlier statements;
interest/fees/credits/adjustments/charge-offs move the balance with no matching
flow). A period's `creditCardSpending − debtServiceCashOut` is **not** an unpaid
balance and must never be presented as one.

Each entry is tagged with a **status**:
- **AVAILABLE NOW** — a canonical DayFacts fact or a trivial derived total over one.
- **AVAILABLE WITH COVERAGE CAVEAT** — derivable today at **Space-aggregate** grain
  from `SpaceSnapshot.debt`, subject to snapshot coverage + `isEstimated`
  (flat-held backfill) + `fxMiss` exclusions.
- **FUTURE PER-ACCOUNT SUPPORT** — blocked on data the schema does not hold today
  (per-account daily balance history / statement data). Not a refactor.

Each entry is also one of: **CURRENT CANONICAL FACT** (produced by an authority),
**CURRENT DERIVED SEMANTIC** (a pure view over authorities), **PLANNED CANONICAL
PROJECTION** (the `DebtFacts` projection, not yet built), or **FUTURE DATA
REQUIREMENT** (needs new data).

### A. `creditCardSpending`  — CURRENT CANONICAL FACT · AVAILABLE NOW
- **Purpose:** period cost flows (SPENDING + FEE + INTEREST) charged to liability-tier accounts.
- **Authority:** `foldDayFacts` (DayFacts field), via `FlowType`/`isCostFlow` + `classifyLiquidity` tier.
- **Inputs:** window-filtered `LiquidityTx[]` + `LiquidityContext`; per-row FX at row date when a `ConversionContext` is supplied.
- **Outputs:** one number on `DayFacts` (⊂ `spendGross`, ∉ `cashOut`).
- **Consumers:** Cash Flow Summary context row, Cash Flow Key Insights (credit bullet), economic tile.
- **Must NOT be used for:** an unpaid credit-card balance; net purchases (it is **gross of refunds**); a card-only figure (**includes interest & fees**, and **any `debt` account** incl. loans/LOC); same-window debt still outstanding.

### B. `debtPayment` / debt-payment fact family  — CURRENT CANONICAL FACT · AVAILABLE NOW
- **Purpose:** cash leaving a liquid account toward a liability (a credit-card/loan payment).
- **Authority:** `classifyLiquidity` → `CASH_OUT / DEBT_PAYMENT` → `DayFacts.byReason.DEBT_PAYMENT` (source-side liquid legs; the received-on-liability leg is NEUTRAL, so a payment is counted once). Per-row membership: `CALENDAR_MEASURES.debtPayments.rowMatches`.
- **Inputs:** window-filtered rows + tier context (a `flowType === DEBT_PAYMENT` liquid row, OR a `TRANSFER` from liquid to a liability counterparty).
- **Outputs:** `byReason.DEBT_PAYMENT` total + the `debtPayments` Calendar measure + the "Debt payments" liquidity-breakdown line.
- **Consumers:** Cash Flow Summary/Calendar/History, `DebtPaymentsWidget`, Key Insights.
- **Must NOT be used for:** new spending (it is ignored by `foldEconomicRow`); proof that this window's purchases were paid (payments settle **earlier** statements); proof of balance reduction net of interest. **May undercount** payments from accounts not connected to Fourth Meridian (no visible liquid leg).
- **Same-family VIEW (not a second authority):** `lib/debt.ts` `totalDebtPaid` / `rollupDebtPaymentsByAccount` are the **received-by-liability** (destination-side) view of the same DebtPayment family — a per-liability attribution, useful for a connected card's own balance math. The AI assembler's `debtPaymentTotal` (flowType, negative-only) is the settled-window view. All three are views of ONE fact family; they can disagree at the population edges (unconnected payer; TRANSFER-typed payments) and should be reconciled by a future oracle (B-S2), **not** treated as competing truths.

### C. `debtServiceCashOut`  — CURRENT DERIVED SEMANTIC · AVAILABLE NOW
- **Purpose:** "How much cash went toward debt during this period?" — the period total of canonical DEBT_PAYMENT cash-out.
- **Authority:** a trivial view over B: `= DayFacts.byReason.DEBT_PAYMENT ?? 0`. No new fold.
- **Inputs / Outputs:** a DayFacts → one number.
- **Consumers:** Cash Flow timing insight; a future `DebtFacts.cashPaid`.
- **Must NOT be used for:** principal reduction; total debt reduction; unpaid balance. It is a **cash-flow** answer, not a balance answer.

### D. `debtOpeningBalance`  — CURRENT DERIVED SEMANTIC · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** aggregate liability balance at the start of a window.
- **Authority:** **balance truth** — `SpaceSnapshot.debt` at `t₀−1` (daily, per-Space, abs sum of all debt balances).
- **Inputs:** a snapshot series + the window start; the reporting currency stamped on the snapshot.
- **Outputs:** a number or `null` (no coverage before the connection date).
- **Consumers:** Debt Perspective opening/closing panel; a future `DebtFacts`.
- **Must NOT be used for:** a transaction-derived number; per-account opening balance (**no per-account history** → FUTURE PER-ACCOUNT SUPPORT). Backfilled rows hold debt **flat** (`isEstimated`) and `fxMiss` rows are unusable — carry the estimated/coverage disclosure.

### E. `debtClosingBalance`  — CURRENT DERIVED SEMANTIC · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** aggregate liability balance at the end of a window.
- **Authority:** `SpaceSnapshot.debt` at `t₁` (or `FinancialAccount.balance` when `t₁` = today).
- **Inputs / Outputs / Consumers / Caveats:** as D.
- **Must NOT be used for:** as D.

### F. `debtNetChange`  — CURRENT DERIVED SEMANTIC · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** `closing − opening`. Negative ⇒ aggregate debt fell; positive ⇒ it rose.
- **Authority:** **balance truth** (D − E), NOT transaction subtraction.
- **Inputs / Outputs:** two balances → a number or `null`.
- **Consumers:** Debt Perspective; `DebtFacts`.
- **Must NOT be used for:** `charges − payments` (that is a different, non-reconciling quantity — see `debtReconciliationResidual`).

### G. `debtReduction`  — CURRENT DERIVED SEMANTIC · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** observed liability reduction over the window: `max(0, opening − closing)`.
- **Authority:** balance truth.
- **Outputs:** a non-negative number or `null`.
- **Must NOT be used for:** "how much of payments went to old debt" (that needs an allocation convention — see the allocation note below); it is not `debtServiceCashOut` (payments can exceed reduction when interest/new borrowing occur).

### H. `debtCarryover`  — CURRENT DERIVED SEMANTIC · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** the closing balance of one period, used as the opening liability state of the next.
- **Authority:** balance truth — **it is not a new computed quantity; it is the closing balance re-labeled** for the next window.
- **Must NOT be used for:** a charge/payment-arithmetic figure; anything implying it is "unpaid current-period charges".

### I. `debtReconciliationResidual`  — PLANNED CANONICAL PROJECTION · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** a completeness/trust signal: `actual closing − expected closing`, where `expected = opening + liability charges + interest + fees − debt payments − credits`.
- **Authority:** balance truth (opening/closing) reconciled against DayFacts flow facts. A `DebtFacts` projection (not yet implemented).
- **Outputs:** a signed number surfaced as a disclosure — **never silently forced to zero**.
- **Consumers:** Debt Perspective / AI completeness copy.
- **Must NOT be used for:** a hidden correction. Likely non-zero causes to document alongside it: incomplete history, unconnected payment sources, adjustments, charge-offs, estimated (flat-held) snapshots, FX gaps.

### J. `averageCarriedDebt`  — CURRENT DERIVED SEMANTIC · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** average observed aggregate debt balance across a window.
- **Authority:** balance truth (mean of `SpaceSnapshot.debt` over the window).
- **Outputs:** a number, computed **only** over reliable (non-`isEstimated`, non-`fxMiss`) snapshot days.
- **Must NOT be used for:** any window with estimated/missing coverage without disclosure; per-account averages (FUTURE PER-ACCOUNT SUPPORT).

### K. `debtFreeStreak`  — CURRENT DERIVED SEMANTIC · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** a continuous run of observed snapshot days where aggregate debt == 0.
- **Authority:** balance truth (runs over daily `SpaceSnapshot.debt`).
- **Must NOT be used for:** streaks across estimated/uncovered gaps (they break the observation); a per-account claim.

### L. `debtPaydownVelocity`  — CURRENT DERIVED SEMANTIC · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** change in observed aggregate debt balance over a normalized period (Δ balance / time).
- **Authority:** balance truth.
- **Must NOT be used for:** equating it with `debtServiceCashOut` — **it is balance movement, not cash service.** Interest / new borrowing can make payments high while paydown velocity is low (or negative).

### Allocation note (Part 4) — payments vs opening debt is NOT observed
Splitting debt payments into "toward prior-period debt" vs "funding current-period
purchases" is **not an observed fact** — money is fungible and no statement
allocation exists. Do **not** add either as a canonical fact. Any such split
requires an explicit **convention** (e.g. "payments apply to the opening balance
first": `towardPrior = min(payments, opening)`). If ever exposed, it MUST carry an
`assumptions[]` disclosure and be presented as an assumption, never as observed
truth. (By contrast, interest paid / fee payments / net principal ≈ payments −
(interest + fees) ARE derivable from flowType splits, exact when issuer INTEREST/FEE
rows exist and otherwise estimated with the existing `estimated` taint.)

### Planned projection contract — `DebtWindowFacts` / `DebtFacts` (NOT yet implemented)
The window debt record is documented here as a **contract**; it is **deferred** —
no module, type, or DB read is added in this slice (see the P2-1B report for why).
When built, it is a **projection, not a fourth fold**: every transaction figure
reads DayFacts, every balance figure reads the `SpaceSnapshot.debt` series, and the
`residual` is disclosed, never zeroed.

```
DebtWindowFacts(window) {   // PLANNED — conceptual, not implemented
  opening   : number | null   // SpaceSnapshot.debt at t₀−1        (balance truth)
  closing   : number | null   // SpaceSnapshot.debt at t₁          (balance truth)
  charged   : number          // DayFacts liability-tier SPENDING  (flow truth)
  interest  : number          // DayFacts liability-tier INTEREST  (exact | estimated)
  fees      : number          // DayFacts liability-tier FEE
  credits   : number          // DayFacts liability-tier REFUND
  cashPaid  : number          // DayFacts byReason.DEBT_PAYMENT (source-side)
  netChange : number | null   // closing − opening
  reduction : number | null   // max(0, opening − closing)
  carryover : number | null   // = closing
  residual  : number | null   // closing − (opening + charged + interest + fees − cashPaid − credits)
  completeness                // cashFlowStamp ⊕ snapshot coverage/isEstimated
  assumptions[]               // e.g. payments-apply-to-opening, only if a split is exposed
}
```

- **Sequencing:** lands **after** the debt-payment reconciliation oracle (B-S2); per-account carryover is gated on adding **per-account daily balance snapshots** (FUTURE DATA REQUIREMENT).
- **Consumers when built:** Cash Flow (uses only `cashPaid` + timing language — already has it today), Debt Perspective (opening/closing/reduction), AI Daily Brief, Planning (carryover as the payoff-sim initial condition).
- **Must NOT (when built):** introduce a new classifier, a second aggregate fold, or per-account semantics before the per-account balance data exists.
