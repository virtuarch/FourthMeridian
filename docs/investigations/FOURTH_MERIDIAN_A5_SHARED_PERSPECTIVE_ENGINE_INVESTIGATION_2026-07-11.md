# Fourth Meridian — A5 Shared Perspective Engine Investigation

**Date:** 2026-07-11
**Branch:** `feature/v2.5-spaces-completion`
**Type:** Architecture investigation only. No code written, no files modified, no migrations, no commits.
**Established inputs:** `FOURTH_MERIDIAN_TIME_MACHINE_CROSS_PERSPECTIVE_INVESTIGATION_2026-07-11.md` (ratified TM definition, completeness tiers, anti-`FinancialState` ruling), `FOURTH_MERIDIAN_TIME_MACHINE_TIMELINE_SIMULATION_IMPLEMENTATION_PLAN_2026-07-11.md` (L1–L7 layering), `FOURTH_MERIDIAN_INVESTMENT_HISTORY_PROGRESSIVE_EVIDENCE_IMPLEMENTATION_PLAN_2026-07-11.md` (A-track).
**Governing principle:** *"Did the data earn this?"*

A-track numbering used here (current workstream numbering, which supersedes the older plan-internal track letters): **A1** Investment Observation Foundation (**landed** — `752b07a`), **A2** Holding modernization (**underway** — `lib/investments/sync-current-holdings.ts` exists and is wired into both writers, but the `refresh.ts`/`exchangeToken.ts` wiring sits uncommitted in the working tree), **A3** InvestmentEvent (planned — the older plan's B1/B2), **A4** Position Reconstruction (planned — the older plan's B3), **A5** this question.

---

## 1. Executive conclusion

**Yes — A5 is the correct point to begin the shared Perspective Engine, and the platform has earned a shared `FinancialContext(asOf)` — provided `FinancialContext` is defined as a *request-scope + trust-envelope contract*, not a data container.** The ratified anti-`FinancialState` ruling stands: no universal state object, no table. What every Perspective shares is *how it is asked* (space, viewer, asOf, currency, clock) and *how it must answer about trust* (dataAsOf, completeness, provenance, assumptions, visibility). What each Perspective computes stays its own.

Three findings make A5 the right moment rather than a later slice:

1. **The seam already exists in fragments and is beginning to drift.** The repository now carries **four independent trust vocabularies**: `LensResult.estimated` + `assumptions[].source` (`lib/perspective-engine/types.ts`), `SpaceSnapshot.isEstimated`, `FinancialAssessment`'s per-section `ConfidenceLevel` (`lib/ai/intelligence/annotations.ts`), and — new since A1 — `PositionObservation.origin` (`OBSERVED|IMPORTED|DERIVED|USER_ASSERTED`) plus a **reserved, currently-null `PositionObservation.completeness` string column**. A fifth is imminent: A4's reconstruction must write that column. Unifying the vocabulary *now*, before A4 invents its own, is the cheapest it will ever be.
2. **A5 is a scheduling *prerequisite* of A4, not a competitor.** `PositionObservation.completeness` was deliberately left null in A1 ("derived-only reconstruction provenance"). If A4 lands first, it either invents a private completeness vocabulary (drift) or blocks on this decision anyway. A5 defines the canonical enum; A4 adopts it.
3. **Three perspectives already own their historical substrate**, so the shared seam can be proven with **zero new schema**: Wealth reads persisted `SpaceSnapshot`; Liquidity's cash walk-back exists (`reconstructDailyCashBalances`, `lib/snapshots/backfill-core.ts:59`); revolving Debt's reverse walk exists (`reconstructDailyLiabilityBalances`, `:101`); Cash Flow is already period-native (`DayFacts`, `lib/transactions/cash-flow-projection.ts`).

**Scope discipline:** A5 = the shared contract + completeness envelope + as-of resolvers + one proving lens (Wealth/net-worth over `SpaceSnapshot`). Not a query engine, not a `FinancialState` table, not investment valuation.

---

## 2. Repository audit

What exists, what is reusable, what is duplicated.

| Subsystem | Where | State | Reusable for A5? |
|---|---|---|---|
| **Perspective Engine** | `lib/perspective-engine/` (types, registry, index, `lenses/{liquidity,debt}.{core,ts}`) | Deterministic, non-persistent, visibility-gated; injected clock; `LensResult` carries `verdict`, `metrics`, `assumptions[].source`, `provenance{accountIds,tierCounts,dataAsOf,redactions}`, `estimated`; fail-shaped; `ComputeOptions{now,targetCurrency}` — **no `asOf`** | **Yes — this IS the shared engine.** A5 extends it; nothing is rebuilt |
| **Cash Flow** | `lib/transactions/cash-flow-projection.ts` (CF-3 `DayFacts`, two axes), `cash-flow.ts` (periods, buckets), `cash-flow-context.ts`; widgets `CashFlowSummaryWidget`/`CashFlowHistoryWidget`/`CashFlowCalendar` + `cash-flow-adapters.tsx` | Complete deterministic period engine. **Not a lens** — parallel to the engine, with its own local time control (`CashFlowPeriodSelector`) | Yes as a *consumer/adapter*; its period vocabulary (`CashFlowPeriod`, `periodRange`) is the shared time-control's foundation |
| **History / Calendar** | `CashFlowHistoryWidget`, `CashFlowCalendar` over `bucketDayFacts` / `CALENDAR_MEASURES` | Shipped, tested | Yes — proof that period-scoped Perspectives work; needs only the shared control |
| **Wealth** | `components/space/widgets/wealth-adapters.tsx` (assets-only, over `classifyAccounts`), history via `lib/data/snapshots.ts` (`getRecentSnapshots`, stamp-aware currency conversion) | UI adapters, no lens; point-in-time history **already persisted** (`SpaceSnapshot`: 10 daily aggregates, `isEstimated`, `reportingCurrency`) | Yes — the proving ground: as-of read with zero schema |
| **Liquidity** | Registered lens `lenses/liquidity.{core,ts}`; reads `getAccountsWithVisibility` (`lib/data/accounts.ts:71`) | Pure core takes rows — feed it as-of rows and it computes historically unchanged | Yes |
| **Debt** | Registered lens `lenses/debt.{core,ts}` + `DebtProfile` (user-asserted terms) + `DebtPaymentsWidget` (flows) | Same pattern as Liquidity | Yes (cards); installment loans hold flat |
| **Investments** | A1: `Instrument`/`InstrumentAlias`/`PositionObservation` (append-only, incl. brokerage cash via `lib/investments/brokerage-cash.ts` residual derivation); A2: `sync-current-holdings.ts` (stable upsert, wired in `lib/plaid/refresh.ts` and `exchangeToken.ts` after observation capture); UI `InvestmentAccountsWidget` over `lib/data/investment-accounts.ts` | Observation capture live behind `INVESTMENT_OBSERVATIONS_ENABLED`; **no events (A3), no reconstruction (A4), no price series** | Partially — the adapter contract can be defined; honest results are thin until A3/A4/prices |
| **Snapshots** | `lib/snapshots/` (`regenerate.ts`, `backfill.ts`, `backfill-core.ts`, `stamp-conversion.ts`), `lib/data/snapshots.ts` | Persisted daily Space aggregate + ≤30d backfill; **both walk-back algorithms live here** | Yes — the as-of resolvers' engine room |
| **Transaction Intelligence** | `flow-classifier.ts` (single semantic authority, P5 complete), `flow-predicates.ts`, `liquidity.ts` (axis), `transfer-evidence*.ts`, merchant stack | Canonical event-log semantics | Yes — powers Cash Flow adapter and future Timeline drivers |
| **RelationshipResolver** | `lib/transactions/RelationshipResolver.ts` | Pure, read-time, refuse-on-ambiguity (TI4: relationships are recomputed context, never rows) | Not directly in A5; pattern precedent for derived (non-persisted) context |
| **Projection engine** | `cash-flow-projection.ts` (historical folds); `lib/goals/goal-trajectory.ts` (back-solve only; explicitly refuses pace projection) | No forward simulation exists | The refusal precedent is the honesty bar for the later simulation phase |
| **Simulation** | — | **Does not exist.** No `Scenario`/`ForecastRun`/`UserAssertion` models in `prisma/schema.prisma` | N/A — downstream of A5 (see §7) |
| **FinancialAssessment** | `lib/ai/intelligence/annotations.ts#computeAssessment()` — deterministic, per-section `ConfidenceLevel`, honesty constraints | The platform's richest existing completeness reasoning — but a *third* vocabulary | Its confidence semantics fold into the shared tier model over time; not rewritten in A5 |
| **Timeline** | `lib/timeline-types.ts` + activity stream (EV-1 producers + `timeline-placeholder.ts`) | This is the *activity* timeline (member/goal events), **not** the financial `FinancialTimelineDiff` (L4) — which does not exist | The L4 Timeline is a consumer of A5's seam (§6) |
| **LLM chain** | `lib/ai/assemblers/*` → `computeAssessment` → `lib/ai/provider.ts` (single boundary) + `output-validator.ts` (live) | The "LLM stays downstream" discipline already enforced | Yes — A5's stamped DTOs are exactly what its tools should consume (§8) |

**Duplicated today (the cost of not sharing):**

- **Trust vocabulary ×4** (see §1) — the single strongest duplication signal.
- **Freshness:** `LensProvenance.dataAsOf` computed inside lenses; snapshot reads carry their own date/stamp handling; Cash Flow surfaces none.
- **Time scope:** `CashFlowPeriod` is Cash-Flow-local; Wealth history hardcodes a days window (`getRecentSnapshots(days = 30)`); lenses have no time scope at all.
- **Currency threading:** each surface builds/threads `ConversionContext` separately (lens bindings via `buildSpaceConversionContext`, snapshots via `stamp-conversion.ts`, Cash Flow per-row) — consistent but repeated glue that a shared context naturally carries.

**Should become shared:** request scope (space, viewer, asOf/period, currency, clock), the completeness envelope, the as-of row/snapshot resolvers, and the shell time control. **Should stay per-Perspective:** state models, aggregation, valuation, decomposition, event semantics — the ratified §5 ruling of the TM investigation, unchanged.

---

## 3. Shared `FinancialContext` contract

Two halves. The **request half** is consumed by every Perspective; the **stamp half** is emitted on every result. Neither carries financial state.

```ts
// ── Request half — what every Perspective consumes ──────────────────────────
// Evolution of PerspectiveScope + ComputeOptions; additive and kill-switched
// (asOf absent ⇒ byte-identical current behavior).
interface FinancialContext {
  space:   { spaceId: string };            // one Space, never cross-Space (existing invariant)
  viewer:  { userId: string };             // the VIEWING member — drives KD-19 visibility
  asOf:    string | null;                  // YYYY-MM-DD valuation date; null = "now"
  period?: { start: string; end: string }; // flow-scoped Perspectives (Cash Flow); point-in-time ones ignore it
  targetCurrency?: string;                 // existing MC1 override semantics, moved into the context
  now: () => Date;                         // injected clock (existing determinism invariant)
}

// ── Stamp half — what every Perspective result carries ──────────────────────
type CompletenessTier = "observed" | "derived" | "estimated" | "incomplete" | "unknown";
interface Completeness {
  tier: CompletenessTier;                  // worst tier among contributors
  conflict: boolean;                       // orthogonal flag — same-tier sources disagree (§5)
  reason: string;                          // one deterministic, name-free sentence
  coverageFrom?: string;                   // earliest date this Perspective can answer for
  byComponent?: Record<string, CompletenessTier>; // per-metric/per-account detail, never collapsed away
}
interface FinancialContextStamp {
  asOf: string | null;                     // what was asked
  dataAsOf: string | null;                 // oldest contributing input freshness (exists today in LensProvenance)
  completeness: Completeness;              // NEW — the one genuinely new concept
  provenance: LensProvenance;              // exists (accountIds, tierCounts, redactions)
  assumptions: LensAssumption[];           // exists (source: default|user|provider|estimate)
  visibility: { full: number; balanceOnly: number; summaryOnly: number }; // = provenance.tierCounts, promoted
  space: { spaceId: string; reportingCurrency: string }; // echo, for cache keys and rendering
}
```

**Field-by-field ruling on what belongs in the shared contract:**

- `asOf` — **shared** (request). The single load-bearing addition. Null means "now" and must be byte-identical to today's behavior.
- `dataAsOf` — **shared** (stamp). Already exists as `LensProvenance.dataAsOf`; promoted to a first-class stamp field so non-lens Perspectives (Cash Flow) emit it too.
- `completeness` — **shared** (stamp). The one new ontology concept. Runtime envelope, **not a table** (ratified).
- `provenance` — **shared** (stamp). Exists; unchanged semantics (ids only, name-free, sorted).
- `assumptions` — **shared** (stamp). Exists; `source` vocabulary unchanged and feeds tier derivation (§5).
- `visibility` — **shared** (stamp), as counts + redactions only. Visibility *enforcement* stays where it is — in `getAccountsWithVisibility` and the lens cores' defense-in-depth re-gating — never in the context object.
- `space` — **shared** (request + stamp echo). `spaceId` scoping is the existing structural privacy invariant; `reportingCurrency` rides for rendering/caching.
- **Excluded, permanently:** account rows, balances, positions, holdings, `DayFacts`, any state. A `FinancialContext` that carries state is the rejected `FinancialState` under a new name.

Alongside the contract, two shared **data-layer resolvers** (the only new compute):

```ts
getSnapshotAsOf(spaceId, asOf)            // nearest SpaceSnapshot ≤ asOf, stamp-aware — thin read over lib/data/snapshots
getAccountsAsOf(ctx: FinancialContext)    // getAccountsWithVisibility rows with balances resolved to asOf:
                                          //   cash → reconstructDailyCashBalances walk-back      (derived)
                                          //   revolving liability → reconstructDailyLiabilityBalances (derived)
                                          //   everything else → held flat                          (estimated)
                                          //   before earliest transaction / link date              (incomplete)
                                          // each row carries { method, tier } so lenses stamp honestly
```

---

## 4. Perspective adapter design

Each Perspective consumes the same `FinancialContext`; each keeps its own state model. "Adapter" = the thin binding between the shared context and the Perspective's existing pure compute.

| Perspective | Adapter behavior under `FinancialContext(asOf)` | Historical status after A5 |
|---|---|---|
| **Cash Flow** | Ignores `asOf`; consumes `period`. Adapter maps the shared time control onto the existing `CashFlowPeriod` → `DayFacts` fold. Emits the stamp: tier `observed` within transaction depth, `incomplete` when the period predates coverage (`availableHistoricalPeriods` already computes this). No engine change | **Immediately historical** (already is — A5 only formalizes the stamp + shared control) |
| **Liquidity** | Binding calls `getAccountsAsOf` instead of `getAccountsWithVisibility` when `asOf` set; `liquidity.core` is untouched (it already takes rows). Stamp = worst row tier: cash walked back ⇒ `derived`; investments/manual held flat ⇒ `estimated`; beyond depth ⇒ `incomplete` | **Immediately historical** within transaction depth (90–730d Plaid bound) |
| **Debt** | Same pattern into `debt.core`. Revolving cards walk back (`derived`); installment loans held flat (`estimated`, explicit reason); **refuses principal-vs-interest** — no amortization engine exists and none is built | **Partial** — balances yes; decomposition refused by design |
| **Wealth** | New `networth` lens (pure core + binding) reads `getSnapshotAsOf`. Snapshot present, `isEstimated=false` ⇒ `observed`; `isEstimated=true` ⇒ `estimated`; carry-forward from an earlier snapshot ⇒ `derived` + `coverageFrom`; none ≤ date ⇒ `incomplete` shaped result. No interpolation, ever | **Immediately historical, partial** — headline line yes (bounded by snapshot depth); contribution-vs-growth decomposition waits for prices |
| **Investments** | Adapter defined at A5 but honest output is thin: quantities as-of are answerable only from each account's first `PositionObservation` (accruing since A1 enablement) ⇒ `observed` for observed dates, `incomplete` before; **valuation refused** (no `PriceObservation`) except same-day `institutionPrice`/`institutionValue` facts. Ships as a shaped partial result, never a fabricated line | **Must wait** — for A3 (events), A4 (reconstruction fills gaps as `derived`), and the price series (valuation) |

**Immediately historical:** Cash Flow, Liquidity, Wealth (headline). **Partial:** Debt (balances only), Wealth (no decomposition). **Must wait:** Investments (and it should still get its *adapter contract* at A5, so A3/A4 land into a fixed seam).

---

## 5. Completeness propagation

Canonical shared vocabulary — one enum, one orthogonal flag:

| Tier | Meaning | Derivation source today |
|---|---|---|
| **Observed** | Provider/user stated it for that date (live balance, posted transaction, same-day `SpaceSnapshot` with `isEstimated=false`, `PositionObservation.origin=OBSERVED`) | exists |
| **Derived** | FM computed it deterministically from observed anchors (cash/card walk-backs, snapshot carry-forward, A4 reconstruction) | algorithms exist; tier is new |
| **Estimated** | Heuristic or flat-hold (non-cash held flat, FX walk-back miss, balance×APR/12, `isEstimated=true` snapshots) | `estimated` flag exists; formalized |
| **Incomplete** | The data cannot answer (before transaction depth, before first observation, missing price) — a **gap statement**, never a number presented as whole | exists informally (shaped `empty`) |
| **Unknown** | The method cannot even be determined (e.g. `SUMMARY_ONLY` accounts — contribute to no aggregate, counted only in visibility; unrecognized account types) | tierCounts exist; tier is new |
| **Conflict** (flag) | Two same-tier sources disagree (provider vs import, residual ≠ 0 beyond tolerance — `brokerage-cash.ts` reconciliation statuses are the precedent). Orthogonal because a conflicted value may still have a tier; the flag **blocks aggregation** and forces a drill-down surface | reconciliation statuses exist; flag is new |

Richer source detail (user-asserted, imported, provider-derived — the investment plan's §12 8-row table) is **not** flattened into new tiers: it lives in `assumptions[].source` and provenance, and maps into the 6-value model (user-asserted ⇒ `observed`-aggregable but labeled via assumption source; imported ⇒ `observed` with source attribution).

**Propagation (worst-tier, at every level; conflict ORs upward):**

1. **Field/row →** each resolved value carries `{tier, method}` from the resolver or origin column.
2. **Account →** min over its contributing fields (a card with walked-back balance = `derived` even if its APR is user-asserted).
3. **Perspective →** min over contributing accounts *and* the computation method, surfaced as `completeness.tier` + `byComponent` (per-metric detail retained — a Liquidity result may be `derived` for cash and `estimated` for marketable assets, and must say so).
4. **Space / FinancialContextStamp →** min over the Perspectives consumed in that read, **with the per-Perspective breakdown preserved** — never a single collapsed badge without its components.
5. **LLM →** the tier travels machine-readably in every tool DTO. Contract (system-prompt enforced, mirroring `computeAssessment`'s existing honesty constraints): `observed`/`derived` may be stated as fact (`derived` with attribution: "based on your transaction history"); `estimated` must be hedged and never presented as observed; `incomplete`/`unknown` must state the gap; `conflict` must be surfaced, never averaged. `output-validator.ts` (already live) gates that figures trace to tool results.

Pixel rule (ratified, restated): estimated/incomplete values are never summed into a figure styled as observed. `PositionObservation.completeness` (reserved column) adopts this enum's values when A4 writes DERIVED rows — that is the drift this sequencing prevents.

---

## 6. Timeline integration

**Ruling: Timeline consumes Perspective results computed under two shared `FinancialContext`s — not a raw `FinancialContext`, and not bespoke DTOs.**

`FinancialTimelineDiff(from, to)` (L4, not yet built) is a pure subtraction over two L3 states: `getTimelineDiff(scope, from, to)` internally computes each Perspective at `FinancialContext(asOf=from)` and `FinancialContext(asOf=to)` and diffs the **perspective-specific results** — because drivers are irreducibly perspective-specific (flows for Cash Flow, purchases-vs-payments for Debt, composition for Wealth). The shared contract contributes exactly three things: the two contexts are guaranteed comparable (same viewer, same visibility, same currency semantics), the diff's `completeness` is the min of the two stamps, and `unexplainedDelta` stays honest (whatever drivers can't explain — including, until A3/A4/prices land, the entire investment market move). A Timeline built directly on a shared state object would need the rejected `FinancialState`; a Timeline built on per-Perspective DTOs *without* the shared context would re-derive comparability per perspective. This is both, correctly split.

---

## 7. Simulation integration

**Ruling: Simulation consumes a separate simulation state, *seeded from* Perspective results under `FinancialContext(asOf=now)` — it never holds a live `FinancialContext`.**

Simulation (L5, not yet built — no `Scenario`/`ForecastRun` models exist) projects a *frozen* starting state forward under explicit assumptions. It must not consume `FinancialContext` directly because the context is a live read handle: re-resolving it mid-run would make forecasts non-reproducible. Instead: `SimulationState = { lensResults@now (with stamps), assumptions[], inputHash }` — the stamp travels in, so a baseline built on `estimated` inputs carries that tier into `ForecastRun.completeness` (worst-input rule, §5). The seeding boundary is one function; everything downstream is the already-planned L5 design. A5 changes nothing here except making the seed's trust envelope exist.

---

## 8. Conversation integration

**Ruling: the LLM consumes a higher-order set of tool DTOs — stamped `LensResult[]`, `FinancialTimelineDiff`, `ForecastRun` — never the raw `FinancialContext`, never Timeline/Simulation internals.**

The repository already enforces the right architecture: `assemblers → computeAssessment (deterministic) → provider.ts (single boundary) → output-validator (live)`. A5 slots in as: tool wrappers (`getStateAsOf`, `getCurrentFinancialState`, later `getTimelineDiff`/`runScenario`) return the deterministic DTOs **with `FinancialContextStamp` attached**, plus evidence references (`Transaction` ids / snapshot keys) resolved on drill-in only. The `FinancialContext` itself is not a narration surface — it has no verdicts, no metrics; handing it to the model would invite the model to compute, which is forbidden. The stamp's machine-readable tier is what upgrades the existing per-section `ConfidenceLevel` prose into an enforceable contract (§5 rule 5).

---

## 9. Readiness assessment

**"After A5, should Fourth Meridian begin implementing P0–P5, or wait?"**

| Slice | Verdict | Repository evidence |
|---|---|---|
| **P0 Shared Perspective Engine** | **Begin — P0 largely *is* A5** | Engine exists with every invariant P0 needs (determinism, visibility, fail-shaped, provenance: `lib/perspective-engine/`); the only missing axes are `asOf` and the completeness envelope; four drifting trust vocabularies make delay actively costly |
| **P1 Cash Flow Time Machine** | **Begin (immediately after P0 contract)** | The engine is already period-native and tested (`DayFacts`, `bucketDayFacts`, `CALENDAR_MEASURES`, `availableHistoricalPeriods`); P1 = shared control + stamp + "Then vs Now" diff helper — compute over existing functions, zero schema |
| **P2 Liquidity Time Machine** | **Begin** | `reconstructDailyCashBalances` (`backfill-core.ts:59`) is the exact algorithm; `liquidity.core` already takes rows; bound = transaction depth, stamped `incomplete` beyond — zero schema |
| **P3 Debt Time Machine** | **Begin, balances only** | `reconstructDailyLiabilityBalances` (`:101`) covers revolving; `DebtProfile` covers terms; installment flat-hold is `estimated`; principal-vs-interest **refused** (no statement history, no amortization engine — confirmed absent) — zero schema |
| **P4 Wealth Time Machine (partial)** | **Begin — the recommended proving slice** | `SpaceSnapshot` persisted, `isEstimated` + `reportingCurrency` shipped, stamp-aware reads in `lib/data/snapshots.ts`, ≤30d backfill + daily accrual since D2.x; partial = headline only, decomposition waits for prices — zero schema |
| **P5 Investments Time Machine** | **Wait** | Missing capability, exactly: **(a) A3 `InvestmentEvent`** — no model in `prisma/schema.prisma`, no `investmentsTransactionsGet` ingestion; **(b) A4 reconstruction** — `PositionObservation.completeness`/`reconstructionVersion`/`unexplainedQuantity` are reserved-null, no `PositionReconstruction` summary, no DERIVED rows; **(c) price series** — no `PriceObservation`; only `FxRate` is a historical value series. Quantities-as-of exist only from each account's first observation (days old). P5's *adapter contract* should be defined in A5 so A3/A4 land into a fixed seam; the *feature* waits for (a)+(b)+(c) |

**Net:** begin P0–P4 after A5 (P0 is A5's core; P1–P4 are zero-schema consumers, with P4 first as the seam proof and {P1} / {P2,P3} parallelizable). P5 waits on A3 → A4 → prices, in that order. This also preserves the ratified stopping rule: no further investment schema until the read-only block is proven on real data — and A1/A2 are meanwhile accruing the observation history P5 will eventually read, so waiting costs nothing that isn't already being captured.

---

## 10. Claude Code implementation roadmap

Each slice = one commit boundary, additive, kill-switched (absent `asOf` ⇒ byte-identical), zero schema throughout.

1. **A5-S1 — Shared contract + completeness envelope.** `FinancialContext` (request) as a documented evolution of `PerspectiveScope`+`ComputeOptions` (`asOf` added; existing callers untouched); `Completeness` + stamp types; canonical `CompletenessTier` enum exported as THE vocabulary (A4 will import it). Files: `lib/perspective-engine/types.ts`, `engine.test.ts` guards. Tests: kill-switch byte-identity, determinism, serialisability.
2. **A5-S2 — As-of resolvers.** `getSnapshotAsOf` (thin, over `lib/data/snapshots.ts`) + `getAccountsAsOf` (walk-backs from `backfill-core.ts`, per-row `{method,tier}`). Pure cores fixture-tested; no engine changes.
3. **A5-S3 — `networth` lens (P4 proof).** `lenses/networth.core.ts` + binding; tier derivation per §4; shaped incomplete/gap results; no interpolation. Mirror existing lens test suites.
4. **A5-S4 — Shell as-of control + completeness badge.** Shared control in the `SpaceDashboard` shell (Wealth reads it; others ignore this slice); badge renders `completeness` with user-facing language ("Reconstructed", "No history before …"). Ontology terms stay internal.
5. **P1 — Cash Flow adapter + Then-vs-Now** (parallel with 6): stamp emission from `availableHistoricalPeriods`; `DayFacts` diff helper.
6. **P2/P3 — Liquidity + Debt as-of:** bindings switch to `getAccountsAsOf` under `asOf`; cores untouched; Debt refuses decomposition.
7. **Investments adapter contract (P5 seam only):** shaped partial results from `PositionObservation` observed dates; valuation refused. Feature-complete P5 remains gated on A3/A4/prices.
8. **→ hand off:** A3/A4 proceed on their own track, now importing the canonical `CompletenessTier` for `PositionObservation.completeness`; Timeline (L4) and Simulation (L5) follow per the ratified plan once the read-only block is proven on real data.

---

## 11. Exact copy-paste implementation prompt for A5

> **Task: A5 — Shared Perspective Engine seam: `FinancialContext(asOf)` + canonical completeness envelope, proven through a read-only Wealth/net-worth as-of lens. Branch `feature/v2.5-spaces-completion`.**
>
> **Hard constraints:** No Prisma model changes, no migrations. Read-only: no writes to historical data, no interpolation. Every existing caller and test byte-identical when `asOf` is absent (kill switch). All existing perspective-engine invariants hold: injected clock only, no Prisma import inside `lib/perspective-engine/`, name-free provenance, fail-closed/fail-shaped. Design sources: `FOURTH_MERIDIAN_A5_SHARED_PERSPECTIVE_ENGINE_INVESTIGATION_2026-07-11.md` §3–§5, and the ratified TM investigation §5/§9.
>
> **1. Investigate first (report inline before coding):** `lib/perspective-engine/types.ts` (`PerspectiveScope`, `ComputeOptions{now,targetCurrency}`, `LensResult`, `LensProvenance.dataAsOf`, `assumptions[].source`, `estimated`), registration in `registry.ts`/`index.ts`, both lens bindings' use of `getAccountsWithVisibility` and `buildSpaceConversionContext`; `lib/data/snapshots.ts` reads and `SpaceSnapshot` fields (`netWorth`, `totalAssets`, `debt`, `cash`, `savings`, `isEstimated`, `reportingCurrency`, `date`); the walk-backs in `lib/snapshots/backfill-core.ts` (`reconstructDailyCashBalances`, `reconstructDailyLiabilityBalances`); the shell time control (`CashFlowPeriodSelector`) and `SpaceDashboard` SectionRegistry wiring.
>
> **2. Shared contract (additive):** add `asOf?: string` (YYYY-MM-DD) to `ComputeOptions`; define and export the canonical completeness vocabulary — `type CompletenessTier = "observed" | "derived" | "estimated" | "incomplete" | "unknown"` — and `Completeness { tier; conflict: boolean; reason: string; coverageFrom?: string; byComponent?: Record<string, CompletenessTier> }`; add `completeness?: Completeness` to `LensResult` (present whenever `asOf` was supplied; may be present otherwise). Document that `PositionObservation.completeness` (reserved-null since A1) MUST adopt these string values when A4 lands — this enum is the single trust vocabulary going forward. Worst-tier propagation and the conflict flag per the investigation §5.
>
> **3. As-of resolvers (data layer, not engine):** `getSnapshotAsOf(spaceId, asOf)` — nearest `SpaceSnapshot ≤ asOf` via the existing stamp-aware read path; `getAccountsAsOf(ctx)` — `getAccountsWithVisibility` rows with balances resolved to `asOf` using the existing walk-backs (cash ⇒ derived; revolving liability ⇒ derived; all else held flat ⇒ estimated; before earliest transaction/link ⇒ incomplete), each row carrying `{method, tier}`. Pure cores split from DB bindings (the lens/core convention), fixture-tested.
>
> **4. `networth` lens (the proof):** `lenses/networth.core.ts` (pure) + `lenses/networth.ts` (binding + `registerLens`); add `"networth"` to `LensId`. Given `asOf`: snapshot on the date with `isEstimated=false` ⇒ `observed`; `isEstimated=true` ⇒ `estimated`; carry-forward from an earlier snapshot ⇒ `derived` with `coverageFrom` and an explicit reason; no snapshot ≤ date ⇒ shaped `incomplete`/empty result. Metrics: net worth, total assets, debt. No interpolation. Currency via the existing stamp-aware conversion. Attach `lensId` in `lib/perspectives.ts` per its guard conventions.
>
> **5. UI (minimal):** one shared as-of date control in the perspective shell setting a single `asOf` (Wealth consumes it; all other Perspectives ignore it this slice); completeness badge rendered from `completeness` using existing empty/estimated conventions — user-facing copy only ("Reconstructed", "No history before …"), never internal tier names.
>
> **6. Tests (mirror existing suites):** `lenses/networth.test.ts` — determinism (fixed clock + fixed `asOf` ⇒ byte-identical JSON), visibility-tier privacy, tier derivation (observed/estimated/derived/incomplete), gap/empty shapes, estimated-never-styled-as-observed; resolver fixture tests (walk-back correctness incl. beyond-depth incompleteness); kill-switch guard: every existing lens call without `asOf` is byte-identical (extend `engine.test.ts`); `lib/perspectives.test.ts` invariants still pass.
>
> **7. Real-data validation:** a Space with ≥30 snapshot days including ≥1 `isEstimated` row and ≥1 gap; verify observed-vs-reconstructed labeling, gap handling (no silent smooth line), and an `asOf` before coverage returning the shaped incomplete result.
>
> **Stop conditions:** all of §6–§7 green; no schema/migration; no other Perspective consumes `asOf` yet; no Timeline, no simulation, no investment valuation, no decomposition. Commit boundaries: (1) contract + envelope + guards, (2) resolvers + tests, (3) networth lens + tests, (4) shell control + badge. Rollback: pure revert — everything additive and kill-switched.

---

*End of investigation. No code was written, no files modified besides this report, no schema or migrations created, nothing committed.*
