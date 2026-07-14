# Fourth Meridian — Repository-Wide Architecture, Product & Implementation Audit

**Date:** 2026-07-12
**Scope:** Full repository on `feature/v2.5-spaces-completion`, audited as one system: A1–A10, Perspective Shell, Wealth UI redesign, imports, backfills, cross-domain correctness.
**Method:** Direct code inspection (lib/, app/, components/, prisma/, scripts/, jobs/), git history (through `9689ca1` + the working tree, where the A7-6 import wizard and Wealth S8 integration are landing live), env files, and the in-repo investigation documents — verified against code, not trusted.

---

## 1. Executive assessment

**Overall architectural health: strong, and genuinely converging.** The intended dependency chain — observations → events → reconstruction → completeness/residuals/evidence → historical valuation → wealth regeneration → perspective/shell → UI — exists in code with the arrows pointing the right way. There is exactly one replay engine (`lib/investments/reconstruction-core.ts`), one historical valuation path (`lib/investments/valuation.ts` → `valuation-core.ts`), one price archive (`PriceObservation` + `lib/prices/service.ts`), one FX layer (`lib/money/*` + `FxRate`), and one completeness vocabulary (`lib/perspective-engine/completeness.ts`, imported by A4, A8, A9, A10 rather than re-minted). A9 deliberately upserts into the existing `SpaceSnapshot` cache instead of creating a second wealth store; A10 composes A4 + A8 instead of forking either. The house pattern (pure fixture-tested core + thin DB binding + kill switch + dry-run script) is applied with unusual consistency.

**Is the roadmap coherent?** Yes — with one large caveat: the roadmap has produced a **dark system**. Nearly every A-series capability is behind env flags (`INVESTMENT_OBSERVATIONS_ENABLED`, `INVESTMENT_EVENTS_ENABLED`, `INVESTMENT_RECONSTRUCTION_ENABLED`, `INVESTMENT_IMPORTS_ENABLED`, `SECURITY_PRICES_ENABLED`, `WEALTH_REGENERATION_ENABLED`) and **none of them appear in any env file in the repo** (`.env.example`, `.env.local`, `.env.preview`). The price-vendor registry is intentionally empty (`lib/prices/registry.ts` — licensing-gated). The perspectives HTTP route never forwards `asOf` to the as-of-capable Liquidity/Debt lenses. `lib/transactions/cash-flow-compare.ts` (the P1 Cash Flow Then-vs-Now model) has **zero consumers**. A9 has **no trigger wiring** (`regenerateWealthHistoryForAccounts` and `computeAffectedWindow` are exported and called by nobody). The repository is converging architecturally while accumulating finished-but-unreachable capability.

**Converging or fragmenting?** Converging at the canonical-fact layer; mildly fragmenting at the consumption layer. Three read patterns now coexist: perspective-engine lenses (Liquidity/Debt), domain read models (Wealth TM, A10, Cash Flow lib), and legacy page reads (`app/(shell)/dashboard/*` server pages, `SpaceDashboard.tsx`'s widget renderers). That is two more patterns than the "Shared Perspective Engine as universal read layer" doctrine implies — see §4 and §7 for why this is mostly fine and where it is not.

**Largest strength:** honesty discipline. "Unknown is preferable to incorrect" is actually enforced in code: frozen observed snapshot rows are never rewritten (`regenerate-history.core.ts`), unvalued positions stay visible with null values and `incomplete` tiers (`valuation-core.ts`), A10's residual is a labeled residual rather than an asserted "market gain", the wealth chart refuses interpolation, and the import safety core blocks a Coinbase file aimed at a Schwab account with a defensible reason.

**Largest risk:** activation debt. The gap between what is built and what a user can see is now ~10 initiatives deep. Every additional dark capability increases the cost and risk of the eventual cutover (stale envelope copy already exists: `lib/perspectives/envelope.ts` still tells Investments users "historical valuation arrives with the price foundation" — A8 landed). Secondary risk: historical price **data coverage** is near-zero until a vendor is licensed or imports carry institution anchors — A9/A10 will honestly answer "incomplete" for most past dates, which is correct but underwhelming, and needs product framing.

**Most important next decision:** stop building new capability and run an **activation-and-reconciliation pass** — flags on in a controlled env, bootstrap backfills run, A9 triggers wired, one perspective (Investments) cut over to the new read models — before A11/A12 or further perspective redesigns.

---

## 2. Current system map

### Intended (from product doctrine)

```
Raw data → canonical normalization → deterministic computation → persisted knowledge
  → Shared Perspective Engine → Timeline → AI interpretation
```

### Actual (verified in code)

```
Plaid sync (lib/plaid/refresh.ts, exchangeToken.ts, jobs/sync-banks.ts)
  ├─ syncCurrentHoldings (A2)              → Holding (current-state read model)
  ├─ capturePositionObservations (A1)      → PositionObservation(OBSERVED)   [flag]
  │    └─ captureSecurityPrices (A8-2)     → PriceObservation(RAW_CLOSE)     [flag]
  ├─ ingestInvestmentEvents (A3)           → InvestmentEvent                 [flag]
  └─ regenerateSnapshotsForAccounts (A6)   → SpaceSnapshot (today's row)

A7 import (lib/imports/investments/* + lib/investments/investment-import-*)
  → ImportBatch(INVESTMENT_HISTORY) → InvestmentEvent + PositionObservation(IMPORTED)
  → supersession of USER_ASSERTED openings → bounded reconstruction repair
  → rollback (lib/investments/investment-import-rollback.ts, inside the batch tx)

A4 reconstruction (reconstruction-core/-runner/-read)
  → PositionObservation(DERIVED) + PositionReconstruction (residuals, conflicts)
  → resolvePositionAsOf (origin precedence OBSERVED > IMPORTED > DERIVED > USER_ASSERTED)

A8 valuation (valuation.ts → valuation-core.ts)
  = quantityAsOf(A4) × priceAsOf(PriceService over PriceObservation) × fxAsOf(money layer)
  with institution-value/price anchors taking precedence; partial subtotals explicit.

A9 (lib/snapshots/regenerate-history[.core].ts + scripts/regenerate-wealth-history.ts)
  → re-derives ESTIMATED SpaceSnapshot rows: cash/card walk-backs kept,
    flat investments replaced by A8 valuation; upserts into the SAME SpaceSnapshot cache.

A10 (investments-time-machine[.core].ts + GET /api/spaces/[id]/investments/time-machine)
  = A8 view at asOf + A8 view at compareTo + canonical-event period flows (A10-1)
    → holdings, portfolio, flows, reconciliation with labeled residual.

Shell (lib/perspectives/time-range.ts + components/space/shell/*)
  owns {preset, asOf, compareTo}, URL-synced, MTD default, ALL coverage-aware
  → Wealth: computeWealthTimeMachine(snapshots, asOf, compareTo) → WealthPerspective (S8 landing)
  → Cash Flow: preset mapped to CashFlowPeriod (widgets unchanged)
  → Liquidity/Debt: lens results fetched WITHOUT asOf (current-only)
  → Investments: current holdings only (A10 route unconsumed)
```

**Where implementation diverges from intent:**

1. **The Perspective Engine is not the universal read layer.** Only Liquidity and Debt are lenses (`LensId = "liquidity" | "debt"`, `lib/perspective-engine/types.ts:45`). Wealth, Cash Flow, and Investments consume domain read models directly. The shell + envelope registry (`lib/perspectives/envelope.ts`) has become the de-facto unification layer instead — temporal and trust language is shared there, not in the engine.
2. **`asOf` dies at the HTTP boundary.** The lenses implement A5-P2/P3 as-of resolution, but `app/api/spaces/[id]/perspectives/route.ts` reads only `target` from the query string and `SpaceDashboard` never sends dates. Liquidity/Debt Time Machines are built and unreachable.
3. **A5-S2's `resolveAccountsAsOf` predates A8** and still holds investments/crypto flat as `estimated` (`lib/data/accounts-asof.core.ts:153`). Once lens as-of is activated, the same historical date would value investments differently in Liquidity (flat) vs Wealth/Investments (A8). Bounded today because the path is dark.
4. **P1 Cash Flow compare is orphaned.** `compareCashFlow`/`cashFlowStamp` have no importers outside their own test.
5. **A9 output loses tier granularity at persistence.** `SpaceSnapshot` carries only `isEstimated: boolean`; the core computes a full `CompletenessTier` per day and then throws away everything except `tier !== "observed"`. "Flat-held estimate" and "A8-derived reconstruction" render identically downstream — a genuine "completeness must survive every layer" violation (see §6-C2).

---

## 3. Initiative-by-initiative findings

### A1 — Investment Observation Foundation — **Complete, flag-dark**
Exists: `PositionObservation` schema with origin/source/supersession/deletion, `lib/investments/position-capture.ts` wired into `lib/plaid/refresh.ts` and `exchangeToken.ts`, brokerage-cash derivation (`brokerage-cash.ts`), bootstrap backfill (`scripts/backfill-position-observations.ts`, idempotent, alias-flagged). Missing: evidence that the bootstrap has been run; flag not set anywhere in-repo. No duplication or overengineering. **Disposition: keep; run the bootstrap and enable the flag as part of activation.**

### A2 — Holding Writer Modernization — **Complete**
`lib/investments/sync-current-holdings.ts` (stable per-holding sync replacing destructive rewrite, `f935b89`), consumed by both Plaid paths. `Holding` remains the current-state read model — correctly separate from the evidence store. **Disposition: keep.**

### A3 — Investment Event Foundation — **Complete, flag-dark**
Canonical `InvestmentEvent` (provider raws on-row, `@@unique([source, externalEventId])`), pure Plaid mapper, ingest wired into `jobs/sync-banks.ts:93`. **Disposition: keep; enable.**

### A4 — Position Reconstruction — **Complete, flag-dark**
Pure core + persistence (`PositionReconstruction` with `unexplainedOpeningQuantity` never forced to zero), bounded repair (`repairReconstructionForAccount`) correctly invoked from event ingest, opening-position assertion, import commit, and import rollback. Read model (`reconstruction-read.ts`) provides `resolvePositionAsOf` with origin precedence and tier stamping — consumed canonically by A8. **Disposition: keep.**

### A5 — Shared Perspective Engine — **Complete as built; scope narrower than the name**
Engine contract is excellent (fail-shaped, name-free, deterministic, validated results). The A5-S1 completeness vocabulary is the single most successful shared artifact in the repo — it is imported by A4 writes, A8 valuation, A9 regeneration, and A10 assembly. But: two lenses only; `asOf` threaded through the engine and dropped by its sole HTTP consumer; the batch route recomputes every lens on every dashboard load with no caching. **Disposition: keep the engine for lens-style aggregate answers; do NOT try to force Wealth/A10 into it (they are richer shapes); fix the route to pass `asOf` or explicitly declare lens perspectives current-only for beta.**

### A6 — Cash Flow / Liquidity / Debt / Partial Wealth Time Machines — **Mixed**
- Wealth TM (`lib/wealth/wealth-time-machine.ts`): complete, pure, consumed by the live Wealth perspective and the envelope registry. The one A6 deliverable that reached users.
- Liquidity/Debt as-of (`lenses/*.ts` + `accounts-asof*`): built, tested, dark (no `asOf` from the route).
- Cash Flow compare (`cash-flow-compare.ts`): built, tested, **zero consumers**.
**Disposition: wire or park. Decide during the Cash Flow redesign whether `compareCashFlow` is the shape you want; if not, delete it rather than letting it drift.**

### A7 — Historical Investment Import — **Backend complete; UI landing in the working tree now**
What exists (all committed): pure pipeline (parse → columns → normalize; profiles for schwab/fidelity/coinbase/generic), preview/commit with dedupe + user decisions + instrument resolution + supersession of weaker assertions, provenance (`importBatchId`, `importedRaw`, `mapperVersion`), rollback inside the batch transaction with un-supersede pointer clearing and post-tx bounded repair, the A7-6 safety core (`lib/imports/investments/import-validation.ts`), upload guard, connection-scoped account/history routes, and — uncommitted but present — `components/connections/import/ImportHistoryButton.tsx` + `ImportHistoryWizard.tsx` (upload → preview → commit → history → rollback) mounted on the canonical `ConnectionCard`.

**Wrong-file behavior (what actually happens today, per the code):**
| Case | Behavior | Verdict |
|---|---|---|
| Coinbase export → Schwab connection | `checkImportCompatibility`: branded ≥medium-confidence mismatch ⇒ `blockingMismatch`, commit 422s even if the client bypasses preview (route re-runs the gate) | Correct |
| Correct institution, wrong account | File states no account identity (pipeline parses no account column) ⇒ `unverified` ⇒ explicit confirmation required (409 without `acknowledged`) — **not detected**, only confirmed away | Honest but weak; acceptable for beta, document it |
| Mixed-account file | `assessAccountMapping` blocks on >1 identifier — but identifiers are never parsed, so this branch is currently unreachable | Latent, fine |
| Malformed CSV | `malformed-csv` / `missing-columns`, blocking | Correct |
| Unrelated spreadsheet (résumé) | `not-investment`, blocking | Correct |
| Unsupported export (.xlsx) | Upload guard 415 with actionable message | Correct (deliberate scope cut) |
| Duplicate-only | Non-blocking, surfaced as "importing again will change nothing" — commit is a no-op that still creates an empty ImportBatch row | Correct; minor clutter |
| No valid rows | `all-invalid` / `no-records`, blocking | Correct |

Gaps: no per-row account-identifier parsing (the strongest mismatch signal is unused for brokers that include it — Fidelity/Schwab exports often do); Excel rejected rather than converged through the existing banking excel path; **no A9 regeneration after commit or rollback** (`computeAffectedWindow` computed and dropped); flags off. Provider/account mismatch detection is adequate for the three supported brands; the signature table is proportionate, not overbuilt. The pipeline is investment-specific but the ImportBatch/rollback spine is shared with banking — correctly reusable at the provenance layer, correctly specific at the parsing layer. Connections/`ConnectionCard` is the right single entry point ("context, not proof" is implemented literally — the connection only scopes the account picker; identity is judged from the file). No second entry point is needed yet. **Disposition: finish the in-flight UI slice, wire the affected-window → A9 trigger, then enable.**

### A8 — Historical Price Foundation & Valuation — **Complete; correctly the only valuation path**
Verified single-path: A9 (`regenerate-history.ts:187`) and A10 (`investments-time-machine.ts:70`) both call `getInvestmentValueAsOf`; no other quantity×price arithmetic exists outside `valuation-core.ts` (the legacy current-state Investments view uses `Holding`/institution values — current, not historical, and predates A8 legitimately). No current-price-for-historical-date reuse found: misses stay `incomplete`, zeros are never fabricated, tiers propagate via `worstTier`, FX is per-date through the same money layer everywhere. Valuation tiers are NOT flattened inside A8 — flattening happens at the SpaceSnapshot boundary (A9's problem, §6-C2).

Sizing: the vendor/backfill framework (registry, fetch, backfill-core, daily job, script) with an **empty registry** is infrastructure without a near-term execution path — but it is small (~500 lines total), seam-shaped, a clean no-op, and the blocking condition is external (licensing), not speculative. Borderline built-ahead-of-need; acceptable. **Disposition: keep; do not extend until a vendor is licensed. The vendor decision is the single highest-leverage external unblock in the repo.**

### A9 — Wealth Regeneration — **Complete as a core; unintegrated by design, and it shows**
What it actually does: for a bounded `{spaceId, from, to}` window, per day: rebuild backfill-parity classified totals (cash/card walked back, everything else flat), replace the flat investment component with `getInvestmentValueAsOf().valuedSubtotal` when any position evidence reaches the day, recompute derived fields through the same `computeSnapshotFields` the live row uses, and **upsert into `SpaceSnapshot`** — never touching `isEstimated: false` rows.

- **Persist vs derive:** persistence is justified — `SpaceSnapshot` is already the read cache for the Wealth chart, hero, compare, history page, and debt history; deriving per-request would repeat the A8 valuation per chart point. Reusing the existing cache (zero new schema) is the correct minimal choice.
- **Component detail:** sufficient for the current Wealth UI (stocks/crypto/cash/savings/real/debt columns) — but crypto and real assets remain **flat-held at today's value** on regenerated historical rows. For crypto-heavy users the "historical" trend is substantially fictional-but-labeled. Known, labeled, worth a product note.
- **Evidence/completeness survival:** partial. Tier collapses to `isEstimated` (see §6-C2); residuals/conflicts don't reach the snapshot at all (they do reach A10).
- **Reusable read model or batch script?** Batch script only, today. The read model is `computeWealthTimeMachine` over the snapshots A9 improves — so integration is *implicit*: the moment regeneration runs, the existing Wealth UI gets better data with zero UI changes. That is elegant, and it also means **nothing fails loudly if regeneration never runs** — which is exactly the current state (flag absent, script manual, no triggers).
- **Per-day strategy:** acceptable — bounded window, idempotent upserts, best-effort per day. The per-day `getInvestmentValueAsOf` call is O(days × batched-reads); fine for 30–365-day windows per space, would need batching for a global multi-year backfill.
- **Duplicates A6?** No — it is explicitly a sibling of `backfill.ts` that imports its walk-backs unchanged.
- **Missing triggers:** import commit, import rollback, price capture/backfill, and investment sync all change historical truth and none regenerate. `regenerateWealthHistoryForAccounts` exists for precisely this and has no callers.
**Disposition: the next A9 work is a thin trigger-wiring slice + a decision on tier persistence, not more core.**

### A10 — Investments Time Machine — **Backend complete and clean; zero UI**
Uses A4 via A8 canonically (one valuation path, called at both endpoints); flows read canonical events with the provenance filter and convert per-event-date through the same money layer; assembly is pure; residual is honest ("includes market movement, FX, reinvested income, fees, and any incomplete history"); no premature performance accounting (no TWR/IRR); endpoint-incomplete and conflict states are explicit; does not depend on A9. DTO is appropriately shaped (portfolio view + flows + reconciliation + envelope) — not UI-specific, not bloated. Missing: any consumer (`grep time-machine components/` → only Wealth imports); per-holding change attribution (deferred, correctly); cash/fees/dividends are itemized in `PeriodFlows` categories but only boundary flows enter the identity (correct — internal flows would double-count). Current vs historical investments do **not** share one read model yet: `InvestmentAccountsWidget` reads `current-holdings.ts`. Product-ready enough to drive the Investments redesign, with the caveat that price coverage limits how deep the history goes. **Disposition: this is the highest-value unconsumed asset in the repo — build its UI next.**

### Perspective Shell redesign — **S1–S7 committed; S8 landing in the working tree; S9 pending**
Landed: canonical time model (`lib/perspectives/time-range.ts` — MTD default, CUSTOM inference, preset↔dates bidirectional sync, calendar-aware rolling windows, ALL from `earliestDefensibleDate`, URL round-trip, exhaustive tests), one owner hook (`usePerspectiveShellState`), two-frame shell, envelope registry (S3), interactive completeness popover + evidence drawer (S4), compare overlay (S5), Hero/Ledger/TrendChart (S6/S7). Working tree: S8 (WealthPerspective recomposition; KpiStrip/NetWorthChart/ChangeSummary deleted; host wiring).

Findings: the shell does not own domain behavior (good); perspectives no longer hold time state, with one sanctioned exception — `cashFlowPeriod` remains host state synced event-driven from the shell (§3.5 of the plan). That is a *documented* second time-ish state, tolerable, but it means Cash Flow widgets still consume a `period`, not `{asOf, compareTo}` — Cash Flow has not truly adopted the temporal model, it is bridged to it. `earliestDefensibleDate` is Space-level (oldest non-fxMiss snapshot), not domain-aware — ALL on a future Investments tab would claim a range investments can't answer for (matches the prompt's concern; currently bounded). Space navigation untouched (verified: shell renders inside the PERSPECTIVES tab only). Abstraction weight is appropriate; no component fragmentation beyond need; mobile behavior is addressed in S9 (pending). Not ready for *all* perspectives yet only in the sense that Liquidity/Debt/Investments don't respond to its dates — a backend wiring gap, not a shell gap. **Disposition: land S8/S9, then stop shell work; the next lever is making the other perspectives actually obey the shell's dates.**

### Wealth Perspective UI redesign — **Mid-flight (S8), direction correct**
Consuming A9? Indirectly and correctly: it reads `SpaceSnapshot` via `computeWealthTimeMachine`; A9 improves those rows in place. It does not use current-state aggregations for historical answers; the trend is regenerated-or-backfilled data, never inferred/interpolated (gap-preserving chart, hollow markers for estimated). Single net-worth-number doctrine implemented (Hero is the only statement; KPI strip deleted in S8). Composition reconciles with the hero by construction (same snapshot row). Change attribution = real component deltas between two resolved snapshots; ledger reconciliation is tested (Σ asset deltas − liability delta = net-worth delta). Incomplete history yields shaped "No history before …" states, never zeros. Explanation is template-deterministic, no LLM. Preserved behaviors verified: crypto first-class in composition, epsilon zero-filtering is presentation-only, Real World Assets present, MTD default, synchronized dates, ALL, calendar-aware windows. Residual concern: `real = max(0, totalAssets − cash − inv − crypto)` is a derived residual — classifier drift would silently pool into "Real World Assets". **Disposition: finish S8/S9 before starting any other perspective redesign — one perspective fully done is the template.**

---

## 4. Perspective audit

| Perspective | Backend capability | UI capability | Gap | Pre-time-machine assumptions? | Hist/compare/evidence visible? | Primary user question | Redesign priority |
|---|---|---|---|---|---|---|---|
| **Wealth** | A6 TM + A9 regeneration (dark) + snapshots | New Hero/Trend/Ledger/Composition (S8 landing) | Smallest. Data quality (flat investments) until A9 runs | No | Yes — all four | "How wealthy am I, and what changed?" | Finish now (in flight) |
| **Investments** | A10 complete: holdings-as-of, valuation, flows, reconciliation, evidence | Current holdings widget only; envelope copy stale ("historical valuation arrives with the price foundation") | **Largest gap in the product** | Yes — entirely | No | "What did I own and what was it worth?" | **1st after Wealth** |
| **Cash Flow** | Rich current lib (cash-flow.ts, projection, context) + orphaned compare model | Mature widgets (summary, history, calendar, categories) bridged to shell via period mapping | Medium: no Then-vs-Now consumer; period-bridge instead of true asOf/compareTo | Partially | Compare no; evidence via static envelope only | "Where does my money go?" | 2nd |
| **Liquidity** | Lens + as-of core (dark: route drops asOf) | Lens card, current-only, honest "live balances" envelope | Medium; also investment flat-hold inconsistency vs A8 when activated | Yes for history | Current evidence yes; history no | "What can I access now?" | 3rd |
| **Debt** | Lens + as-of core (dark), DebtProfile, payoff widgets | Lens card + payoff calculator + debt history chart (snapshots) | Medium | Yes for history | Partial | "What do I owe and when is it gone?" | 4th |
| **Goals / Retirement / others** | Goals CRUD; retirement is a tab shell | Functional | n/a for this wave | n/a | n/a | — | Defer |

**Unified doctrine recommendation:** yes — run a deliberate **Perspective Interface Regeneration** program after Wealth ships, not page-by-page ad-hoc redesigns. Shared: shell, time model, envelope (completeness + evidence chips → popover/drawer), compare semantics (compare = f(asOf) − f(compareTo), both endpoints real or no delta). Per-perspective: information hierarchy (Wealth = hero+trend; Investments = holdings table + reconciliation ledger; Cash Flow = flows-first; Liquidity = tiers-of-access; Debt = payoff trajectory). Order: **Investments → Cash Flow → Liquidity → Debt**, because Investments has a finished backend and the largest honesty gap; Cash Flow has the most users of its widgets and needs the compare decision; Liquidity/Debt need the `asOf` plumbing decision first.

---

## 5. Backfill and regeneration audit

| Domain | Exists | Run? | Idempotent | Resumable | Tenant-safe | Del/rollback-safe | Provenance | Re-runnable after ontology change | Mode | Required before UI activation? | Overbuilt? | Coverage measurable? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Position observations | `scripts/backfill-position-observations.ts` | Unknown (no marker) | Yes | Yes | Per-account | Yes (soft-delete filters) | `bootstrap` alias flag | Yes | One-time manual | **Yes** (A4 anchors) | No | Weak |
| Investment events (provider history) | No provider backfill; A7 import IS the mechanism | n/a | — | — | — | Yes (batch rollback) | ImportBatch | Yes | On-demand user | Yes for deep history | No | Via events/date range |
| Historical prices | `scripts/backfill-security-prices.ts` + daily job | **Cannot run — registry empty** | Yes | Yes (resume from latest covered) | Global (instrument-keyed) | Append-only | `source` column | Yes | Scheduled + one-time once vendor exists | Yes for historical valuation depth | Slightly ahead of need | Yes (`selectInstrumentsMissingDate`) |
| Historical FX | `scripts/backfill-fx-rates.ts` + daily job | **Yes (2026-07-06, per STATUS.md)** | Yes | Yes | Global | Append-only | Yes | Yes | Done + daily | Done | No | Yes |
| Historical wealth snapshots | `backfill.ts` (cash walk-back) + A9 regeneration | Backfill yes; **A9 never (flag absent)** | Yes | Windowed | Per-space | Frozen-row guard; but **not invalidated by rollback** | `isEstimated` only | Yes (upsert) | On-demand per space + triggered | Yes before Wealth historical claims deepen | No | No (no per-day tier record) |
| Transaction intelligence | `backfill-transaction-facts.ts` | Per TI ledger | Yes | Keyset | Yes | Yes | Version-gated | Yes | One-time | Done/near | No | Version counts |
| Flow classification | `backfill-flowtype.ts` (+ desync audit certified) | Yes | Yes | Yes | Yes | Yes | classifierVersion | Yes | Done | Done | No | Yes |
| Transfer evidence / merchant intel | Scripts, dry-run default | Partial | Yes | Yes | Yes | Yes | Yes | Yes | One-time | No | No | Partial |
| Regenerated perspective outputs | Nothing persisted beyond snapshots (correct) | n/a | — | — | — | — | — | — | — | — | — | — |

**The larger product question — backfill everything now, or only what has a canonical consumer?**

**Only what has a canonical consumer — with one ordering rule: prices before wealth.** Full eager backfill is wrong here because: (a) the price vendor doesn't exist yet — the biggest data mass is externally blocked regardless; (b) A9 is windowed and idempotent, so wealth history is cheap to regenerate on demand per space; (c) the ontology is still moving (tier persistence question, §11-Q3) — mass-materialized snapshots regenerated before that decision would need a second pass; (d) beta trust is better served by honest "incomplete before <date>" labels than by a week of silent batch jobs.

**Recommended concrete policy (adopt the four-tier hierarchy):**
1. **Mandatory correctness backfills before read-path cutover:** position-observation bootstrap; verify FX archive; run reconstruction (`scripts/run-reconstruction.ts`) for all investment accounts. Cheap, internal, unblocked.
2. **On-demand, user-scoped regeneration:** A9 per space, triggered by import commit/rollback (use the already-computed `affectedWindow`), investment sync deltas, and a manual "rebuild history" affordance. Regenerate **all days in the affected window** (the chart reads daily; skipping to "meaningful dates" would create fake flat segments) but never wider than the window.
3. **Background enrichment after UI activation:** vendor price backfill (once licensed) → automatic A9 re-run for affected spaces. Price backfill **must precede** any marketing of deep wealth history.
4. **Deferred:** nothing currently identified as low-value enough to build a backfill for; explicitly do not build provider-history fetchers Plaid doesn't offer.

Also: **expose partial results now** (the honesty machinery exists precisely for this), and add a lightweight **coverage read** (per-space: first covered date, % days valued at each tier over the window) surfaced in the Evidence drawer — this is the missing "visible coverage status" and it is a read-time aggregation, not new schema.

---

## 6. Cross-system correctness findings

Ranked; "dark" = currently unreachable by users, so severity is conditional on activation.

- **C1 (High, on activation): No invalidation chain from fact changes to persisted wealth history.** Import commit, import rollback, price arrival, and account changes all mutate historical truth; none trigger A9. The banking rollback route explicitly documents "No SpaceSnapshot regeneration" from an era when imports couldn't affect balances — investment history broke that assumption. Once A9 has run once, any later rollback leaves stale regenerated snapshots that no longer match the canonical facts A10 reads → **Wealth and Investments would disagree about the same date**. Fix: wire `affectedWindow` → `regenerateWealthHistoryForAccounts` on commit and rollback.
- **C2 (High, on activation): Completeness tier flattened at the SpaceSnapshot layer.** `regenerate-history.core.ts` computes `tier ∈ {observed, derived, estimated, incomplete}` per day; persistence keeps only `isEstimated`. The Wealth UI then labels every non-observed day "Reconstructed" — including days that are actually flat-held estimates or partial subtotals. This is the one place the "evidence survives every layer" invariant genuinely breaks. Options in §11-Q3.
- **C3 (Medium): Regenerated history is anchored to the CURRENT account-link set and current balances.** `regenerate-history.ts` walks back from today's balances over `ACTIVE, deletedAt: null` links. Unlinking or deleting an account silently rewrites regenerated history (while frozen observed rows keep the old totals) → a visible discontinuity at the frozen/regenerated boundary. Deleted accounts do NOT remain in regenerated history — the opposite bias: they vanish from it entirely. Needs a product decision (§11-Q4).
- **C4 (Medium, on activation): Same-date investment value differs between Liquidity/Debt as-of (flat-held, `accounts-asof.core.ts`) and Wealth/Investments (A8).** Fine while lens as-of is dark; must be reconciled (or the lens envelope must say "investments held at current value") before threading `asOf` to lenses.
- **C5 (Medium): `earliestDefensibleDate` is Space-global, not domain-aware.** ALL on any perspective derives from the oldest wealth snapshot; investments coverage typically starts later. Bounded today (only Wealth/Cash Flow obey the shell).
- **C6 (Medium): "Real World Assets" is a subtraction residual** in `wealth-time-machine.ts:163` — classifier drift pools silently into it. Consider deriving it from `classifyAccounts` totals directly when the snapshot schema next changes.
- **C7 (Low–Medium, unverified): payment-app / liability-account misbucketing.** The liquidity lens buckets purely by `AccountType` (`liquidity.core.ts:107`); whether payment-app accounts and liability-side payment transactions are correctly tiered could not be confirmed from the code inspected. Flagged for a targeted check, not asserted as a bug.
- **C8 (Low): duplicate-only imports still create an ImportBatch row** (create=0) — clutter in import history, no correctness impact; rollback of such a batch is a clean no-op.
- **C9 (Low): compare integrity holds where implemented** — Wealth deltas are literally f(asOf) − f(compareTo) over resolved states; A10's reconciliation is arithmetic over two valuation views. No violation found.
- **C10 (Low): timezone discipline is consistent** — date-only UTC (`T00:00:00.000Z`) across shell, snapshots, valuation, flows. No boundary bug found.
- **Verified clean:** zero-value filtering is presentation-only (totals unaffected); crypto and RWA included in composition and hero; brokerage cash represented (derived brokerage-cash capture + `isCash` valuation at unit price); no-ticker securities survive (instrument-id-keyed prices, institution anchors, resolver aliases); Summary/History pages read the same `lib/data/snapshots.ts` the Wealth TM reads.

---

## 7. Overengineering findings

| Concern | Files | Cost | Harmful now? | Recommendation |
|---|---|---|---|---|
| Price vendor framework with empty registry | `lib/prices/registry.ts`, `fetch.ts`, `backfill-core.ts`, `jobs/fetch-security-prices.ts`, `scripts/backfill-security-prices.ts` | ~500 lines idle; risk of drift before first real adapter | No — clean no-op, externally blocked | **Keep**; freeze until vendor licensed |
| Orphaned Cash Flow compare model | `lib/transactions/cash-flow-compare.ts` (+152-line test) | Dead code presenting as capability | Mildly — misleads status assessments | **Decide during Cash Flow redesign: wire or remove** |
| Unwired A9 trigger surface | `regenerateWealthHistoryForAccounts`, `computeAffectedWindow` | Exported API nobody calls | Yes, jointly with C1 | **Wire (next slice)** |
| Perspective Engine generality vs 2 lenses | `lib/perspective-engine/*` (registry, batch, validation) | Machinery-to-lens ratio high | No — the contract does real safety work | **Keep; add no engine features until a 3rd lens exists** |
| `SpaceDashboard.tsx` at 3,435 lines | `components/dashboard/SpaceDashboard.tsx` | The real complexity hotspot: host owns goals CRUD, sections, shell wiring, cash-flow state, URL sync | Yes — every initiative queues on it (the plan's own merge-conflict analysis names it) | **Simplify incrementally** (extract Goals + section renderers); no rewrite |
| Duplicated `isReconstructableCard` (3 copies) | `backfill.ts` (private), `accounts-asof.core.ts`, `regenerate-history.ts` | Documented parity copies to avoid `server-only` imports | Only a drift risk | **Simplify later**: move to a shared pure module |
| A5-S2 accounts-asof vs A8 | `lib/data/accounts-asof.core.ts` | Partially superseded treatment of investments | Only when lens as-of activates | **Keep + document boundary; reconcile before activation** |
| Repo-root hygiene | 20+ investigation MDs at root, 15 `tsconfig.*.tmp.tsbuildinfo`, `.fuse_hidden*`, empty `jobs/take-snapshot.ts` (`export {}`), stale `STATUS.md` (last verified 2026-07-06 — before this entire wave) | Onboarding noise; STATUS actively wrong about "current initiative" | Yes for STATUS | Move docs to `docs/investigations/`, gitignore buildinfo, **update STATUS.md** |

**Complexity that is justified:** the import safety core's confidence model (blocking vs confirm is exactly right for evidence-based UX); valuation precedence + tier propagation; reconstruction residuals/conflict surfacing; the frozen-row guard; the pure-core/DB-binding split everywhere (it is why this audit could verify behavior from fixtures). None of these should be simplified.

---

## 8. Missing capabilities

**Correctness blockers (before flags go on together):**
- A9 trigger wiring from import commit/rollback (+ optionally sync/price events) — C1.
- Decision + minimal fix for tier flattening at SpaceSnapshot — C2.
- Position-observation bootstrap + reconstruction run executed and verified.
- Reconcile or explicitly label the lens-as-of investment treatment — C4.

**Product blockers (for the historical experience to be visible):**
- Investments Time Machine UI (A10 has no consumer).
- Flags promoted into real environments (they exist in no env file — activation is currently impossible by configuration).
- Stale envelope copy fixed (`envelope.ts` Investments case).
- Import UI slice landed (in flight) + `INVESTMENT_IMPORTS_ENABLED` decision.
- Cash Flow compare consumer or removal.

**Beta-readiness blockers:**
- Coverage/status surface (per-space history coverage in the Evidence drawer).
- User-facing explanation of incomplete history (one standard sentence pattern exists in reasons; needs a first-run explainer on Wealth/Investments).
- STATUS.md refresh + backfill runbook (which scripts, what order, per new tenant).
- Observability for the new writers (JobRun exists; import/regeneration outcomes should land there or in SyncIssue consistently — import repair already records SyncIssue on failure).
- Error/empty states audit of the new wizard + shell chips (mostly present; S9 validates).

**Later optimizations:** A10 route caching (per space+dates); global A9 batch mode; mobile polish (S9); accessibility pass on popover/drawer; per-holding compare in A10.

**Speculative (do not build now):** A11 Timeline, A12 Conversation Layer, additional broker profiles beyond the three, XLSX investment import, engine lens-ification of Wealth/Investments.

---

## 9. Recommended next sequence

**Immediate next slice — "Activation & Reconciliation" (1 slice, small):**
wire import-commit/rollback → `regenerateWealthHistoryForAccounts(affectedWindow)`; add the six flags to `.env.example` with documented defaults; fix the Investments envelope copy; update STATUS.md. Stop condition: any need for schema change (there is none).

**Then, in order:**
1. **Investments Perspective redesign on A10** (direction 2). Consume `GET /investments/time-machine` from the shell's dates; holdings table + portfolio + flows + reconciliation ledger + unvalued remainder; reuse the envelope registry (A10 already returns the canonical `Completeness` shape). Dependency: activation slice. Stop condition: A10 route latency unacceptable → add caching, don't denormalize.
2. **Controlled activation + bootstrap backfills in staging/beta env** (direction 8, merged with 3): flags on, run `backfill-position-observations` → `run-reconstruction` → A9 dry-run → apply per space; verify Wealth/Investments reconcile on spot dates (the two now read the same A8 values — assert it). Stop condition: reconciliation mismatch between A9 snapshots and A10 valuations → fix before exposing.
3. **Price vendor selection + historical price backfill + full A9 regeneration** (external decision + direction 5's useful half). This is the moment deep history becomes real. No "unified backfill coordinator" abstraction — the existing script + trigger pattern is enough; build a coordinator only if operating >2 backfill kinds per tenant becomes routine.
4. **Perspective Interface Regeneration: Cash Flow** (direction 4, scoped): adopt true asOf/compareTo (decide the fate of `cash-flow-compare.ts` here), retire the period bridge where possible.
5. **Liquidity + Debt historical activation**: thread `asOf` through the perspectives route, reconcile C4, envelope from lens completeness.

**Pause:** A11 Timeline and A12 Conversation Layer — both consume exactly the read models being activated; starting them now adds consumers to unverified data. **Pause** further shell work after S9.
**Defer:** unified backfill coordinator; additional import formats/brands; A10 per-holding attribution.
**Remove from roadmap if unnecessary:** nothing structural. Delete `cash-flow-compare.ts` only if step 4 chooses a different shape; delete the empty `jobs/take-snapshot.ts` now.

Rationale: this ordering converts the ~10 dark initiatives into user-visible, mutually-reconciled truth before adding any new surface — maximum product coherence and beta readiness for near-zero new infrastructure.

---

## 10. Files and evidence (keyed to conclusions)

- **Single valuation path:** `lib/investments/valuation.ts`, `valuation-core.ts`; consumers `lib/snapshots/regenerate-history.ts:187`, `lib/investments/investments-time-machine.ts:70`.
- **Completeness vocabulary shared, not re-minted:** `lib/perspective-engine/types.ts:86`, `completeness.ts`; imports in A4/A8/A9/A10 files above.
- **Engine scope = 2 lenses:** `lib/perspective-engine/types.ts:45`; registrations only in `app/api/spaces/[id]/perspectives/route.ts:38-39`.
- **asOf dropped at the route:** `app/api/spaces/[id]/perspectives/route.ts` (reads `target` only) vs `lenses/liquidity.ts:45`, `lenses/debt.ts:49`.
- **Orphaned Cash Flow compare:** `lib/transactions/cash-flow-compare.ts` — zero importers (grep).
- **A9 shape and guards:** `lib/snapshots/regenerate-history.core.ts` (frozen/no-fabrication/flip/monotone), `regenerate-history.ts` (window binding, kill switch, unwired fan-out at :273), `scripts/regenerate-wealth-history.ts`.
- **Tier flattening:** `regenerate-history.core.ts:113` (tier → `isEstimated`), `prisma/schema.prisma` SpaceSnapshot (no tier column), `lib/wealth/wealth-time-machine.ts:289` (isEstimated → "Reconstructed").
- **A7 spine:** `lib/imports/investments/{pipeline,columns,normalize,profiles,dedupe,import-validation}.ts`, `lib/investments/{investment-import-preview,-commit,-rollback,import-upload-guard,connection-import-accounts,investment-import-history}.ts`, routes under `app/api/accounts/[id]/import/investments/*`, `app/api/connections/[id]/*`, `app/api/imports/[id]/rollback/route.ts`; UI (working tree) `components/connections/import/ImportHistory{Button,Wizard}.tsx`.
- **Unwired affected window:** `investment-import-commit.ts:17-19` ("called by nobody yet") and `:287`.
- **Empty price registry / vendor gate:** `lib/prices/registry.ts:43-46`; job no-op `jobs/fetch-security-prices.ts`.
- **Flags absent from env:** grep of `.env.example`/`.env.local`/`.env.preview` — only `RATE_LIMIT_ENABLED` present.
- **Shell canon:** `lib/perspectives/time-range.ts` (+209-line test), `components/space/shell/*`, envelope `lib/perspectives/envelope.ts` (stale Investments copy at :122-130).
- **Wealth read model + UI:** `lib/wealth/wealth-time-machine.ts` (+test), `components/space/widgets/wealth/*` (S8 in working tree: KpiStrip/NetWorthChart/ChangeSummary deleted).
- **A10:** `lib/investments/investment-flows-core.ts`, `investments-time-machine-core.ts` (+tests), `investments-time-machine.ts`, `app/api/spaces/[id]/investments/time-machine/route.ts`; no component imports it.
- **Rollback-vs-snapshot staleness:** `app/api/imports/[id]/rollback/route.ts` header ("No SpaceSnapshot regeneration").
- **Current-links anchoring:** `regenerate-history.ts:113-136`.
- **Stale STATUS:** `STATUS.md` (last verified 2026-07-06; names OPS-1/MI2 as current focus — the entire A-wave post-dates it).
- **Timeline of the wave:** `git log` — A1 (`752b07a`) through A7-6/S6-S7 (`9689ca1`, `de84023`), majority landed 07-11/07-12.

---

## 11. Questions requiring product decisions

1. **Historical-price vendor licensing (external blocker).** Which vendor, and do its terms permit persistent storage of derived close prices? *Default: prioritize this decision now; everything in §9 step 3 queues behind it.*
2. **Should Liquidity/Debt ship historical (thread `asOf`) in beta, or stay current-only?** *Default: current-only for beta with the existing honest "live balances" envelope; activate as-of only after C4 is reconciled — Wealth + Investments carry the time-machine story alone, credibly.*
3. **Tier persistence on SpaceSnapshot (C2):** add a nullable `completeness` string column, or accept `isEstimated` for beta and enrich the evidence drawer from live A8 at read time? *Default: accept the boolean for beta; add the column in the next scheduled migration rather than a dedicated one — but change the UI label so non-observed days say "Estimated or reconstructed", not "Reconstructed".*
4. **Deleted/unlinked accounts in regenerated history (C3):** true-history (keep their past contribution) or current-portfolio view? *Default for beta: current links (what the code does), disclosed in the completeness detail; revisit with link-period provenance if users notice discontinuities.*
5. **When do imports auto-trigger regeneration vs prompt the user?** *Default: automatic, windowed to `affectedWindow`, with the result surfaced ("history rebuilt for Mar 2024 – today").*
6. **Excel investment imports:** keep the deliberate CSV-only stance? *Default: yes for beta; the banking excel path exists if demand appears.*
7. **Flag promotion plan:** which environments get the six flags, in what order? *Default: all-on in preview/staging immediately; production per-flag after step 2 of §9 verifies reconciliation.*

---

## Final answer to the central question

**The repository is converging toward one reusable historical financial intelligence system.** No parallel replay, valuation, price, FX, or trust-vocabulary implementations were found; the two genuinely parallel artifacts (the orphaned Cash Flow compare model, and the flat-held investments treatment inside the A5-S2 resolver) are small, known, and bounded. The system's real problem is not architecture but *activation*: an unusually disciplined backend has been built dark, and the smallest set of changes that produces a coherent, trustworthy, user-visible historical experience is wiring, flags, bootstraps, and one Investments UI — not new infrastructure.
