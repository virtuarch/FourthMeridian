# Debt-Payment Liability Attribution Investigation

**Status:** Investigation complete — architectural recommendation only. No implementation.
**Date:** 2026-07-02
**Trigger:** "How much credit card debt have I paid from January to now? Show me month to month and each card" → AI attributed ~100% of payments to one card (Sapphire), $0 to the other (Amex Platinum), which the user knows is false.
**Relationship to KD-17:** different semantic layer, not a regression. KD-17 fixed *"what counts as spending."* This is *"which liability did a payment satisfy"* — flow **destination**, a dimension the pipeline does not model.
**Companion proof script (read-only, optional):** `scripts/kd-debt-attribution-audit.ts`

---

## 1. What actually happened (deterministic trace, no DB required)

The user's question produces this context, and only this context, for debt payments:

1. **Monthly scalars.** `buildMonthlyBreakdown` emits one `debtPaymentTotal` per month — `Σ|amount|` over `category = Payment AND amount < 0` rows (`lib/ai/assemblers/transactions.ts:762`). No account dimension. The user's table's Jan figure ($14,500) is exactly the January `debtPaymentTotal` proven in the KD-17 audit — the *totals* are deterministic and correct.
2. **Liability names.** The accounts assembler serializes each liability (name, balance, APR, `debtSubtype`) — so the model knows "Ultimate Rewards®" and "Platinum Card®" exist.
3. **Nothing that joins them.** No per-liability payment rollup exists anywhere in the pipeline. The drilldown *could* attach per-row `accountName` evidence, but its trigger regexes (`route.ts:452-465`) don't fire on this phrasing ("show me month to month and each card" matches no evidence pattern), so no rows were attached.

The model was therefore handed correct per-month totals, two card names, and a question demanding a per-card split that the context cannot express. It fabricated the allocation (everything to one card). The output validator is membership-based (KD-2 caveat): $14,500 appears in the prompt → reconciled; "$0" and the column assignment are *attribution*, which the validator structurally cannot check. Same failure signature as KD-17: **deterministic pipeline supplies authority, model supplies the impossible part, validator confirms it.** But here the missing piece is an absent dimension, not a wrong aggregation.

## 2. Q1 — Can the current deterministic model already know which liability each payment belongs to?

**Partially — and the partial answer is the important architectural fact.**

Every credit-card payment is **two rows**:

| Leg | Row shape | Attribution content |
|---|---|---|
| Source (checking) | `amount < 0`, `category = Payment`, on the checking account | Source known (row's own account). **Destination is NOT recorded anywhere on the row** — only inferable from the merchant string ("Payment to Chase card…"), which is heuristic, not deterministic. |
| Destination (card) | `amount > 0`, on the **card's own `financialAccountId`** ("Payment Thank You-Mobile" credits in the KD-17 audit) | **Destination is deterministically known today** — it is the row's own account, and `FinancialAccount.debtSubtype` (`schema.prisma:755`) identifies it as a liability. |

So: the data to answer "how much did I pay toward each card" **already exists in the database** — as the card-side credit legs — with two caveats:

- **Caveat A (data quality, proven in KD-17):** Plaid's PFC tags the same payment merchant inconsistently; in January, $4,000 of card-side payment credits carried `category = Payment` and $9,500 carried `Other`. A category-based selector undercounts; a deterministic selector needs `amount > 0 AND account.debtSubtype != null` plus either category or merchant pattern. Quantifiable via the companion script.
- **Caveat B (semantic mismatch):** card-side credits measure *payments received by the card*, which can differ from source-side debits in a month (timing skew, payments from external accounts, both legs not always visible). `debtPaymentTotal` (source-side) and a per-card rollup (destination-side) are two views of the same flow and will not reconcile exactly without pair-linking.

The **source-side** legs — what `debtPaymentTotal` actually sums — can **never** carry destination attribution without transfer-pair linking (FlowType investigation Option F, explicitly deferred there, §4/§7).

## 3. Q2 — Where is the attribution lost?

Four distinct loss points, in pipeline order:

1. **The select.** The summary query fetches only `date, merchant, category, amount, pending` (`transactions.ts:235-241`) — `financialAccountId`/`accountId` are discarded at the door. Even the attribution the DB *does* hold (card-side legs) cannot survive into any rollup.
2. **The aggregation semantic.** `debtPaymentTotal` counts source-side debits only (`:296, :762`); destination-side credits are deliberately skipped (correct for avoiding double-count, but it means the aggregated population is precisely the one with no destination information).
3. **The rollup shape.** All debt flow collapses to one scalar per month. There is no `byLiability` anywhere in `TransactionsSummaryData`.
4. **The serialization + validation gap.** The prompt presents per-month totals next to named liabilities with no statement that attribution is unknown, and no rule forbidding the model from constructing per-card tables. The membership validator cannot catch invented attribution.

Plus the KD-17 data-quality amplifier (Caveat A) corrupting the category signal on the destination legs.

## 4. Q3 — What semantic objects are missing?

For the full future ontology (the user's sketch is accurate):

- **Flow destination** — a first-class notion that a `DEBT_PAYMENT` flow *reduces a specific liability*. Minimal form: per-liability payment rollup keyed by the destination account. Full form: `flowType = CREDIT_CARD_PAYMENT` with source/destination account references.
- **Transfer-leg pairing** (FlowType Option F, deferred) — required to attribute *source-side* legs and to make source/destination views provably reconcile.
- **Principal / interest / fees / statement-cycle decomposition** — explicitly deferred in the FlowType investigation (§6 Q5: insufficient provider signal today).

Notably, the FlowType investigation as written models the flow **kind** but not the flow **destination** — `DEBT_PAYMENT` as a value carries no "which liability" either. Destination attribution must be added to that initiative's requirements or it will rebuild this gap.

## 5. Q4/Q5 — Option A or Option B, and roadmap disposition

**Verdict: Option B for the capability, with one thin Option-A carve-out.** This mirrors exactly the precedent set in the FlowType investigation (§6 Q9), which deferred the model to v2.5 but carved out the Banking income bug as an immediate defect.

- **The capability** (true per-card payment history) is FlowType-layer ontology: it needs the destination dimension, a per-liability rollup, careful double-count semantics, and eventually pair-linking. Building it now inside v2.4.5 is scope creep into v2.5.5 Financial Intelligence — precisely "scope creep by curiosity."
- **The carve-out (genuine v2.4.5-class defect):** the pipeline currently *invites a fabricated deterministic-sounding answer*. That is a financial-correctness defect in the same class as KD-17 (validated-looking false figures), and it has a stabilization-sized fix that adds **honesty, not capability**: serialize an explicit statement that debt payments are not attributed per liability, and a prompt rule that per-card payment questions must be answered with the monthly totals plus "per-card attribution isn't available yet" — never a per-card table. A few serializer lines + a regression test. No schema, no aggregation change.

**Recommendation:**

1. Open a new KD (suggest **KD-18**): *"AI fabricates per-liability attribution of debt payments; context contains no destination dimension."* Scope for v2.4.5 = the honesty guardrail only. (Checklist-first per project rules, on approval.)
2. Fold **destination attribution** into the Transaction Flow Classification initiative as an explicit requirement (per-liability payment rollup from destination-side legs; pair-linking remains its own deferred stage). Record Caveat A there as a dependency on import fidelity (the same `mapPlaidCategory` fix that initiative already stages).
3. **Close v2.4.5 once the guardrail lands.** Do not hold the release for the ontology: v2.4.5's contract is "figures the AI presents are not false," which the guardrail satisfies; "the AI can answer per-card payment history" is a v2.5.5 capability by the roadmap's own definition. Then merge Phase 2, rename, and start v2.5 clean.

## 6. Other metrics with the same missing-dimension defect (watch list for FlowType)

Same root cause — account identity discarded at the summary select — so any per-account question invites the same fabrication:

| Metric | Today | Failure mode |
|---|---|---|
| `transferTotal` | One scalar | "How much did I move to savings vs brokerage?" — unanswerable, model may fabricate |
| Interest costs | Global aggregate | "How much interest is each card charging me?" — the rows sit ON each card (attribution exists in DB), aggregation discards it |
| `incomeTotal` / income sources | Merchant-grouped, not account-grouped | "How much lands in my joint account?" — unanswerable |
| Per-account spending | None | "How much did I put on the Amex this month?" — only the drilldown's per-row accountName exists, no totals |

The guardrail KD should cover the fabrication risk generically (attribution disclaimer for per-account questions), even if only debt payments are fixed with data later.

## 7. Evidence index

| Claim | Source |
|---|---|
| Summary select discards account identity | `lib/ai/assemblers/transactions.ts:235-241` |
| `debtPaymentTotal` = source-side debits only, scalar | `transactions.ts:296, 762`; serialized `route.ts:795` |
| Liability names/subtypes enter context | `lib/ai/assemblers/accounts.ts`; `schema.prisma:755` (`debtSubtype`) |
| Drilldown carries per-row accountName but didn't trigger | `transactions.ts:920-929`; trigger patterns `route.ts:452-465` |
| Validator cannot check attribution | `lib/ai/output-validator.ts` header (membership-based, KD-2 caveat) |
| Card-side payment credits exist, partially miscategorized | KD-17 audit `docs/investigations/kd17-audit-output.md` (rows 46/48/62/87; Payment credits $4,000) |
| FlowType initiative defers pair-linking and P/I split; models kind not destination | `docs/investigations/TRANSACTION_FLOW_CLASSIFICATION_INVESTIGATION.md` §4 Option F, §6 Q5, §7 |
| Precedent: defer model, carve out defect | same doc §6 Q9 (Banking income carve-out) |
