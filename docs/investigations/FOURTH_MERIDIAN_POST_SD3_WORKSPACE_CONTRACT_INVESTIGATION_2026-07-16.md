# Fourth Meridian — Post-SD-3 Workspace Contract Investigation
### Wealth · Debt · Liquidity · Cash Flow — the remaining Perspective data boundaries
**Date:** 2026-07-16 · **Branch:** `feature/v2.5-spaces-completion` · **Status:** Investigation only — no code changed, no runtime behavior modified.

---

## 0. Executive summary

The mission asked whether each remaining Perspective Workspace has a **stable composition boundary worth naming** as a `*SpaceData` contract, before the SD-4 extraction slices begin. The answer is deliberately asymmetric — as instructed, symmetry was not forced.

| Workspace | Verdict | One-line reason |
|---|---|---|
| **Wealth** | **NO** (new contract) | `WealthResult` *already is* the boundary — one pure authority over a Space-level snapshot series. A `loadWealthSpaceData` would relocate a pure function or duplicate a shared fetch. |
| **Debt** | **YES — narrow** | Justified *only* as a **time-composition** contract: nothing today owns the asOf/compareTo windowing. Not a KPI DTO — visible figures stay presentation-derived by design. |
| **Liquidity** | **NO / DEFER** | Current-state-only over three already-shared primitives; its real contract (`computeLiquidity → LensResult`) already exists. The composition that would justify a name doesn't exist until the temporal gap is closed. |
| **Cash Flow** | **YES** | A single windowed projection of transactions fans out to summary/history/calendar/category/income/debt/trust — a genuine boundary. But a **pure client-side projection**, not a DB loader. |

**The unifying finding.** None of these four is a server-side DB loader in the `loadInvestmentsSpaceData` / `loadConnectionsSpaceData` mold. Investments/Connections earn their loaders by **hiding multi-read DB access across time authorities**. Wealth/Debt/Liquidity/Cash Flow all compose data the host has *already fetched client-side* (snapshots, transactions, an HTTP-fetched lens). So where a contract is justified, its boundary is a **pure/client composition seam** (`buildCashFlowSpaceData(...)`, a `useDebtSpaceData(...)` hook), whose value is *consolidating already-canonical projections + trust*, not *hiding a database*. Promoting any of these to a true server-side loader (doctrine §5 / Phase 5) is a **separate, later step** that first requires moving the underlying fetch server-side — the "double-fetch" work — and must not be conflated with naming the composition boundary now.

This refines, and in one place corrects, the doctrine's §5 "Planned" list (`CashFlowSpaceData`, `DebtSpaceData`, `WealthSpaceData`, `TransactionsSpaceData`): **`WealthSpaceData` as a distinct contract is not justified** (see §1.11), and **`LiquiditySpaceData`'s absence from that list is correct** (see §3).

---

## 1. Wealth

### 1.1 Purpose
"How much am I worth, and how has that changed over time?" — a historical, time-sliced net-worth question driven by the shared shell time context (As Of / Compare To / range). Assets-*and*-liabilities net worth (distinct from Liquidity's assets-only access question).

### 1.2 Current composition graph
```
GET /api/spaces/[id]/snapshots → getRecentSnapshots(365)      (lib/data/snapshots.ts)
   FX stamp-convert + isEstimated/fxMiss provenance
        │  snapshots: Snapshot[]   (host state, SpaceDashboard.tsx:2358)
        │  asOf / compareTo        (shell state, :2589)
        │  currency = snapshotCurrency ?? displayCurrency  (:2636)
        ▼
   computeWealthTimeMachine({snapshots, asOf, compareTo, currency})   PURE, host memo :2637
        │  → WealthResult  (lib/wealth/wealth-time-machine.ts:119-145)
        ├─► resolvePerspectiveEnvelope → envelope (chip + evidence)   (:2680)
        └─► WealthHero · WealthTrendChart · WealthChangeLedger · WealthCompositionCard(class) · WealthExplanationCard
GET /api/spaces/[id]/accounts → SpaceAccount[] (live) ─► WealthCompositionCard (institution/account/concentration modes only)
```
Two streams, never joined: the **historical `Snapshot[]` series** (aggregate class totals — the model carries *no* per-account/per-institution history) drives everything time-sliced; **live `SpaceAccount[]`** drives only the three current-only composition modes.

### 1.3 Canonical authorities (single-owner, must not duplicate)
- **Snapshot build / FX / `isEstimated` / `fxMiss`** → `lib/data/snapshots.ts` (+ write authority `lib/snapshots/regenerate.ts`). *The single snapshot-reconstruction authority.* Both the BTC double-count and the ~$9k cash-drop regressions originated here — sensitive ground.
- **As-of / deltas / drivers / chart windowing / completeness / explanation** → `computeWealthTimeMachine` (pure; introduces *no new reconstruction* — every number is a field already on `SpaceSnapshot`).
- **Envelope shaping** → `wealthEnvelope` (`lib/perspectives/envelope.ts:63`).

### 1.4 Time / trust / FX
- **Time:** As-of = nearest snapshot ≤ asOf; deltas emitted only when *both* endpoints are real. Historical composition ("By class") reads `asOfState.composition`; institution/account/concentration are **permanently current-only** by data ceiling (no per-account history exists).
- **Trust:** `envelope: "wealth"` — tier straight from `WealthResult.completeness`, evidence rows from `chart.points`. No fabricated counts.
- **FX:** resolved **entirely upstream** in `getRecentSnapshots`; Wealth performs no conversion of its own on the series (only drops `fxMiss` points, formats copy in `currency`). The one host reconciliation is `snapshotCurrency ?? displayCurrency` — a single line.

### 1.5 Host duplication
Strikingly little: two pure calls (`computeWealthTimeMachine`, `resolvePerspectiveEnvelope`) plus a passthrough of already-fetched state. **No inline financial computation, no multi-read orchestration.** The `snapshots` fetch is *not* wealth-specific — it is the Space-level net-worth series shared with Overview's `net_worth_chart` and with Debt (`dataNeeds:["snapshots"]` ⇔ wealth|debt).

### 1.6 Proposed shape / loader
**None as an Investments-style contract.** The durable typed boundary already exists — it is `WealthResult`. A `loadWealthSpaceData(scope, {asOf, compareTo, currency})` would either (a) move the pure `computeWealthTimeMachine` to the server for no benefit, or (b) invent a snapshot-fetch orchestration that belongs to a **Space-level** contract (snapshots are shared by Overview + Debt), not to Wealth. The only defensible cleanup is a thin **client** `useWealthSpaceView` hook grouping `{result, envelope, accounts, ctx}` for host readability — an ergonomic refactor, *not* a data contract.

### 1.7 What moves vs stays
Essentially nothing moves. Snapshot authority, wealth math, envelope shaping, classification, and FX all stay in shared services, already correctly placed.

### 1.11 Verdict — **WealthSpaceData justified? NO.**
Wealth has no multi-read composition graph: one shared Space-level `Snapshot[]` fetch → one pure authority whose output `WealthResult` *is already* the typed boundary, with reconstruction cleanly owned upstream and FX resolved before the data arrives. **Recommendation:** update doctrine §5 to reclassify "WealthSpaceData" as *satisfied by `WealthResult`*; treat any Phase-5 server-side move as a **Space-level snapshot loader** (shared with Overview/Debt), not a wealth-branded one.

---

## 2. Debt

### 2.1 Purpose
"What do I owe?" — the shape, cost, and risk of liabilities, LIABILITIES ONLY. Eight panels: lens lede, KPI strip, Balance-Over-Time, utilization, interest cost, debt-by-account, payoff planner + scenarios, credit health (FICO), complete-details.

### 2.2 Current composition graph
```
accounts  ─┬─ computeDebtKpis(accounts,ctx)  (debt-kpis.ts:65) ─► KPI strip  [CLIENT array = figures of record]
           ├─ renderDebtByAccount / renderDebtCost / CreditUtilizationWidget
           ├─ computePayoffAggregate → simulatePayoff → buildPayoffScenarios ─► Payoff planner + strip
           └─ buildDebtSignals ─► signal rows
snapshots ─── DebtHistoryPanel (FULL series, NO window clip) ─► Balance Over Time
lensResult ── verdict/headline (PROSE ONLY) ─► lede;  provenance ─► resolvePerspectiveEnvelope ─► shell chip
fico ──────── FicoCard (Personal host only)
```
Entire composition happens **client-side inside `DebtPerspective.tsx`**; the host passes four raw inputs (`accounts`, `snapshots`, `fico`, `lensResult`) at `SpaceDashboard.tsx:3395-3402`. No server loader, no `DebtSpaceData` symbol exists.

### 2.3 The load-bearing dual-authority rule
The lens (server) may see DebtProfile-merged terms the visibility-filtered client payload lacks, so lens figures and client figures **can legitimately disagree**. The design resolves this by making the **lens PROSE-ONLY** in the UI and sourcing every **visible number** from the client `accounts` array (so the strip agrees byte-for-byte with the bars). *This forbids a figure-computing DebtSpaceData* — pre-baking KPIs would reintroduce the exact contradiction the design forbids.

### 2.4 The asOf/compareTo clipping gap
`consumesShellTime: true`, and the shell **renders** As Of / Compare To for Debt — but they have **zero runtime effect** today:
1. **Lens never recomputes as-of** — the perspectives route passes no time params, so the debt lens takes its present-day branch; the entire A5-P3 as-of trust envelope (`buildDebtCompleteness`, tested by `debt.asof.test.ts`) is **dormant** on this path.
2. **History never clipped** — the host stores and renders the *full* snapshot series; `DebtHistoryPanel` explicitly adds no `[compareTo, asOf]` filter.

Both are **presentation/orchestration-level, not math-level**: the as-of lens path already exists (`getAccountsAsOf` supported by `lenses/debt.ts:49-56`), and history clipping is a one-line pure filter. **Nothing owns the composition of the shell window against the inputs** — and that un-owned windowing is the entire justification for naming the boundary.

### 2.5 Proposed shape (contract vs presentation-derived)
```ts
interface DebtSpaceData {
  current: {
    lens: LensResult | null;              // [contract] carried, computed AT asOf (closes gap 1)
    completeness: DebtCompleteness | null; // [contract] the dormant as-of trust envelope, now emitted
  };
  history: {                              // [contract] Snapshot.totalDebt clipped to [compareTo??start, asOf]
    series: DebtHistoryPoint[];
    currency: string;                     // [contract] snapshot currency basis — distinct from KPI currency
    windowAsOf: string; compareTo: string | null;
  } | null;
  credit: { ficoScore: number|null; ficoUpdatedAt: string|null };  // [contract] passthrough, never debt math
  accounts: DebtAccountView[];            // [contract] the SAME visibility-filtered array — the durable INPUT
  // kpis / payoffAggregate+scenarios / signals / bars / util rows / gap list / envelope chip
  //   → ALL [presentation-derived], computed client-side off `accounts` per the §2.3 rule
}
```
- **Payoff scenarios → presentation-derived.** Pure function over the client aggregate, pinned to the interactive planner so the strip can never disagree. Server-baking would fork them and source from terms the client lacks.
- **Lens verdict/headline → contract, but owned by `LensResult`.** DebtSpaceData *carries* the lens computed at the right window; it never re-authors the verdict.
- Net *new* contribution: `current.lens@asOf`, `current.completeness`, the clipped `history`. It is a **temporal composition boundary, not a KPI DTO**.

### 2.6 Loader boundary
```ts
function useDebtSpaceData(scope, { asOf, compareTo, targetCurrency, snapshots, fico, now }): DebtSpaceData
```
Most honestly a **client-side composition hook** (like `useInvestmentsTimeMachine`), not a server loader: the lens is HTTP-fetched and the client KPI authority is *intentionally* client-side, so a server loader would fight the dual-authority doctrine. It orchestrates (lens@asOf + snapshot clip + FICO passthrough) and computes no debt math.

### 2.7 Must-NOT
Move `lib/debt.ts` math (shared with AI + Credit tab) into it; include `debt_payments` flow rollups (those belong to **cashFlow**, not Debt); compute visible KPIs in the loader; re-author the lens verdict; treat history currency as identical to KPI currency.

### 2.8 Verdict — **DebtSpaceData justified? YES — narrowly.**
Justified purely because Debt is a temporal Perspective whose asOf/compareTo windowing is currently un-owned. Were it not temporal, it would remain a client widget over shared resources and justify no contract. Scope it to the windowed composition; the extraction's headline deliverable is **closing the clipping gap by consuming the asOf the engine already supports + a one-line snapshot filter** — not new math.

---

## 3. Liquidity

### 3.1 Purpose
"How accessible is my money, and how fast?" — access and readiness, assets-only (unused credit shown separately, never counted).

### 3.2 Current reality
Composed entirely from **three already-shared, current-state primitives**: current `accounts`, current `transactions`, and the already-fetched current `LensResult` (used for the lede **sentence only**). No Liquidity-specific server read, no persisted DTO. The lens fetch is keyed on `[spaceId, currencyNonce, targetCurrency]` — **never** on asOf/compareTo.

### 3.3 Two structural problems it inherits (dedup targets, not a contract)
- **Two liquidity computations** agree only by convention: server `computeLiquidity` (`cashNow/marketable/illiquid`) vs the four workspace widgets that recompute the same figures client-side via `classifyAccounts`. Nothing enforces agreement.
- **`classifyAccounts` re-run ≥5×** per render over identical accounts; **two ladder presenters** (`renderLiquidityLadder` vs `LiquidityLadderTiers`); **money helpers duplicated 4×**.

### 3.4 The temporal gap — a *locked* current-state decision
`consumesShellTime: true` is **aspirational**. `LiquidityPerspective` is current-state-only *by decision* — `LiquidityPerspective.test.ts:88-100` forbids the tokens `asOf`/`compareTo`/`getAccountsAsOf`/`usePerspectiveShellState` in the component and host branch. The "What Changed" card is a **transaction-window fold relative to now**, explicitly *not* a two-date balance delta — so it does **not** imply a `compareTo`.

Closing the gap is **not pure wiring**: `getAccountsAsOf` reconstructs only **cash + credit-card** balances historically and holds **investment/crypto/other flat at current value** (stamped `estimated`). An honest historical *ladder* therefore needs historical valuation for the marketable/illiquid tiers — which the **A10 Investments Time Machine** owns. That would be a real cross-authority composition (Liquidity × A10) that does not exist today.

### 3.5 Is a composed contract justified?
No. Single-source-per-need, all current-state, no second authority to orchestrate against, no cross-derivation invariant to protect. The one real contract (`computeLiquidity → LensResult`) already exists and is canonical; a `LiquiditySpaceData` would either redundantly wrap it or formalize the client `classifyAccounts` duplication into a named object. The composition that *would* earn a name — `{current, asOf, compareTo}` lenses + honest historical ladder via A10 — is entirely hypothetical until the gap is closed, and naming a contract now freezes its shape before that shape is understood.

### 3.6 Verdict — **LiquiditySpaceData justified? NO / DEFER.**
**Recommendation:** (1) do a **primitive-level dedup now** (one memoized `classifyAccounts`, one ladder presenter, shared money helpers) with **no named `*SpaceData`**; (2) treat "wire asOf/compareTo into Liquidity" as its own scoped slice, noting it needs A10 historical valuation for the ladder, not just wiring; (3) reconsider `LiquiditySpaceData` (the `{current, asOf, compareTo}` triple) *only after* that composition is real. Confidence: high for the current tree.

---

## 4. Cash Flow

### 4.1 Purpose
"Where does my money move?" — movement over a selected period, on **two honest, non-double-counting axes the user toggles**: **LIQUIDITY** ("Cash Flow" — did spendable cash move?) and **ECONOMIC** ("Spending" — what did I actually spend?). A credit-card purchase is ECONOMIC spend the day it happens; its later payment is a LIQUIDITY Debt payment — different axes, never double-counted.

### 4.2 The projection authority (the whole point)
`lib/transactions/cash-flow-projection.ts` — `foldDayFacts` reads both canonical classifiers (`classifyLiquidity` + flow-predicates) **exactly once per row** → `DayFacts` (both axes). Everything fans out from this one fold:
```
windowed rows ─► aggregateDayFacts → DayFacts        (Summary)
             ─► projectDailyFacts → Map<iso,DayFacts> (Calendar cells + drill)
             ─► bucketDayFacts    → FactsBucket[]      (History cards)
             ─► outflowByCategory / incomeBySource / groupLiquidityByReason / groupDebtPaymentsByCreditor
             ─► cashFlowStamp → CashFlowStamp          (Trust)
```
Pinned by `cash-flow-fold-authority.test.ts` (forbids resurrecting the retired double-fold). **`DayFacts` is perspective-agnostic** — widgets *select* measures out of it via `CALENDAR_MEASURES`/`netOfMeasures`; they never re-classify. This is the decisive design fact for the contract shape.

### 4.3 Time / controls
- **Time:** `CashFlowPeriod` (relative WTD/MTD/…/ALL or explicit month/quarter/year) — **not** canonical asOf/compareTo. Reads the SD-0B preset dimension `shell.derived.cashFlowPeriod`, plus a CF-local **explicit drill** (`cashFlowExplicitPeriod`) the relative model can't express. The window is a pure **input** to the projection.
- **Semantic controls (STAY in the workspace — control state, not contract):** two perspectives (`liquidity`→"Cash Flow", `economic`→"Spending"), ~14 named non-overlapping filters over 12 `CalendarMeasureId`s (`cashIn/cashOut/income/allSpending/creditCardSpending/directDebitSpending/debtPayments/moneyInvested/fromInvestments/fromPaymentApps/paymentsThroughApps/cashWithdrawals`), history `mode` (calendar/cards), All-Time `viewYear`. These *select* which already-computed both-axis numbers to show; they trigger **no re-fold and no re-fetch**.

### 4.4 Proposed shape (data vs control)
```ts
// lib/cash-flow/space-data.ts — PURE projection, perspective-AGNOSTIC (both axes pre-folded once)
interface CashFlowSpaceData {
  period: CashFlowPeriod; range: {start:string; end:string}; rows: Transaction[]; // window echo + drill source
  summary: DayFacts;                    // aggregateDayFacts
  daily:   Map<string, DayFacts>;       // projectDailyFacts  → Calendar
  buckets: FactsBucket[];               // bucketDayFacts     → History cards
  outflowByCategory: CashFlowContribution[];
  incomeBySource:    CashFlowContribution[];
  cashInByReason:    LiquiditySliceLine[];
  debtPayments:      /* grouped-by-creditor */;
  context:           CashFlowContext;   // Moved-not-spent / Needs-classification
  stamp:             CashFlowStamp;      // trust — lifted out of the host memo
  available:         AvailableHistoricalPeriods; dataYears: number[];  // selector option lists
}
// CONTROL STATE — stays in the workspace: perspective, filterId→measures, mode, viewYear, period-drill decision
```
Keep **both axes** (do not collapse to `{in,out,net}`): collapsing would force the contract to know the perspective and re-project on every toggle, defeating the "select, don't re-fold" doctrine.

### 4.5 Loader boundary
```ts
function buildCashFlowSpaceData({ transactions, accounts, period, now, moneyCtx }): CashFlowSpaceData
```
A **pure/client composition** — no DB. Takes the **window as input** (like Investments' `asOf`); does **not** take perspective/filterId (display selectors over the perspective-agnostic result). Orchestrates the existing authorities (`filterByPeriod` once, `tierResolver` once, then the projections + stamp + selector lists) and computes none of the math — same "composes, computes none" discipline as `loadInvestmentsSpaceData`, but pure rather than server-side. This is the one structural difference from the exemplar worth flagging: **CashFlowSpaceData is a projection contract, not a DB-read contract.**

### 4.6 Host duplication it absorbs
Host-side `cashFlowStamp` memo (strongest target — a data computation living in the component); ~6 duplicate `filterByPeriod` windowings; `tierResolver` rebuilt per widget; a 4-deep `period/perspective/filterId` prop-drill. No server-side duplication exists.

### 4.7 Verdict — **CashFlowSpaceData justified? YES.** **Heatmap preserved as first-class? YES.**
A single windowed projection fanning to summary/history/calendar/category/income/debt/context/trust — all provably reconciling — is exactly the "typed domain composition boundary" worth naming, and it kills real duplication. Qualification: it's a pure projection contract, payoff more modest than Investments/Connections because the fold-authority work is already done — this is "name and consolidate the boundary," not "build a new authority." The extraction is behavior-neutral by construction: the workspace keeps the Calendar/Cards toggle, 14 filters, two perspectives, tooltips, All-Time nav, and `rowsForMeasures` drill-down, consuming the same `DayFacts` it folds today. No raw transaction is ever re-classified in the UI.

---

## 5. Heatmap / reusable visualization architecture

### 5.1 Headline: the generic seam already exists
`components/space/widgets/shared/CalendarHeatmapGrid.tsx` is already the metric-agnostic, presentation-only grid the doctrine envisions — **no `mode=`/`variant=` coupling**, imports nothing domain-specific. Both consumers already act as the per-domain adapters:
- **`CashFlowCalendar.tsx`** — owns liquidity/economic measure semantics, drill-down (`openDay`), All-Time year clamp.
- **`TransactionsCalendarHeatmap.tsx`** — owns money-in/out semantics; read-only (no `onSelectDay`).

Current contract: `{ months, range, values: Map<iso,number>, max, fmt, tooltipRowsFor, onSelectDay?, legend?, footer? }`. The grid owns pixels, tint, states, tooltip placement, a11y, click emission; the adapter supplies aggregation, metric meaning, tooltip content, legend, click behavior. **This is essentially the doctrine's target layering, already realized.** (Grepped: only these two consumers exist.)

### 5.2 Similarity — sufficient, but same-family
Both produce `Map<iso, signedNet>` + a `Net`-terminated tooltip and compute `max` with byte-identical visible-range reduction. The one divergence (Cash Flow drills down, Transactions is read-only) is already handled by optional `onSelectDay`. **Caveat:** they are similar *because both are signed-net-currency metrics* — a narrow basis. Reuse is proven for the *net* family, not for a sequential/count metric.

### 5.3 Two cosmetic leaks (only)
1. `aria-label` hardcodes "Open transactions." even on non-interactive cells.
2. The scale is intrinsically **signed/diverging** (`Math.sign(net)`) — a non-bipolar consumer (e.g. transaction *count*) can't express itself without abusing sign.

### 5.4 Recommendation
- **Do NOT** build the deeper `CalendarCell { date, intensity, tone, tooltip }` generalization now — it's justified only by a third, non-net consumer that doesn't exist. Guessing the tone/scale API on two same-family consumers is textbook premature abstraction.
- **DURING Cash Flow extraction (cheap ride-along):** optionally relocate `CalendarHeatmapGrid` to a domain-neutral path and fix the two cosmetic leaks (add optional `selectLabel`, gate the aria suffix on `onSelect`). Renaming wrappers to `…CalendarAdapter` is optional/nominal.
- **LATER with Transactions:** revisit the intensity/tone generalization *only if* a non-bipolar calendar appears — that extraction is what would reveal the true general shape.

### 5.5 Verdict — **Reusable CalendarHeatmap seam justified? YES — and already realized; further generalization DEFER.**

---

## 6. Cross-cutting: FX, trust, and the loader-shape distinction

- **Trust/envelope is already a solved, shared seam.** Every workspace's trust slice sources from one canonical authority through `resolvePerspectiveEnvelope`: Wealth←`WealthResult`, Cash Flow←`CashFlowStamp`, Investments←A10, Liquidity/Debt←`LensResult`. No workspace needs a new trust builder; each contract simply *carries* its already-canonical envelope input. (Anti-pattern §14: no duplicate trust builders.)
- **FX ownership is consistent.** Conversion is a shared service (`lib/money/convert`); each workspace owns only *presentation* of its own figures. Wealth resolves FX upstream in the snapshot authority; Cash Flow/Liquidity/Debt convert per-row at the row's own date via an injected `ConversionContext`. Every proposed contract threads `moneyCtx`/`currency` as an **input**, never post-converts aggregates.
- **The loader-shape distinction (most important architectural point).** Doctrine §5 frames the canonical loader as *server-side*. That fits Investments/Connections (DB reads). It does **not** fit these four today, because their inputs are host-fetched client-side via API routes. So:
  - Wealth → no contract (`WealthResult` is it).
  - Cash Flow → **pure client projection** (`buildCashFlowSpaceData`).
  - Debt → **client composition hook** (`useDebtSpaceData`).
  - Liquidity → no contract (dedup only).
  
  Naming/extracting these composition boundaries (Phase 4 / SD-4) is **independent of** promoting them to server-side loaders (Phase 5 / SD-5), which additionally requires moving the fetch server-side to kill the double-fetch. Keep the two steps distinct in every downstream plan.

---

## 7. Parallelization after SD-4

**All shared coupling is already removed** by prior slices: one URL authority (SD-0A), one time reducer (SD-0B), the SpaceShell slot (SD-1), the registry (SD-2), declarative activation (SD-3). The shared domain authorities each extraction consumes — `classifyAccounts`, `classifyLiquidity`/`cash-flow-projection`, the lens engine, the snapshot authority, `resolvePerspectiveEnvelope`, `CalendarHeatmapGrid` — are **stable and are not being moved**. Each extraction carves a workspace out of the host and consumes those unchanged.

**Therefore the four remaining extractions are logically independent.** The single real constraint is **mechanical**: every extraction edits the same 3,721-line `SpaceDashboard.tsx`, so concurrent work contends on that file (merge conflicts), not on logic.

**Recommended sequence after SD-4 (Investments) proves the Phase-4 pattern:**
1. **Wealth next** — lowest risk (no new contract; `WealthResult` ready; validates the "workspace reads one composition" shape for a NO-contract case) and removes the least from the host.
2. **Debt · Liquidity · Cash Flow — parallelizable in logic.** They touch disjoint domain modules (`lib/debt*` · `lib/perspective-engine/lenses/liquidity*` · `lib/transactions/cash-flow*`) and share only stable authorities. Serialize their *host-file edits* (or stage them behind a small extraction of the perspective render-ladder into per-workspace mounts) to avoid `SpaceDashboard.tsx` contention.

**Soft ordering caveats:**
- **Liquidity's temporal-gap decision** (defer vs close, §3.6) should be settled before Liquidity work — a scoping decision, not a code dependency.
- **Cash Flow owns the heatmap cosmetic fixes** (§5.4); the deeper generic-seam generalization waits for Transactions (a separate Phase-5 `TransactionsSpaceData` track).
- **Wealth + Debt both read the Space-level `snapshots`** resource; if that fetch is retyped/relocated during either extraction, coordinate — but neither *owns* it, so it stays a Space-level concern.

---

## 8. Final scorecard

```
WealthSpaceData justified?                          NO   (WealthResult already IS the boundary)
DebtSpaceData justified?                            YES  (narrow — a time-composition contract, not a KPI DTO)
LiquiditySpaceData justified?                       NO   (defer — shared primitives; real contract already = the lens)
CashFlowSpaceData justified?                        YES  (pure client projection; window in, semantics stay in workspace)

Cash Flow heatmap preserved as first-class?         YES
Reusable CalendarHeatmap seam justified?            YES  (already realized as CalendarHeatmapGrid; deeper generalization DEFER)

Which extractions can run in parallel after SD-4?
  → All four are LOGICALLY independent (shared authorities are stable, not moved).
    Recommended: Wealth first (lowest risk), then Debt · Liquidity · Cash Flow in parallel by logic,
    serialized only on SpaceDashboard.tsx host-file edits (mechanical, not architectural).
```

### Doctrine follow-ups (recommendations, not changes)
1. **§5 "Planned" list:** reclassify `WealthSpaceData` as *satisfied by `WealthResult`*; keep `LiquiditySpaceData` off the list (its absence is correct).
2. **Record the loader-shape distinction:** Wealth/Debt/Cash Flow composition boundaries are **pure/client** seams; server-side promotion (Phase 5) is a separate step gated on moving the fetch server-side.
3. **Debt & Cash Flow:** name the boundary as a client hook / pure builder respectively; Debt's headline deliverable is closing the asOf/compareTo clipping gap using the engine support that already exists.
