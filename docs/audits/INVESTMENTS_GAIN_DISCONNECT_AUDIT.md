# Investments Percentage-Gain Disconnect — Audit (Read-Only)

**Perspective:** Investments · **Preset:** MTD (`2026-07-01 → 2026-07-18`)
**Symptom:** Hero shows **≈ +364%**; the Balance-history chart shows a much smaller
increase (**< ~$2k**).
**Scope:** Investigation only. No implementation, no UI changes, no fixes.

---

## TL;DR

The hero percentage and the chart answer the **same user question with two different
financial authorities**, and they do not reconcile:

| | Hero change | Balance-history chart |
|---|---|---|
| Authority | **A10 Time Machine** reconstruction (`getInvestmentsTimeMachine`) | **Persisted `SpaceSnapshot` window** (`getRecentSnapshots`) |
| Opening value | `compareView.valuedSubtotal` — reconstructed **valued** subtotal at `compareTo` | `SpaceSnapshot.stocks + SpaceSnapshot.crypto` on the compareTo day |
| What it counts | valued positions **only** (partial-coverage subtotal) | the persisted stocks+crypto buckets |
| Includes contributions? | **Yes** (`totalChange` = value delta, flows included) | Yes (it's a value series) |

Because the hero's **denominator** is the *opening-date valued subtotal* — a
partial-coverage number that can be a small fraction of the true opening portfolio —
and its **numerator** is the raw close−open delta (contributions included), the
percentage detaches from the dollar change the chart draws. The two surfaces are **not
lying about their own inputs; they are measuring different things**, so the displayed
`%` is not a trustworthy answer to "how much did my portfolio move this month?".

**Verdict: C** — hero and chart measure different things; the percentage is
semantically dishonest as presented.

---

## 1. Exact calculation paths

| Surface | File | Authority | Formula |
|---|---|---|---|
| Hero `%` | `components/space/widgets/investments/InvestmentsHero.tsx:49-51` | A10 reconciliation (`data.historical.reconciliation`) | `pct = (totalChange / openingValue) * 100` |
| Hero `$` delta | `InvestmentsHero.tsx:49`, rendered `wealth-ui.tsx:60` via `DeltaBadge` | same | `abs = totalChange` |
| Hero headline `$` | `InvestmentsHero.tsx:63` | **current** portfolio (`primary.portfolio`) | `portfolio.valuedSubtotal` |
| `totalChange` / `openingValue` | `lib/investments/investments-time-machine-core.ts:204-206` | A10 valuation **views** | `openingValue = compareView.valuedSubtotal`; `closingValue = view.valuedSubtotal`; `totalChange = closingValue − openingValue` |
| Chart series | `components/space/widgets/investments/InvestmentsBalanceHistory.tsx` → `components/space/widgets/charts/TrendChart.tsx` | persisted `SpaceSnapshot` | one point per day |
| Chart point value | `lib/investments/portfolio-series.ts:60-68` (`buildPortfolioValueSeries`) | `getRecentSnapshots` | `value = totalInvestments + totalCrypto` (stocks + crypto, disjoint buckets) |
| Both composed in one response | `app/api/spaces/[id]/investments/space-data/route.ts:66-72` | — | `historical` (A10) and `series` (snapshots) fetched **side by side, independently** |

### Hero path, expanded

```
InvestmentsHero.tsx:49-51
  change  = reconciliation.totalChange
  opening = reconciliation.openingValue
  pct     = (change / opening) * 100

investments-time-machine-core.ts:204-206
  openingValue = compareView.valuedSubtotal   // VALUED subtotal at compareTo (2026-07-01)
  closingValue = view.valuedSubtotal          // VALUED subtotal at asOf     (2026-07-18)
  totalChange  = closingValue − openingValue

⇒ pct = (view.valuedSubtotal − compareView.valuedSubtotal)
        / compareView.valuedSubtotal * 100
```

Two structural properties of this formula:

1. **The denominator is a partial-coverage subtotal.** `valuedSubtotal` sums *only the
   positions that could be valued at that date* (`toInvestmentsPortfolio`,
   `investments-time-machine-core.ts:161-170`; unvalued positions are excluded). The
   opening and closing subtotals are computed over **potentially different sets of
   holdings**. If the opening date had thin valuation coverage, `openingValue` is a
   small slice of the real opening portfolio, and dividing by it explodes the `%`.

2. **The numerator includes external flows (contributions/withdrawals).** `totalChange`
   is the raw value delta; by the module's own identity
   `closingValue = openingValue + netExternalFlows + residualChange`
   (`investments-time-machine-core.ts:74`). The flow-excluded figure
   `residualChange = totalChange − netExternalFlows` (`:208`) **exists but is not what
   the hero shows**. The component docstring is candid about this
   (`InvestmentsHero.tsx:14-17`): "a VALUE DELTA over the period (it includes
   contributions by construction) … never 'gain'."

The code even detects the partial-endpoint condition —
`endpointIncomplete = view.unvaluedCount > 0 || compareView.unvaluedCount > 0`
(`:209`) with reason "Opening or closing value is a partial subtotal … so this
reconciliation is partial" (`:218-219`) — **but the hero divides by that partial
`openingValue` anyway** (`InvestmentsHero.tsx:51`), without guarding on
`endpointIncomplete`.

### Chart path, expanded

```
route.ts:66-71
  snaps  = getRecentSnapshots(SERIES_DAYS, { spaceId })   // persisted SpaceSnapshot rows
  series = buildPortfolioValueSeries(snaps, reportingCurrency)

portfolio-series.ts:60-68
  each point.value = s.totalInvestments + s.totalCrypto   // stocks + crypto, counted once
  (fxMiss points dropped; estimated flag rides through)

InvestmentsBalanceHistory.tsx:36-42
  clip to window: p.date <= asOf && (!compareTo || p.date >= compareTo)
```

The chart's "change" = `last.value − first.value` over the clipped window. Each point is
a **persisted, fully-materialised** stocks+crypto value — not a per-date reconstruction
of valued positions. This is why it shows the true, small monthly move.

**Both surfaces use `reportingCurrency`, both use the same `asOf`/`compareTo` window,
both include flows.** The divergence is **not** currency, **not** time boundary, **not**
contributions-vs-market. It is the **opening-value authority** and the **partial-coverage
denominator**.

---

## 2. Numerical reproduction

> Exact live figures were not pulled (read-only investigation; no DB/browser query).
> The values below are an **illustrative reconstruction** consistent with the reported
> `+364%` and `< ~$2k` — they demonstrate the mechanism, not audited balances. Live
> numbers can be confirmed on `:3000` (Investments · MTD) via the browser harness if a
> precise pin is wanted.

### Hero (A10 reconstruction)

```
openingValue (compareView.valuedSubtotal @ 2026-07-01)  ≈  $  4,400   ← PARTIAL coverage
closingValue (view.valuedSubtotal @ 2026-07-18)         ≈  $ 20,450
totalChange  = 20,450 − 4,400                           ≈  $ 16,050   (flows included)
pct          = 16,050 / 4,400 * 100                     ≈  +364.8 %   ✓ matches symptom
```

### Chart (persisted SpaceSnapshot series)

```
start (2026-07-01: totalInvestments + totalCrypto)      ≈  $ 18,500   ← FULL value
end   (2026-07-18: totalInvestments + totalCrypto)      ≈  $ 20,450
change = 20,450 − 18,500                                ≈  $  1,950   (< ~$2k)  ✓
pct    = 1,950 / 18,500 * 100                           ≈  +10.5 %
```

### Why they differ

Both endpoints are the **same two dates**, the **same currency**, and **both include
flows** — yet the openings disagree by ~4×:

- **Chart opening ≈ $18,500** — the persisted July-1 snapshot already carried the full
  stocks+crypto value.
- **Hero opening ≈ $4,400** — A10's *reconstructed valued subtotal* at July 1 could only
  price a fraction of the holdings (sparse `PositionObservation` coverage at the start of
  the month → most positions land in `unvalued`, excluded from `valuedSubtotal`).

The hero then divides a nearly-correct closing-minus-small-opening delta by that small
opening. The result (`+364%`) says nothing about portfolio return — it is the ratio of
"value that appeared once coverage filled in" to "the sliver that was priced on day one."
The `$16,050` dollar delta is equally an artefact: most of it is coverage catching up
(and any real contributions), not market movement.

---

## 3. Semantic verdict

**C — Hero and chart are measuring different things, and the UI label is dishonest.**

- The chart answers **"what was my invested value each day, and how did it move?"** using
  the persisted daily value. It is the trustworthy answer to the money question.
- The hero `%` answers **"by what fraction did the *priced-at-open* valued subtotal grow,
  flows included?"** — a partial-coverage ratio with contributions in the numerator. It
  is presented next to the headline as if it were a period return.

The hero is not internally malformed (it faithfully computes its documented fields), and
the chart is not wrong. **The dishonesty is the juxtaposition**: a partial-coverage,
flow-inclusive ratio rendered as *the* period-change badge invites the user to read it as
"my portfolio is up 364% this month," which is false.

### Recommended honest naming (presentation, not the fix)

Given the authority actually behind the number, the honest options are:

- Show the **dollar value change** and drop or heavily qualify the `%`:
  > **Portfolio value change** · **+$16,050** vs Jul 1 *(includes contributions; opening
  > coverage partial)*
- Or, if a percentage stays, base it on a **coverage-consistent** opening (see §4) and
  label it as a **value change, not a return**:
  > **Value change (excl. contributions)** · **+$1,950** *(residual over Jul 1–18)*

The word that must never appear is "gain"/"return" while the number carries flows and a
partial denominator — the code comments already know this; the rendered badge undercuts
them.

---

## 4. Architectural fix recommendation (do not implement)

The goal: **one user question → one financial meaning → one displayed answer.** The chart
already owns the trustworthy meaning. The fix is to stop the hero from asserting a
*second, incompatible* meaning — not to change the chart to match the hero, and not to
add a new calculation inside the component.

**Correct owner: `InvestmentsSpaceData` / the historical series builder — not the
component.** Three coherent directions, in order of preference:

1. **Make the hero speak the chart's authority for the *value change*.** The
   period value-delta the hero shows should be derived from the **same persisted
   `SpaceSnapshot` series** the chart draws (first-vs-last point over the window), so the
   headline delta and the chart are the same number by construction. This belongs in the
   space-data / series layer (`lib/investments/portfolio-series.ts` +
   `lib/investments/space-data.ts`), exposed as a first-class field on the contract, so
   the component only *reads* it. Preserves the canonical investment authority (the
   snapshot spine), the trust envelope, time semantics, and historical mode — all already
   flow through that path.

2. **If A10's reconciliation stays the source, make the percentage coverage-honest.**
   Never divide by a partial `openingValue`: when `endpointIncomplete` is true (already
   computed at `investments-time-machine-core.ts:209`), the reconciliation should
   **suppress `pct` / expose it as `null`** rather than let the component divide anyway.
   The percentage denominator must be a coverage-matched opening (same holding set valued
   at both endpoints), or there is no honest ratio to show. This is a change in the
   **core reconciliation contract**, consumed unchanged by the component.

3. **Separate "value change" from "return" in the contract vocabulary.** The residual
   (`residualChange`, flow-excluded, already computed at `:208`) is the closest thing to a
   market move; `totalChange` is a value delta. The hero currently conflates them. The
   contract should hand the component *labelled* figures ("value change", "excl.
   contributions"), so presentation cannot accidentally imply return.

### Constraints honoured

- **No new calculation in the component** — the fix lives in `space-data` / the series
  builder / the reconciliation core; `InvestmentsHero` stays presentation-only.
- **Do not make the chart match the hero** — the chart is the correct authority; it is the
  hero that must converge onto the persisted-snapshot meaning (direction 1) or stop
  asserting a partial-coverage ratio (direction 2).
- **Canonical investment authority preserved** — persisted `SpaceSnapshot` spine
  (stocks+crypto, no double-count) remains the single value source.
- **Trust envelope / time semantics / historical mode preserved** — the recommended owner
  is already inside those seams; nothing about `asOf`/`compareTo`, `reportingCurrency`, or
  the completeness envelope changes.

---

## Appendix — files touched by this trace

- `components/space/widgets/investments/InvestmentsHero.tsx` — hero `%` and `$` badge
- `components/space/widgets/investments/InvestmentsWorkspace.tsx` — wires hero (A10
  `reconciliation`) and chart (`series`) from independent sources
- `components/space/widgets/investments/InvestmentsBalanceHistory.tsx` — clips + hands
  series to `TrendChart`
- `components/space/widgets/charts/TrendChart.tsx` — shared chart core
- `lib/investments/investments-time-machine-core.ts` — `buildReconciliation`,
  `openingValue`/`closingValue`/`totalChange`/`residualChange`
- `lib/investments/portfolio-series.ts` — `buildPortfolioValueSeries` (persisted-snapshot
  authority)
- `lib/investments/space-data.ts` — `loadInvestmentsSpaceData` (A10 historical binding)
- `app/api/spaces/[id]/investments/space-data/route.ts` — composes `historical` (A10) +
  `series` (snapshots) in one response

*Read-only audit. Nothing was modified.*
