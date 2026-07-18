# A10 Long-Range Return Integrity — Audit & Slice (investigate, then implement)

**Builds on** the coverage foundation (`docs/audits/A10_HISTORICAL_VALUATION_COVERAGE_AUDIT.md`
— `PortfolioValuationCoverage`, `coverageConsistent`, `holdConstantBeforeEarliest`). That
slice made a *partial opening* detectable. This one asks the next question: **even with a
fully-covered, like-for-like opening, is `(closing − opening) / opening` a valid *return*
over an arbitrary window (YTD, 1Y, All Time)?**

**Answer: no — and the reason is semantic, not coverage.** The percentage is a *value
change* that folds in contributions and withdrawals; it equals a return only when no
external money crossed the portfolio boundary. Over long ranges those flows accumulate and
the number becomes a confident, wrong "return."

**Constraints honoured:** no hero patch, no snapshot substitution, no current-balances-
backward, no second engine, no fabricated values. A10 authority, `PortfolioValuationCoverage`,
`PerspectiveEnvelope`, and the trust model are preserved. The fix is a **contained semantic
verdict on the reconciliation contract** — implemented here; hero consumption is the
explicitly-deferred presentation follow-up.

---

## 1. The complete path (traced)

```
preset (WTD/MTD/QTD/YTD/PAST_WEEK/…/PAST_YEAR/ALL)
  → compareToForPreset(preset, asOf, coverageFrom)          lib/perspectives/time-range.ts:108
        YTD → startOfYear(asOf) · PAST_YEAR → asOf−1yr · ALL → coverageFrom (or null)
  → historicalCompareTo (strict compareTo < asOf)           time-range.ts:210
  → getInvestmentsTimeMachine({ asOf, compareTo })          investments-time-machine.ts:55
        getInvestmentValueAsOf @asOf   (holdConstantBeforeEarliest:true)   :76
        getInvestmentValueAsOf @compareTo (holdConstantBeforeEarliest:true) :79
        readPeriodFlows over (compareTo, asOf]              :117  → PeriodFlows
  → buildReconciliation                                     investments-time-machine-core.ts:284
        openingValue = compareView.valuedSubtotal
        closingValue = view.valuedSubtotal
        totalChange  = closingValue − openingValue
        netExternalFlows = flows.netExternalFlows
        residualChange   = totalChange − netExternalFlows
        openingCoverage/closingCoverage/coverageConsistent  (prior slice)
  → HistoricalPortfolio.reconciliation
  → InvestmentsHero:  pct = (totalChange / openingValue) * 100    InvestmentsHero.tsx:51
```

The hero renders `pct` in a `DeltaBadge` labelled `vs {from}` (`InvestmentsHero.tsx:64-72`).

---

## 2. Is the return math using comparable endpoints? — three tests

**(a) Same universe? — PARTIALLY, and the prior slice already reports it.** `openingValue`
and `closingValue` are each a `valuedSubtotal`; `coverageConsistent` is true only when
neither endpoint dropped a held position. `holdConstantBeforeEarliest` (both endpoints)
holds a later-observed position's earliest quantity backward as a disclosed `estimated`
continuation, so a position first seen mid-range no longer silently vanishes from the
opening. **Residual universe risk over long ranges:** a position *bought and sold within
the window* is absent at both endpoints (closed at `asOf`, and — if its earliest
observation is inside the window — held-constant into the opening at a quantity it may not
have had). This is disclosed via the `estimated` tier + coverage, not silently, but it does
make long-range endpoints softer. **This is not the primary failure.**

**(b) Missing positions disclosed? — YES.** Unpriced positions are an explicit `unvalued[]`
remainder; `openingCoverage.unavailableCount` / `coverageByCount` / `fullyObserved` expose
it; `coverageConsistent` gates the change. Over long ranges the opening date more often
predates a position's price history → `unavailableCount > 0` → `coverageConsistent = false`
(already caught).

**(c) Flows separated from performance? — NO. This is the defect.** The reconciliation
*computes* the separation (`netExternalFlows`, and `residualChange = totalChange −
netExternalFlows`), and `investment-flows-core.ts:10-16` is explicit that a cash transfer
"is never equated with investment performance." **But the hero's percentage divides
`totalChange` — which still *includes* `netExternalFlows` — by the opening.** The one
number the user reads re-fuses exactly what the flow model was built to separate.

---

## 3. Where the first invalid assumption appears — by range

The invalid assumption is a single line: **`(closing − opening) / opening` is a return.**
That is true *only* when no external capital entered or left during the window (then
time-weighted ≡ money-weighted return). It is **false the instant any external flow
occurs**. Its *kind* is range-independent; its *magnitude* grows with the window because
flows accumulate.

| Range | compareTo | Typical external flows in window | `totalChange/opening` reads as… | First invalid assumption |
|-------|-----------|----------------------------------|--------------------------------|--------------------------|
| **1D** | asOf−1d | ~none | ≈ real 1-day return | (holds) |
| **1W** (PAST_WEEK) | asOf−7d | rare | ≈ real return | (holds) |
| **MTD** | startOfMonth | small (a paycheck contribution) | drifts if a deposit lands | flows begin to distort; prior slice's coverage guard catches the *coverage* half |
| **YTD** | startOfYear | several months of contributions | **inflated** — deposits dominate | **BROKEN**: % conflates contributed capital with return |
| **1Y** (PAST_YEAR) | asOf−1yr | a full year of contributions | **badly inflated** | **BROKEN** |
| **All Time** (ALL) | coverageFrom | the entire funding history | **absurd** — opening ≈ near-zero, closing ≈ everything ever deposited | **BROKEN** + opening often coverage-incomplete (predates price history) |

### Worked reproduction (illustrative; mechanism exact, exercised by the new tests §6)

A steadily-funded account, one year, no coverage gaps (so it is *not* the MTD coverage bug):

```
opening (1 year ago)              $10,000     ← real, fully covered
external contributions in window  +$50,000    (netExternalFlows)
closing (today)                   $65,000     ← real, fully covered
totalChange = 65,000 − 10,000  =  +$55,000
residualChange = 55,000 − 50,000 = +$5,000    ← the flow-excluded change (≈ performance)

Hero:  pct = 55,000 / 10,000 * 100  =  +550%          ← CONFIDENT AND WRONG
Truth: the portfolio earned ≈ +$5,000 on an average
       invested base near ~$40k → a single-digit % return.
```

`coverageConsistent` here is **true** (both endpoints fully valued) — so the prior slice
does **not** flag it. The `+550%` is a pure Case-B semantic failure: a value change wearing
a return's clothes.

---

## 4. Money-movement treatment — value change vs return

`change = market performance + contributions/withdrawals` (both folded into `totalChange`),
and the hero presents it as a percentage that reads as return. Per the deliverable's
decision fork:

- It **should remain a *value change*** — an honest "your invested value went from A to B"
  figure, shown as a currency amount, and as a percentage **only when it is a genuine
  return** (no external flows).
- A **true return over a flow-containing window requires a separate methodology** —
  **time-weighted return** (TWR: chain sub-period returns across each flow, needs the
  intra-window valuations A10 can already produce via `getInvestmentValueForWindow`) or
  **money-weighted return** (IRR/XIRR over the cash-flow timeline). This is deliberately
  **not built here** (the "do not create IRR/TWR unless justified" rule): it is the
  justified-future slice, unblocked once the product commits to a real return figure.

---

## 5. Classification & root cause

**Primary: Case B — return semantic problem.** The system computes `(closing − opening) /
opening` and surfaces it as a change percentage that reads as a gain/return. The fix is to
make the contract state, machine-readably, *what the change is* — a return only when no
external flows crossed the boundary; otherwise a value change; otherwise (universe mismatch)
incomparable — so no consumer can present a value change as a return.

**Secondary (already handled / out of scope here):**
- **Case A/C — coverage & lifecycle.** Long-range openings more often predate price history
  (→ `coverageConsistent = false`, caught) and positions enter/leave (held-constant +
  `estimated`, disclosed). Improving lifecycle handling (e.g. reconstructing closed
  positions' contribution to the residual) is a later refinement, not the headline defect.
- **Case D — price history.** The key/adapter coverage gaps are the prior slice's Phase-5
  investigation (Tiingo/CoinGecko config, NAV/generic-crypto implementation). Not re-opened.

**Root cause, one line:** the hero's percentage divides a *flow-inclusive* value delta by
the opening basis, so it equals a return only when external flows are zero — a condition
long ranges routinely violate, and which the contract did not yet express.

---

## 6. Fix — a contained semantic verdict on the reconciliation (implemented)

Add two derived, machine-readable fields to `InvestmentsReconciliation`
(`investments-time-machine-core.ts`), computed in `buildReconciliation` from the values it
already has — **no new engine, no valuation math, no hero change, no fabrication**:

```ts
/** Did external capital cross the portfolio boundary in the window (or move unmeasured)? */
hasExternalFlows: boolean;

/** What totalChange represents — the gate a consumer reads before showing a percentage:
 *   "return"       — coverageConsistent AND no external flows ⇒ (Δ/opening) IS a
 *                    holding-period return; a percentage is valid.
 *   "value-change" — coverageConsistent but external flows occurred ⇒ Δ folds in
 *                    contributions/withdrawals; show the $ value change, never a return %.
 *   "incomparable" — endpoints cover different universes (coverageConsistent === false)
 *                    ⇒ not even a clean value change; show $ with a caveat, no %.        */
changeInterpretation: "return" | "value-change" | "incomparable";
```

Precedence `incomparable > value-change > return`. `hasExternalFlows` is true when any gross
external leg is nonzero (`contributions`/`withdrawals`/`transfersIn`/`transfersOut`) OR value
moved that we could not measure as a flow (`externalAmountMissingCount` / `inKindTransferCount`
> 0) — a net-zero pair of offsetting flows still breaks the simple return, so the test is
gross, not `netExternalFlows`. Estimation is deliberately **not** folded in — it is a
confidence axis carried by the `completeness` tier (trust-model tier-vs-warning split),
not a change of *kind*.

**Why this is the honest answer to the goal.** After this slice the contract can answer
"what happened over any range?" with a *valid comparison* (`changeInterpretation: "return"`)
or an *honest classification of why it cannot* (`"value-change"` / `"incomparable"`) — never
a confident wrong percentage at the semantic layer.

### Authority ownership

| Concern | Owner | Change |
|---------|-------|--------|
| What the change *is* (return / value-change / incomparable) | `buildReconciliation` (A10 pure core) | **new** derived verdict |
| External-flow truth | `investment-flows-core.ts` (`netExternalFlows` + gross legs) | reused, unchanged |
| Universe comparability | `coverageConsistent` (prior slice) | reused, unchanged |
| Confidence (observed/estimated) | `completeness` tier / `PerspectiveEnvelope` | reused, unchanged |
| Presenting the verdict (label "Value change" / omit %) | the hero (future presentation slice) | **NOT touched here** |

---

## 7. Recommended implementation slices

1. **THIS SLICE (done):** `hasExternalFlows` + `changeInterpretation` on the reconciliation
   contract + doctrine §6 return-vs-value-change boundary + regression tests. Semantic,
   contained, no UI.
2. **Presentation follow-up (deferred, matches the coverage pattern):** the hero reads
   `changeInterpretation` — `"return"` → keep the `%`; `"value-change"` → label the figure
   "Value change" and drop/relabel the `%`; `"incomparable"` → currency delta + caveat, no
   `%`. Pure presentation; the logic stays in the contract.
3. **True return (justified-future, only when the product commits):** a real TWR (chained
   sub-period returns via `getInvestmentValueForWindow`) or IRR/XIRR over the flow timeline —
   the only honest way to show a *return* for a flow-containing window. New authority, own
   slice, its own trust treatment.

---

## 8. Constraints / non-goals restated

- **No hero patch, no blind percentage suppression** — the verdict is in the contract; the
  hero decides presentation in a later slice.
- **No snapshots, no current-balances-backward, no second engine, no fabricated values** —
  every input is A10's existing valuation + flows.
- **Preserved:** A10 authority, `PortfolioValuationCoverage`, `PerspectiveEnvelope`, trust
  model. `residualChange` remains the disclosed "change not explained by flows" figure — it
  is **not** repurposed into a return %, which would be a subtly-wrong metric.

*Read-only investigation → contained semantic implementation. No UI touched.*
