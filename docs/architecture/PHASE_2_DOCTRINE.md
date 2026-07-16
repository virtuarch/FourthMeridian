# Phase 2 Doctrine — Canonical Truth-Spine Convergence

**Status:** the permanent architectural contract achieved by Phase 2. Phase 2 is
**formally complete** (Closure Audit: PASS · 0 Category-A blockers · 0 remaining
parallel semantic authorities · Doctrine Oracle green 255/255 · High confidence).

This document records the contract future work must not break. It is intentionally
short. The full authority-by-authority map is `../doctrine/financial-semantics.md`.

---

## The guiding doctrine

Every financial number flows through one funnel, and consumers only ever project
the truth it produces:

```
Providers
  ↓
Canonical identity / evidence      (TransferEvidence, RelationshipResolver, PositionObservation)
  ↓
Canonical semantics                (FlowType + flow-predicates, classifyLiquidity, TransferDisposition, convertMoney)
  ↓
Canonical facts / projections      (DayFacts fold, getCurrentPositions, reportingBalance)
  ↓
Consumers                          (widgets, AI, export, Daily Brief)
```

**Consumers project canonical truth. Consumers never independently decide financial
truth.** A consumer that re-classifies a row, re-folds a total, re-converts a
currency, or re-ranks in native balances is a defect — it re-creates a parallel
authority, which is exactly what Phase 2 removed.

---

## Phase 2 success criteria — all met

- ✓ **One canonical transaction population** — `flowType != INVESTMENT` (`isBankingPopulation` + the `BANKING_POPULATION` query fragment). `UNKNOWN` / `ADJUSTMENT` / `null` rows stay in the population for review and carry no economic bucket (`isNonEconomicResidue`). No category allow-list gate survives.
- ✓ **One economic fold** — `foldEconomicRow` + `clampEconomicSpend`, folded once into `DayFacts`. No re-inlined 3-way branch or refund clamp anywhere.
- ✓ **One liquidity authority** — `classifyLiquidity` (per-row), projected by `DayFacts` / `groupLiquidityByReason`. No consumer decides a liquidity effect, payment-app treatment, or debt-payment behavior on its own.
- ✓ **One transfer authority** — `TransferEvidence` → `TransferDisposition` (+ `RelationshipResolver` for ownership). **Ownership dominates rail.** No merchant/rail purpose inference.
- ✓ **One investment position authority** — `getCurrentPositions` (current) and the A10 Time Machine (historical), both projections over the `PositionObservation` spine. No production consumer reads the legacy `Holding` table.
- ✓ **One reporting-currency aggregation authority** — `convertMoney` (per-Space `ConversionContext`); the accounts assembler's `reportingBalance` is the single cross-account basis.
- ✓ **One reporting-currency comparison basis** — every summed / averaged / weighted / ranked / sorted / thresholded / compared figure is in reporting currency. Native balances are detail facts only.
- ✓ **Consumers project truth** — AI assemblers, serializers, Daily Brief, exports, and every cash-flow surface read the authorities above.
- ✓ **Consumers do not recreate truth** — no surviving private cost set, refund clamp, net formula, population gate, or FX conversion.
- ✓ **Oracle green** — `financial-doctrine-oracle.test.ts` passes 255/255 (run via `npx tsx`).
- ✓ **Zero remaining parallel semantic authorities** — verified by the closure audit across population, economic fold, liquidity, transfer, investments, FX, and cross-surface consumers.

---

## What "done" does not mean

Phase 2 convergence is an architectural property (one authority per truth), not a
zero-debt state. The closure audit recorded a small set of **non-blocking**
residues — all compatibility / cleanliness / documentation, none a rival authority:

- **Transitional compatibility (B):** the legacy `Holding` retirement bridges (crypto read bridge, transitional dual-writes, the dead `getHoldings`); the `SpaceTransactionsPanel` spend chip composed inline from the canonical `sumByFlowType` map; the per-month net formula re-authored (test-pinned) in AI intelligence.
- **Cleanup (C):** the account-tier / credit-card partition duplicated (consistently) across balance-reconstruction consumers instead of calling `accountTier`.
- **Presentation / future (D/E):** the Daily Brief savings-rate as a deliberately distinct metric; dictionary/doc enrichment.

These are tracked in `../doctrine/financial-semantics.md` §11. They may be paid down
opportunistically; none reopens the convergence contract.

---

## The contract for future work

1. **Add a truth once.** A new financial kind, tier, disposition, or currency rule
   is added to its single authority module — never re-inlined at a consumer.
2. **Consume, don't re-decide.** Need a financial answer? Read the authority. If the
   authority can't answer it, extend the authority — do not author a parallel one.
3. **Facts vs presentation.** Fact records hold numbers; labels/ordering/rows live in
   projections.
4. **Keep the Oracle green.** `financial-doctrine-oracle.test.ts` freezes the
   behavioral contract. A change that moves a pinned behavior is a doctrine change,
   made deliberately (and documented here), not a silent drift.
5. **Reporting currency for every comparison.** Anything summed/weighted/ranked/
   compared is in reporting currency; native balances are detail only.
