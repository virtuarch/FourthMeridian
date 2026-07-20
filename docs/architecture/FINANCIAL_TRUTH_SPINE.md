# Financial Truth Spine

*Governs which single module decides each financial truth, what that authority means, and what each surface must never be used for. These are binding rules, not a status report. See also [money & FX](../systems/money-and-fx.md), [historical data](../systems/historical-data.md), [transactions](../systems/transactions.md), [cash flow](../systems/cash-flow.md), [debt](../systems/debt.md), [investments](../systems/investments.md).*

> **New here? Read this before touching any financial number.** This is the most
> important engineering document in the repository. Fourth Meridian's central law is
> **one authoritative model · one semantic layer · one aggregation path · many
> consumers.** Every financial figure flows through a single funnel
> (Providers → canonical identity/evidence → canonical semantics → canonical
> facts/projections → consumers). An **authority** *decides* a truth; everything else
> is a **consumer** that *projects* it. The one question to answer before writing any
> calculation is: **"which authority already owns this, and am I re-deciding it?"** If
> you find yourself re-classifying a row, re-folding a total, or re-converting a
> currency, stop — you are creating a parallel authority, which is a defect, not a
> feature. The table of authorities below tells you where each truth lives.

This document is the canonical map of Fourth Meridian's financial semantics: for
every financial question the product answers, *which one module is allowed to
answer it*, what that authority means, and — critically — what each surface must
**not** be used for. A future engineer should be able to understand the
financial-semantic architecture from this file alone.

> **Reading rule.** An "authority" is the single module that *decides* a financial
> truth. Everything else is a **consumer** that *projects* that truth. A consumer
> that re-decides a truth (re-classifies a row, re-folds a total, re-converts a
> currency, re-ranks in native balances) is a bug, not a feature — it is the exact
> parallel-authority drift the semantics layer eliminated. When in doubt: **read
> the authority, do not re-implement it.**

---

## The one-paragraph model — the canonical funnel

Every financial number in the product is derived through a single funnel, and no
consumer is allowed to short-circuit it:

```
Providers (Plaid / exchange / wallet / CSV / manual)
  → Canonical identity / evidence     (TransferEvidence, RelationshipResolver, PositionObservation)
  → Canonical semantics               (FlowType + flow-predicates, classifyLiquidity, TransferDisposition, convertMoney)
  → Canonical facts / projections     (DayFacts fold; getCurrentPositions; reportingBalance)
  → Consumers                         (widgets, AI, export, Daily Brief)
```

Two rules hold everywhere:

1. **Semantics live in exactly one place.** `FlowType` (persisted) and
   `classifyLiquidity` (derived) are the sole per-row authorities;
   `foldEconomicRow` + `clampEconomicSpend` are the sole economic-fold authority;
   `getCurrentPositions` is the sole current-position read; `convertMoney` is the
   sole native→reporting conversion. **Nothing re-decides what a row *is*.**
2. **Facts vs presentation.** `DayFacts` and the canonical projections hold only
   summed numeric facts. Labels, ordering, sorted lines, and row payloads live in
   projections/views, never in the fact records.

There is exactly **one aggregate transaction fold — DayFacts.** Everything
downstream is a projection over it (or, for row-level surfaces, a filter over the
same per-row classifiers).

---

## Table of authorities

| # | Domain | Authority module | Decides |
|---|--------|------------------|---------|
| 1 | Transaction population | `flow-predicates.ts` `isBankingPopulation` + `lib/data/transactions.ts` `BANKING_POPULATION` | which rows are eligible for banking analysis |
| 2 | FlowType membership | `flow-classifier.ts` (writer) + `flow-predicates.ts` (readers) | the economic KIND of a row and which kinds count as X |
| 3 | Economic fold | `cash-flow.ts` `foldEconomicRow` / `clampEconomicSpend` | income / gross-spend / refund / clamped-spend |
| 4 | Aggregate facts | `cash-flow-projection.ts` `DayFacts` + fold family | the one summed liquidity + economic fact record |
| 5 | Liquidity effect | `liquidity.ts` `classifyLiquidity` | did spendable cash move, and why |
| 6 | Account tier | `account-classifier.ts` `accountTier` | liquid / asset / liability / unknown |
| 7 | Transfer evidence | `transfer-evidence.ts` `TransferEvidence` | provider-neutral transfer signal (rail/form/venue) |
| 8 | Transfer meaning | `transfer-evidence.ts` `TransferDisposition` | the single-value meaning of a transfer |
| 9 | Ownership resolution | `RelationshipResolver.ts` `matchTransferCandidate` | which two legs are the same owned transfer |
| 10 | Current positions | `current-positions.ts` `getCurrentPositions` | today's valued investment positions |
| 11 | Historical positions | `investments-time-machine.ts` (A10) | as-of / compare / period investment reads |
| 12 | Reporting currency | `money/convert.ts` `convertMoney` (+ `reportingBalance`) | the cross-currency comparison basis |
| 13 | Debt family | `cash-flow-projection.ts` + `debt.ts` + `SpaceSnapshot.debt` | flow-truth vs balance-truth debt facts |
| 14 | Visibility | `lib/ai/visibility.ts` `TRANSACTION_DETAIL_VISIBILITY` | which links may expose transaction/position detail |

---

# 1 — Transaction population

### isBankingPopulation
- **Purpose:** decide which transaction rows are eligible for canonical banking financial analysis. **FlowType, NOT provider category, is the gate.**
- **Authority:** `lib/transactions/flow-predicates.ts` `isBankingPopulation(flowType) = !isInvestmentFlow(flowType)` — every flow EXCEPT pure investment security-activity (`INVESTMENT`) is in the banking population. Its DB twin is the Prisma fragment `BANKING_POPULATION = { flowType: { not: FlowType.INVESTMENT } }` in `lib/data/transactions.ts` (applied by `getTransactions` / `getDebtTransactions`) and mirrored in the AI assembler (`lib/ai/assemblers/transactions.ts`). Prisma scalar `not` returns null rows, so the query and the predicate agree on the null/UNKNOWN case (pinned by `transactions.population.test.ts`).
- **Inputs:** the persisted `flowType` value (string) per row.
- **Outputs:** boolean membership. Structural exclusions (`deletedAt`, Space visibility, date window) are ANDed on top and are unaffected.
- **Consumers:** the banking data layer, the AI transactions assembler, every cash-flow surface (all read a population already filtered to this rule).
- **Must NOT be used for:** a category-based allow-list. There is **no** `flowType: { in: [...] }` inclusion gate anywhere in production — admitting a taxonomy allow-list is exactly the drift this predicate replaced. Do **not** drop `null` / `UNKNOWN` / `ADJUSTMENT` rows here — see the population doctrine below.

### UNKNOWN / ADJUSTMENT / null population doctrine
- **Rule:** an unclassified (`null`), `UNKNOWN`, or `ADJUSTMENT` row **stays in the banking population** — visible for review / needs-classification, never silently dropped by a taxonomy filter. It carries **no economic bucket**, so it must never fold into income / spend / refund / transfer / debt totals or a category money sum (doctrine: an `ADJUSTMENT` is not spending; an `UNKNOWN` is not income).
- **Authority for the "carries no bucket" half:** `isNonEconomicResidue` (below).

### isNonEconomicResidue
- **Purpose:** name the non-economic residue INSIDE the banking population — the rows that are present for review but must never fold into any money total.
- **Authority:** `lib/transactions/flow-predicates.ts` `isNonEconomicResidue(flowType) = flowType == null || 'UNKNOWN' || 'ADJUSTMENT'`. It is the exact complement, within the banking population, of the five economic-bucket predicates (`isCostFlow ∪ isRefund ∪ isIncome ∪ isTransfer ∪ isDebtPayment`) — a named partition over the single authorities, NOT a new membership list.
- **Inputs / Outputs:** the `flowType` value → boolean.
- **Consumers:** the AI transactions assembler's money-fold loop (admits residue rows for count/review via `unclassifiedCount`, excludes them from every economic total).
- **Must NOT be used for:** dropping a row from visibility. Residue is *excluded from money*, not *excluded from the population*.

---

# 2 — FlowType & membership predicates

### FlowType — the persisted economic kind
- **Purpose:** the persisted, stable economic KIND of a transaction (`SPENDING`, `INCOME`, `REFUND`, `DEBT_PAYMENT`, `TRANSFER`, `INVESTMENT`, `FEE`, `INTEREST`, `ADJUSTMENT`, `UNKNOWN`).
- **Authority:** the write-time classifier `lib/transactions/flow-classifier.ts` is the SOLE writer; the membership predicates in `lib/transactions/flow-predicates.ts` are the SOLE readers of "which kinds count as X".
- **Inputs:** provider category / PFC + sign + account context, at write time.
- **Outputs:** one `FlowType` enum value persisted on `Transaction.flowType`.
- **Consumers:** `foldEconomicRow`, `classifyLiquidity`, the Transactions Tab, the AI assembler — **always via `flow-predicates`, never via inline string comparisons.**
- **Must NOT be used for:** deciding whether spendable *cash* moved (that is `classifyLiquidity`, a tier-dependent derivation). Do not re-inline `flowType === 'X'` set checks — extend `flow-predicates` instead.

### The write / read split — one classifier, one predicate home
FlowType semantics are split by responsibility, and the split is doctrine:

- **Write path (classify once).** `classifyFlow(...)` in `flow-classifier.ts` is the SOLE function that *decides* a row's `flowType`. It is a pure, deterministic function run at sync / import / manual-write time; its output is persisted on the row. Aggregate at read; **never re-classify at read.** No CSV parser, no Plaid mapper, no assembler decides flow inline — semantic decisions are pulled *up* into the classifier, never left in a provider adapter.
- **Read path (membership only).** `flow-predicates.ts` is the SOLE home for "which flowTypes count as X" — pure, zero-import, operating on the `flowType` value as a plain string. Readers ask a predicate; they never author a `new Set([...]).has(flowType)` at a call site.

### Classifier precedence & the honesty valve
- **Precedence (highest wins):** **provider taxonomy** (Plaid `pfcDetailed` → `pfcPrimary`) → **account-type context** → **`category`** → **sign.** CSV / manual rows skip the provider step and classify from category + sign + account type.
- **`UNKNOWN` and `ADJUSTMENT` are honesty valves.** The classifier is **never forced to emit a confident wrong value.** Confidence below threshold → `UNKNOWN` (explicitly unclassified, surfaced for review, never silently absorbed into `SPENDING`). `ADJUSTMENT` names reconciled non-economic / provider-artifact rows. Both are excluded from every economic total.
- **Direction is not the `amount` sign.** The per-account sign says in/out relative to *one account*; it does not say in/out relative to the user's *whole world*. Internal movements (owned-to-owned transfers, card payments) are structurally internal regardless of sign, so a net-external-cash-flow query excludes them by predicate rather than by hoping positive and negative legs cancel.

### Versioning & backfill — FLOW_CLASSIFIER_VERSION
- **Rule:** `FLOW_CLASSIFIER_VERSION` (`flow-classifier.ts`) stamps every classified row (`Transaction.classifierVersion`). Bump it whenever the classification *rules* change. A later, improved classifier re-runs over **only** stale rows — `WHERE classifierVersion < FLOW_CLASSIFIER_VERSION` — without disturbing higher-confidence ones.
- **Backfill discipline:** backfill is a separate, **idempotent, re-runnable** script (never folded into a migration). Running it twice yields byte-identical rows. Coarse `flowType` backfills deterministically from `(category, sign, account type)`; fine sub-types that require `pfcDetailed` are **forward-only** (historical rows never stored it). What is genuinely unresolvable stays `UNKNOWN` / null — **never fabricated into a confident value.**

### Liability payment classification — the CCPAY rules
*Durable rules earned across CCPAY-2A…2F. Authorities: `lib/transactions/liability-payment.ts` (category rescue + the liability definition), `lib/transactions/flow-classifier.ts` (flow), `flow-category-coverage.test.ts` (the coverage tripwire), `scripts/audit-flow-desync.ts` (certification).*

1. **Descriptors rescue CATEGORY; they never classify FLOW.** A merchant/descriptor string may promote an unresolved category (`isCardPaymentDescriptor` / `resolveLiabilityPaymentCategory`), but `classifyFlow` is **descriptor-blind by contract** — it accepts no `merchant`/`description` field, enforced by a compile-time `@ts-expect-error` in `flow-classifier.test.ts`. The layering is fixed: **descriptor → category → flowType.** A rule that wants a merchant string belongs in the category layer, never in the classifier. *Why: the two flow-input builders populated descriptor fields inconsistently, so a rule in the classifier silently no-ops on the live path; and a descriptor means "this category is Payment", so flow must follow from category or the two columns desync.*

2. **Liability-payment rescue is PROMOTION-ONLY from the unresolved category.** `resolveLiabilityPaymentCategory` rewrites **only** `category === 'Other'` → the payment category, guarded by liability tier + positive sign + descriptor. It can never overwrite a confident provider category, a merchant-intelligence category, or a `USER_*` correction, and it never demotes. The symmetric demote (a liability *outflow* wrongly carrying `Payment`) is the classifier's structural job — `debtPaymentUnlessLiabilityOutflow` — never duplicated in the rescue.

3. **The structural negative-liability veto.** Money *out* of a liability account raises what is owed — a charge, never a debt payment — **regardless of what PFC or a descriptor claims** (`debtPaymentUnlessLiabilityOutflow`, the sole `DEBT_PAYMENT` constructor in the classifier). This generalizes CF-4's argument (a liability holds no owned cash to transfer out) from `TRANSFER_OUT` to the `LOAN_PAYMENTS` and `Payment`-category paths. Account context outranks the provider tag.

4. **Semantic authorities resolve BEFORE the ingestion branch fans out.** The card-payment rescue runs once per row, above the CREATE / UPDATE / merchant-intelligence / persistence fork, and **preview consumes the identical authority** as the write paths (`app/api/accounts/[id]/import/preview/route.ts` mirrors `route.ts`). A preview that showed a different category than the import would write is a divergence bug, not a display detail. Every ingesting path — Plaid sync, CSV/Excel import, backfill — calls the same `resolveLiabilityPaymentCategory` and the same `classifyFlow`; none re-implements either.

5. **An authoritative enum mirror requires a build-time coverage tripwire.** `flow-classifier.ts`'s `SPEND_CATEGORIES` (and its siblings) mirror the schema's `TransactionCategory`. A category the schema can store but the classifier does not know classifies `UNKNOWN` — which removes the row from the spend ledger, `expenseTotal`, and AI context entirely: a **silent disappearance**, not a degradation. `flow-category-coverage.test.ts` pins every mirror against the **real Prisma enum**, so the next schema category fails the build rather than deleting money. Never trust memory to keep a hand-maintained semantic set in step with its authority. *(Precedent: `lib/data/transactions.ts:96` already retired one hand-listed category allow-list for the same silent-omission bug.)*

6. **Classifier version is OWNERSHIP metadata, not merely staleness metadata.** `classifierVersion` records **which authority produced a row's flow facts.** A convergence backfill must target the population a *prior version of this classifier* wrote — an exact `classifierVersion = N` (`backfill-flowtype.ts --only-version=N`) — never the broadest technically-matching predicate. In particular **`classifierVersion IS NULL` does not imply "safe to recompute with the current classifier"**: at the v3 migration it covered both `btc-sync`'s hand-authored flow facts (a separate authority that derives category *from* flowType) and a never-classified seed backlog. Sweeping either into a version migration destroys facts this classifier never owned. **Backfills are scoped by semantic ownership, not by the widest matching WHERE clause.** The certification audit (`audit-flow-desync.ts`) segregates the three populations — classifier-owned, never-classified backlog, foreign-authority — and only fails on the first.

7. **A version bump and its persisted-fact convergence are ONE logical migration.** Do not commit a state where the classifier declares vN but persisted rows still hold vN-1 facts — that is exactly the drift `audit-flow-desync.ts` exists to catch. The bump, the scoped backfill, and the audit land together. The audit certifies by **recomputing through the canonical authorities** (`buildFlowInputFromRow → classifyFlow`), never by re-encoding a `category ⇒ flowType` shortcut — CF-4 and CCPAY-2B both prove those shortcuts are context-dependent and wrong.

8. **Introduce a provider-neutral abstraction from the SECOND instance, not the first.** A canonical evidence abstraction (e.g. a proposed `CardPaymentEvidence` struct each provider adapter emits) *generalizes a pattern* — and you cannot see the pattern from one provider. Designing the "neutral" shape against a single emitter bakes that provider's quirks into a type, where they are far more expensive to remove than a string. Evidence: CCPAY-1 found **8 of 12** card-payment descriptor tokens were speculative guesses about issuers never connected — a `CardPaymentEvidence` schema authored at that moment would have frozen the same guesswork. Until a second real emitter exists, keep the **provider adapter thin** (it knows only which fields hold the descriptor and the provider's own taxonomy) and the **canonical classifier consuming already-normalized facts** (category + tier + sign + PFC family + normalized descriptor) — which is provider-neutral *without* the abstraction. `resolveLiabilityPaymentCategory`'s argument list already *is* the canonical card-payment evidence; naming it a struct adds no capability with one provider. The template to copy **when** provider #2 arrives is the existing `TransferEvidence` sibling-adapter pattern (`plaid-transfer-evidence.ts`: *"Adding another provider … means writing a SIBLING adapter that emits [the neutral evidence]"*), not a preemptive generalization. Full analysis + trigger conditions: [CCPAY-2G Provider Evolution Review](../decisions/ADR-006-provider-abstraction-timing.md). Corollary: a descriptor allowlist is the **fallback for evidence-poor providers** (CSV/manual, no PFC/subtype), never the primary authority — structural signals (tier, sign, PFC family) are primary; the descriptor rescues only the residue they miss.

### flow-predicates — the membership authority
- **Purpose:** the single home for "which flowTypes count as X". One flow kind is admitted once, not four times.
- **Authority:** `lib/transactions/flow-predicates.ts`. PURE, zero-import. Pinned by `flow-predicates.test.ts` (label completeness against the `FlowType` enum) and the doctrine oracle.
- **The predicates:**
  - `isCostFlow` / `COST_FLOWS = {SPENDING, FEE, INTEREST}` — the "Spend" money-out set (gross, `INTEREST` included). **`REFUND` is NOT here** — it is netted separately.
  - `isSerializedSpendingFlow` / `SERIALIZED_SPENDING_FLOWS = {SPENDING, FEE}` — the AI chat serializer's per-category spending-LINE set. Deliberately NARROWER than `COST_FLOWS` (interest lives in the expense total but not in the per-category lines — the KD-17 invariant is `≤`, not `=`). **Not interchangeable with `COST_FLOWS`.**
  - `isSpendLedgerFlow = {SPENDING, REFUND}` / `isExcludedFromSpendLedger` — spend-ledger membership (a flow contributes to the spend ledger, as spend or as its reversal). Backs `flow-classifier.ts`'s `isSpendingFlow`/`isExcludedFromSpending` and, transitively, the opportunity-eligibility gate in `lib/ai/intelligence/annotations.ts`. **Distinct from `isCostFlow`** — do not conflate the two "spend" notions.
  - `isIncome` / `isRefund` / `isTransfer` / `isDebtPayment` / `isInvestmentFlow` / `isAdjustment` — single-value kind predicates.
  - `isNonEconomicResidue`, `isBankingPopulation` — the partitions documented in §1.
- **Consumers:** every economic/liquidity/AI consumer of "kind".
- **Must NOT be used for:** re-inlining a `new Set([...]).has(flowType)` check at a call site. Add or reuse a predicate here.

### sumByFlowType
- **Purpose:** the SINGLE per-FlowType aggregation both the Transactions summary bar and its "By Flow Type" Group By consume — a per-kind total can never be computed two different ways.
- **Authority:** `lib/transactions/flow-predicates.ts` `sumByFlowType(rows, amount)`. Pure and import-free — currency conversion / abs / sign all live in the caller's `amount` accessor. `null` flow buckets under `UNCLASSIFIED_FLOW_KEY`.
- **Outputs:** `Map<flowType, number>`.
- **Consumers:** `SpaceTransactionsPanel` summary chips + the "By Flow Type" grouped view (both read the same map).
- **Must NOT be used for:** economic aggregation with refund netting — it is a raw per-kind sum, not a fold. The clamped economic spend is `clampEconomicSpend`, not a composition of `sumByFlowType` buckets.

### FLOW_TYPE_LABEL
- **Purpose / Authority:** the single humanized `FlowType`→label map (`lib/transactions/flow-predicates.ts`), one entry per enum value (pinned so a new flow kind can't ship without a label). **Presentation only** — no predicate reads it.

---

# 3 — Economic semantics

### foldEconomicRow · clampEconomicSpend
- **Purpose:** the SINGLE economic-fold decision — into which economic bucket (income / gross spend / refund) one row's converted magnitude goes; and the SINGLE spend clamp (`max(0, spendGross − refunds)`).
- **Authority:** `lib/transactions/cash-flow.ts`. Both `economicTotals` and the DayFacts fold call it; nothing else re-implements the 3-way branch or the clamp (pinned by `cash-flow-fold-authority.test.ts`).
- **Inputs:** an `EconomicAccumulator` (`{income, spendGross, refunds}`; `DayFacts` is a structural superset), a `flowType` string, a non-negative converted magnitude.
- **Outputs:** mutates the accumulator; `clampEconomicSpend` returns the floored spend.
- **Consumers:** `economicTotals`, `foldDayFacts` — nowhere else.
- **Refund doctrine:** a `REFUND` is a **reversal of prior spending, never income**. It is disclosed and netted against gross spend inside `clampEconomicSpend` (floored at 0), never added to income.
- **Spend doctrine:** two distinct "spend" notions exist and must not be conflated — **cost flow** (`isCostFlow`, gross money-out for the Spend chip) and **spend-ledger** (`isSpendLedgerFlow`, SPENDING+REFUND, the netting ledger). Economic spend = `clampEconomicSpend(spendGross, refunds)`.
- **Must NOT be used for:** liquidity/tier decisions (the creditCard-vs-direct split lives in `foldDayFacts`, which has a `LiquidityContext`). The clamp shape `Math.max(0, spendGross − refunds)` must appear only here.

### DayFacts · aggregateDayFacts / bucketDayFacts / projectDailyFacts
- **Purpose:** the ONE canonical aggregate fact record (day / bucket / whole period) — every summed liquidity + economic fact downstream projections need, computed in a single fold.
- **Authority:** `lib/transactions/cash-flow-projection.ts` (interface + `foldDayFacts`, and the fold family).
- **Inputs:** `LiquidityTx[]`, a `LiquidityContext`, an optional `ConversionContext`.
- **Outputs (facts only):** liquidity — `cashIn`, `cashOut`, `unresolved`, `byReason` (effect-partitioned reason sums); economic — `income`, `spendGross`, `refunds`; cross-cutting subsets — `creditCardSpending`, `directSpending`, `cashWithdrawals`.
  - `aggregateDayFacts` → one `DayFacts` (Summary headline, whole-period totals).
  - `bucketDayFacts` → `FactsBucket[]` per time bucket (History), each a `DayFacts` + `key` + display `label`.
  - `projectDailyFacts` → `Map<'YYYY-MM-DD', DayFacts>` (Calendar heat-map); keeps card-only days.
- **Consumers:** all cash-flow surfaces — Summary, History, Calendar, drawer, Compare, insights — and the projections `perspectiveTotals` / `economicSpend` / `netOfMeasures` / `groupLiquidityByReason`.
- **Must NOT hold:** presentation. NO labels, NO sorted arrays, NO UI ordering, NO row payloads — only numeric facts. `byReason` is EFFECT-PARTITIONED (a reason is recorded only under its canonical CASH_IN/CASH_OUT effect; straddle reasons' NEUTRAL legs are deliberately excluded). Do not flatten `byReason` across effects. It is the **sole production fold** — no surface calls the retired `deriveCashFlowAxes`.

### economicTotals · perspectiveTotals · economicSpend · netOfMeasures
- **Purpose:** pure PROJECTIONS over the facts above — **not** aggregation authorities.
- **Authority:** `cash-flow.ts` (`economicTotals`) and `cash-flow-projection.ts` (the rest).
  - `economicTotals(rows, ctx)` — the no-liquidity-context economic shortcut (`{income, spend, refunds, net}`); byte-identical to `perspectiveTotals(aggregateDayFacts(...), "economic")`. Thin projection over `foldEconomicRow` + `clampEconomicSpend`.
  - `perspectiveTotals(dayFacts, perspective)` — collapses a `DayFacts` to `{in, out, net}` for the LIQUIDITY or ECONOMIC perspective. **The two nets are DIFFERENT metrics by design** (economic sees card purchases; liquidity sees the later debt payment) — never force them equal.
  - `economicSpend(dayFacts)` — clamped economic spend; delegates to `clampEconomicSpend`.
  - `netOfMeasures(dayFacts, ids)` — the net of a selected set of Calendar measures; reads facts only, never re-classifies.
- **Must NOT be used for:** any surface that also needs the liquidity axis or per-tier subsets (reach for `aggregateDayFacts`). None of these re-fold rows.

---

# 4 — Liquidity semantics

### classifyLiquidity · LiquidityReason
- **Purpose:** the derived, tier-dependent LIQUIDITY effect of a single row — did spendable cash move, and why (`effect ∈ CASH_IN/CASH_OUT/NEUTRAL/UNRESOLVED`, `reason ∈ 15 LiquidityReason`s).
- **Authority:** `lib/transactions/liquidity.ts` — the single per-row liquidity classifier. Never persisted; derived from `(flowType, own-account tier, counterparty tier, transferDisposition)` so it self-heals when accounts are reclassified or a counterparty is linked later.
- **Inputs:** a `LiquidityTx` (row + optional counterparty / financial-account ids) and a `LiquidityContext` (a tier resolver over `accountTier`).
- **Outputs:** `{ effect, reason, confidence, economicKind }` for one row.
- **Consumers:** `foldDayFacts` (primary); `groupCashFlowContext` reads `effect` at row level for the "moved, not spent" grouping.
- **Must NOT be used for:** aggregation (that is DayFacts' job — do not write a new loop summing `classifyLiquidity`). Do not treat a `reason` as having a single fixed `effect` in aggregate — the four **straddle reasons** (EARNED_INCOME / REFUND / REAL_COST / DEBT_PAYMENT) are CASH_IN/OUT for a liquid account but NEUTRAL for a non-liquid one. **No consumer may independently decide a liquidity effect, a payment-app liquidity treatment, or a debt-payment liquidity behavior** — all live here.

### accountTier
- **Purpose:** the single account-type → tier map (`liquid | asset | liability | unknown`).
- **Authority:** `lib/account-classifier.ts` `accountTier`. `classifyLiquidity` consumes it via its `tierResolver`.
- **Must NOT be used for:** re-hardcoding the type→tier partition at a consumer.

### groupLiquidityByReason
- **Purpose:** the effect-split, labeled, sorted reason breakdown of the liquidity axis (e.g. "Cash In $16,044 = Earned income $6,000 + Asset liquidation $10,044"), plus context figures.
- **Authority:** `lib/transactions/liquidity-breakdown.ts`. A **pure PROJECTION over `DayFacts`** — no fold. Splits `DayFacts.byReason` via the static `LIQUIDITY_REASON_SIDE` map (pinned to `classifyLiquidity`).
- **Outputs:** a `DayFacts` → `LiquidityBreakdown` (`cashIn[]`/`cashOut[]` labeled lines, totals, `netCash`, `unresolved`, `creditCardPurchases`, `internalTransfers`).
- **Consumers:** `CashFlowSummaryWidget`, `cash-flow-insights`, `liquidity-what-changed`, `cash-flow-adapters`.
- **Must NOT be used for:** re-summing rows. It must NEVER call `classifyLiquidity` or take `(rows, ctx)` — feed it a `DayFacts`.

### groupCashFlowContext
- **Purpose:** the row-level "context" grouping — "Moved, not spent" (NEUTRAL/UNRESOLVED transfers by disposition) and "Needs classification" (unidentified inflows), each with drill-down rows.
- **Authority:** `lib/transactions/cash-flow-context.ts`. A ROW-LEVEL projection (needs individual rows; partitions by `transferDisposition`) — cannot be derived from an aggregate `DayFacts`.
- **Consumers:** `CashFlowSummaryWidget` (the context section).
- **Must NOT be used for:** computing Cash In/Out/Net — it deliberately excludes every row already counted there (zero overlap). Review/navigation projection, never a total.

---

# 5 — Transfer semantics

**Doctrine gate: rail ≠ purpose.** A transfer's *rail* (how the money moved — a
payment app, a wire, a card) is never its *purpose* (why). Evidence axes are
persisted at write time; the transfer's meaning and its owned-pairing are resolved
at **read** time, so they self-heal as accounts are linked or reclassified.

### TransferEvidence
- **Purpose:** the provider-neutral, multi-axis TRANSFER evidence contract — the canonical shape every provider adapter (Plaid, exchange, wallet, CSV, manual) normalizes its transfer signal INTO (rail / form / venue axes, **orthogonal**).
- **Authority:** `lib/transactions/transfer-evidence.ts` (canonical side); provider adapters (e.g. `plaid-transfer-evidence.ts`, which holds the only payment-app name list) produce it. Pure, no provider strings on the canonical side.
- **Outputs:** a `TransferEvidence` value (a single axis illuminated; others left undefined — "unknown over incorrect").
- **Must NOT be used for:** encoding **ownership** (a canonical RELATIONSHIP fact from `RelationshipResolver`, not evidence) or **purpose** (a payment app is HOW, not WHY). Never collapse the orthogonal axes into one "counterparty class".

### TransferDisposition · ownership > rail precedence · payment-app doctrine
- **Purpose:** the canonical, single-value meaning of a transfer, derived from `TransferEvidence` + relationship context: `INTERNAL_TRANSFER`, `EXTERNAL_BANK_TRANSFER`, `ASSET_VENUE_TRANSFER`, `CASH_MOVEMENT`, `PAYMENT_APP_MOVEMENT`, `UNKNOWN_MOVEMENT`.
- **Authority:** `lib/transactions/transfer-evidence.ts` `deriveTransferDisposition`. Provider-neutral; "unknown over incorrect".
- **Resolution order (ownership dominates rail):** (1) CASH form → CASH_MOVEMENT; (2) EXCHANGE/BROKERAGE venue → ASSET_VENUE_TRANSFER; **(3) `counterpartyIsOwned` → INTERNAL_TRANSFER**; (4) DEPOSITORY venue → EXTERNAL_BANK_TRANSFER; **(5) PAYMENT_APP rail → PAYMENT_APP_MOVEMENT**; (6) UNKNOWN. The only **rail** (`PAYMENT_APP`) sits at the lowest priority — strictly dominated by ownership. There is **no path where a rail signal beats an ownership relationship.** (Step-2 venue-over-ownership is a *venue*, not a rail — a self-owned brokerage transfer still crosses the liquid→asset boundary; deliberate and documented.)
- **Payment-app doctrine:** `PAYMENT_APP_MOVEMENT` is deliberately ambiguous — a rail, never a purpose. **Never** treat a payment app (Venmo/PayPal/CashApp/Zelle) as P2P payment / spending / income, and never infer transfer purpose from a merchant name, description, or rail. No consumer carries a payment-app purpose heuristic.
- **Cross-currency pairing is currently unresolvable.** A transfer whose two legs are recorded in different currencies cannot be paired as one owned movement today; it stays honestly unresolved rather than being force-matched.
- **Consumers:** `classifyLiquidity` (venue/payment-app/cash evidence resolves an otherwise-UNRESOLVED transfer) and `groupCashFlowContext` (the "moved, not spent" labels).

### RelationshipResolver
- **Purpose:** read-time resolution of transaction relationships — matching the two legs of a transfer so `classifyLiquidity` can resolve a counterparty tier (turning UNRESOLVED into Internal transfer / Asset deployment / Asset liquidation).
- **Authority:** `lib/transactions/RelationshipResolver.ts` `matchTransferCandidate`. Pure, deterministic, zero-import; relationships are NOT persisted (recomputed at read time).
- **Outputs:** a target row + caller-supplied candidate rows → structured relationship facts (ids/roles), never prose.
- **Must NOT be used for:** fuzzy matching or persistence. Deterministic/low-risk only (exact provider match, exact fingerprint, owned-account transfer). Ownership is a resolved RELATIONSHIP fact fed into disposition — **"ownership is not evidence."**

---

# 6 — Investment positions

**Doctrine gate (read first): investments have TWO truths, and they must never be
conflated** — the same split debt already draws between flow truth and balance
truth (§8). One is bottom-up and evidence-gated; the other is a total. A consumer
that reads the first as if it were the second is the exact bug the coverage
contract exists to prevent (it is what produced a hero "+364%" against a small
real move — a period change divided by a *partial* opening subtotal).

### Position valuation truth — A10 / `getCurrentPositions`
- **Question:** *"What can be reconstructed from known positions, observations, and
  price evidence at a date?"*
- **Owns:** holdings, allocation, concentration, position decomposition, per-holding
  historical analysis.
- **Properties:** **bottom-up**, evidence-based, **coverage-gated**. It values only
  what it has a position observation AND a price for; everything else is an explicit
  unvalued remainder or a disclosed `estimated` continuation. Its `valuedSubtotal`
  is **a subtotal, never a whole-portfolio total** — the same "a partial is never
  presented as the whole" rule the valuation core enforces (valuation-core.ts).
- **Coverage is part of the contract, not an afterthought.** Every A10 endpoint
  carries a `PortfolioValuationCoverage` (`valuedValue` / `observedValue` /
  `estimatedValue` / `unavailableCount` / `unavailableValue` (null when it cannot be
  estimated without fabricating a price) / `coverageByCount` / `fullyObserved`), and
  the reconciliation carries `openingCoverage`, `closingCoverage`, and the
  like-for-like verdict `coverageConsistent`. A change is a defensible return only
  when `coverageConsistent` is true.
- **Must NOT be used for:** the headline "what was the whole portfolio worth" total,
  or a period return, when coverage is partial. `valuedSubtotal` alone is never a
  portfolio total — read the coverage.

### Portfolio total truth — balance-oriented, reconciled
- **Question:** *"What was the total portfolio worth at a point in time?"*
- **Owns:** the headline portfolio value, total change, AI summaries, export totals.
- **Properties:** **balance-oriented**, reconciled against whatever account truth
  exists, and **may be `estimated`** when no historical balance evidence exists
  (there is no per-account per-date balance history in the schema — provider
  `balance` is a single mutable scalar; the only persisted historical total is the
  aggregated `SpaceSnapshot`, held flat on estimated rows). It is NOT derivable by
  summing individually-priced positions — for the same reason debt balance truth is
  not derivable from period flows: coverage gaps, unpriced holdings, and cash sweep
  mean the bottom-up sum and the account total need not agree.
- **Status:** the coverage contract above is the foundation; the reconciled total
  authority (one figure feeding hero / chart / AI / export, with an explicit
  residual against the position-valuation subtotal) is the planned build on top of
  it. Until then, consumers read A10's coverage and refuse to present a partial
  subtotal as a whole-portfolio total or a coverage-inconsistent change as a return.

### Change vs return — a period % is a return only when flows are zero
- **Rule:** `(closing − opening) / opening` equals a genuine holding-period return
  **only when no external capital crossed the portfolio boundary in the window**
  (then time-weighted ≡ money-weighted). Any contribution / withdrawal / transfer
  folds contributed capital into `totalChange`, so the percentage becomes a *value
  change*, not a return. Its error is range-independent in kind but grows with the
  window — a year of deposits turns a single-digit return into a confident "+550%."
  This is the exact separation `investment-flows-core.ts` encodes ("a cash transfer
  is never equated with performance"); the percentage must not re-fuse it.
- **Authority:** `buildReconciliation` (A10 pure core) derives, from the values it
  already holds, a machine-readable verdict `changeInterpretation`:
  `"return"` (coverageConsistent AND no external flows) · `"value-change"`
  (coverageConsistent but flows crossed the boundary — present the $ change, never a
  return %) · `"incomparable"` (coverageConsistent false). `hasExternalFlows` exposes
  the driver (gross legs + unmeasured external counters — net-zero offsetting flows
  still break the simple return).
- **Must NOT be used for:** presenting a `"value-change"` or `"incomparable"` delta
  as a return / gain percentage. `residualChange` (flow-excluded) is a disclosure,
  **not** a return % — a true return over a flow-containing window is TWR / IRR, a
  separate methodology built only when the product commits to it.

### getCurrentPositions — the current-position seam
- **Purpose:** the ONE cheap current-position projection for non-historical consumers — today's valued investment positions per Space or account.
- **Authority:** `lib/investments/current-positions.ts` `getCurrentPositions(scope, options)`. It is **A10-at-today**: it composes the exact same valuation path as the A10 Time Machine (`valuation.ts` → `valuation-core`) but sources its rows through a CHEAP latest-observation-per-`(account, instrument)` read instead of scanning the full window. It computes **no** value / price / FX / cash / completeness math of its own — **not a second investment authority.** Pure assembly lives in `current-positions-core.ts` (`assembleCurrentPositions`).
- **Outputs:** `CurrentPositions` (`asOf`, `reportingCurrency`, value-descending `CurrentPositionRow[]` = A10's `ValuedHoldingRow` + an additive `costBasis`).
- **Consumers:** the AI holdings assembler, data export, Connections health, the future Plan layer. **These are the only production current-position readers, and none reads the legacy `Holding` table.**
- **Visibility:** enforced INSIDE the seam — current-position DETAIL is always scoped to detail-eligible (FULL) links via the canonical `TRANSACTION_DETAIL_VISIBILITY` predicate. Fails closed to empty. No caller can opt out.
- **Must NOT be used for:** As-Of / compare / period flows — it deliberately cannot do those. A caller needing any of them is an **A10 caller**, not a `getCurrentPositions` caller.

### A10 Investments Time Machine
- **Purpose:** the historical / As-Of / compare / period investment read. **Historical truth belongs EXCLUSIVELY to A10.**
- **Authority:** `lib/investments/investments-time-machine.ts` (`getInvestmentsTimeMachine`), over the same valuation core. Surfaced under its contract name as `loadInvestmentsHistory`.
- **Outputs:** `InvestmentsTimeMachineResult` = the `HistoricalPortfolio` slice — as-of holdings, valued portfolio, period `flows`, and the `opening + netExternalFlows + residual = closing` reconciliation. Reuses NONE of the current-position DTOs.
- **Must NOT be used for:** the cheap "today" read that has no As-Of need — that is `getCurrentPositions`.

### InvestmentsSpaceData — the Investments workspace read contract
- **Purpose:** the ONE navigational home for reading the Investments workspace, so the host composes a uniform per-workspace contract instead of reaching into mechanism modules.
- **Authority:** `lib/investments/space-data.ts` + `space-data-core.ts`. `InvestmentsSpaceData` has two slices split by **time**, never cross-derived:
  - `current` → `loadInvestmentsSpaceData(scope, options)` → `CurrentPortfolio`, sourced EXCLUSIVELY from `getCurrentPositions()` (+ folded allocation).
  - `historical` → `loadInvestmentsHistory(args)` → `HistoricalPortfolio` = the A10 result VERBATIM.
- **The invariant (pinned):** `Current → getCurrentPositions()` · `Historical → A10`. `historical` is never derived from `current` and the current seam is never a historical portal (`getCurrentPositions`'s `asOf` is only ever today). Guarded by `space-data-historical.test.ts` + `space-data-core.test.ts`.

### PositionObservation — the canonical position spine
- **Purpose:** the canonical, provider-neutral evidence record of a held position at a point in time — the identity/evidence layer beneath both current and historical reads. Crypto wallet positions and Plaid/brokerage holdings both write here.
- **Authority:** the `PositionObservation` model (`prisma/schema.prisma`); crypto writes via `lib/crypto/btc-sync.ts` `writeBtcObservation` and `lib/crypto/wallet-position-capture.ts`.
- **Current vs Historical doctrine:** **current** = latest observation per pair, valued at today (`getCurrentPositions`); **historical** = the full observation window reconstructed as-of a date (A10). Both are projections over the one observation spine — neither is a second source of position truth.
- **Must NOT be used for:** the legacy `Holding` table (being retired).

---

# 7 — FX / reporting currency

*The full multi-currency rule-book is [money & FX](../systems/money-and-fx.md). The authority summary below is its financial-semantic face.*

### convertMoney · ConversionContext
- **Purpose:** the SOLE native→reporting-currency conversion — the one seam that turns a `{amount, currency}` at a date into a reporting-currency amount, carrying an `estimated` taint when the rate is missing/walked-back.
- **Authority:** `lib/money/convert.ts` `convertMoney(money, dateISO, ctx)`, driven by a per-Space `ConversionContext` built from `Space.reportingCurrency` via `lib/money/server-context.ts`.
- **Outputs:** `ConvertedMoney` (`amount` in reporting currency, `estimated` flag). Missing FX degrades to the native amount + `estimated` — **never dropped, never silently claimed exact** (the kill-switch: `if (!ctx) return native`).
- **Consumers:** the accounts assembler (`reportingBalance`), the transactions assembler (per-row conversion before every sum/sort), debt strategy, investment valuation/allocation, snapshot stamping — **every cross-currency aggregation.**
- **Must NOT be used for:** comparing to a native amount. If you convert one side, convert both.

### reportingBalance · native-balance doctrine
- **Purpose:** the per-account balance expressed in the Space's reporting currency — **the ONLY balance field valid for cross-account aggregation, weighting, ranking, or sorting.**
- **Authority:** produced by the accounts assembler (`lib/ai/assemblers/accounts.ts`) on `AccountSummaryItem.reportingBalance`, with an `estimated` companion.
- **Native-balance doctrine:** `AccountSummaryItem.balance` / `currency` are **detail facts** — for account-specific display only ("Card balance: AED 20,000"). They must **never** be summed, averaged, weighted, ranked, sorted, thresholded, or compared across mixed currencies. Every such operation reads `reportingBalance` (or a per-row `convertMoney` result). Pinned by `debt-strategy-fx.test.ts` and the `.fx.test.ts` suites.
- **Must NOT be used for:** claiming exactness when `estimated` is set — propagate the taint (e.g. `DebtStrategySection.balancesEstimated`).

---

# 8 — Debt semantic family

**Doctrine gate (read first):** debt has TWO independent truths that must never be
conflated. **Flow truth** (what cash/spending moved this window) comes from
`FlowType` → `classifyLiquidity` → DayFacts. **Balance truth** (what is owed at a
point in time) comes from account balances / `SpaceSnapshot.debt` and is NOT
derivable by subtracting period flows (money is fungible; charges predate the
window; payments settle earlier statements; interest/fees/credits/adjustments move
the balance with no matching flow). A period's `creditCardSpending −
debtServiceCashOut` is **not** an unpaid balance and must never be presented as one.

**Debt strategy / paydown reporting-currency rule.** Debt-strategy math in
`lib/ai/intelligence/annotations.ts` (`monthlyInterestBurden`, `weightedAvgApr`
weighting, snowball ranking, avalanche/snowball candidate balances) is a
**cross-account** computation and therefore uses each account's **reporting
balance** (`AccountSummaryItem.reportingBalance`), never the native `balance` — per
§7. **APR is dimensionless and untouched.** An estimated reporting balance
propagates to `DebtStrategySection.balancesEstimated` so the cross-currency ranking
is never claimed exact.

**Debt payment semantics.** Cash leaving a liquid account toward a liability. The
authority is `classifyLiquidity` → `CASH_OUT / DEBT_PAYMENT` →
`DayFacts.byReason.DEBT_PAYMENT` (source-side liquid legs; the received-on-liability
leg is NEUTRAL, so a payment is counted once). `lib/debt.ts` `totalDebtPaid` /
`rollupDebtPaymentsByAccount` are the **destination-side** view of the *same* fact
family (per-liability attribution), and the AI assembler's `debtPaymentTotal` is the
settled-window view — all three are views of ONE family (`isDebtPayment`), never
competing truths.

Each derived quantity is tagged **AVAILABLE NOW** (a DayFacts fact or trivial
derived total), **AVAILABLE WITH COVERAGE CAVEAT** (from `SpaceSnapshot.debt`,
subject to coverage + `isEstimated` + `fxMiss`), or **FUTURE PER-ACCOUNT SUPPORT**
(blocked on per-account daily balance history the schema does not hold).

### A. `creditCardSpending` — CURRENT CANONICAL FACT · AVAILABLE NOW
- **Purpose:** period cost flows (SPENDING + FEE + INTEREST) charged to liability-tier accounts.
- **Authority:** `foldDayFacts` (DayFacts field), via `FlowType`/`isCostFlow` + `classifyLiquidity` tier.
- **Outputs:** one number on `DayFacts` (⊂ `spendGross`, ∉ `cashOut`).
- **Must NOT be used for:** an unpaid credit-card balance; net purchases (it is **gross of refunds**); a card-only figure (**includes interest & fees**, and **any `debt` account**).

### B. `debtPayment` / debt-payment fact family — CURRENT CANONICAL FACT · AVAILABLE NOW
- **Authority:** `classifyLiquidity` → `byReason.DEBT_PAYMENT`; per-row membership `CALENDAR_MEASURES.debtPayments.rowMatches`.
- **Consumers:** Cash Flow Summary/Calendar/History, `DebtPaymentsWidget`, Key Insights.
- **Must NOT be used for:** new spending (ignored by `foldEconomicRow`); proof this window's purchases were paid (payments settle **earlier** statements); proof of balance reduction net of interest. **May undercount** payments from accounts not connected to Fourth Meridian.

### C. `debtServiceCashOut` — CURRENT DERIVED SEMANTIC · AVAILABLE NOW
- **Authority:** a trivial view over B (`= DayFacts.byReason.DEBT_PAYMENT ?? 0`). A **cash-flow** answer, not a balance answer.

### D–F. `debtOpeningBalance` / `debtClosingBalance` / `debtNetChange` — AVAILABLE WITH COVERAGE CAVEAT
- **Authority:** **balance truth** — `SpaceSnapshot.debt` at `t₀−1` / `t₁` (or `FinancialAccount.balance` when `t₁` = today); `netChange = closing − opening`.
- **Must NOT be used for:** a transaction-derived number; `charges − payments` (a different, non-reconciling quantity); per-account opening balance (FUTURE PER-ACCOUNT SUPPORT). Backfilled rows hold debt flat (`isEstimated`); `fxMiss` rows are unusable — carry the disclosure.

### G–L. `debtReduction` / `debtCarryover` / `averageCarriedDebt` / `debtFreeStreak` / `debtPaydownVelocity` — AVAILABLE WITH COVERAGE CAVEAT
- **Authority:** balance truth (`max(0, opening − closing)`; means/runs/deltas over reliable non-`isEstimated`, non-`fxMiss` snapshot days only).
- **Must NOT be used for:** equating paydown velocity with `debtServiceCashOut` (balance movement ≠ cash service); per-account claims; uncovered/estimated windows without disclosure.

### I. `debtReconciliationResidual` — PLANNED CANONICAL PROJECTION · AVAILABLE WITH COVERAGE CAVEAT
- **Purpose:** a completeness/trust signal: `actual closing − expected closing`, where `expected = opening + charges + interest + fees − payments − credits`.
- **Authority:** balance truth reconciled against DayFacts flow facts — a `DebtFacts` projection.
- **Outputs:** a signed number surfaced as disclosure — **never silently forced to zero.**

### Allocation note — payments vs opening debt is NOT observed
Splitting debt payments into "toward prior-period debt" vs "funding current-period
purchases" is **not an observed fact** — money is fungible; no statement allocation
exists. Do **not** add either as a canonical fact. Any such split requires an
explicit **convention** carrying an `assumptions[]` disclosure, never presented as
observed truth.

---

# 9 — AI consumer doctrine

**AI consumers project canonical truth; they do not recreate it.** Every AI
assembler, serializer, and intelligence module reads the authorities above rather
than re-deciding a financial truth locally. (The full Intelligence architecture is
[AI foundation](../systems/ai-foundation.md).)

- **Transactions assembler** (`lib/ai/assemblers/transactions.ts`) — gates population on `BANKING_POPULATION`, partitions money **exclusively** via the `flow-predicates` predicates, and converts every row via `convertMoney` before summing/sorting. Net = `income + refund − expense − debtPayment`, matching `clampEconomicSpend` doctrine.
- **Accounts assembler** (`lib/ai/assemblers/accounts.ts`) — delegates totals / liquid / net-worth / liability classification to `classifyAccounts`; produces `reportingBalance` via the canonical FX seam.
- **Intelligence** (`lib/ai/intelligence/annotations.ts`) — never re-folds raw rows; reads the assembler's already-canonical scalars. Debt strategy ranks/weights on `reportingBalance` + `apr`.
- **Chat serializer** (`app/api/ai/chat/route.ts`) — spending-category lines derive from `SERIALIZED_SPENDING_FLOWS`; reads assembler scalars, no independent net/spend fold.
- **Daily Brief** (`app/api/brief/route.ts`) — projects off canonical assembler outputs; does not re-fold transactions.
- **Holdings assembler** (`lib/ai/assemblers/holdings.ts`) — reads `getCurrentPositions`, not the `Holding` table.

**Must NOT:** resurrect a local cost set, refund clamp, net formula, population gate, or FX conversion. If the AI needs a financial answer, it consumes the authority — it does not author a parallel one.

---

# 10 — Visibility & viewer-relative semantics

**Read surfaces must honor `VisibilityLevel`.** A `SpaceAccountLink` grants an
account into a Space at a `visibilityLevel` — `FULL`, `BALANCE_ONLY`,
`SUMMARY_ONLY`, `PRIVATE`, (legacy) `SHARED`. Only `FULL` may expose
transaction-level detail (rows, merchants, amounts) or investment-position detail.
`BALANCE_ONLY` exposes a balance total; `SUMMARY_ONLY` a qualitative summary;
neither may ever leak a transaction row or a holding line.

- **One predicate, no second definition.** `lib/ai/visibility.ts`
  `TRANSACTION_DETAIL_VISIBILITY` (= `[FULL]`) is the SOLE source of truth for
  "may this link expose detail," with `grantsTransactionDetail` /
  `grantsAccountDetail` as its readers. Every read path — the AI context assemblers,
  the UI transaction/debt/investment list reads in `lib/data/transactions.ts`, the
  account-detail modal, and the `getCurrentPositions` seam — filters the link on
  `visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY }`. **No surface defines a
  second visibility predicate, and none re-derives visibility client-side** —
  filtering stays in the server loader.

- **KD-15 — a transfer's disposition is a (row, viewer) fact.** Viewer-relative
  visibility gating lives *inside* the semantics, not only at the query boundary.
  The same transfer row resolves to a **known meaning** ("Internal transfer") for a
  viewer who can see both owned legs, and stays **unresolved / unmatched** for a
  viewer who cannot see the counterparty account. A read-time transfer match, and
  the `counterpartyAccountId` it would expose, are surfaced only when that
  counterparty account is visible to the viewing Space (`filterVisibleCounterparty‑
  Accounts`); otherwise the match is dropped and the row honestly reads as
  needing classification. A resolved counterparty is therefore never a property of
  the row alone — it is a property of *(row, viewer)*, and the disposition must be
  computed with the viewer's visibility set in hand. Fails closed: an
  unresolvable/invisible counterparty leaves the row unmatched, never leaked.

---

# 11 — Invariants (pinned by tests) & the Doctrine Oracle

- **Doctrine Oracle** — `lib/transactions/financial-doctrine-oracle.test.ts` (a custom `check()` harness; run via `npx tsx`, not vitest). Freezes the behavioral contract: refund≠income clamp, transfer/investment exclusion from the economic fold, `INVESTMENT`-only out-of-population rule, `UNKNOWN`→UNRESOLVED / `ADJUSTMENT`→NON_CASH, straddle NEUTRAL-leg exclusion, debt-payment A/B/C fact family, rail≠purpose, FX kill-switch + missing→native+estimated, and the visibility ladder.
- **Reporting-currency comparison** — `debt-strategy-fx.test.ts` + the assembler `.fx.test.ts` suites (every summed/weighted/ranked figure uses reporting currency; native never; missing→estimated).
- **One economic-fold authority** — `cash-flow-fold-authority.test.ts` (no re-inlined 3-way branch / clamp; DayFacts is the sole production fold).
- **DayFacts completeness + `byReason` effect-partition + `LIQUIDITY_REASON_SIDE`** — `dayfacts-completeness.test.ts`.
- **Summary / History / Calendar / economic-only derive the same economic semantics** — `cash-flow-projection.test.ts`.
- **Banking population** — `transactions.population.test.ts` (`isBankingPopulation` ↔ the `flowType: { not: INVESTMENT }` query, null-row parity).
- **FlowType label completeness** — `flow-predicates.test.ts` (one label per enum value).
- **Classifier composition + backfill idempotence** — `flow-row-input.test.ts` (`classifierVersion` stamped; running the classifier twice yields identical write fields).

---

# 12 — Sanctioned exceptions (not rival authorities)

These are compatibility / cleanliness residues — **explicitly not** rival semantic
authorities, and each is value-coincident with the authority it shadows:

- **`SpaceTransactionsPanel.tsx` spend chip** — composes the "Spend" summary chip inline (`SPENDING+FEE+INTEREST − REFUND`, clamped) from the canonical `sumByFlowType` map rather than calling `isCostFlow` + `clampEconomicSpend`. Value-coincident and test-pinned; a presentation-tier duplicate to fold back onto the authorities.
- **Account-tier partition duplication** — several balance-reconstruction consumers (`perspective-engine/lenses/liquidity.core.ts`, `asof-completeness.ts`, `accounts-asof.ts`, `isReconstructableCard` copies, snapshot builders) re-hardcode the type→tier / credit-card partition instead of calling `accountTier`. Consistent with it; cleanup, not divergence.
- **Legacy `Holding` retirement** — the crypto compatibility read bridge (`legacy-crypto-holdings.ts`), transitional dual-writes, and the dead `getHoldings` remain during `Holding`-model retirement. Sanctioned transitional debt.
- **Daily Brief savings-rate** — uses an independent `(income − expense)/income` definition (drops refund + debt-payment vs `netCashFlow`); a deliberately different presentation metric over canonical scalars.
