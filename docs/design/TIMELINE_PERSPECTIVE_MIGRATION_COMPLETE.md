# Timeline-5 — Perspective TimelineLens Migration

Status: **all five temporal Perspectives migrated. Legacy controls retained pending review.**
Date: 2026-07-19
Prior: `TIMELINELENS_V4_MIGRATION_MATRIX.md` · `TIMELINELENS_V4_PROMOTION_REPORT.md` · `TIMELINELENS_WEALTH_INTEGRATION.md` · `TIMELINELENS_SLICE4_VALIDATION.md`

---

## 1. Two corrections to the brief, and why

### There were never five selectors

The brief's "Before" state — a Wealth selector, a Cash Flow selector, an Investments selector, a Debt selector, a Liquidity selector — did not exist. Re-verified at the start of this slice:

```
widgets/{wealth,cashflow,investments,debt,liquidity}: 0 files with any time-selection UI
<PerspectiveShell> render sites: 1
```

All five Perspectives already shared **one** control. Both workspace headers say so outright — `DebtWorkspace.tsx:29` and `LiquidityWorkspace.tsx:41`: *"Owns NO time state — asOf / compareTo / today are shell props threaded into the hook."*

So 5B–5E were not four migrations. Each was **one allowlist entry plus a verification gate**.

### Four adapters would have undone the consolidation

The brief asked for `CashFlowTimeAdapter`, `InvestmentsTimeAdapter`, `DebtTimeAdapter`, and `LiquidityTimeAdapter` while also forbidding workspace-specific time logic. Those are the same thing, and the doctrine guard added in Slice 3 would have failed on them.

**No per-Perspective adapter was created.** The reason is structural: the differences between these lenses live *downstream* of time selection —

- `historicalCompareTo` clamping in `workspaceRenderers.tsx:124/133/154/166`
- the Cash-Flow explicit-period fork in `SpaceDashboard.tsx:405-409`

— never in how time is *chosen*. Selecting `MTD` is the same act in every Perspective. One adapter, one authority, five consumers.

### Legacy controls NOT removed

5A asked to "remove the unreachable legacy selector path". It was not unreachable — it was what the other four Perspectives rendered. Removing it before 5E would have broken them. It is now unreachable, but retaining it through review keeps the rollback path intact and gives the open decision in §6 a comparison baseline. Deletion is its own slice.

---

## 2. Migrated consumers

| Perspective | `temporalCapability` | Verified |
|---|---|---|
| Wealth | `{asOf: full, compareTo: full, period: none}` | Slice 3 + Slice 4 gate |
| Cash Flow | `{asOf: full, compareTo: full, period: full}` | §4 |
| Investments | `{asOf: full, compareTo: full, period: none}` | §4 |
| Debt | `{asOf: partial, compareTo: partial, period: none}` | §4, §5 |
| Liquidity | `{asOf: partial, compareTo: partial, period: none}` | §4, §5 |

All five render TimelineLens; none render a legacy control. Verified live by switching every lens tab.

---

## 3. Adapter inventory

**One.** `components/space/shell/perspective-time-adapter.ts`

```
TimelineIntent → shellActionForIntent() → existing ShellTimeAction
              → the SAME PerspectiveShell callbacks the legacy controls used
              → SpaceDashboard handlers (unchanged)
              → shellTimeReducer (unchanged) → canonical {preset, asOf, compareTo}
```

The integration decision that makes this safe: the adapter's action is routed back through `onSelectPreset` / `onAsOfChange` / `onCompareToChange` / `onSwap` — the *existing* props. The host cannot tell which UI produced the intent.

This is not incidental. `cashFlowExplicitPeriod` (`SpaceDashboard.tsx:381`) is CF-local, absent from canonical state and the URL, and cleared in exactly two places. **A widget dispatching `shell.actions.selectPreset` directly would strand it permanently** — Cash Flow would stay pinned to a drilled month while every other Perspective moved. Routing through `handleSelectSlice` preserves the clearing, and equally preserves the existing quirk that `handleAsOfChange` does *not* clear it.

No new reducer action. No new canonical state. No URL-model change.

---

## 4. Parity results

### Canonical parity (unit, Perspective-independent)

117 adapter checks including **50 preset-parity assertions** (10 presets × 5 starting states) comparing the lens path and the legacy path through the real reducer — byte-identical. Perspective-independent *because* the adapter is shared.

### Wealth (Slice 4 gate)

Flag ON vs OFF on the same URL produced **byte-identical** rendered financials: net-worth delta, chart caption, completeness, evidence, and the chart's SVG series path (length `2255`, identical fingerprint and tail, 183 circles).

### Cash Flow — the highest-coupling case

The explicit-period override is the one interaction a wrongly-wired widget would break. Tested live:

| Step | Canonical URL | Cash Flow period | Result |
|---|---|---|---|
| Start | `MTD \| 2026-07-19 \| 2026-07-01` | June 2026 | — |
| Drill to an explicit month | `MTD \| 2026-07-19 \| 2026-07-01` | April 2026 | **canonical unchanged** ✅ |
| Pick "This year" via the lens | `YTD \| 2026-07-19 \| 2026-01-01` | July 2026 | **override cleared** (month select reset to index 0) ✅ |

Exactly today's behavior. Also confirmed from the investigation: `asOf` sets the window *end* via `asOfClock → periodRange` (`cash-flow.ts:144`), and DayFacts are affected **only through row membership** — nothing inside the fold reads `asOf`, `compareTo`, or the period, and FX resolves at each row's own date.

### Investments

A pure function of `(spaceId, asOf, historicalCompareTo, active)` with **three** independent `compareTo` guards — the `historicalCompareTo` derivation, `useInvestmentsSpaceData.ts:65`, and a route-level 400. `holdConstantBeforeEarliest` is hardcoded, not time-selection-derived. Cost basis exists only on the `current` path and is `asOf`-independent. Any widget emitting the same triple produces identical output.

### Debt / Liquidity

Both honor the lens-selected historical `asOf` (`urlAsOf: 2026-03-31`), both fetch and re-render, and both still render their honesty copy: *"Balances are current — the trend and verdict below reflect Mar 31, 2026."*

---

## 5. The `partial` gap — investigated, not papered over

5E asked whether Liquidity honors canonical time before migrating. The answer for **both** Debt and Liquidity:

**Partially, by architectural design, with documented disclosure.**

The cause is dual-authority, stated at `DebtWorkspace.tsx:19-22`: *"every VISIBLE FIGURE is PRESENTATION-DERIVED from the visibility-filtered `accounts` array … NEVER the lens."* So:

| Honors `asOf` | Present-day by design |
|---|---|
| lede window delta, balance-history chart, verdict, trust envelope | Debt: headline total, ledger, utilization, payoff, interest |
| Liquidity: the whole Sources block when reconstruction succeeds | Liquidity: cashNow headline, coverage, concentration, reachability |

The read models do **not** silently substitute current data — `accounts-asof.core.ts:14-18` labels held-flat values `estimated` and pre-floor as `incomplete`.

**The migration is orthogonal to this gap.** Neither workspace owned time before or after; `computeDebtKpis(accounts, ctx)` and `classifyAccounts(accounts, ctx)` take no date argument and would stay present-day regardless of how the date arrives.

### ⚠️ But one pre-existing defect was found, and observed live

`LiquidityWorkspace.tsx:165-170` falls back to the **present-day** lens when the as-of reconstruction degrades:

```ts
const showAsOf = atAsOf != null && atAsOf.status === "ok";
const ledeLens = showAsOf ? atAsOf : (data?.current ?? null);
```

But `LiquidityHero.tsx:144-147` gates its disclosure on `asOf < today` **alone**:

```tsx
{historical && <p>Balances are current — the trend and verdict below reflect {formatDate(asOf)}.</p>}
```

In the degraded case the UI **states something untrue**: it claims the verdict reflects the selected past date while rendering the present-day verdict — and the trust chip, derived from the same `ledeLens`, agrees with the false claim. The Sources block silently reverts to the present-day ledger with no "as-of unavailable" disclosure.

**Observed live at `asOf = 2026-03-31`**: the honesty line rendered, but the `Reconstructed as of …` marker did **not** — i.e. `showAsOf` was false and the fallback had fired, while the hero asserted otherwise.

Debt has a milder version: `useDebtSpaceData.ts:114-119` deliberately keeps the last successful lens on fetch failure, so the hero can attribute a stale verdict to a new date. Partially mitigated by `verdictAsOf` rendering the lens's own `provenance.dataAsOf`.

**This is pre-existing and unrelated to TimelineLens.** It is *not* fixed here — fixing it means changing Liquidity workspace behavior, which this consolidation brief forbids. It should be its own slice, and it should be scheduled: a more inviting time control raises the rate at which users select historical dates, which raises how often this fires.

### A related structural note

`temporalControlVisibility` (`lib/perspectives.ts:217-222`) returns `cap.asOf !== "none"` — so a `partial` Perspective renders the **identical** control to a `full` one. The declared distinction is purely documentary. Making the lens capability-aware would be feature growth, which this brief excludes; but it means the migration neither reveals nor worsens the gap — it leaves it exactly as visible as it was.

---

## 6. Remaining gaps and open items

1. **OPEN — the as-of empty-field decision.** Legacy: clearing As-of silently becomes *today* (`ShellContextRow.tsx:134`). Lens: rejects with a field-level message. Now inherited by all five Perspectives, and **most consequential in Cash Flow**, where the As-of sets the window *end* — so under legacy, clearing it jumps the window to today. **Should be resolved before legacy deletion**, while a comparison baseline still exists.
2. **Liquidity false-disclosure defect** (§5) — pre-existing, observed live, needs its own slice.
3. **Not verified** — 360/390 px viewports (Chrome clamps this environment to 500 px); multi-member shared Space (only one Space in this account).
4. **Deferred** — `usePerspectiveShellState`'s unused `spaceId` param; "Done" button 42 px and `PanelHeader` close 32 × 32 (shared Atlas primitives).
5. **Not migrated, correctly** — Transactions (blocked on TX-2/TX-3 read architecture) and Activity (60-row recency cap would make a date filter misleading). Neither is a temporal Perspective; the guard now asserts they can never be allowlisted.

---

## 7. Removed legacy controls

**None yet — deliberately.** `ShellContextRow`'s time half and `CashFlowPeriodSelector` remain in the tree and are now unreachable. Retained because:

- the rollback path stays one line (`timeline-lens-rollout.ts`) for as long as review is open;
- the open decision in §6.1 needs a behavioral baseline to compare against;
- deletion touches the guard that currently asserts the rollback path exists.

Deletion is the next slice, gated on §6.1.

---

## 8. Regression guards

| Test | Checks | Enforces |
|---|---|---|
| `timeline-lens-exclusivity.test.ts` | 24 | One canonical selector presentation; renders `PerspectiveShell` rather than scanning it, so it distinguishes "in source" from "on screen"; allowlist may only contain real temporal Perspectives; Transactions/Activity/Accounts/Overview can never be allowlisted; null/unknown fails safe to legacy |
| `workspace-definition.test.ts` | 661 | No workspace-specific time authority — scans workspace dirs for selector components, authority imports, direct action dispatch, raw date inputs |
| `TimelineLens.test.ts` | 299 | TimelineLens cannot import domain logic; no clock reads; cannot name a canonical preset; token/CSS-module/primitive compliance |
| `perspective-time-adapter.test.ts` | 117 | Adapters own intent mapping only — intent → existing action → canonical parity |
| `timeline-lens-coverage.test.ts` | 68 | `ALL` never fabricates a start date across the async coverage lifecycle |
| `GlassPanel.test.ts` | 41 | Primitive renders valid markup for every `as` target |

The exclusivity guard was made **rollout-agnostic** in this slice: it previously pinned "the allowlist has not expanded past Wealth", which would have become a chore to edit rather than a guard. It now asserts the durable property — only real temporal Perspectives may be allowlisted, and Wealth (the validated canary) must stay in while the flag exists.

Suite: **303/305**. Both failures are outside this work — the pre-existing `MarketingNav`/`Reveal` marketing-boundary check, and `lib/data/transactions.privacy.test.ts`, which is red from a **concurrent session's in-progress edit** to `lib/data/transactions.ts` (verified: that file is dirty and not touched by this slice; committed with explicit pathspecs).

---

## 9. Final architecture

```
                    ┌─────────────────┐
                    │  TimelineLens   │   components/atlas/TimelineLens
                    │  presentation   │   cannot import domain, cannot read a
                    │  + intent only  │   clock, cannot name a preset
                    └────────┬────────┘
                             │  TimelineIntent
                             ▼
                  ┌──────────────────────┐
                  │ PerspectiveTimeAdapter│  ONE adapter — intent → existing action
                  └──────────┬───────────┘
                             │  ShellTimeAction
                             ▼
                  ┌──────────────────────┐
                  │  PerspectiveShell    │  routes through the EXISTING callbacks
                  │  + SpaceDashboard    │  (handleSelectSlice, handleCompareToChange…)
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │   shellTimeReducer   │  THE canonical time authority — unchanged
                  │  usePerspectiveShell │  one owner, one URL model
                  └──────────┬───────────┘
                             │  {preset, asOf, compareTo}
       ┌──────────┬──────────┼──────────┬───────────┐
       ▼          ▼          ▼          ▼           ▼
    Wealth    Cash Flow  Investments   Debt     Liquidity
     (raw     (asOfClock  (historical  (partial   (partial
   compareTo)  + period)   CompareTo)   — §5)      — §5)
```

One presentation layer. One adapter. One authority. Five consumers.

**Stop condition met.** Not starting TX-3, UX redesigns, or TimelineLens feature expansion.
