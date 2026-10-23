# V26-SEMANTICS-CONSUMER-CONVERGENCE — Semantic Architecture Audit

*Audit date: 2026-08-01 · Baseline: `v2.6` working tree · Read-only; no code was modified. All references are `file:line` in the repository root. The quantity/valuation authority repair (V26-QUANTITY / V26-PRICING arcs) is acknowledged as in flight; this audit maps every consumer that can drift from it.*

---

## 0. Verdict — where the choir splits

Fourth Meridian has a genuinely canonical core: A10 (`getInvestmentsTimeMachine`), `getCurrentPositions`, `computeWealthTimeMachine`, `buildInvestmentsTrustSummary`, and the pure valuation engine under them are real, tested, single-authority code. The drift is not in the authorities. It is in **who is allowed to bypass them**, and the bypasses cluster into eight structural faults:

1. **The persisted `SpaceSnapshot` series has two writers with two valuation bases.** Today's row is `classifyAccounts` over `FinancialAccount.balance` (`lib/snapshots/regenerate.ts:170-183`) — no positions, no prices, no valuation core. Historical rows are A8 valuation (`lib/snapshots/regenerate-history.ts:393-399`). Today's row is written `isEstimated: false` and therefore **frozen against A9 forever** — the today↔history seam is a permanent, structural discontinuity in every net-worth chart. The disclosure built to explain it (`WealthResult.basis`, from `lib/wealth/basis-disclosure.ts`) is computed and **rendered nowhere**.

2. **`getCurrentPositions()` reaches exactly one screen.** No dashboard widget, no wealth surface, no section renderer, no snapshot writer calls it (verified import census). Every "current" investment/crypto number on the Dashboard, Overview sections, Spaces launcher, Wealth perspective, AI accounts domain, and Brief is `FinancialAccount.balance`. The canonical current-portfolio authority serves only the Investments Workspace, the AI holdings domain (INVESTMENT/RETIREMENT Spaces only), and Export.

3. **The Investments page disagrees with itself by construction.** The hero is A10 `valuedSubtotal` (scope `detailEligible`, crypto included, unvalued positions excluded); the chart directly beneath it is `SpaceSnapshot.stocks + crypto` (scope `all`, ownership-filtered, crypto valued by a different engine, last point balance-derived, no point guaranteed at `asOf`/`compareTo`). Five independent divergence mechanisms in one JSON payload (`app/api/spaces/[id]/investments/space-data/route.ts:71-72`). This is *pinned as intended* by `InvestmentsWorkspace.test.ts:100-106` — the divergence is architectural and undisclosed, not accidental.

4. **`attribution` escapes display-FX conversion.** `convHistorical` (`lib/investments/display-conversion.ts:147-156`) spreads `...h` and converts holdings/portfolio/flows/reconciliation — not `attribution`. The hero and the bridge's partial state render source-currency magnitudes under a display-currency label. `display-conversion.test.ts` contains zero references to `attribution`, so the "EXHAUSTIVENESS is load-bearing" guard does not cover the newest money-bearing field. This is the most concrete reproducible wrong number in the app.

5. **The ungated `(change / opening) * 100` still exists** — `InvestmentsHero.tsx:62`, the exact expression the attribution gate was built to eliminate, live on the `attribution == null` fallback branch. Plus ten more independent opening-value rules and two incompatible sign conventions for percent denominators (`abs` vs no-`abs`), which produce opposite-signed percentages for negative openings.

6. **The AI/Brief layer is converged on one read path and nothing else.** B2 pointed the snapshot assembler at `getRecentSnapshots`; everything downstream re-derives: `accounts.totalInvestments` is Σ balances beside `holdings.totalPortfolioValue` (spine) in the same prompt with no reconciliation; trust prose is re-authored (`holdings-core.ts:219-222` vs `investments-trust.ts:181`) with a *different unvalued count*; the Brief renders a 90-row trend under "Since yesterday" (`app/api/brief/route.ts:99-186`), prints snapshot **row counts as days** (twice), and hardcodes `$` for every figure. `buildInvestmentsTrustSummary`, `buildPortfolioValueSeries`, A10, and `WealthResult` have **zero** AI/Brief consumers.

7. **Quantity has seven as-of implementations; coverage has five vocabularies; "nearest snapshot" has ten copies.** The purpose-built repair (`quantity-replay` / `quantity-authority`) is fully wired into valuation but defaults `off`; the two modules written specifically to gate snapshot honesty (`price-completeness.core.ts`, `representativeness.core.ts`) are consumed **only by diagnostic scripts**, never by the writer they were written for.

8. **Crypto is valued by two engines.** On-spine positions: `PositionObservation × RAW_CLOSE × FX` (valuation-core). Snapshot history: `FinancialAccount.nativeBalance × BTC/USD`, quantity held constant, **BTC-only** (`regenerate-history.ts:508-519`) — a non-BTC crypto account with a `nativeBalance` is valued as if it were Bitcoin. The legacy `Holding` table is still dual-written (`lib/crypto/btc-sync.ts:157`), and the stated no-overlap invariant in `legacy-crypto-holdings.ts:16-20` is **no longer true** — double-counting is prevented only by two ad-hoc consumer-side dedups.

Everything below is the evidence and the way out.

---

## 1. Consumer inventory

Every consumer of investment history, grouped by family. Template fields abbreviated: **Auth** = current semantic authority · **Qty/Px** = historical quantity / price source · **Val** = current valuation source · **Gain** = gain source · **Chart** = chart source · **Snap** = snapshot dependency · **Cov** = coverage awareness · **Attr** = attribution awareness · **Legacy** = legacy fallback · **Drift** = known drift.

### 1.1 Investments page (the one converged screen — with cracks)

**INV-1 · InvestmentsWorkspace (composition root)**
- Purpose: owns fetch, display-FX, current↔historical pivot for the whole page.
- Entry: `components/space/widgets/investments/InvestmentsWorkspace.tsx:60` ← `useInvestmentsSpaceData` ← `GET /api/spaces/[id]/investments/space-data` ← `loadInvestmentsSpaceData` (`lib/investments/space-data.ts:175`).
- Auth: **CANONICAL** — `current` = `getCurrentPositions`, `historical` = A10, never cross-derived.
- Qty/Px: A10 → `PositionObservation` replay + price archive. Val: `getCurrentPositions`.
- Gain: delegated to hero. Chart: `series` field (see INV-3). Snap: indirect via `series` only.
- Cov: ✅ `unvaluedCount`, `ExcludedDisclosure`, `scopeDivergence`. Attr: passes `historical.attribution` down.
- Legacy: none (pinned by source-scan §5 of `space-data-historical.test.ts`).
- Drift: **the authority pivot is a period conditional in the view** — `historicalMode = asOf < today && data.historical != null` (`:87-88`); `figureLabel` is trust(A10)-derived while the figure it labels is `current`-derived at `asOf === today` (`:115`); on fetch error, stale data renders under the new `asOf` heading (hook keeps last-good, error path unreachable, `useInvestmentsSpaceData.ts:82` + workspace `:98`).

**INV-2 · InvestmentsHero (headline + period change)**
- Entry: `InvestmentsHero.tsx:31`.
- Auth: **MIXED** — figure = `primary.portfolio.valuedSubtotal` (current-authority at today); delta = `attribution` (A10) via `heroComparison`.
- Gain: `heroComparison(attribution)` when present; **fallback branch computes `(change / opening) * 100` ungated** (`:57-63`) from `reconciliation` — the pre-fix expression, reachable whenever `attribution` is null.
- Cov: valued/total stated inline (`:92-102`) — but as hand-rolled JSX, not `valuedOfTotalLabel` (`investments-trust.ts:70`), reintroducing the drift that helper was written to prevent.
- Attr: ✅ (gated branch). Legacy: the reconciliation-only fallback. Snap: none.
- Drift: **`attribution` is not display-FX-converted** (fault #4) — delta rendered in source currency under display-currency symbol; figure and delta cross-authority at `asOf === today` so `headline − change ≠ opening`; `compareLabel` from `reconciliation` while amount from `attribution` (`:82`); renders the `asOf` prop, never `data.*.asOf` (`:97`).

**INV-3 · InvestmentsBalanceHistory (the portfolio chart)**
- Entry: `InvestmentsBalanceHistory.tsx:23`; series `lib/investments/portfolio-series.ts:55` over `getRecentSnapshots(1100)`.
- Auth: **LEGACY-BASIS** — deliberately *not* A10: value = `SpaceSnapshot.totalInvestments + totalCrypto`.
- Qty/Px: whatever wrote the snapshot columns (mixed A8/balances/backfill — fault #1). Snap: total.
- Chart: shared `TrendChart` (gap detection = local median-spacing heuristic ×3, `TrendChart.tsx:141`; no interpolation ✅). Window clipping done in the view (`:36-42`).
- Cov: estimated/gap treatment ✅; **attribution-blind** — a period the hero refuses to attribute still draws a confident line.
- Drift: the five mechanisms — **M1** bucket vs valuedSubtotal (unvalued remainder inside the line, outside the hero); **M2** scope `all` vs `detailEligible`; **M3** last point balance-derived, earlier points valuation-derived, drawn as one continuous run; **M4** no point guaranteed at `asOf`/`compareTo` while the subtitle prints the *requested* window (`:44-46`); **M5** series re-converted at the single `asOf` rate over rows stamp-converted per-date (`portfolio-series.ts:78-91`); plus the currency label taken from `data.current.reportingCurrency` without verifying it equals the stamp target (`space-data/route.ts:71`).

**INV-4 · InvestmentsBridgeCard + investments-bridge.ts ("This period" waterfall)**
- Entry: `InvestmentsBridgeCard.tsx:23`; model `investments-bridge.ts:69`.
- Auth: **CANONICAL** — A10 reconciliation + flows + attribution; the only surface that refuses to render when NOT_ATTRIBUTABLE (`:87-105`) ✅.
- Gain: in/out grouping re-derived in the presentation model (`:110-111`) with a runtime identity `throw` (`:125-130`) — arithmetic-with-invariant living in `components/`.
- Drift: **partial/not-attributable branch renders `attribution.*` unconverted** (same root cause as fault #4) while the reconciled branch renders converted `reconciliation.*` — the same card flips denomination by state; local caveat inference (`:132`); `flows == null` fallback collapses gross flows to net (`Math.max/min(netExternalFlows, 0)`), changing meaning silently.

**INV-5 · InvestmentsActivityCard**
- Entry: `InvestmentsActivityCard.tsx:24`; model `investments-activity.ts:71`.
- Auth: CANONICAL values (`historical.flows`) — but read via `historical.flows`, not the contract's `activity` slice (two access paths to one object).
- Drift: the money-in/out grouping (`contributions + transfersIn` / `withdrawals + transfersOut`) is a **second copy** of the bridge's rule (`investments-activity.ts:87,96` vs `investments-bridge.ts:110-111`), kept in sync by comment.

**INV-6 · HoldingsLedger (holdings table)**
- Entry: `HoldingsLedger.tsx:31`. Auth: CANONICAL rows (`primary.holdings`).
- Cov: partial — unvalued em-dash, tier dot, staleDays, conflict icon. Attr: none.
- Drift: "Top by value" = DTO sort by `reportingValue` desc with unvalued last (`:48`) — a large *unvalued* position is silently ranked below every valued one; share clamp renders unvalued as 0-length bar indistinguishable from 0-weight (`:142`); local `overallTier !== "observed"` test duplicated outside `OBSERVED_TIERS`.

**INV-7 · HoldingDetail (per-holding "Performance")**
- Entry: `HoldingDetail.tsx:33`.
- Gain: **the only per-holding return computation in the app, and it lives in a component** (`:44-48`): `costBasis/quantity`, `nativeValue − costBasis`, `(vsCost/costBasis)*100`. No lib authority, no completeness gate (an `estimated`-tier row gets a confident colored %), no attribution gate.
- Drift: A10 rows carry no `costBasis`; `holdings-util.ts:19-22` reads it via an untyped cast, so the cost block silently vanishes in historical mode with no explanation — and becomes a live footgun (current cost basis differenced against reconstructed value) the day A10 carries the field.

**INV-8 · InvestmentAllocationPanel + AllocationSliceDetail + HoldingsConcentration (asset allocation)**
- Entry: `InvestmentAllocationPanel.tsx:59`, `AllocationSliceDetail.tsx:29`, `HoldingsConcentration.tsx:46`.
- Auth: **MIXED** — the contract already carries server-computed, display-converted `current.allocation` (`space-data-core.ts:122`, `display-conversion.ts:97-108`); **all three components ignore it** and recompute `computeAllocation(holdings, accountNames)` client-side (twice), with a *different* accountNames source than the server (`accounts` prop vs `resolveAccountNames`).
- Drift: **four independent share derivations on one page** — server `share`, client `computeAllocation`, `BreakdownWidget`'s `value/total` (the adapter deliberately drops `share`, `InvestmentAllocationPanel.tsx:55-57`), and `AllocationSliceDetail`'s `(sliceValue/valuedTotal)*100`; converted-then-summed vs summed-then-converted float drift; Concentration discloses **no unvalued remainder at all** — a portfolio whose largest holding is unpriced reads "Diversified"; negative slices render `0% of slice` (`AllocationSliceDetail.tsx:103`).

**INV-9 · InvestmentConnectionsCard**
- Entry: `InvestmentConnectionsCard.tsx:93` ← `GET /api/spaces/[id]/investments` ← `getInvestmentAccountsView` ← `countCurrentPositionsByAccount` (canonical wrapper).
- Auth: CANONICAL for counts. Drift: the DTO's `totalValue` = raw account balance sorted as if it were position value (`current-holdings.ts:103,110-112`) — unrendered today, a live seam; stale "legacy read model" header comment.

**INV-10 · useInvestmentsSpaceData + /space-data route (server loader)**
- Entry: `useInvestmentsSpaceData.ts:51`; `app/api/spaces/[id]/investments/space-data/route.ts:40`.
- Auth: CANONICAL composition — computes nothing ✅.
- Drift: `series` bolted onto the response **outside the `InvestmentsSpaceData` contract** (`route.ts:71-72`) — bypasses the assembler, the display-conversion exhaustiveness guarantee, and gets its own converter with the **opposite** FX-miss policy (drop vs keep-flagged); window-validity rule (`compareTo < asOf`) duplicated in hook and route.

### 1.2 Net Worth / Wealth perspective

**WLT-1 · WealthWorkspace (composition root)**
- Entry: `components/space/widgets/wealth/WealthWorkspace.tsx:71`.
- Auth: **CANONICAL** — `computeWealthTimeMachine` over shared host snapshots, `convertWealthSnapshots` upstream ✅.
- Qty/Px: none — persisted snapshot columns (inherits fault #1 wholesale). Val: nearest snapshot ≤ asOf — never live balances, even at today.
- Cov: ✅ tier/coverageFrom/backfill state. Attr: component drivers only (explicitly disclaimed).
- Drift: FX incompleteness grafted on from **live** `classifyAccounts(accounts).unconverted` (`:129-132`) — a live-account fact on a historical envelope; local display-currency fallback chain (`:108`).

**WLT-2 · WealthHero**
- Entry: `WealthHero.tsx:36`. Auth: CANONICAL (`asOfState`, `deltas`).
- Drift: at `asOf = today` before the snapshot job runs, shows **yesterday's** net worth while the Overview `net_worth` card shows today's live balances — two "now" numbers in one session; `DeltaBadge` exact-zero rule vs authority's `WEALTH_EPSILON = 0.5` (a +$0.30 move renders as a signed delta but appears in no driver row); header promises rows that don't exist.

**WLT-3 · WealthTrendChart**
- Entry: `WealthTrendChart.tsx:30`. Auth: CANONICAL (`chart.points`, shared `TrendChart`) ✅.
- Drift: `chart.compareSeries` — the prior-period overlay the authority computes — is **never rendered** (dead honesty machinery); local metric shadow-state can desync hero/chart.

**WLT-4 · WealthChangeLedger ("what moved it")**
- Entry: `WealthChangeLedger.tsx:44`. Auth: CANONICAL values (`drivers`, `deltas`).
- Drift: the metric→components partition (a reconciliation identity) lives in a presentation constants file (`wealth-metric-facets.ts:49-54`), not the authority; `liquidNetWorth = cash − liabilities` invariant maintained by comment in two files; renders unconditionally with a static "attribution arrives later" note while `period-attribution.core.ts` now exists — Investments and Wealth have **opposite honesty postures** for the same question.

**WLT-5 · WealthCompositionCard + Detail**
- Entry: `WealthCompositionCard.tsx:69`.
- Auth: **MIXED by mode** — class mode = snapshot composition ✅ ("Current classification" labels on live modes ✅); institution/account/concentration/debt/liquidity modes = live `FinancialAccount.balance`.
- Drift: `real` is a clamped residual (`Math.max(0, totalAssets − cash − inv − crypto)`) that silently absorbs any writer disagreement or excluded-FX magnitude; detail-panel shares divide by a locally-reduced live `totalAssets` — a **different total** than the hero's `asOfState.totalAssets` on the same screen; `driverGood` duplicated verbatim from the ledger.

**WLT-6 · WealthExplanationCard**
- Entry: `WealthExplanationCard.tsx:21`. Auth: CANONICAL sentence.
- Drift: the ">50% of net change" dominance clause is computed in the view (`:45-51`) and always divides by `deltas.netWorth` even when the user is on Assets/Liabilities/Liquid.

**WLT-7 · Shell trust envelope (PerspectiveShell / ShellTrustRow)**
- Entry: `PerspectiveShell.tsx:193`; `lib/perspectives/envelope.ts:338`; Investments branch reads `buildInvestmentsTrustSummary` ✅.
- Drift: Wealth evidence rows always list **net worth** regardless of selected metric (`envelope.ts:198-202`); `sync-incomplete` appliable at two seams; **`WealthResult.basis` — the one disclosure that would explain the today-vs-history basis seam — has zero consumers.**

**WLT-8 · TimelineLens / shell time state (the opening boundary)**
- Entry: `usePerspectiveShellState.ts:78`; reducer `lib/perspectives/time-range.ts:109-127` — the period-preset conditional lives **correctly** in an authority ✅.
- Drift: `earliestDefensibleDate` computed in the host as `snapshots?.find(s => !s.fxMiss)?.date` (`SpaceDashboard.tsx:420-423`) — a coverage floor derived in presentation, on an unasserted sort order; preset re-inference duplicated in the host (`:456-460`).
### 1.3 Dashboard, Overview sections, launcher (the legacy generation — still live)

**DSH-1 · SpaceTrendHero (Overview hero cards)**
- Entry: `components/dashboard/widgets/SpaceTrendHero.tsx:66`; series built in host `SpaceDashboard.tsx:615-616`; metric selectors `lib/space-hero.ts:42-108`; loader `GET /api/spaces/[id]/snapshots`.
- Auth: **NONE** — raw `Snapshot[]` + per-category selector lambdas.
- Qty/Px: whatever wrote snapshot columns. Val: last snapshot row (up to 1 day stale vs the section card beside it).
- Gain: **local** — private "nearest ≤ (today − 30d), else `points[0]`" opening rule with its own label (`:96-106`), independent of the shell's `compareTo` and of `nearestOnOrBefore`.
- Chart: recharts AreaChart — `type="monotone"` **interpolates across gaps**; no estimated/reconstructed distinction.
- Snap: all columns via lambdas — including `totalInvestments + totalCrypto` for INVESTMENT/RETIREMENT, restating the `portfolio-series.ts:64` bucket rule.
- Cov: length checks only. Attr: none. Legacy: **yes — the pre-Perspective hero, still the default Overview lede.**
- Drift: **CURRENCY MASQUERADE** — points are raw stamped magnitudes but labelled `heroCurrency={effectiveDisplay}` (the "view as" override, `SpaceDashboard.tsx:1054` + `PersonalDashboard.tsx:67`): a SGD view of a USD Space renders USD magnitudes with S$; fxMiss filter is a host-side copy (`:616`); 30-day delta disagrees with WealthHero's shell-window delta by design.

**DSH-2 · Emergency-fund headline override**
- Entry: `SpaceDashboard.tsx:635-646`. Auth: none.
- Drift: `months = latestSavings / monthlyExp` computed in the host (a third copy of this ratio — also `SectionRegistry.tsx:730-732`, `SpaceDashboard.tsx:710-713`), labelled with the override currency (same masquerade).

**DSH-3 · `net_worth` section card**
- Entry: `SectionRegistry.tsx:320-359`. Auth: `classifyAccounts` over live balances — **not** `getCurrentPositions`.
- Drift: for any Space with investment/crypto accounts, this Σ-balances number can differ from `valuedSubtotal` by unvalued positions, stale sync, brokerage-cash handling, crypto scope — undisclosed.

**DSH-4 · NetWorthChart + NetWorthChartModal (`net_worth_chart` section)**
- Entry: `SectionRegistry.tsx:435-488`; `components/charts/NetWorthChart.tsx:66`; `NetWorthChartModal.tsx:92`.
- Auth: **NONE** — raw snapshots. Chart: recharts, **period-preset conditional in presentation** (`cutoffForInterval`, `NetWorthChart.tsx:50-57`: `if (interval === "YTD") …`), local `new Date()` window, independent of the shell `asOf`.
- Drift: **does not filter `fxMiss`** (every authority-side reader drops or flags them) — can plot native magnitudes beside converted ones; modal plots `c.native.amount` on a rate miss while the chart passes `null` — two policies in sibling files; modal drops the reconstructed badge the chart shows.

**DSH-5 · AllocationChart (`allocation` section)**
- Entry: `SectionRegistry.tsx:490-510`; `AllocationChart.tsx:56`. Auth: `classifyAccounts` inputs, local math.
- Drift: local denominator mixes assets + `Math.abs(debt)` (re-doing `amountOwed`'s job with a different rule); loses the `estimated` flag the adjacent card renders as `≈`.

**DSH-6 · `investment_summary` / `investment_allocation` / `retirement_accounts` sections**
- Entry: `SectionRegistry.tsx:400-426`, aliases `:573-575`.
- Auth: **NONE — the most divergent investment number in the app.** Private filter `a.type === "investment"` + Σ balances: crypto silently excluded (unlike every bucket rule elsewhere), no unvalued disclosure, no trust chip — on the same product as the A10 hero.
- Legacy: three-way alias; `implemented: false` in `widget-registry.ts:671,707,733` is **not enforced** — `SectionCard.renderBody()` (`SectionCard.tsx:180-182`) never reads the flag, so "unimplemented" widgets render live money.

**DSH-7 · `retirement_progress` section**
- Entry: `SectionRegistry.tsx:763-800`. Auth: none.
- Drift: a full FV compounding model (`projectFV`, `:301-315`) with hard-coded 7% default return + on-track verdict, implemented inline in the section registry.

**DSH-8 · `debt_history` section (legacy twin of DebtBalanceHistory)**
- Entry: `components/space/widgets/debt-perspective-adapters.tsx:288-338`.
- Auth: none. Gain: local `points[last] − points[0]` over a hard-coded `slice(-24)` window ("over N snapshots"). No fxMiss filter, no isEstimated treatment. Still registered (`SectionRegistry.tsx:544`) alongside the canonical `DebtBalanceHistory` — two different debt stories live simultaneously.

**DSH-9 · Wealth-adapter sections (`wealth_by_account`, `institution_allocation`, `asset_allocation`, `wealth_concentration`)**
- Entry: `components/space/widgets/wealth-adapters.tsx:159-645`.
- Auth: partial `classifyAccounts`; own `inDisp` FX rule (miss ⇒ contribute **0**).
- Drift: **an entirely independent HHI implementation** (`hhi = Σ(v/total)²`, `:612`) with different bands (0.25/0.15, no top-weight clause) than `lib/investments/concentration.ts:51-59` — "Well diversified" on Wealth and "Concentrated" on Investments can be simultaneously true; two renderers are self-described "TEMPORARY EXPERIMENT" wired into the live registry (`SectionRegistry.tsx:517-526`).

**DSH-10 · Spaces launcher cards (SpacesClient)**
- Entry: `components/dashboard/SpacesClient.tsx:353,440-462,560-580`; loader `getSpaceNetWorthSummaries` (`lib/data/snapshots.ts:146-212`).
- Auth: **NONE.** Val: last convertible snapshot, `?? 0` — if the last 14 rows are all fxMiss-dropped, **a fabricated $0 renders as the Space's figure**.
- Gain: local `((last − first)/|first|)*100` over a hard-coded `slice(-14)` window (`:346-351`).
- Drift: **category-mislabelled metric** — cards print "Portfolio Value"/"Equity"/"Balance" over a number that is always `SpaceSnapshot.netWorth`, contradicting `lib/space-hero.ts`'s per-category column mapping; `isEstimated` not even selected — reconstructed history indistinguishable; its % disagrees with DSH-1's for the same Space (14 rows vs 30 days).

### 1.4 Liquidity & Debt (investment-value consumers)

**LIQ-1 · Liquidity splice engine**
- Entry: `GET /api/spaces/[id]/liquidity/space-data` → `lib/liquidity/space-data.ts:95` → `getAccountsAsOf` + `getInvestmentValueAsOf({visibilityScope: "all"})` → `spliceLiquidityRows`.
- Auth: CANONICAL valuation call — but with a **third option profile**: scope `all` (vs A10 `detailEligible`), **no `holdConstantBeforeEarliest`** (vs A9/A10 `true`). Same date, three answers.
- Drift: foreign cash converted at *today's* rate on historical dates (documented, `space-data.ts:26-31`) while A9/backfill convert per-date; pre-floor accounts contribute hard `0` with tier `incomplete` — the "0 = no coverage" and "0 = nothing" conflation; hero delta (workspace `pts[0]` local math, `LiquidityWorkspace.tsx:203-207`) is snapshot-basis while `LiquiditySpaceData.delta` is lens-basis — two liquidity changes for one window.

**LIQ-2 · Debt surfaces**
- `lib/debt/**` consumes SpaceSnapshot only (`clipDebtHistory` reading `totalDebt`); no investment values. Debt as-of via `getAccountsAsOf`. Drift is confined to the window-clip family (see §3) and DSH-8.

### 1.5 AI context, Daily Brief, exports, cached models

**AI-1 · AI holdings assembler (`holdings_summary`)**
- Entry: `lib/ai/assemblers/holdings.ts:154`; shaper `holdings-core.ts:141`.
- Auth: **MIXED** — canonical reads (`getCurrentPositions` + `getInvestmentValueAsOf('all')` + legacy crypto bridge), local reductions.
- Qty/Px: none (today only). Gain: refused (costBasis received and discarded).
- Cov: **re-derived** — `current.portfolio` (coverage/completeness/tiers) is dropped at `holdings.ts:184`; unvalued recounted over FULL rows only ⇒ **understates the unvalued remainder on shared Spaces**; trust prose re-authored (third author of the caveat sentence); no `figureLabel` gate — a partial subtotal presented as the whole.
- Legacy: `readLegacyCryptoWalletPositions` (Holding table), deduped ad hoc.
- Drift: two valuation instants in one total (spine at `todayIso()`, crypto at `yesterdayUTCISO()`, own conversion context — `holdings.ts:109-124`); concentration weights recomputed locally; `investments-trust.ts:17-19` names this file as the un-converged fourth surface.

**AI-2 · AI snapshot assembler (`snapshot_history`) — the B2 surface**
- Entry: `lib/ai/assemblers/snapshot.ts:135`.
- Auth: read path CANONICAL (`getRecentSnapshots(90)`); reductions local.
- Gain: local first-vs-last over 90 **rows** (`:108-113`) — no flow separation, no coverage gate; the signal detector prints it as "over N **days**" with hardcoded `$` (`signals/detectors/snapshot.ts:77,97`) — a mislabeled unit laundered into the prompt as a source number.
- Cov: `estimated`/`excludedFxMissPoints` computed, **never serialized into prose**; no gap/span awareness (90 sparse rows ≡ 90 days in the payload).
- Drift: `resolveStampContext` can silently revert to USD while the serializer asserts the Space's reporting currency for all totals (`context-serializer.ts:89-93`) — history can be USD under an EUR label.

**AI-3 · AI accounts assembler — the de facto AI net-worth authority**
- Entry: `lib/ai/assemblers/accounts.ts:123`.
- Auth: **NONE** — local `classifyAccounts` over raw links; `totalInvestments` = Σ account balances.
- Drift: the exact two figures `scope-divergence.ts` exists to reconcile appear **in the same prompt** (`accounts.totalInvestments` beside `holdings.totalPortfolioValue`) with no reconciliation note — and `investmentsScopeDivergence()` is consumed only by the Investments workspace, never by AI/Brief.

**AI-4 · Assessment engine + serializer**
- Entry: `lib/ai/intelligence/annotations/engine.ts:47`; `assessment-serializer.ts`.
- Drift: `snapshotSpanDays: snapshotCount` (`engine.ts:107`) — **a row count assigned to a days field**, then used to gate transaction-history confidence (cross-domain proxy) and printed as "N-day history"; investment readiness = domain presence only; for PERSONAL/BUSINESS/HOUSEHOLD Spaces the prompt says "no holdings data" while reporting non-zero `accounts.totalInvestments` — **self-contradictory prompt**.

**AI-5 · Domain manifest + serializer (structural)**
- `HOLDINGS_SUMMARY` mapped only to INVESTMENT/RETIREMENT (`domain-manifest.ts:125-126`) — for most Space types the canonical investment authority is **never called by the AI at all**; domains are serialized as raw JSON blobs (`context-serializer.ts:502-508`); every provenance/window disclosure is inside `if (txn)` — the model gets exact transaction bounds and **nothing** about snapshot/holdings bounds, coverage, or FX state.
- KD-16 confirmed in code: window re-derived per turn by re-classifying message history (`message-analysis.ts:106-125`), threaded **only** to transactions — "net worth in March?" narrows transactions to March and leaves snapshots at last-90-rows, holdings at today, under a single asserted "analysis window".

**BRF-1 · Daily Brief (`GET /api/brief`)**
- Entry: `app/api/brief/route.ts:463`; rebuilds N Space contexts per page view (no cron, no cache).
- Auth: inherits AI-1/2/3 wholesale; touches no wealth/portfolio/trust authority.
- Drift: **"Since yesterday" section renders the full-window 90-row trend** — the honesty exists only in a code comment (`:151-154`); headline = accounts-domain live net worth beside a snapshot-domain delta ("up $X, now $Y" where Y−X is the opening of nothing); `fmtCurrency`/`fmtDelta` hardcode `$` (`:63-73`); local composition ratios and savings rate (`:317,408-410,436-437`); failed Spaces silently dropped with no payload field to disclose (KD-8 class); cross-Space signals lose their Space name at render; snapshot count printed as days again (`:401`).

**BRF-2 · Cached AI advice (`AiAdvice`) — orphaned presentation model**
- Entry: `route.ts:600-606`, rendered with highest precedence at `:355-366`.
- Drift: **no production writer exists** (seed only; KD-14) — yet served unconditionally with no staleness check, no provenance: an arbitrarily old row presents as "Today's Insight". The only persisted/cached financial presentation model in the system, and it is authority-free.

**EXP-1 · Data export (`assembleUserExport`)**
- Entry: `lib/export/assemble.ts:70`.
- Auth: **CANONICAL** — `getCurrentPositions` + `getRecentSnapshots(all)` + crypto bridge merged disjointly ✅; unvalued kept as `null` never 0 ✅; costBasis exported ✅.
- Drift: `positions.portfolio` (coverage/completeness/conflict envelope) dropped — a conflicted portfolio exports as a flat row list; the FX-estimate note is unconditional prose, not driven by the rows' actual flags.

**ALR-1 · Alerts / notifications** — **no financial exposure** (`lib/alerts/authorities.ts:21-25` restricts to ops-health authorities). No drift; also no coverage-regression alerting (nothing notices stale snapshots, coverage drops, fxMiss spikes).

**CACHE · Cached presentation models** — none exist beyond `AiAdvice` (BRF-2). Every AI/Brief request rebuilds context from scratch.

### 1.6 Write side: snapshot producers, jobs, regeneration, scripts

**WRT-1 · `regenerateSpaceSnapshot` (today's row)**
- Entry: `lib/snapshots/regenerate.ts:99`.
- Auth: **LEGACY-BASIS** — `classifyAccounts` over `FinancialAccount.balance`; never calls anything under `lib/investments/**`.
- Snap: writes all totals; **`isEstimated` defaults false ⇒ today's row frozen against A9 forever.**
- Cov: none (only the investments-consent Part-B gate). Attr: none.
- Drift: fault #1 — the today/history basis seam, named verbatim by `scripts/diagnose-wealth-chart-gap.ts:19-21` and disclosed by the unrendered `wealthBasisDisclosure`.

**WRT-2 · `regenerateWealthHistory` (A9)**
- Entry: `lib/snapshots/regenerate-history.ts:172`.
- Auth: **MIXED, four sources per row** — investments via `getInvestmentValueForWindow({holdConstantBeforeEarliest: true, excludeDigitalAssetAccounts: true}` + default scope `all`); crypto via `nativeBalance × BTC/USD` held-constant (**BTC-only**; non-BTC crypto mis-valued or held flat); cash/cards via posted-only walk-back; real assets/loans held flat.
- Cov: ownership eligibility applied (**only here** — A10 never applies it, so A10 ≥ snapshot by the excluded-prehistory amount, unreconciled); the purpose-built `price-completeness.core.ts` (3-axis observed rule) and `representativeness.core.ts` are **not imported by the writer** — nothing structurally prevents a false `observed` beyond the valuation tier happening to come back non-observed.
- Attr: none in the writer (dispositions only).
- Drift: **the only read path that WRITES to the price archive** (acquires prices mid-regeneration, `:224-269`) ⇒ two runs over identical DB state can produce different rows, and **dry-run ≠ apply**; `holdConstant` widens the observation read to unbounded history on the cron path (`valuation.ts:261`).

**WRT-3 · `backfillSpaceSnapshots` (30-day new-Space backfill)**
- Entry: `lib/snapshots/backfill.ts:83`.
- Auth: cash walk-back + **investments/crypto held FLAT at today's balance for every historical day** — a third, mutually incompatible historical-holdings semantics, persisted `isEstimated: true`, never overwritten unless A9 is enabled and every guard passes.

**WRT-4 · `snapshot-amendment` (preview/apply)**
- Entry: `lib/snapshots/snapshot-amendment.ts:123,169`.
- Drift: **preview ≠ apply** — preview runs `dryRun: true` which skips price acquisition (V26-PRICE-5), apply acquires first; the user consents to a diff that is not the diff that gets written.

**WRT-5 · Jobs**
- `jobs/fetch-security-prices.ts:45` — canonical (PriceObservation insert-only; priceability via coverage-binding). ✅
- `jobs/sync-crypto.ts:46` → `btc-sync.ts` — **dual-writes** the same balance into `Holding` (legacy), `PositionObservation` (canonical), and `FinancialAccount.balance` — three stores, three semantics; A9 then values crypto by a fourth path.
- `jobs/sync-banks.ts:159` — ordering: investment-event ingestion runs **after** A9 regen in the same pass ⇒ each daily run regenerates from yesterday's event corpus (self-healing but undocumented at either site).
- Snapshot-write fan-out: 14 trigger sites (webhooks, token exchange, background history sync, crons, manual sync, wallet routes, share/disconnect/restore, build-intelligence, resume-sync) — with an ordering hazard in `backgroundHistorySync` (backfill before A9; either can silently no-op).

**WRT-6 · Reconstruction / capture / import writers**
- `reconstruction-runner/-core` (persists DERIVED observations; own backward-walk semantics — holds *today's* qty flat with no positivity guard, opposite anchor to valuation's earliest-qty rule), `position-capture` (OBSERVED rows incl. cash/no-ticker), `sync-current-holdings` (legacy `Holding` projection: skips cash/no-ticker — never matches the spine sum for the same account), `opening-position.ts` (USER_ASSERTED events/observations; **no snapshot regeneration triggered** by the route), `investment-import-*`.

### 1.7 APIs and server loaders (roster)

| Route | Serves | Authority verdict |
|---|---|---|
| `GET /api/spaces/[id]/investments/space-data` | envelope + series | CANONICAL + LEGACY-basis series in one payload |
| `GET /api/spaces/[id]/investments` | per-account cards | CANONICAL (counts) |
| `GET /api/spaces/[id]/snapshots` | 365-day series + backfill flag | CANONICAL read; **second local mid-sync check** diverging from `lib/spaces/sync-completeness.ts` (omits the deletedAt guard) |
| `GET /api/spaces/[id]/liquidity/space-data` | liquidity lens | CANONICAL calls, third option-profile |
| `GET /api/spaces/[id]/debt/space-data`, `/perspectives` | lenses | CANONICAL (no wealth lens exists) |
| `GET /api/brief` | daily brief | MIXED (see BRF-1) |
| `GET /api/user/export` | ZIP export | CANONICAL |
| `POST /api/spaces/[id]/wealth/amend` | history amendment | CANONICAL path, preview≠apply defect |
| `GET /api/money/view-context` | FX prefetch | CANONICAL |
| removed `/investments/time-machine` | — | dead re-export comment survives (`space-data.ts:77-79`) |
---

## 2. Semantic divergence matrix

Marks: **C** = CANONICAL (consumes the authority) · **L** = LEGACY (bypasses it) · **M** = MIXED (both / partial) · **U** = UNKNOWN/undisclosed basis · **–** = not applicable to this surface.

### 2.1 Interactive surfaces

| Fact | Inv Hero | Inv Chart | Holdings tbl | Alloc/Conc | Bridge/Activity | Wealth (hero/chart/ledger) | Wealth Compo | SpaceTrendHero | NetWorthChart | Sections (NW/inv_sum) | Launcher cards | Debt hist §  | Liquidity ws |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quantity | C | U (snapshot) | C | C | C | U | U/L | U | U | L (none) | U | – | M |
| prices | C | U | C | C | C | U | U/L | U | U | L (none) | U | – | M |
| valuation | M (cur vs A10) | L | C | C | C | C (over L-written rows) | M by mode | L | L | L | L | L | M |
| opening value | M (gated + ungated fallback) | L (first point ≥ compareTo) | – | – | C | C (nearest ≤) | – | L (−30d local) | L (interval cutoff) | – | L (slice(-14)[0]) | L (slice(-24)[0]) | L (pts[0]) |
| closing value | M (cross-authority at today) | L (last row ≤ asOf) | – | – | C | C (≤ asOf) | M | L (last row) | L | L (live Σ) | L (`?? 0`) | L | M |
| historical timeline | – | L | – | – | – | C | C (class only) | L | L | – | L | L | M (splice) |
| gain | M | – | – | – | C | C | C | L (local delta) | – | – | L | L | L (two deltas) |
| gain % | M (ungated branch) | – | L (HoldingDetail local) | – | C | C (ungated by attribution) | – | – | – | – | L | – | L |
| attribution | C | **absent** | – | **absent** | C | L (drivers-as-attribution, disclaimed) | M | absent | absent | absent | absent | absent | L (txn-window panel) |
| completeness | M (re-authored JSX) | C (chart marks) | M | M/absent (Conc) | M (local inference) | C | C | L | L (partial) | L (FX-only) | **absent** | absent | M |
| chart continuity | – | M (median heuristic; basis seam undetected) | – | – | – | C (TrendChart) | – | L (monotone interpolation) | L (interpolates; no fxMiss filter) | – | L (sparkline) | L | C |
| coverage | C | U | C | M | C | C | C | L | L | absent | absent (fabricated 0) | L | M (0-conflation) |
| unsupported history | C (refusals) | absent | – | – | C | M (EMPTY_STATE >365d) | C (labels) | absent | absent | absent | absent | absent | M |
| unresolved events | C (conflict icon) | absent | C | – | C | – | – | – | – | – | – | – | – |

### 2.2 Derived & write-side consumers

| Fact | AI holdings | AI snapshot | AI accounts | Assessment | Brief | Export | A9 history writer | Today writer | Backfill | Amendment | Liquidity splice | fetch-prices job | sync-crypto job |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quantity | C (today only) | U | L (balances) | – | U/L | C | M (A8 + BTC-flat + held-flat) | L (balances) | L (today flat) | M (=A9) | M (no holdConstant) | C | M (triple-write) |
| prices | C | U | – | – | U | C | M (acquires mid-run) | – (none) | – (none) | M | C | C | M |
| valuation | M (2 instants, own FX) | U | L | – | L | C | M | L | L | M | M (3rd profile) | – | M |
| opening value | – | L (points[0]/90 rows) | – | – | L | – | – | – | – | – | – | – | – |
| closing value | M | L (last row) | L (live) | – | **L (mixed: live Y, snapshot ΔX)** | C | M | L | L | M | M | – | – |
| historical timeline | absent | M (rows≠days) | – | L (count-as-days) | L | C (raw rows) | M (writer) | – | L | M | M | – | – |
| gain | refused ✅ | L (ungated first-vs-last) | – | – | L | – | – | – | – | C (delta) | – | – | L (stored toFixed %) |
| gain % | – | L (own rounding) | – | – | L (re-rounded) | – | – | – | – | – | – | – | L |
| attribution | absent | absent | – | – | L (mislabeled window) | C (ids) | absent | absent | absent | C (per-day record) | – | – | – |
| completeness | L (re-derived, FULL-only count) | M (computed, unserialized) | L (FX only) | **L (count-as-days gate)** | absent + mislabeled | M (envelope dropped) | M (3-axis rule not consulted) | absent (frozen false) | M | M | M | C | – |
| chart continuity | – | – | – | – | – | – | M (skip-days leave stale neighbours) | M (frozen seam) | M | M | – | – | – |
| coverage | L | M | absent | L | absent | M | M (ownership only here) | absent | M | M | M (0-conflation) | C | – |
| unsupported history | L (own prose) | absent | absent | absent | absent | M | M (refusal dispositions, unexported) | absent | absent | M | M | – | – |
| unresolved events | dropped (`conflicted` discarded) | – | – | – | – | dropped | M | – | – | – | – | – | – |

**Reading of the matrix.** The only column that is CANONICAL nearly top-to-bottom is Export. The Investments page is canonical except at exactly its seams (figure/delta cross-authority, chart, allocation recompute, FX of attribution). Wealth is canonical *over legacy-written rows* — its honesty is bounded by fault #1. Everything in the Dashboard/sections/launcher generation, and everything in the AI/Brief generation past the B2 read path, is LEGACY or MIXED.

---

## 3. Duplicate calculations — implementations that can disagree

Condensed to the disagreement sets. (Full per-implementation expressions were verified in code; representative cites given.)

**3.1 Opening value — 11 implementations, 3 semantic families.**
Family A (valuation view at compareTo): `investments-time-machine-core.ts:350`, gated `period-attribution.core.ts:211`, hero fork `InvestmentsHero.tsx:59`. Family B (nearest snapshot ≤ compareTo): `wealth-time-machine.ts:215-218`. Family C (first point of a clipped/sliced window): Liquidity `LiquidityWorkspace.tsx:203`, Debt `DebtWorkspace.tsx:159`, `debt-perspective-adapters.tsx:311` (`slice(-24)`), launcher `snapshots.ts:206` (`slice(-14)`), AI `snapshot.ts:102` (90 rows), SpaceTrendHero `:99-104` (−30d lookback), Liquidity lens `space-data-core.ts:155`.
→ Wealth's "since ⟨date⟩" and Liquidity/Debt's "since ⟨date⟩" reference **different days and values on the same screen** whenever no snapshot lands exactly on `compareTo` (nearest-≤ vs first-≥-inside-window).

**3.2 Period gain / gain% — 20 sites, two sign conventions.**
`abs(denominator)`: `wealth-time-machine.ts:222`, `SpacesClient.tsx:351`, `ai/snapshot.ts:110`, `CashFlowWorkspace.tsx:196`. No-abs: `period-attribution.core.ts:247`, `InvestmentsHero.tsx:62`, `LiquidityWorkspace.tsx:206`, `DebtWorkspace.tsx:163`. → opposite-signed percentages for the same move on a negative opening, all rendered through the same `DeltaBadge`. Also: `heroComparison` recomputes `closing − opening` instead of reading `reconciliation.totalChange` (agrees today only by common derivation); `sync-current-holdings.ts:61` is the sole *stored* percentage (`toFixed(2)`), diverging from every live-computed one.

**3.3 Portfolio total / net-worth sum — 17 sites.**
The net-worth identity is written three times (`regenerate.ts:172-183`, `backfill-core.ts:316-327` — an admitted textual duplicate, `AllocationChart.tsx:89` with `Math.abs(debt)` instead of `amountOwed`) and asserted executably only in a diagnostic script. `valuePortfolioAsOf` excludes null values; `applyOwnershipEligibility` re-sums with `?? 0` (null ⇒ real zero) — two subtotals for the same day whenever an eligible holding is unvalued. Wealth re-derives `liquidNetWorth` from components instead of reading `netLiquid`; `real` is a clamped residual absorbing writer disagreement.

**3.4 Historical holdings / quantity as-of — 7 implementations.**
(1) `resolvePositionAsOf` (canonical); (2) `resolveHeldQuantity` + holdConstant (earliest-qty-backward, positive-only); (3) quantity-replay/authority (licensed segments; **mode=off**); (4) `reconstruction-core.walkQuantityAsOf` (today's-qty-backward, no positivity guard — conflict detection measured against a different projection rule than valuation uses); (5) `position-capture`; (6) `sync-current-holdings` (symbol-keyed, cash/no-ticker skipped, no date dimension); (7) held-flat (`backfill.ts:285`, `accounts-asof`, `regenerate-history.ts:515`). Also two copies of the "greatest institutionValue wins the tie" rule (`current-positions.ts:186-212` vs `valuation.ts:521-527`).

**3.5 Historical value as-of — 12 implementations**, headline pairs: A9(+BTC path) writes what V9/`getRecentSnapshots` read, with skip-days leaving stale values beside regenerated neighbours; live writer (balances) vs history writer (valuation) at the today boundary; on-spine vs off-spine crypto engines; `archive.ts:70-74` vs the in-memory `memoryPriceReader` (`valuation.ts:536-545`) — two nearest-price-within-floor scans.

**3.6 Chart series / timeline — 17 constructors, 4 FX-miss policies.**
For the identical rate miss on the identical Space: Wealth/Debt/Liquidity **drop** the day, Investments series **keeps it flagged**, `NetWorthChartModal` plots the **native magnitude**, section adapters contribute **0**. Four charts on adjacent tabs with four point counts from one rate lookup. Gap policy splits the same way: `TrendChart` breaks runs; every recharts chart interpolates straight through.

**3.7 Coverage / completeness — 19 sites, ≥5 vocabularies** (acquisition `CoverageState`, valuation `PortfolioValuationCoverage`, ingestion `EventStreamCompleteness`, snapshot 3-axis, presentation tiers) — deliberately non-comparable, with **no mapping**, and the two snapshot-specific ones absent from the write path. Two same-named `ownershipTier` functions (`ownership-eligibility.core.ts:86` vs `price-completeness.core.ts:131`). Two mid-sync checks (`lib/spaces/sync-completeness.ts:56` vs the snapshots route's inline copy). C5 vs C8: cash-excluded vs cash-included coverage ratios — a cash-heavy portfolio reads near-100% and NON_REPRESENTATIVE simultaneously.

**3.8 Attribution — 11 sites, 3 taxonomies.**
Investments: flows-vs-residual (gated, 8 refusal codes). Wealth: component deltas ("drivers", explicitly not attribution). Regeneration: its own 6-category taxonomy re-deriving axes locally instead of `summariseSnapshotEvidence`. Brief: pairs a snapshot trend with a live-balances "now". Liquidity "What Changed": transaction-window-relative-to-today while every sibling panel is asOf-relative — the slider moves one and not the other.

**3.9 Nearest-snapshot resolution — 10 implementations.**
`getSnapshotAsOf` **does not exist as a function** — it survives as prose. The shared primitive `nearest-on-or-before.ts` unified exactly the two copies it names; `reconstruction-core.ts:410` (hand-rolled), `snapshots.ts:206-207` (slice-last), `current-positions.ts:110` (SQL groupBy) are additional unlisted copies. The primitive's `maxStaleDays` ceiling is documented as consumer-less while prices *do* enforce a floor — "nearest ≤" is unbounded for positions/snapshots and bounded for prices, producing rows whose `quantityDate` and `priceDate` embed different staleness doctrines. Wealth resolves ≤ asOf over a 365-row window (>365d ⇒ EMPTY_STATE) while Investments resolves unbounded — same date, one surface says "no history", the other returns a valuation.

**3.10 Stocks+crypto bucket — 17 sites, one boolean flag.**
`valuedSubtotal` means *brokerage-only* in the snapshot writer (`excludeDigitalAssetAccounts: true`) and *brokerage+crypto* everywhere else (A10, AI, current, liquidity). The flag is a convention on a shared type — nothing in the type system distinguishes the two meanings (`valuation.ts:135-142` says "MUST set this" in a comment). The hero (crypto-in) sits above a chart (crypto via the BTC path) on the same screen. `space-hero.ts:69` restates the bucket sum outside `portfolio-series.ts`.

---

## 4. Semantic violations — financial reasoning in presentation code

Every occurrence found (file:line, ranked by consequence). "Presentation" includes components, section adapters, hooks, presentation models under `components/`, and AI/Brief serialization layers.

**Currency & FX**
1. `SpaceDashboard.tsx:615-616,1054` + `PersonalDashboard.tsx:67` — raw snapshot magnitudes labelled with the "view as" override currency (masquerade).
2. `display-conversion.ts:147-156` — `attribution` rides the spread unconverted (authority-side bug surfaced only in presentation).
3. `portfolio-series.ts:83-90` — a second converter, opposite miss policy, for a field outside the contract.
4. Four component-level FX-miss policies: `wealth-adapters.tsx:59` (`?? 0`), `SectionRegistry.tsx:271-274` (`?? 0` + estimated), `NetWorthChartModal.tsx:120-122` (native), `NetWorthChart.tsx:89` (null).
5. Local currency fallback chains: `WealthWorkspace.tsx:108`, `WealthCompositionCard.tsx:299,311`, `SpaceDashboard.tsx:328-333`. Brief hardcodes `$` (`brief/route.ts:63-73`).

**Gains / returns / percentages**
6. `InvestmentsHero.tsx:62` — ungated `(change/opening)*100` fallback.
7. `HoldingDetail.tsx:44-48` — per-holding cost-basis return in a component, no tier/attribution gate.
8. `SpacesClient.tsx:346-351`, `SpaceTrendHero.tsx:105`, `debt-perspective-adapters.tsx:311-313`, `LiquidityWorkspace.tsx:203-207`, `DebtWorkspace.tsx:159-163`, `CashFlowWorkspace.tsx:196`, `ai/snapshot.ts:108-113`, `brief/route.ts:401,408-410,436-437` — local deltas/ratios/savings rate.
9. `SectionRegistry.tsx:301-315,782-783` — FV compounding model + on-track verdict, default 7% return.
10. `WealthCompositionDetail.tsx:75,105,128`; `AllocationSliceDetail.tsx:46,103`; `BreakdownWidget.tsx:225,262,320,433` — share/percent re-derivations discarding canonical `share`.

**Opening/window/period selection**
11. `InvestmentsWorkspace.tsx:87-88` — the current↔historical authority pivot (`asOf < today`).
12. `NetWorthChart.tsx:50-57` (+Modal) — `if (interval === "YTD")` preset table in a chart file.
13. `SpaceTrendHero.tsx:96-106` — private −30d nearest-≤ opening + label.
14. `useInvestmentsSpaceData.ts:65` — window-validity rule duplicated with the route.
15. `SpaceDashboard.tsx:437-465` — preset re-inference + cash-flow period shadow state in the host.
16. `InvestmentsBalanceHistory.tsx:36-42` — window clip in the view (the same operation Wealth performs in its authority) — one of four clip implementations.

**Completeness / coverage inference**
17. `SpaceDashboard.tsx:420-423` — `earliestDefensibleDate = snapshots.find(s => !s.fxMiss)?.date` (coverage floor in the host, unasserted sort).
18. `InvestmentsWorkspace.tsx:115` — second author of the figure-label rule owned by `investments-trust.ts:209`.
19. `InvestmentsHero.tsx:92-99` — "N of M positions valued" as inline JSX (bypasses `valuedOfTotalLabel`).
20. `investments-bridge.ts:132`, `HoldingsConcentration.tsx:59`, `InvestmentAllocationPanel.tsx:93`, `debt-perspective-adapters.tsx:300`, `NetWorthChart.tsx:125`, `WealthWorkspace.tsx:129-132` — local completeness/renderability verdicts.
21. `holdings-core.ts:207` — `positionsPartiallyHidden` from an epsilon float comparison standing in for a knowable visibility fact.

**Thresholds / verdicts / identities**
22. `wealth-adapters.tsx:612,625-626,639-640` — HHI + bands + accent thresholds in a render function (parallel to `lib/investments/concentration.ts`).
23. `WealthExplanationCard.tsx:45-51` — >50% dominance clause (and against the wrong metric).
24. `wealth-metric-facets.ts:49-54` — the metric→component reconciliation identity in a presentation constants file.
25. `investments-bridge.ts:60,125-130` — EPSILON + a throwing identity assertion in `components/`.
26. `wealth-ui.tsx:30-64` — DeltaBadge exact-zero rule vs authority `WEALTH_EPSILON`.
27. Direction/"good news" rules restated seven times (`space-hero.ts:26`, `WealthHero.tsx:56`, `WealthChangeLedger.tsx:40-42,79`, `WealthCompositionCard.tsx:65-67` verbatim dup, `SpacesClient.tsx:378-381,646-648`, `SpaceTrendHero.tsx:122`).

**AI/Brief assembly layer (same class of violation, different tier)**
28. `holdings.ts:109-124` — own conversion context, two valuation instants summed.
29. `holdings-core.ts:154-198` — local portfolio totals, cash partition re-derivation, local concentration weights, three re-authored disclosure sentences.
30. `accounts.ts:233` — the AI's own net-worth build.
31. `engine.ts:107` + `assessment-serializer.ts:92,182` — count-as-days.
32. `signals/detectors/snapshot.ts:57-97` — computes the real span for gating, then prints row count as days with hardcoded `$`.
---

## 5. Canonical ownership table

One owner per financial fact. "Owner" = the only code allowed to compute it; everyone else consumes the object. Facts marked ⊕ have no owner today and must be created inside the target authority (§6).

| Financial fact | Owner (target) | Exists today at | Consumers (must never recompute) |
|---|---|---|---|
| Current holdings + valuation | `getCurrentPositions` | `current-positions.ts:87` ✅ | Investments page, AI holdings, Export, Connections counts, **Dashboard/section/launcher "current" numbers (must migrate)** |
| Historical holdings (qty as-of) | Quantity authority (`quantity-replay` via `decideQuantity`, mode=adopt) | built, `off` | valuation-core only; nothing else may resolve a quantity |
| Historical instrument value | `valueInstrumentAsOf` / `valuePositionRowsOverDates` | `valuation-core.ts:112` ✅ | A10, A9, splice — via their bindings only |
| Historical portfolio (as-of + compare + flows + reconciliation + attribution) | A10 `getInvestmentsTimeMachine` | ✅ | Investments page, AI, Brief, Reports — via HistoricalPortfolioView |
| Portfolio value **series** | ⊕ HistoricalValuationAuthority (one series builder with declared basis) | split: `portfolio-series.ts` (snapshot basis) vs A10 endpoints | Investments chart, hero — same object, same basis, or an explicit basis-seam disclosure |
| Opening / closing period values | `assessPeriodAttribution` + `buildReconciliation` | `period-attribution.core.ts:144`, `investments-time-machine-core.ts:350` ✅ | Hero, bridge, chart endpoints, AI period claims. **Delete all Family-C `points[0]` rules** |
| Gain / gain% (portfolio) | `heroComparison` gated by `mayShowReturnPercentage` | ✅ | every surface; **no local `(b−a)/a` anywhere** |
| Per-holding return | ⊕ (new, in lib, tier- and basis-gated) | none — lives in `HoldingDetail.tsx` | HoldingDetail |
| Net worth (current) | `classifyAccounts` — **with** position-spine investments once converged | `account-classifier.ts:271` | sections, AI accounts, snapshot writer |
| Net worth (historical + deltas + drivers + chart) | `computeWealthTimeMachine` | ✅ | Wealth surfaces, **SpaceTrendHero, NetWorthChart, launcher, Brief, AI snapshot reductions (must migrate)** |
| Snapshot as-of resolution | `nearestOnOrBefore` | `nearest-on-or-before.ts` ✅ | all ten current copies |
| Snapshot series read + FX stamping | `getRecentSnapshots` | ✅ | all — **with one shared fxMiss/estimated drop policy** |
| Snapshot writing (all rows incl. today) | A9 `regenerateWealthHistory` + a converged today-writer using the same valuation | **violated by `regenerate.ts`** | — |
| Snapshot write admission (observed claim) | `mayClaimObserved` (3-axis) + `assessRepresentativeness` | built, unwired | A9 writer |
| Price as-of | `priceArchive.readRange` semantics | `archive.ts:70` | valuation only (retire `memoryPriceReader` divergence by contract test) |
| Price coverage / priceability | `coverage-binding.core` | ✅ | jobs, acquisition planning |
| Event-stream coverage | `event-coverage.core` | ✅ | quantity authority |
| Crypto valuation | valuation-core over spine positions (one engine) | **violated by A9 BTC path** | A9, A10, AI |
| Trust / completeness prose | `buildInvestmentsTrustSummary` (+ Wealth `completeness`) | ✅ | UI chips, **AI/Brief/Export (must adopt)** |
| Scope divergence disclosure | `investmentsScopeDivergence` | ✅ | Investments UI, **AI/Brief (must adopt)** |
| Concentration | `lib/investments/concentration.ts` | ✅ | Investments + **wealth-adapters (delete local HHI)** |
| Allocation | server `computeAllocation` in the envelope | ✅ | panels/widgets consume `share`; no client recompute |
| Money-in/out grouping | ⊕ one helper in `investment-flows-core` | duplicated in bridge + activity | both cards |
| Display FX | `convertMoney` + per-domain display-conversion, **one shared miss policy** | 4 modules, 2 policies | all |
| Liability sign | `amountOwed` (`balance-semantics.ts`) | ✅ | AllocationChart (`Math.abs` copy must die) |
| Period window (`preset → asOf/compareTo`) | `shellTimeReducer` / `compareToForPreset` | ✅ | NetWorthChart intervals, SpaceTrendHero −30d, launcher slice(-14), AI windows (must adopt or disclose) |

---

## 6. Sheet-of-music proposal — `HistoricalPortfolioView`

One immutable object per (scope, period), assembled by one authority, consumed verbatim by every surface. Mapping to existing shapes:

```
HistoricalPortfolioView {
  period            // ONE canonical interval {fromISO, toISO, preset?} — today split across 5 shapes
                    //   (asOf/compareTo, reconciliation.from/to, attribution.fromISO/toISO, flows.from/to, wealth asOf/compareTo)
  opening           // {value, date, coverage, defensible} ← reconciliation + attribution merged; null only with a reason
  closing           // {value, date, coverage}
  historicalSeries  // [{date, value, basis, estimated}] — ONE series with a declared per-point basis
                    //   (snapshot-derived today; valuation-derived when the authority can afford it; the
                    //    today-boundary basis seam becomes a first-class point attribute instead of a silent step)
  coverage          // unified: valuation (PortfolioValuationCoverage) + price (CoverageState) + event
                    //   (EventStreamCompleteness) mapped into one consumer vocabulary
  attribution       // PeriodAttribution — REQUIRED, not optional; display-FX-converted like every money field
  gaps              // [{fromISO, toISO, reason}] ← QuantityTimeline.uncovered + CoverageReport.missingRanges
                    //   + snapshot holes — none of which reach any consumer today
  unsupportedReasons// ONE reason vocabulary unifying the six that exist (ATTRIBUTION_REFUSALS, trust
                    //   indicator keys, FALLBACK_REASONS, COVERAGE_REASONS, UncoveredReason, BACK_SOLVE_REFUSALS)
  gain              // = attribution.portfolioChange / unattributedChange; null carries a reason code
  gainPercent       // present ONLY when mayShowReturnPercentage; computed once, here
  valuationBasis    // portfolio-level rollup of per-row basisUsed (exists per-holding only today)
  quantityBasis     // portfolio-level rollup: OBSERVED_ANCHOR / REPLAYED / BACK_PROJECTED / HELD_FLAT
                    //   (exists in quantity-replay segments; collapsed to a 2-value tier before any consumer sees it)
  priceBasis        // RAW_CLOSE etc. + staleness envelope (enum exists in Prisma; hardcoded at every read)
}
```

Assembly: A10 already produces ~70% of this. The deltas are: make `attribution` required and converted; graft the series in **behind the contract** (not bolted onto the route response); surface `gaps`; unify the reason vocabularies; add the three basis rollups. `WealthResult` is the same pattern for net worth and needs: a real `coverage` object, an attribution verdict gating `WealthDelta.pct` (today ungated — asymmetric with Investments), and consumption of its own `basis` field.

**Consumption rule:** every UI surface, AI assembler, Brief section, and export row that states a historical portfolio fact reads it off this object. Nobody recalculates anything — no `points[0]`, no `(b−a)/a`, no local bucket sums, no local coverage prose.

---

## 7. Required migrations

Ordered inside §9; enumerated here by system.

M1. **Converge the today-snapshot writer** onto the valuation core (or write today's row `isEstimated`-equivalent basis-marked) — removes the frozen balance-basis seam. Requires a `basis`/`writerVersion` column on `SpaceSnapshot` (the failure mode is already named in `lib/prices/coverage-binding.ts:14-17`; the column doesn't exist).
M2. **Wire `mayClaimObserved` + `assessRepresentativeness` into A9's write decision** (currently diagnostic-only).
M3. **One crypto engine**: value spine crypto via valuation-core in A9; delete the BTC-only `nativeBalance × btcUsd` path; stop `btc-sync` dual-writing `Holding`.
M4. **Fix `convHistorical` to convert `attribution`**; extend the exhaustiveness test to every field of the result type (structural, not enumerated).
M5. **Delete the ungated hero fallback branch**; make `attribution` required on the A10 result.
M6. **Serve the series inside the contract** with declared basis; render the basis seam (adopt `WealthResult.basis` pattern) or converge the endpoints; guarantee endpoint points at `asOf`/`compareTo` or label the plotted range (the chart already prints real dates — the *subtitle* lies).
M7. **Allocation**: consume `current.allocation`/`share` everywhere; delete the three client recomputes and the adapter that strips `share`.
M8. **Per-holding return**: move HoldingDetail math into a lib authority with tier/basis gates.
M9. **Migrate Dashboard/sections/launcher onto authorities**: SpaceTrendHero + NetWorthChart(+Modal) + debt_history + launcher cards onto `computeWealthTimeMachine` (or a thin summary read model over it); `net_worth`/`investment_summary` sections onto `classifyAccounts`/`getCurrentPositions`; kill the "view as" masquerade by converting hero points through the display-conversion authority.
M10. **AI/Brief convergence** (the real B2): holdings assembler consumes `portfolio` + `InvestmentsTrustSummary` + `scopeDivergence` instead of re-deriving; snapshot reductions (trend, span) from `computeWealthTimeMachine`; fix count-as-days (3 sites) and hardcoded `$`; serialize snapshot/holdings windows + coverage the way transaction windows already are; Brief "Since last visit" either computes the actual since-window or labels the real one; emit `BriefBasis`; gate or retire `AiAdvice` precedence.
M11. **One FX-miss policy** for series across the four display-conversion modules; add the missing fxMiss filters (NetWorthChart, Modal, debt_history); replace fabricated zeros (`?? 0` sites, launcher `latest?.value ?? 0`) with honest absence.
M12. **Unify nearest-≤** onto `nearestOnOrBefore` (rewire D4/D8/D9; decide the staleness-ceiling question deliberately).
M13. **Amendment preview = apply** (preview must either acquire or disclose that apply will).
M14. **Quantity authority to `compare` in prod, then `adopt`** once the comparison ledger is clean — this is the in-flight repair; the bridge and ledger already exist.
M15. **Liquidity option profile**: reconcile `holdConstantBeforeEarliest` with A9/A10 or record the divergence as a deliberate, tested decision.
M16. Fix the snapshots route's local mid-sync check → `spaceHasSyncIncompleteProviderData`.
M17. Fire snapshot regeneration from `opening-position` writes; reorder event-ingest before A9 in `sync-banks` (or document the one-day lag at both sites).

## 8. Deletions

- `InvestmentsHero.tsx:57-63` fallback branch (post-M5).
- The three client-side `computeAllocation` calls + `share`-stripping adapter (post-M7).
- `legacy-crypto-holdings.ts` — its own deletion condition is satisfied; also the two ad-hoc dedups guarding its stale invariant (post-M3, after export/AI cutover).
- `Holding` writes from `btc-sync.ts:157`; then `sync-current-holdings`' `Holding` projection and `lib/data/accounts.ts:248 getHoldings()` (no production caller); then the `Holding` model itself.
- `wealth-adapters.tsx` local HHI + bands (`:591-645`); the "TEMPORARY EXPERIMENT" registry swaps or their shadowed originals (`SectionRegistry.tsx:517-526`).
- `debt_history` legacy section (`debt-perspective-adapters.tsx:288-338`) in favor of `DebtBalanceHistory`.
- `SpaceTrendHero`'s private opening rule + host fxMiss copies (post-M9).
- `investment_summary`/aliases renderer (post-M9) — or enforce `implemented: false` and let them fall back.
- Dead honesty machinery **or** its deadness: render or remove `WealthResult.basis`, `chart.compareSeries`; emit or remove `BriefBasis`; write or stop serving `AiAdvice` (KD-14).
- Stale prose: `space-data.ts:77-79` time-machine-route comment; `legacy-crypto-holdings.ts:16-20` invariant claim; `InvestmentConnectionsCard` header; `nearest-on-or-before.ts` two-copy claim; `WealthHero` header.
- One of the two `ownershipTier` functions; the route-local mid-sync check; `memoryPriceReader` (or pin parity by test).

## 9. Architectural guardrails (ratchets)

The codebase's enforcement idiom is source-scan tests + type-level `Equal<>` asserts (no custom ESLint). Extend that idiom; add lint only where it's structurally better.

R1. **Import bans (ESLint `no-restricted-imports` / boundary rule):** `components/**` may not import `valuation*`, `quantity-*`, `reconstruction-*`, `classifyAccounts`, `computeAllocation`, `computeConcentration`, or Prisma. Components consume `*View` objects only.
R2. **Expression tripwires (source-scan, the `space-data-historical.test.ts` §6 pattern):** the tokens `/ opening) * 100`, `* 100` adjacent to money-field subtraction, `.slice(-`, `points[0]`, `new Date()` for window math, `Intl.NumberFormat(` occurring under `components/**` fail the suite except in an enumerated baseline that may only shrink (Atlas palette-ratchet pattern with a baseline JSON).
R3. **Exhaustive display-FX**: replace the enumerated-field conversion test with a structural walker asserting every `number`-typed money field of `InvestmentsTimeMachineResult`/`HistoricalPortfolioView` differs after a known-rate conversion (this alone would have caught the `attribution` escape).
R4. **Single-writer snapshot guard**: source-scan that `spaceSnapshot.upsert|createMany` appears only in the A9 family; today-writer convergence pinned the way `regenerate-history.test.ts` pins its own binding.
R5. **One-series guard**: extend `InvestmentsWorkspace.test.ts` §3 to assert the series arrives *inside* the contract and that the route adds no fields to the JSON beyond it.
R6. **Nearest-≤ singleton**: the regex `date .?<=|lte:.*asOf` resolution idiom allowed only in `nearest-on-or-before.ts`, `archive.ts`, `fx/archive.ts`; all else must import the primitive (same one-file-owns-the-expression trick as §6 of the historical test).
R7. **Reason-vocabulary registry test**: a test importing all reason enums and asserting each maps into the unified `unsupportedReasons` vocabulary — adding a refusal code without a consumer mapping fails CI.
R8. **AI parity tests**: golden test asserting the AI holdings caveat strings are `===` the `investments-trust.ts` authors; assert `accounts.totalInvestments` is either spine-derived or accompanied by the scope-divergence disclosure in the serialized prompt.
R9. **Unit honesty**: type-brand `SnapshotCount` vs `DayCount` (or a scan for `snapshotCount` interpolated near the token "day") — kills the count-as-days class.
R10. **Bucket-flag ratchet**: extend `valuation.investment-bucket.test.ts` to enumerate *every* `getInvestmentValueAsOf|ForWindow` call site with its expected `excludeDigitalAssetAccounts`/`visibilityScope`/`holdConstantBeforeEarliest` triple — any new call site must register its profile.
R11. **Dead-honesty tripwire**: a test asserting every exported field of `WealthResult`/`InvestmentsTrustSummary`/`HistoricalPortfolioView` has ≥1 non-test consumer (import census), so disclosures can't silently go unrendered again.
R12. **`implemented: false` enforcement** in `SectionCard.renderBody()` + a test.

## 10. Ordered migration plan

Sequenced so each step shrinks the divergence surface without waiting on the quantity repair (which slots in at step 7).

1. **Stop the bleeding (correctness, no architecture):** M4 attribution FX + R3; M5 delete the ungated fallback; M11 missing fxMiss filters + fabricated zeros; M16 mid-sync check; count-as-days + `$` fixes (part of M10); M13 preview=apply. Small diffs, each independently shippable.
2. **One page, one truth (Investments):** M7 allocation consumption; M8 per-holding return authority; hero figure/label/delta single-sourcing (trust summary as the only author); M6 series-in-contract with basis field + rendered seam. Guards R2/R5 land with it.
3. **Snapshot spine honesty:** M1 today-writer convergence + `basis` column; M2 wire the 3-axis observed rule + representativeness into A9; M3 one crypto engine; M17 ordering. R4 lands here. This collapses fault #1 — after it, every snapshot consumer inherits one basis story.
4. **Legacy UI generation retired:** M9 dashboard/sections/launcher onto `computeWealthTimeMachine`/`classifyAccounts`; deletions (HHI, debt_history, experiments, masquerade); R1/R6/R12.
5. **AI/Brief convergence (finish B2):** M10 wholesale; R8/R9/R11. The Brief gets `BriefBasis` from the same object the UI trusts.
6. **`HistoricalPortfolioView` formalized:** fold §6 into the A10 result + Wealth equivalent; unify reason vocabularies (R7); period as one shape; gaps surfaced.
7. **Quantity/price authority adoption (the parallel repair merges):** M14 compare→adopt; `quantityBasis`/`priceBasis`/`valuationBasis` rollups populated from the replay segments; M12/M15 resolved deliberately; R10 finalized.
8. **Deletion wave:** everything in §8 not already gone; the divergence matrix re-run as a verification artifact — target state: every column reads C or a disclosed, tested M.

---

*End of audit. Nothing in this document was implemented; no code was modified.*
