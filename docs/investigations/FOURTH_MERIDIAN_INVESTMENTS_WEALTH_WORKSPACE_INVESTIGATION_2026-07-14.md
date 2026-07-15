# Fourth Meridian — Investments Perspective: "Wealth Workspace" Vision vs. Current Reality — Investigation

**Date:** 2026-07-14
**Type:** Investigation / architecture exercise only — no code written, no files modified.
**Branch inspected:** `feature/v2.5-spaces-completion` (working tree, via connected device), HEAD at time of writing.
**Mockup:** reviewed as direction-only (hierarchy/density/tone), not copied literally, per the brief.

---

## Headline finding (read this first)

**The redesign this brief asks to investigate has already shipped.** `docs/implementation-plans/FOURTH_MERIDIAN_INVESTMENTS_PERSPECTIVE_REDESIGN_IMPLEMENTATION_PLAN_2026-07-12.md` proposed exactly the "Portfolio Header → Holdings → Period Activity → Change Bridge → Connections" composition over the A10 Investments Time Machine. It is fully implemented, committed, and host-wired:

- Commit `188a69d` — *"feat(investments): S1–S5 — Investments Perspective composition over the A10 time machine"* — added `InvestmentsPerspective.tsx`, `InvestmentsHoldings.tsx`, `InvestmentsActivityCard.tsx`, `InvestmentsBridgeCard.tsx`, `InvestmentConnectionsCard.tsx`, `useInvestmentsTimeMachine.ts` (1,329 lines across 11 files, tests included).
- STATUS.md (§Current focus, line 54): *"Four Perspective redesigns — Cash Flow, Liquidity, Investments, Debt — ... all merged and all host-wired ... Investments and Debt merged from their worktrees (`36d4af5` + host-wire `b87ba7c`)."*
- Verified directly in the working tree: `components/dashboard/SpaceDashboard.tsx` imports `InvestmentsPerspective`/`useInvestmentsTimeMachine`, computes `investmentsActive`/`investmentsCompareTo`, calls the hook (`:2711–2713`), threads `investmentsResult` into the shell's completeness envelope (`:3299`), and renders `<InvestmentsPerspective … />` in a dedicated branch (`:3384–3398`). `lib/perspectives/envelope.ts` has a live `investmentsEnvelope()` case (no more stale "historical valuation arrives with the price foundation" placeholder). `lib/perspectives.ts`'s doctrine comment is current, not stale.
- `git status` shows none of this staged/uncommitted — it is settled history, not work-in-progress.

So the honest job here is not "can we build a Wealth Workspace" — it's: **what does the shipped page already deliver against the brief's vision, and what specifically remains** to move from "current holdings + one period's activity" toward the fuller "Portfolio / Performance / Allocation / Insights / Holdings / Timeline / Risk" workspace the mockup gestures at. Everything below is organized around that real gap, verified against the actual DTO, schema, and components — not assumed.

---

## Part 1 — Current architecture

**Rendering path.** `SpaceDashboard.tsx` (single-owner file, ~3,500+ lines) hosts a `PerspectiveShell` that owns `{preset, asOf, compareTo}` with URL sync (`usePerspectiveShellState`). When `activePerspectiveId === "investments"`, the host calls `useInvestmentsTimeMachine(spaceId, asOf, compareToForFetch, investmentsActive)` and renders `<InvestmentsPerspective result loading error onRetry accounts spaceId compareTo />`. This mirrors the Wealth/Cash Flow/Liquidity/Debt compositions — no widget registry, no schema-driven layout, no chart library (the Change Bridge is CSS bars, not a chart).

**Data path.** `GET /api/spaces/[id]/investments/time-machine?asOf=…&compareTo=…` (membership-gated, VIEWER+) → `lib/investments/investments-time-machine.ts` (binding) → `assembleInvestmentsTimeMachine()` in `investments-time-machine-core.ts` (pure assembly, no DB/clock/network — fixture-tested). It composes: an A8 valuation view at `asOf` (and optionally at `compareTo`), a period-flows summary, and an instrument display map. This is the "A10" backend the 07-12 plan describes as complete and independently tested (`investments-time-machine-core.test.ts`, `investments-time-machine.test.ts`, `investment-flows-core.test.ts`, `valuation-core.test.ts`).

**A second, older surface still exists and is intentionally kept**: `GET /api/spaces/[id]/investments` → `lib/investments/current-holdings.ts` — a current-state-only read model that carries connection-health affordances the A10 DTO does not model (`consent_required`, `needs_reauth`, `error`, `zero_holdings`, `lastSyncedAt`, per-account refresh). It now powers only `InvestmentConnectionsCard` (renders nothing when every account is healthy) rather than the primary holdings list.

**Ingestion.** Two paths feed the canonical investment models: Plaid sync (`lib/investments/plaid-investment-events.ts`, `sync-current-holdings.ts`) and CSV/manual import (`lib/imports/investments/*` — profiles for Schwab-style exports, generic CSVs, position statements; `lib/investments/investment-import-preview.ts` / `-commit.ts` / `-rollback.ts`). Both write into the same canonical `Instrument` / `PositionObservation` / `InvestmentEvent` tables, with a reconstruction engine (`reconstruction-runner.ts`, `reconstruction-core.ts`) that walks position history from PositionObservation + InvestmentEvent when a continuous quantity series isn't directly observed, honestly labeling `derived`/`incomplete`/`conflicted` rather than fabricating certainty.

**Design system.** The perspective renders through Atlas Glass primitives (`GlassPanel`, the shared `Panel` helper pattern also used by Wealth/CashFlow — a deliberately un-extracted local copy, third instance) — consistent with the rest of the redesigned Space surfaces.

---

## Part 2 — Existing capabilities already available (verified, not assumed)

### 2.1 Data already persisted

| Domain | Model(s) | Notes |
|---|---|---|
| Instrument identity | `Instrument` (cusip/isin/sedol, ticker, name, `assetClass` enum, `securityType`/`securitySubtype`, `currency`, **`sector`**, `industry`, status) | `country` is **not** a field anywhere on `Instrument` or its aliases — verified by grep across schema + `lib/investments`. |
| Position history | `PositionObservation` (per-instrument, per-account, per-date quantity + optional institution price/value/cost basis, `origin`: OBSERVED/IMPORTED/DERIVED/USER_ASSERTED) | Append-only; this plus `PositionReconstruction` is the A1/A5 foundation. |
| Investment transactions | `InvestmentEvent` (typed, dated, signed quantity/amount, fees, currency, full provider provenance, corporate-action shape, import/correction lineage) | This is the raw ledger a Timeline feature would read from directly. |
| Historical prices | Price Foundation (A8, `PriceObservation`-style append-only prices keyed by instrument) | Backs "real historical pricing" valuation at any `asOf`, not flat-held balances. |
| Portfolio-level daily value | `SpaceSnapshot.stocks` / `.crypto` (+ `netWorth`, `isEstimated`, `reportingCurrency`) — one row per Space per day | This is the **existing time series** a Performance chart could plot without new backend work (see 3.2 caveat). |
| Legacy current-state | `Holding` (symbol/quantity/price/value/`change24h`/isCash) | Superseded for valuation by A10; still the source for `current-holdings.ts` operational states. |

### 2.2 Existing calculations (verified in `lib/investments/*`)

- **Portfolio value / valuation** — `valuation-core.ts` (`InstrumentValuation`: quantity, native price/value, reporting-currency value, independent quantity/price/FX/overall completeness tiers, `basisUsed`, `priceDate`, `staleDays`, plain-English `reason`, `conflicted`). This already exists **per holding**, at any `asOf`.
- **Allocation-by-position (share of valued subtotal)** — `ValuedHoldingRow.share` (0..1), already computed and already rendered as the Holdings weight bar.
- **Daily / period return** — not literally "today's %"; the DTO instead supports arbitrary two-date comparisons via `compareTo`, which subsumes "1-day" as one special case (compareTo = yesterday).
- **Contribution vs. market return** — `investment-flows-core.ts` computes signed per-category subtotals (contribution/withdrawal/transfer in/out/buy/sell/income/reinvestment/fee/corporate_action/opening/unclassified) and a strict `netExternalFlows` (the four boundary categories only — fees/buys/sells/income are internal by doctrine). `investments-time-machine-core.ts` then reconciles `openingValue + netExternalFlows + residualChange = closingValue`, with the residual **honestly labeled**, never asserted as "market gain."
- **Realized gains** — not computed anywhere in `lib/investments`. No lot-matching / realized-P&L engine exists.
- **Unrealized gains / cost basis at the position level** — `PositionObservation.costBasis` exists as an **institution-reported aggregate** (Plaid holding-level), not a computed value; there is no cost-basis or unrealized-gain field in the A10 DTO. The 07-12 plan explicitly calls this "forbidden" to fabricate.
- **Dividend totals** — the `income` flow category exists and is already summed per period; it is not currently surfaced as its own labeled KPI (Activity groups it under "inside the portfolio" alongside buys/sells/fees), but the underlying number already exists.
- **Cash position** — `isCash` flag exists at both the legacy `Holding` level and via basis/valuation on cash-classified positions; the A10 flows/portfolio shapes can express a cash subtotal, though nothing today aggregates "cash as % of portfolio" as a first-class field.
- **Performance history (chart-ready time series)** — no dedicated "investments-only value over time" endpoint exists yet, but `SpaceSnapshot.stocks/.crypto` already **is** that series at the Space level (see gap analysis, §3).

### 2.3 Existing UI (audit)

The shipped `InvestmentsPerspective.tsx` composition:
- **Portfolio Header** — compact strip (not a hero, by deliberate doctrine: Wealth owns the big number). Shows valued subtotal, "as of / vs" dates, and a "{valued} of {total} positions valued" trust chip. Correctly labels the figure "Valued holdings" (not "Portfolio value") whenever any position is unvalued.
- **Holdings** — dominant panel; ranked table with weight bars, dimmed unvalued rows with plain-English reasons, and (per the plan's S2 slice) expandable trust detail (tiers, basis, price date, staleness, account).
- **Period Activity** — deterministic template sentences from the flow subtotals (no LLM), plus a caveat sentence built from unclassified/in-kind/missing-amount/FX-estimated counters.
- **Change Bridge** — exactly the mockup's waterfall concept, already built: opening → money in → money out → "Portfolio change" (residual, framed honestly, tap-in reason) → closing, rendered as CSS bars with a guaranteed row-sum identity (asserted in the pure helper + its test).
- **Connections** — conditional card, renders only accounts needing attention (consent/reauth/error/zero-holdings), reusing the existing `EnableInvestmentsButton`/`AccountRefreshButton`.
- **What's not here yet**: no tabs (Portfolio/Performance/Allocation/Insights/Holdings as separate views — today it's one scrolling composition), no price chart, no allocation donut, no insights feed, no top movers/worst performers, no upcoming-events calendar, no chronological timeline feed.
- **Mobile**: the grid literally collapses to a single column in source order (Header → Holdings → Activity → Bridge → Connections). This is desktop cards restacked, not a redesigned mobile-first hierarchy — a real, unaddressed gap against the brief's explicit ask.

---

## Part 3 — Capabilities that require no backend work (can build now)

These are genuinely reachable from data and calculations that already exist, using only new presentation/read code against tables and DTOs already in production:

1. **Performance chart (portfolio value over time, with ranges).** `SpaceSnapshot` already has one row per Space per day with `stocks`+`crypto` (+`isEstimated` honesty flag). A chart over 1M/3M/YTD/ALL is a query + a line chart component, not new data. **Caveat, stated honestly rather than glossed over:** `SpaceSnapshot.stocks/crypto` is the Wealth-timeline's reconstructed/backfilled balance series (flat-held historically for older rows), not the A10 engine's real per-instrument historical pricing — so this chart would show "your invested balance over time" at Wealth's precision, not a second, more-precise A10-grade replay. Labeling it consistently with Wealth's own existing `isEstimated` treatment avoids overclaiming precision. (An A10-grade version — calling the time-machine route at N historical dates — is possible but is N backend calls per chart render, not free; likely a future-vision item, not a "now" one.)
2. **Allocation by asset class.** `Instrument.assetClass` is a populated enum on every instrument; grouping the existing `ValuedHoldingRow[]` by `assetClass` and summing `share`/`reportingValue` is pure client/server presentation logic over data already in the DTO.
3. **Allocation by sector.** `Instrument.sector` is populated (provider-reported, "preserved not interpreted"); same grouping approach as above. Coverage will be uneven (sector is nullable and not populated for every asset type, e.g., crypto/cash) — an honest "sector unknown" bucket is required, not a silently-dropped slice.
4. **Allocation by account / currency / provider.** `financialAccountId` (→ account name via the host's existing `accounts` map), native `currency` on each holding, and `InstrumentAlias.provider`/`FinancialAccount.institution` are all already present on or reachable from the DTO/holdings.
5. **Allocation by country.** **Not available.** No country field exists on `Instrument` or any alias/position model. This one specific dimension from both the brief and the mockup ("International 3.1%") cannot be built without new data (see Part 4).
6. **Investment Intelligence / Insights — the subset the data actually supports:**
   - *Concentration* (largest single-position share, e.g., "31% of your portfolio is in TQQQ") — direct from `ValuedHoldingRow.share`, already computed.
   - *Cash allocation* — direct from summing cash-classified holdings' `share`.
   - *Diversification by sector/asset class* — direct from the same grouping as #2/#3 (e.g., "67% concentrated in one sector").
   - *Largest position* — trivially the top-ranked (already sorted) holdings row.
   - **Not supportable without new work:** "largest gain/loss" and "exposure increased X% this month" both require a **per-holding value delta across a comparison** — the 07-12 plan explicitly scoped this out of the DTO ("Per-holding value/weight deltas across comparison do not exist... OUT OF SCOPE... named future slice"), and it remains genuinely absent today. Any insight implying a specific holding's gain/loss must not be fabricated.
7. **Dividends as a first-class KPI**, distinct from the bundled "inside the portfolio" grouping — the `income` flow subtotal already exists; this is a presentation change to Period Activity / a header KPI, not new data.
8. **A chronological Timeline/activity feed** (distinct from the aggregated Period Activity subtotals) is buildable from `InvestmentEvent` rows directly (type, date, quantity, price, amount, instrument — everything a "Bought 2 shares of NVDA –$242.30 / Jul 10" row needs already exists on the model). This needs one new read function (no schema change), so it sits right at the "now" boundary — flagged here rather than folded silently into #1–#7 because, unlike those, nothing today exposes the raw event list (only the aggregated subtotals) — see Part 4 for why it's listed there instead as the more honest classification.
9. **A native mobile information hierarchy** for the existing panels (Header/Holdings/Activity/Bridge) — reordering/collapsing what's already rendered for small screens (e.g., holdings-first with activity/bridge behind a summary, rather than literal restacking) is pure front-end work against data already flowing through the composition.

---

## Part 4 — Capabilities that require backend work

1. **Country / geography allocation.** Requires adding a field to `Instrument` (or a new lookup keyed off CUSIP/ISIN/exchange metadata) and a population strategy (Plaid's security object doesn't reliably carry this; would likely need a reference-data join). Real backend work, not a query change.
2. **Per-holding gain/loss, cost basis (computed), and "Top Movers / Worst Performers."** All three need either (a) a lot-accounting engine (buy lots, realized/unrealized gain by FIFO/average-cost) that does not exist anywhere in the codebase today, or (b) at minimum a per-holding value delta across two dates, which the current DTO deliberately does not carry. This is real modeling work with real doctrine questions (which cost-basis method; how to handle corporate actions/splits already flagged as a `reconstruction` edge case) — not a quick add.
3. **Chronological Timeline feed as a first-class surface** (if scoped as more than "a new read function over `InvestmentEvent`" — e.g., with corporate-action-aware descriptions, dedupe against Plaid vs. import provenance, and pagination) is a small-to-medium backend slice: new query/route, no schema change, but real design decisions about what counts as a "timeline-worthy" event and how multi-source provenance is deduplicated for display.
4. **"Upcoming events" (earnings releases, ex-dividend dates, Fed rate decisions)** — shown prominently in the mockup — requires an entirely new data source (external market/calendar data), which is outside "durable investment facts" as currently scoped in this codebase (no `EarningsEvent`/`MarketCalendar` model exists, and no integration is wired for one). This is the single mockup element most at odds with the brief's own instruction not to invent backend work — it should be treated as future-vision at best, or dropped as out of character for a platform whose stated goal is deterministic intelligence over owned data, not general market-data aggregation.
5. **Risk metrics** (volatility, beta, drawdown, correlation) — none of the current `lib/investments` modules compute anything risk-statistical; this would require historical return series per instrument (which the A8 price foundation could theoretically feed) plus net-new statistical code. Real, non-trivial backend work.
6. **True A10-precision performance chart** (as opposed to the `SpaceSnapshot`-based approximation in Part 3 §1) would need either a persisted daily investments-only valuation snapshot (extending `SpaceSnapshot` or a new table) or accepting N on-demand time-machine calls per chart load — a real design decision, not a trivial change.

---

## Part 5 — Recommended information architecture

Given the shipped composition already embodies "Wealth owns the number, Investments owns what-you-own-and-what-happened," the recommended IA **extends** rather than replaces it:

- **Keep the single-page composition** (no tab navigation like the mockup's Portfolio/Performance/Allocation/Insights/Holdings top bar) for now — introducing tabs would be a bigger structural change than the data justifies today, and the existing Header/Holdings/Activity/Bridge/Connections page already reads coherently top-to-bottom. Reserve tabs for if/when a real Performance chart + Allocation + Insights are all shipped and the single page becomes too long.
- Insert two new panels into the existing grid, in priority order: **Allocation** (asset class / sector / account, honestly labeled by coverage) directly below or beside Holdings, and a compact **Insights** strip (concentration / cash / diversification sentences, in the same deterministic-template register as Period Activity — no LLM) near the Portfolio Header.
- **Performance chart** replaces or sits beside the Portfolio Header's static figure, using the `SpaceSnapshot`-derived series with an explicit `isEstimated`-style honesty marker for historical points, consistent with how Wealth already handles this exact tradeoff.
- **Timeline** becomes a distinct panel (not folded into Period Activity, which stays aggregate-only) once the new read function from Part 3 §8 exists — most naturally placed near or replacing Connections' vertical position, or as a "View all" expansion off Period Activity.
- **Top Movers, Risk, and Upcoming Events are explicitly deferred** — none are buildable without the backend work in Part 4, and Upcoming Events in particular does not clearly belong to this codebase's "durable, deterministic facts" doctrine at all.

---

## Part 6 — Recommended desktop layout

Extend the existing 12-column grid (`items-start`, same Panel language) rather than a new layout system:

- Row 1 (full width, 12 cols): Portfolio Header, upgraded with the Performance chart inline (value + sparkline/range toggle) instead of the current plain figure.
- Row 2: Holdings (7–8 cols, unchanged) | Side column (4–5 cols): Insights strip → Allocation panel → Period Activity → Change Bridge → Connections (conditional). This reorders the existing side column to put the new, higher-signal panels first, pushing the already-shipped Activity/Bridge down rather than displacing them.
- Timeline: either a "View all" affordance off Period Activity (cheapest), or — once justified by real usage — its own panel below Holdings.

This keeps every existing, tested component (`InvestmentsHoldings`, `InvestmentsActivityCard`, `InvestmentsBridgeCard`, `InvestmentConnectionsCard`) untouched in behavior, only re-slotted.

---

## Part 7 — Recommended mobile layout

Today's mobile experience is literally the desktop stack in source order. A real native hierarchy, without any new data:

1. Portfolio Header (figure + as-of; chart, once built, collapses to a smaller sparkline, not the full desktop chart).
2. Holdings — but truncated to a "top N + Show all" pattern by default (already an S5 consideration in the shipped plan for large portfolios) rather than the full table, since mobile scroll cost for 19+ rows is real.
3. Insights strip (once built) — short, scannable sentences are mobile-native by nature.
4. Allocation (once built) — a stacked bar or list-with-percentages reads better than a donut at mobile width; the mockup's donut is a desktop-density choice, not something to copy literally per the brief's own instruction.
5. Period Activity and Change Bridge collapse behind a single "What changed" expandable section rather than two always-open panels — mobile users scan for the headline distinction (in/out vs. residual) before wanting the row-by-row detail.
6. Connections — stays last/conditional, as today.

---

## Part 8 — Recommended implementation order

Ordered by (biggest UX improvement) ÷ (architectural risk + new-data need), cheapest-and-highest-signal first:

1. **Dividends/income as a labeled KPI + concentration/cash/diversification Insights strip.** Zero new data, zero schema, pure presentation over fields the DTO already returns (`share`, `income` flow subtotal). Smallest possible change, directly answers the brief's "why did my portfolio change" / "how concentrated am I" questions the current page doesn't answer yet.
2. **Allocation panel (asset class + sector + account + currency), each dimension honestly labeled by coverage** (an "unclassified" bucket where `sector`/`assetClass` is null, never silently dropped). Same risk profile as #1 — grouping logic over existing DTO data — but slightly more surface area (a new panel, possibly a chart primitive).
3. **Performance chart from `SpaceSnapshot`**, explicitly labeled with the same estimated/observed honesty convention Wealth already uses. Slightly higher risk only because it's a new data source (Space-level, not the A10 per-instrument view) being joined into the Investments page for the first time — needs a decision on whether/how it disagrees with the A10 "as of" figure on the same page (it can, since one is a reconstructed daily balance and the other is real per-instrument pricing; that disagreement needs a design answer, not a silent inconsistency).
4. **Chronological Timeline feed** (new read function over `InvestmentEvent`, no schema change). Ranked after Allocation/Performance because, unlike those, it requires new backend code (however small) and provenance-dedup decisions across Plaid vs. import sources.
5. **Mobile-native hierarchy pass** (Part 7) — best done once #1–#3 exist, so the mobile redesign has the real final panel set to work with rather than needing a second pass.
6. **Future vision, not recommended now:** country/geography allocation, per-holding gain/loss and cost basis, Top Movers/Worst Performers, risk metrics, and Upcoming Events/market calendar — each requires genuine new backend modeling (lot accounting, reference data, statistical engines, or an entirely new external data domain) that the brief's own constraints ("do not recommend backend work unless absolutely necessary," "do not invent calculations") argue against prioritizing until a specific product decision calls for them.

---

## Appendix — mockup vs. reality, mapped element-by-element

| Mockup element | Status |
|---|---|
| Portfolio value + range chart | Not built; buildable now from `SpaceSnapshot` (Part 3 §1), with a precision caveat |
| Change bridge waterfall | **Already shipped**, `InvestmentsBridgeCard` — matches almost exactly |
| Today's change / Net contributions / Investment return / Dividends / Cash / Positions strip | Mostly derivable from existing DTO fields today; dividends need re-labeling (Part 3 §7), cash needs a rollup (Part 3 §6) |
| Holdings table w/ Day%, Total%, Cost basis, Unrealized P/L | Holdings + Total% (`share`) **already shipped**; Day% needs a same-day comparison fetch (buildable now); Cost basis/Unrealized P/L **not available** — explicitly out of scope in the shipped DTO |
| Allocation donut | Not built; buildable now for asset class/sector/account/currency; country is a real gap |
| Insights feed | Not built; concentration/cash/diversification buildable now; gain/loss-based insights are a real gap |
| Top movers / Worst performers | Not built; requires backend work (per-holding deltas) |
| Upcoming events | Not built; requires an entirely new external data domain — weakest fit to this codebase's doctrine |
| Portfolio timeline | Not built as a first-class feed; buildable from `InvestmentEvent` with a small new read function |

**Bottom line:** the shipped Investments Perspective already answers "what do I own" (Holdings) and, better than the mockup's own framing gives it credit for, "what happened to it in this period" (Change Bridge + Period Activity) — the brief's two headline questions. The real remaining gap is breadth (allocation, insights, a real performance chart, a timeline) rather than depth on what already exists, and the honest constraint throughout is: several of the mockup's most visually prominent elements (cost basis, unrealized P/L, top movers, upcoming events) are either explicitly-scoped-out or flatly unsupported by data this codebase currently owns, and building them would mean either fabricating numbers or taking on real new backend/data-modeling work this brief asks to avoid unless necessary.
