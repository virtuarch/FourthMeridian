# SD-4 Contract Priming Wave — Perspective Architecture Preparation
### Wealth · Debt · Liquidity · Cash Flow — canonical composition contracts before extraction
**Date:** 2026-07-16 · **Branch:** `feature/v2.5-spaces-completion` · **Predecessor:** [Post-SD-3 Workspace Contract Investigation](../../investigations/FOURTH_MERIDIAN_POST_SD3_WORKSPACE_CONTRACT_INVESTIGATION_2026-07-16.md)

**Nature of this wave:** contract priming, not extraction. It does for the remaining Perspectives what PCS did for Investments — names the durable composition boundaries and lands the *pure, additive, tested* contract code where a real boundary exists, so the future workspace extractions carry almost no architectural decision-making. No UI extraction, no widget redesign, no render migration, no `SpaceDashboard` surgery, no `SpaceShell` change, no Investments change.

---

## 0. Outcome at a glance

| Perspective | Verdict | Action taken this wave |
|---|---|---|
| **Wealth** | No new contract — `WealthResult` **is** the boundary | Documented (Part A). No code. |
| **Debt** | `DebtSpaceData` **justified** (narrow time-composition) | **Implemented**: `lib/debt-space-data.ts` + test. Pure assembler. |
| **Liquidity** | `LiquiditySpaceData` **now justified** — Part C flipped the prior defer | **Designed** (Part C). Contract shape + composition recipe recorded; engine deferred to extraction (honest as-of ladder needs the not-yet-built A8 splice — implementing now would wrap a hole). |
| **Cash Flow** | `CashFlowSpaceData` **justified** (projection boundary) | **Implemented**: `lib/transactions/cash-flow-space-data.ts` + test. Pure builder. |
| **Heatmap** | `CalendarHeatmapGrid` is the correct reusable seam | Documented (Part E). No code. |

**The implementation line drawn (and why it is principled).** A contract was *implemented* only where its honest inputs exist **today**: Cash Flow's projections and Debt's as-of lens both already produce trustworthy data, so their pure composition boundaries were landed and tested. Liquidity's honest historical ladder requires a new A8 splice that does not exist yet — so its contract was *designed* (the shape is certain; the data-production engine is an extraction task). Wealth needs no contract at all. This respects "implement only narrowly justified contract work; everything else remains planning," and "no speculative abstractions."

**Validation (completely green): `tsc --noEmit` → 0 · `eslint` → 0 · unit suite → 257/257** (the two new fixture tests + the financial-doctrine oracle all pass; was 255 pre-wave).

---

## Part A — Wealth: `WealthResult` is the permanent boundary

**Authority mapping — every durable canonical concern already has one owner, all reachable through `WealthResult`:**

| Concern | Authority | Carried by |
|---|---|---|
| current state (as-of ≤ asOf) | `computeWealthTimeMachine` → `asOfState` | `WealthResult.asOfState` |
| historical snapshots / reconstruction / FX / `isEstimated` | `lib/data/snapshots.ts` (+ `lib/snapshots/regenerate.ts`) — **upstream**, the single snapshot authority | inputs to `computeWealthTimeMachine`; never re-done |
| compareTo | `computeWealthTimeMachine` → `compareState` | `WealthResult.compareState`, `deltas`, `drivers` |
| trend | `computeWealthTimeMachine` → `chart` | `WealthResult.chart` |
| change ledger | `computeWealthTimeMachine` → `drivers` | `WealthResult.drivers` |
| composition | `computeWealthTimeMachine` (`asOfState.composition`) + live-account modes | `WealthResult` + shared `accounts` |
| trust/completeness | `computeWealthTimeMachine.completeness/evidence` → `wealthEnvelope` | `WealthResult` → `resolvePerspectiveEnvelope` |

`WealthResult` already carries every durable concern; `computeWealthTimeMachine` introduces no reconstruction (every number is a field already on `SpaceSnapshot`). A `WealthSpaceData` would either relocate a pure function to the server for no benefit or duplicate the **Space-level** snapshot fetch (shared with Overview `net_worth_chart` and Debt) under a wealth brand.

**Ruling:** do **not** invent `WealthSpaceData`. No additional durable inputs repeatedly accompany `WealthResult` that would justify even a wrapper (`envelope` is derived *from* `WealthResult`; `accounts`/`ctx` are shared host resources). The only optional cleanup — a thin client `useWealthSpaceView` hook grouping `{result, envelope, accounts, ctx}` for host readability — is ergonomic, deferred to extraction, and explicitly **not** a data contract.

**FX activation fit:** the existing FX-selector-into-SpaceShell move (FX Ownership Doctrine §9) is orthogonal to this contract. Wealth resolves FX **upstream** in the snapshot authority and performs no conversion of its own (it only drops `fxMiss` points and formats copy in `currency = snapshotCurrency ?? displayCurrency`). Moving the FX selector to the shell changes *which* currency is requested, not *where* Wealth's values are converted — so it fits `WealthResult` unchanged. **No conflict.**

**Doctrine follow-up:** §5's "Planned `WealthSpaceData`" should be reclassified *satisfied by `WealthResult`*; any Phase-5 server move for Wealth is a **Space-level snapshot loader** (Overview/Debt-shared), not a wealth-branded one.

---

## Part B — Debt: `DebtSpaceData` (implemented)

**Module:** `lib/debt-space-data.ts` · **Test:** `lib/debt-space-data.test.ts` (22 checks, green).

Debt is a temporal Perspective whose asOf/compareTo windowing is **un-owned** today (the clipping gap: the production lens never recomputes as-of, and the Balance-Over-Time series is never clipped). `DebtSpaceData` is that owner. It is deliberately **narrow — a time-composition boundary, not a KPI DTO**:

```ts
interface DebtSpaceData {
  asOf: string;
  compareTo: string | null;
  lens: LensResult | null;              // debt lens computed AT asOf (verdict/headline/metrics authority)
  completeness: Completeness | null;    // POINTER to lens.completeness (as-of trust) — not a recompute
  history: DebtHistorySlice | null;     // Snapshot.totalDebt clipped to [compareTo ?? start, asOf], fxMiss dropped
  fico: { score: number | null; updatedAt: string | null };  // passthrough, never debt math
}
interface DebtHistorySlice { points: DebtHistoryPoint[]; currency: string; windowStart: string | null; windowAsOf: string }
interface DebtHistoryPoint { date: string; totalDebt: number; isEstimated: boolean }
```

**Owns:** the lens@asOf (carrying its as-of `completeness`), the window-clipped history with its explicit snapshot-currency basis, FICO. **Stays presentation-derived inside `DebtWorkspace`** (sourced from the visibility-filtered accounts array — the figures of record): KPI strip, per-account bars, interest cost, utilization rows, payoff scenarios, signals, gap list. This split is load-bearing: the lens may see DebtProfile terms the client array lacks, so the two can legitimately disagree; the design keeps the lens **prose-only** in the UI and sources every visible number from the client array. A figure-computing `DebtSpaceData` would reintroduce that contradiction — so it is refused.

**Temporal-gap closure (formal):** the gap is **presentation/orchestration-level, not math-level.** Both halves are closed by *consuming what already exists*:
1. *Current slice* — request the debt lens with `options.asOf`. The lens **already** supports this (`getAccountsAsOf` + `buildDebtCompleteness`, `lib/perspective-engine/lenses/debt.ts:49-107`); it is dormant only because the production route passes no `asOf`.
2. *History slice* — `clipDebtHistory` (a pure one-pass filter) clips `[compareTo ?? −∞, asOf]`, drops `fxMiss`, sorts ascending.

`assembleDebtSpaceData` is the **pure core**; the runtime binding (a client composition hook — the Debt analogue of `useInvestmentsTimeMachine`, *not* a server loader, since the client KPI authority is intentionally client-side) that fetches the lens at asOf and injects host snapshots is the extraction step. Building the pure core now means the extraction is "wire the hook + point `DebtHistoryPanel` at `history.points`," with the composition decisions already made and tested.

---

## Part C — Historical Liquidity: feasible, contract designed

**The prior "defer" is re-opened and flipped.** Repository evidence proves Fourth Meridian **can reconstruct liquidity at any historical date without inventing a second valuation authority** — the answer is **PARTIAL, and the partial is the honest one.**

### Historical authority mapping (the composition recipe — reuse only, no new math)

| Ladder tier | Existing authority | Honest historical trust |
|---|---|---|
| **cashNow** (checking/savings) | `getAccountsAsOf` transaction walk-back (`lib/data/accounts-asof.core.ts:135`) | **derived** |
| **credit** (card headroom) | `getAccountsAsOf` card walk-back (`:143`) | **derived** |
| **marketable** (investment + crypto) | `getInvestmentValueAsOf` scope `"all"` — A8 price×qty×FX; per-account via `components` grouped on `accountId`; crypto rides the same spine | **derived** where position-covered; **estimated** (held-flat) where balance-only |
| **illiquid** (`other` / manual) | none exists | **estimated** (held-flat) — unavoidable, honest |

**Recipe** for a Space at date D (each step an existing authority; the only new code is a per-account *splice*, which introduces no arithmetic beyond A8's own `Σ reportingValue`):
1. `getAccountsAsOf({spaceId, userId, asOf: D})` → per-account as-of rows + `{method, tier}` (cashNow + credit derived; investment/crypto/other held-flat estimated).
2. `getInvestmentValueAsOf({spaceId, asOf: D, visibilityScope: "all"})` → historical marketable value, per-account, with per-instrument `tier`. **Scope `"all"`, not via `getInvestmentsTimeMachine`** (which hard-codes FULL-only `detailEligible`, a visibility mismatch to liquidity's BALANCE_ONLY-inclusive sums).
3. **Splice**: replace each investment/crypto row's held-flat estimate with its A8 `reportingValue`, restamping that row's tier `derived`/`incomplete` (uncovered rows keep held-flat `estimated`). Pass A8 values as target-currency identity to avoid double-FX.
4. `computeLiquidity(scope, options, splicedRows, ctx)` — **unchanged** pure core (already asOf-agnostic; takes rows).
5. `buildLiquidityCompleteness(D, stamps)` — **unchanged**; already emits per-tier `byComponent` trust, already wired to the asOf lens path, dormant only because production passes no `asOf`.

**compareTo + delta:** run the recipe twice and subtract per tier (pure). The optional "moved vs market-movement" decomposition of the marketable change is **already built** — `getInvestmentsTimeMachine({asOf: D₁, compareTo: D₀})` returns an `InvestmentsReconciliation` (`closing = opening + netExternalFlows + residualChange`, market movement as an honest residual). Delta trust = worst-of endpoints (existing propagation).

**Blockers that WOULD force new math (do not):** balance-only investment/crypto accounts (no positions to value → honest held-flat estimate) and manual `other` real assets (no price series). These are **data-coverage floors** already expressed honestly by A8's unvalued remainder + `incomplete` tier — the reason the verdict is PARTIAL, never a reason to invent valuation.

### Designed contract (not implemented this wave)

```ts
interface LiquiditySpaceData {
  current:   LensResult;                 // computeLiquidity @ today (exists)
  asOf?:     LensResult;                 // computeLiquidity @ asOf over SPLICED rows (recipe above)
  compareTo?: LensResult | null;         // computeLiquidity @ compareTo
  delta?:    LiquidityDelta | null;      // per-tier {cashNow, marketable, illiquid, credit} + net (pure subtraction)
  tiers:     LiquidityLadder;            // the accessible-cash ladder for the active endpoint
  trust:     Completeness;               // buildLiquidityCompleteness — per-tier byComponent, worst-of for delta
}
```

**Why designed, not implemented:** producing an honest `asOf`/`compareTo` `LensResult` requires the **splice engine** (step 3), which is real new composition against DB reads — an extraction/feature task, not pure-contract priming. A pure top-level assembler built now would package `LensResult`s whose honest form cannot yet be produced (it would wrap a hole — the speculative abstraction the constraints forbid). The shape above is certain; landing it is the first, self-contained step of Liquidity extraction. Recommendation: build the splice as a `loadLiquiditySpaceData` server composition (it needs `getAccountsAsOf` + `getInvestmentValueAsOf`), then the top-level assembler + delta is pure and testable in the PCS mold.

**Liquidity dedup (available now, independent of the temporal work):** collapse the two ladder presenters, hoist one memoized `classifyAccounts`, and de-duplicate the 4× money helpers — mechanical cleanup, no named contract, safe to do during extraction.

---

## Part D — Cash Flow: `CashFlowSpaceData` (implemented)

**Module:** `lib/transactions/cash-flow-space-data.ts` · **Test:** `lib/transactions/cash-flow-space-data.test.ts` (delegation-boundary test, green).

A single windowed transaction projection fans out to every panel — a genuine composition boundary. The contract is the **canonical projection for one window**, perspective-agnostic:

```ts
interface CashFlowSpaceData {
  period: CashFlowPeriod; range: { start: string; end: string }; rows: Transaction[];  // window + drill source
  summary: DayFacts;                    // aggregateDayFacts
  daily: Map<string, DayFacts>;         // projectDailyFacts → calendar
  buckets: FactsBucket[];               // bucketDayFacts → history cards
  outflowByCategory: CashFlowContribution[]; incomeBySource: CashFlowContribution[];
  cashInByReason: LiquiditySliceLine[]; debtPayments: DebtPaymentGroup[]; context: CashFlowContext;
  stamp: CashFlowStamp;                 // trust (over FULL history)
  available: AvailableHistoricalPeriods; dataYears: number[];  // selector lists (over FULL history)
}
function buildCashFlowSpaceData({ transactions, accounts, period, now?, moneyCtx? }): CashFlowSpaceData  // PURE
```

**Feeds** summary, history, calendar, category, income, debt, trust — exactly as required. **Composes, computes none:** the test pins every projection field byte-equal to the canonical authority applied to the same windowed rows; the two classifiers (`classifyLiquidity` + flow-predicates) fire exactly once per row inside the projection; no raw transaction is re-classified.

**Workspace-local CONTROL STATE stays OUTSIDE the contract** (confirmed by shape): the perspective toggle (Cash Flow / Spending), the measure filter, Calendar↔Cards, the All-Time year, selected day, and drill state. Those *select* measures out of the perspective-agnostic `DayFacts` (via `perspectiveTotals`/`netOfMeasures`/`rowsForMeasures` in the widgets); they never re-fold. The **window (period) is the one time input** — Cash Flow reads the SD-0B preset dimension, never canonical asOf/compareTo. `stamp`/`available`/`dataYears` correctly read the **full** history (coverage/selectability are data properties, not window properties).

Being a **pure client projection** (not a DB loader — the transactions read is generic and host-owned) is the one structural difference from the Investments exemplar, and is documented in the module header.

---

## Part E — Heatmap architecture: correct as-is

The intended layering — `SpaceData → Workspace → Adapter → Visualization Contract → CalendarHeatmapGrid` — **already exists and is already correct.** `components/space/widgets/shared/CalendarHeatmapGrid.tsx` is the metric-agnostic, presentation-only seam: **no `mode=`/`variant=` coupling**, imports nothing domain-specific, contract `{ months, range, values: Map<iso,number>, max, fmt, tooltipRowsFor, onSelectDay?, legend?, footer? }`. Both consumers already act as the per-domain adapters:
- `CashFlowCalendar.tsx` — owns liquidity/economic measure semantics, drill-down, All-Time clamp.
- `TransactionsCalendarHeatmap.tsx` — owns money-in/out semantics; read-only.

(Grep confirms exactly these two consumers.) The two are similar enough to share the seam **because both are signed-net-currency metrics** — a narrow basis. Do **not** build a deeper `CalendarCell{intensity,tone}` generalization: repository evidence shows no third, non-net consumer, and Transactions (the intended second consumer) is still signed-net. Guessing the tone/scale API now is premature abstraction.

**Verdict:** leave `CalendarHeatmapGrid` as the reusable seam. Two cheap, optional cosmetic fixes may ride along **during** Cash Flow extraction (not now): gate the hardcoded `aria-label` "Open transactions." on `onSelect`, and optionally relocate the file to a domain-neutral path. The heatmap is first-class and preserved: the Cash Flow extraction is behavior-neutral by construction (the contract hands the workspace the same `daily`/`buckets`/`summary` projections the widgets fold today; the Calendar/Cards toggle, 14 filters, two perspectives, tooltips, and drill-down stay in the workspace).

---

## Part F — Parallelization readiness

**Logical coupling: none among the four.** Every shared seam is already done (URL authority SD-0A, time reducer SD-0B, SpaceShell slot SD-1, registry SD-2, declarative activation SD-3). The shared domain authorities each extraction consumes — `classifyAccounts`, `cash-flow-projection`/`classifyLiquidity`, the lens engine, the snapshot authority, `resolvePerspectiveEnvelope`, `CalendarHeatmapGrid`, and now the two landed contracts — are **stable and not being moved**. The contracts landed this wave *remove* coupling: Debt and Cash Flow extraction now consume a ready-made, tested boundary instead of re-deriving composition inside the host.

**The only real constraint is mechanical:** every extraction edits the same 3,721-line `SpaceDashboard.tsx`, so concurrent work contends on that file (merge conflicts), not on logic.

### Recommended execution order after SD-4A (Investments)

1. **Wealth** — lowest risk, no new contract (`WealthResult` ready); validates the "workspace reads one composition" shape for a no-contract case and removes the least from the host.
2. **Debt** and **Cash Flow** — **parallelizable in logic**; both now have a landed, tested `*SpaceData` pure core. Extraction = wire the runtime binding + point the widgets at the contract. Serialize their *host-file edits* (or first extract the perspective render-ladder into per-workspace mounts) to avoid `SpaceDashboard.tsx` contention.
3. **Liquidity** — after (or alongside) the others, but gated on its own first step: build the **splice engine** (`loadLiquiditySpaceData` per Part C), then land the pure top-level assembler + delta. Its contract is designed; this is the one remaining engine build, and it depends on the A8/`getAccountsAsOf` authorities (unchanged), not on the other extractions.

Cash Flow owns the heatmap cosmetic fixes (Part E); the deeper generic-seam question waits for a real non-net Transactions consumer.

---

## Architectural verdicts

```
WealthSpaceData justified?                 NO   — WealthResult is the boundary
WealthResult sufficient?                   YES  — carries every durable canonical concern; FX-activation fits unchanged
DebtSpaceData justified?                   YES  — narrow time-composition contract (IMPLEMENTED, tested)
LiquiditySpaceData justified?              YES  — Part C flipped the defer (DESIGNED; engine deferred to extraction)
Historical Liquidity possible?             YES (PARTIAL) — reconstructable with NO second authority; two tiers honestly estimated-flat
CashFlowSpaceData justified?               YES  — pure projection boundary (IMPLEMENTED, tested)
CalendarHeatmap architecture correct?      YES  — CalendarHeatmapGrid is the seam; defer deeper generalization
Remaining Perspective extractions parallelizable?  YES (logically) — serialized only by SpaceDashboard.tsx merge contention
```

## Validation gate

- `npx tsc --noEmit` → **exit 0**
- `npx eslint` (new files) → **exit 0**
- `npm run test:unit` → **257/257** (incl. the two new fixture tests + `financial-doctrine-oracle.test.ts`)

## What landed vs what remains planning

- **Landed (additive, unconsumed by UI — the PCS discipline):** `lib/debt-space-data.ts` (+ test), `lib/transactions/cash-flow-space-data.ts` (+ test). No host wiring, no widget change, no render migration.
- **Planning (recorded here, deferred to extraction):** the Debt runtime hook + `DebtHistoryPanel` rewire; the Liquidity splice engine + top-level assembler; the Wealth `useWealthSpaceView` ergonomic hook; the Cash Flow builder's host wiring; the heatmap cosmetic fixes; the doctrine §5 reclassification of Wealth.
