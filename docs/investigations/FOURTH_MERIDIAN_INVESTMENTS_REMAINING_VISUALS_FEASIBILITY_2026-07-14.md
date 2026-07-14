# Fourth Meridian — Investments: Remaining Visuals Backend Feasibility & Worth-It Verdict

**Date:** 2026-07-14
**Type:** Investigation only — no code written, no files modified in the app.
**Scope:** Follow-up to `docs/investigations/FOURTH_MERIDIAN_INVESTMENTS_WEALTH_WORKSPACE_INVESTIGATION_2026-07-14.md`. That doc found the Investments Perspective redesign already shipped (Header/Holdings/Period Activity/Change Bridge) and did first-pass triage on six remaining mockup elements (Allocation, Performance chart, Timeline, Top Movers/Worst Performers, Risk, Upcoming events). This investigation goes one level deeper on cost and worth, per the investigation-prompt request, and corrects three places where the prior doc's first-pass triage didn't hold up under closer inspection.

## Bottom line

If you build exactly one thing next: **the Allocation panel** (asset class + sector + account + currency), with concentration insights folded in. It's the only question from the original brief — "how concentrated/diversified am I?" — that the shipped page still doesn't answer, and its real cost is a ~10-line widening of the A10 display map plus one new panel. The concentration math (Herfindahl index, top-5 concentration, effective number of holdings) already exists and is tested in `lib/ai/assemblers/holdings.ts` — this is a reuse, not a new engine.

## Three corrections to the prior investigation

1. **Allocation is not literally zero-backend.** The prior doc's Part 3 classified Allocation as buildable purely from data already in the DTO. That's almost right but not quite: `assetClass` and `sector` live on `Instrument`, but the A10 binding's display map only selects `symbol`/`name` (`lib/investments/investments-time-machine.ts:157–169`). The `ValuedHoldingRow` the UI actually receives does not carry `assetClass`/`sector` today. Widening that display map is trivial (a few fields, no schema change, no new query shape) — but it is a change inside `lib/investments/**`, which the shipped Investments Perspective plan explicitly avoided touching. Worth doing; just don't call it zero-backend.

2. **Country is half a dead end, not a whole one.** The prior doc correctly found no `country` field on `Instrument` and flagged geography allocation as a real gap. Verified against `plaid@42.2.0`: Plaid's `Security` type carries no country field at all, confirming that half. But `Instrument.isin` and `marketIdentifierCode` are already persisted today, and both deterministically yield country of listing/domicile for free (ISIN's first two characters are an ISO country code; MIC resolves to an exchange's country via a public, static reference table — no paid feed needed for this specific fact). What neither can yield is economic exposure — the mockup's "International 3.1%" implies where a company's revenue comes from, not where its shares are listed, and that genuinely needs a paid look-through data feed. Recommendation stands: skip geography allocation, but for the narrower, free reason (listing country ≠ exposure, not "no data at all").

3. **The price pipeline is further along than its own code comments claim.** `jobs/fetch-security-prices.ts`'s comments still describe the vendor registry as empty/unimplemented. It isn't — Tiingo shipped in `lib/prices/registry.ts`, gated behind `TIINGO_API_KEY`. This softens (but doesn't remove) the Performance chart's precision caveat from the prior doc: real per-instrument historical pricing is closer to production-ready than the code comments suggest. It does not change the verdict on Risk metrics (still needs a statistics engine plus benchmark/index data the fetch job deliberately never pulls) or Upcoming Events (still the one item requiring a permanent new external data domain).

## Per-item verdicts

### Allocation (asset class · sector · account · currency) — **build now**
- Current state: `share` (composition weight) and account/currency are already in the DTO; `assetClass`/`sector` are one field-widening away (correction #1 above).
- Backend cost: small — extend the display map in `investments-time-machine.ts`, no schema change, no new endpoint.
- Worth it: yes. This is the one open question from the original brief the shipped page doesn't answer. Concentration insights (Herfindahl, top-5, effective holdings) reuse `lib/ai/assemblers/holdings.ts` math rather than inventing a new engine.

### Performance chart (1M/3M/YTD/ALL) — **build later**
- Current state: `SpaceSnapshot.stocks`/`.crypto` already gives a daily value series; the price pipeline (Tiingo, correction #3) is more production-ready than its own comments claim.
- Backend cost: small-to-medium — no schema change for the `SpaceSnapshot`-based version; a true A10-precision version needs either a new persisted daily investments-only valuation or N on-demand time-machine calls per render.
- Worth it: later, once Allocation ships. Trigger condition: once the precision-vs-cost tradeoff between the `SpaceSnapshot` series and true A10 pricing has a product decision behind it (don't build silently around an inconsistency between two "portfolio value" numbers on the same page).

### Timeline (chronological event feed) — **build later**
- Current state: `InvestmentEvent` already carries everything a per-event row needs; no raw list-read exists today (only aggregated `PeriodFlows` subtotals).
- Backend cost: small — one new read function, no schema change.
- Worth it: later. Real but modest value-add once Allocation and the Activity/Bridge panels have had time to prove out; not urgent.

### Top Movers / Worst Performers — **don't build now**
- Current state: needs a per-holding value delta across two dates, which the DTO deliberately does not carry (named future slice, explicitly out of scope in the shipped plan).
- Backend cost: medium — either a second fetch at `compareTo` diffed client-side by `instrumentId`, or new backend support. No lot-accounting engine exists anywhere in `lib/investments/**` today (confirmed) — cost basis and true gain/loss are a separate, larger question from simple period-over-period movement, and this item conflates the two if scoped loosely.
- Worth it: not now. Revisit once/if per-holding deltas get built for a real reason (not for this feature alone).

### Risk metrics (volatility, concentration risk, drawdown, correlation) — **don't build now**
- Current state: no statistics engine exists; the price-fetch job deliberately never pulls benchmark/index data.
- Backend cost: medium-to-large — a real stats engine plus a benchmark data source, neither of which exists today.
- Worth it: not now. Concentration risk specifically is already covered by the Allocation panel's Herfindahl/top-5 math — building a separate "Risk" surface for that one metric would duplicate Allocation. The remaining risk metrics (volatility, drawdown, correlation) need real new infrastructure with no existing partial credit.

### Upcoming Events (earnings, ex-dividend, macro) — **don't build**
- Current state: no model, no integration, no first-party data source exists anywhere in the repo for this.
- Backend cost: large and ongoing — a paid market-data/calendar subscription, a sync job, staleness handling — a permanent new external data domain, not a one-time build.
- Worth it: no. This is the one item that's a genuine doctrine mismatch: Fourth Meridian's stated direction is deterministic facts over owned data, not general market-data aggregation. Unlike the other five (all first-party-data questions), this one requires taking on an ongoing external dependency with no clear owner-data anchor.

## Ranked recommendation

1. **Allocation** — build now.
2. **Performance chart** — build later, pending a product decision on the two-series precision question.
3. **Timeline** — build later, lower urgency than the above two.
4. **Top Movers / Worst Performers** — hold; revisit only alongside a real per-holding-delta need.
5. **Risk metrics** — hold; concentration is already covered by Allocation, the rest needs real new infrastructure.
6. **Upcoming Events** — don't build; doctrine mismatch, permanent external dependency, no first-party data anchor.
