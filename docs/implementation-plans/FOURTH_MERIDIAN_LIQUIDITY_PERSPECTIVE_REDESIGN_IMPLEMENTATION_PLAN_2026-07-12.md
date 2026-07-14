# Fourth Meridian — Liquidity Perspective Redesign: Investigation & Claude Code Implementation Plan

**Date:** 2026-07-12
**Branch of record:** `feature/v2.5-spaces-completion` (HEAD `33c927e` — Cash Flow S1–S5 recompose landed)
**Scope:** Composition and presentation redesign of the Liquidity Perspective to match the reference mockup's layout hierarchy. No widget replacement, no engine changes, no new time model, no Space-navigation changes.
**Reference:** attached dashboard mockup — Accessible Cash · Liquidity Trend · Liquidity Ladder · Reachability by Category · What Changed · Liquidity Concentration · Cash Flow Outlook · Liquidity Accounts. Layout/hierarchy reference only, not a literal spec; several regions are historical/projective and are explicitly deferred (§2).

**Non-negotiable invariant (user-stated, decided, not open for reinterpretation):** this is a **CURRENT-STATE-ONLY** redesign. `asOf`/`compareTo`/historical reads are NOT wired into Liquidity in this slice — presentation and composition changes only. Reason (verified in-repo): `lib/perspective-engine/lenses/liquidity.ts` already carries full as-of logic (A5-P2, kill-switched — the `options.asOf` branch at `:45–54`, envelope stamping at `:102–108`, tested in `lib/perspective-engine/liquidity.asof.test.ts`), **but** `lib/data/accounts-asof.core.ts` holds every non-cash account (investments, crypto, manual assets, installment loans) **flat at TODAY'S balance for every historical date** — the `held-flat` branch at `:151–153` (`method: "held-flat", tier: "estimated"`). Wiring `asOf` into Liquidity now would make it silently disagree with Wealth/Investments on the same historical date for any Space holding investments or crypto. That reconciliation is deferred, likely paired with the Investments-on-A10 UI work — not bundled here.

---

## 1. Repository findings

### 1.1 Entry point and rendering path

- Host: `components/dashboard/SpaceDashboard.tsx` (~3,500 lines). In the Perspectives tabpanel, two perspectives now have bespoke composition branches — `wealth` (`:3177`, `WealthPerspective`) and `cashFlow` (`:3203`, `CashFlowPerspective` imported as `CashFlowPerspectiveWorkspace`, `:103`). **Liquidity still renders through the generic fallback** (`:3220`): `toVirtualSections(activePerspective.id, activePerspective.widgets)` → a vertical `SectionCard` stack (`space-y-3`, single column).
- The Liquidity widget list is `lib/perspectives.ts:155`:
  `widgets: ["liquidity_ladder", "accessible_cash", "emergency_fund_readiness", "liquidity_concentration"]`
  Doctrine (same file, `:151–154`): Liquidity answers "How accessible is my money?" — access and readiness, not total wealth; assets only; purpose-built widgets, no Overview/Wealth reuse.
- All four keys are in `SOLID_LEDE_KEYS` (`SpaceDashboard.tsx:1648`), so each `SectionCard` renders as `GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4"` with a `text-sm font-semibold` header (`:1794–1799`). Labels come from `lib/widget-registry.ts:249–290` (Liquidity Ladder / Accessible Cash / Emergency Fund Readiness / Liquidity Concentration).
- Renderer dispatch: `SectionRegistry` (`SpaceDashboard.tsx:1356–1359`) → `components/space/widgets/liquidity-adapters.tsx`, each entry `(p) => renderX(p.accounts, p.ctx)`.

### 1.2 Widget inventory (all currently mounted, in this order)

| # | Key | Renderer (`liquidity-adapters.tsx`) | Responsibility | Data source |
|---|-----|-------------------------------------|----------------|-------------|
| 1 | `liquidity_ladder` | `renderLiquidityLadder` (`:84`) | Assets by access horizon — "Available now" (checking·savings) / "Available in days" (brokerage·crypto settlement) / "Illiquid" (property·long-term). Horizon-ordered `BreakdownWidget` bars, NOT value-sorted | `classifyAccounts(accounts, ctx)` |
| 2 | `accessible_cash` | `renderAccessibleCash` (`:112`) | KPI: reachable-now cash headline (color-thresholded at 15%/5% of assets), reachable-within-days stat, share-of-assets stat. Runway deliberately NOT computed (no expense baseline — "we don't fake precision") | `classifyAccounts` |
| 3 | `emergency_fund_readiness` | `renderEmergencyFundReadiness` (`:147`) | KPI: reachable cash as a safety buffer; months-of-coverage honestly absent — "Set a monthly expense target" | `classifyAccounts` |
| 4 | `liquidity_concentration` | `renderLiquidityConcentration` (`:177`) | Ranked `BreakdownWidget` bars of LIQUID (reachable-now) accounts only, with names/institutions and per-account share | `classifyAccounts().liquid` |

Presenters reused: `BreakdownWidget.tsx` (bar/list/donut view modes) and `SummaryWidget.tsx` (primary KPI + stats grid + empty state). All four renderers are pure presentational functions over `(accounts, ctx)` — no fetching, no state, no time input.

An important adapter honesty note (`liquidity-adapters.tsx:16–20`): the schema does not distinguish retirement accounts from taxable brokerage, so there is **no honest "locked/penalty" tier**, and no settlement-day granularity beyond "days". The three horizons are the maximum honest ladder today.

### 1.3 Data and time ownership — confirmed current-only, and kept that way

- **Data:** the host owns everything. `accounts` is host state; the conversion context is `widgetCtx` (`SpaceDashboard.tsx:2344–2347`, rehydrated `/api/user/money-context`). Widgets are pure over props.
- **Time:** Liquidity receives **no time input at all**. The `SectionCard` props that reach it are `accounts` + `ctx` only — `period`/`onSelectPeriod` exist on `SectionCard` but no liquidity renderer reads them, and `asOf`/`compareTo` never leave the shell toward any widget. Moving the shell's As Of / Compare To has zero effect on the Liquidity workspace today. **This plan preserves exactly that.**
- **Lens engine (current-state):** the host batch-fetches `GET /api/spaces/[id]/perspectives` (`:2717–2718`) with **no `asOf` parameter — the A5-P2 kill switch stays closed** — into `lensResults` keyed by lensId (`:2316`). Today that result reaches only (a) the Overview doorway card (`PerspectivesWidget` renders `verdict` + `headline`, `:119–171` of that file) and (b) the shell envelope (§1.5). The Liquidity **workspace** never shows the engine's answer — landed logic, unsurfaced presentation (the exact shape Cash Flow's S4 consumed for `cash-flow-compare.ts`).
- **Lens/widget consistency:** `lib/perspective-engine/lenses/liquidity.core.ts:41–43` states the lens sums deliberately mirror the dashboard's `classifyAccounts()` behavior, and its headline metric is `cashNow` ("Available as cash now", `:212–218`) — the same figure the Accessible Cash widget leads with. Surfacing the verdict in the workspace is therefore consistent by design (and creates a duplicate-KPI risk handled in §3.4/§5).

### 1.4 Canonical read models available (landed, tested)

- `lib/account-classifier.ts` — `classifyAccounts` (typed buckets `liquid`/`investments`/`digitalAssets`/`realAssets` preserving the input row shape incl. names, plus pre-computed totals), `accountTier`. The single classification authority for all four widgets.
- `lib/transactions/liquidity.ts` — the liquidity axis over transactions: `classifyLiquidity` (`:117`), `tierResolver` (`:94`), `deriveCashFlowAxes` (`:268`). Pure, unit-tested (`lib/transactions/liquidity.test.ts`).
- `lib/transactions/liquidity-breakdown.ts` — `groupLiquidityByReason` (`:94`) with `LIQUIDITY_REASON_LABEL` (`:25`): cash-in/cash-out totals grouped by reason (income, transfers in/out, debt payments, spending, …). Already consumed by Cash Flow widgets. This is the ready-made model for the mockup's "What Changed" region.
- `lib/perspective-engine/types.ts` — `LensResult` (`verdict`, `headline: LensMetric`, `metrics`, `assumptions`, `provenance` incl. `dataAsOf` + `tierCounts` + `redactions`, `estimated`). Serialisable, deterministic, name-free by contract.

### 1.5 Envelope — already correct, explicitly untouched

`lib/perspectives/envelope.ts:170–172`: the `liquidity` case maps the fetched `LensResult` through `lensEnvelope` (`:126–141`) — Observed/Estimated tier from `lens.estimated`, detail "Live account balances… as of <provenance.dataAsOf>", evidence chip "N accounts". This is a **current-state provenance envelope, already dynamic in the right way**. Per the stated constraint it does NOT get the dynamic-stamp treatment Cash Flow got in S4 — no `liquidityStamp`, no completeness recomputation, **zero diff in `envelope.ts`**. (`envelope.test.ts` stays untouched and green.)

### 1.6 Layout primitives, precedent

- Two landed composition precedents: `components/space/widgets/wealth/WealthPerspective.tsx` (root grid `grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0`, `:65`; spans 4/8, 6/6, 12) and `components/space/widgets/cashflow/CashFlowPerspective.tsx` (same 12-col root with `items-stretch`, a local non-exported `Panel` helper reproducing the SectionCard solid-lede treatment, adapter renderers reused, lg/xl span pairs, flex-stacked side column). **Liquidity's content shape — KPI tiles + ranked/segmented breakdowns, no dominant calendar — sits between the two; the Cash Flow file is the closer mechanical template (Panel helper + adapter reuse + `items-stretch`), and this plan mirrors it.** No new abstraction.
- Breakpoints: Tailwind defaults; every grid child `min-w-0`; no fixed heights.

### 1.7 Concurrent-modification constraints — verified now

`FOURTH_MERIDIAN_A6_A7_A8_P5_PARALLELIZATION_INVESTIGATION_2026-07-12.md` §9: `components/dashboard/SpaceDashboard.tsx` is **single-owner, primary branch, never a worktree, HIGH merge risk**. Verified at plan time: `git worktree list` shows only the primary checkout on `feature/v2.5-spaces-completion`; `git status` shows only untracked docs (no in-flight code edits); all other local sessions are idle (none holds this file); STATUS.md records the Cash Flow redesign as landed (`4265033`/`85a7539`/`33c927e`), not in-flight. Same rule applies to this work: primary branch only, one bounded branch insertion, land promptly.

### 1.8 Tests and conventions

House pattern: standalone `tsx` scripts (`*.test.ts`) discovered by `npm test` → `scripts/run-tests.ts`; colocated source-scan tests for compositions (`CashFlowPerspective.test.ts` is the direct template — widget-mount counts, grid/span/`min-w-0` locks, no-fixed-height lock, source-order lock, forbidden-import lock, host-branch prop scan). Existing coverage that must stay green: `lib/perspectives/virtual-sections.test.ts:58–65` (locks the exact Liquidity widgets[] list AND its no-Overview/Wealth-reuse doctrine), `lib/perspective-engine/liquidity*.test.ts` (core, as-of, MC1 — all untouched), `lib/perspectives/envelope.test.ts`, `lib/transactions/liquidity*.test.ts`.

### 1.9 Requirement classification

| Requirement | Status |
|---|---|
| Shared shell owns preset/asOf/compareTo/evidence/completeness/tabs | **already landed** (Liquidity envelope already lens-driven) |
| Ladder / Accessible Cash / Emergency Readiness / Concentration widgets | **already landed** — relocation + wrapper only |
| Multi-panel grid composition | **missing** — mirror the Cash Flow/Wealth composition (new component, no new abstraction) |
| Lens verdict/headline surfaced in the workspace | **missing presentation; logic landed & fetched** (`lensResults["liquidity"]` — user-approved for this slice) |
| Reachability-by-type share view | **missing presentation; data landed** (`classifyAccounts` type buckets + `BreakdownWidget` donut mode) |
| "What Changed" liquidity drivers | **missing presentation; logic landed** (`groupLiquidityByReason`, already Cash-Flow-proven) |
| Liquidity Trend (historical series) | **deferred** — requires asOf/history; blocked on held-flat reconciliation (header constraint) |
| Cash Flow Outlook (projections) | **deferred** — no landed projection model; Time Machine timeline-simulation initiative territory |
| Any "change since <date>" delta / "Most Improved" | **deferred** — historical comparison, same constraint |
| 4-tier settlement ladder / coverage multiple | **not honestly buildable** — no retirement/settlement typing, no expense baseline (adapter doctrine §1.2) |

---

## 2. Reference-to-repository mapping

| Mockup region | Fourth Meridian source | Fit / disposition |
|---|---|---|
| **Accessible Cash** (top-left): "$9,754 reachable right now (cash)", This Period tile | `accessible_cash` | **Direct.** Headline + share-of-assets + reachable-within-days already exist. The "+$3,218 (+49.2%) since Jan 1, 2025" delta and the compare tile are **historical — omitted** (deferred with the asOf reconciliation). Internal implementation untouched. |
| **Liquidity Trend · All Time** (top-right, dominant): accessible-cash-over-time chart, Line/Area/Bar toggle | none | **Deferred region — not built.** An accessible-cash history is an asOf/historical read into Liquidity; even a cash-only series would cross the decided constraint, and any asset-inclusive variant hits held-flat disagreement directly. The Liquidity Ladder takes this slot's visual dominance instead (§3.3). Revisit with the A10-paired reconciliation. |
| **Liquidity Ladder**: Now/7/30/90+ day tier tiles with per-tier account rows; footer Total Liquidity / Total Assets / "2.8x of monthly expenses" | `liquidity_ladder` | **Direct with honest reduction.** Three horizons (now / days / illiquid), not four — no settlement/retirement typing exists (§1.2). S2 upgrades presentation to tier tiles with per-tier totals, % of assets, and per-tier account rows — all derivable client-side from `classifyAccounts` buckets (names included, as Concentration already shows). Footer: Total liquidity + Total assets (both landed totals). Coverage multiple **omitted** — no monthly-expense baseline (the same honesty rule the EFR widget already enforces). |
| **Reachability by Category** (donut): Checking/Savings/Brokerage Cash/Settlement/Crypto Cash/Other shares; Top Category; Most Improved | none mounted | **New thin panel over landed data.** `BreakdownWidget` donut over `classifyAccounts` type totals — honest labels are Checking / Savings / Investments / Crypto / Other (no brokerage-cash/settlement split in schema). "Top category" stat derivable; "Most Improved +198%" is **historical — omitted**. |
| **What Changed**: top liquidity drivers this period, signed amounts, "View all activity in Cash Flow" link | none mounted | **New thin panel over landed, Cash-Flow-proven logic** — `groupLiquidityByReason` top cash-in/cash-out reasons for the shell-bridged `cashFlowPeriod`. Deterministic, no AI, no new classification. The deep link is a host callback to the Cash Flow perspective (mirroring the mockup's own framing that activity detail lives in Cash Flow). S4; see §3.5. |
| **Liquidity Concentration**: ranked per-account bars with amounts + % | `liquidity_concentration` | **Near-exact.** Existing widget already renders ranked bars with names, institutions, amounts, shares. The mockup's "Top 3 accounts / account count" footer is optional S5 polish computed from the same items in the composition wrapper (never inside the widget); cut without regret. |
| **Cash Flow Outlook**: projected accessible-cash changes next 7/30/90 days | none | **Deferred region — not built.** No landed projection model for liquidity; simulation belongs to the Time Machine timeline-simulation initiative. Never fabricated. |
| **Liquidity Accounts** table: per-account Type/Reachability/This Period/Change vs Jan 1 | none | **Deferred region — not built.** Its honest columns (account, type, reachability tier) duplicate Concentration + the S2 ladder rows; its interesting columns (This Period, Change vs Jan 1) are historical. Building the honest subset would be a duplicate surface — overengineering check rejects it. |
| — (not in mockup) | `emergency_fund_readiness` | **No mockup region — must remain mounted** (the mockup folds "coverage" into the ladder footer, which we can't honestly compute). Placement: stacked beneath Accessible Cash — its sibling KPI — visually quiet. Never deleted, never duplicated. |
| — (not in mockup; user-approved) | `lensResults["liquidity"]` verdict/headline | **New slim lede strip** over the already-fetched LensResult (§3.4). Current-state-only; no new fetch; absent/error ⇒ strip absent. |

Preservation proof: all four mounted widgets appear exactly once in the target grid; `lib/perspectives.ts` widgets[] unchanged, so `virtual-sections.test.ts:58–65` continues to lock the inventory; `liquidity-adapters.tsx` renderers stay the registry's renderers (untouched file); internal widget/presenter files (`BreakdownWidget`, `SummaryWidget`) untouched.

---

## 3. Exact implementation design

### 3.1 Approach — smallest honest implementation

One new layout component mirroring the landed `CashFlowPerspective` mechanics (local `Panel` helper, adapter renderers reused, 12-col grid); existing widgets relocated unchanged; two thin new panels + one lede strip built strictly over landed models; one bounded branch swap in `SpaceDashboard.tsx`. **No registry, no schema-driven layout, no grid engine, no new card primitives, no engine/envelope/lens diffs, no time model.** The composition must contain **zero occurrences of `asOf`** — enforced by test (§7).

### 3.2 Files

**Add (all under `components/space/widgets/liquidity/`):**
- `LiquidityPerspective.tsx` — the composition (grid + local `Panel` helper copied in mechanic from `cashflow/CashFlowPerspective.tsx:61–70`; owns NO state beyond pass-through). Includes the small local lede renderer and the Reachability donut render (both thin; see §3.4).
- `LiquidityLadderTiers.tsx` — S2: the upgraded ladder presenter (tier tiles + per-tier account rows) over `classifyAccounts`. Pure; the registry's `renderLiquidityLadder` stays untouched as the generic-path renderer (same pattern as Cash Flow's Spending panel calling `CashFlowCategoryBreakdown` directly while the adapter survives).
- `liquidity-what-changed.ts` + `liquidity-what-changed.test.ts` — S4: pure row-builder over `groupLiquidityByReason` (top N cash-in + cash-out reasons with labels from `LIQUIDITY_REASON_LABEL`, signed display amounts; empty/loading sentinels mirroring the Cash Flow adapters).
- `LiquidityWhatChangedCard.tsx` — S4: the panel body (rows + "View all activity in Cash Flow →" action via an `onOpenCashFlow` callback prop).
- `LiquidityPerspective.test.ts` — colocated source-scan test (§7).

**Modify:**
- `components/dashboard/SpaceDashboard.tsx` — ONE bounded change in the Perspectives tabpanel: insert an `activePerspectiveId === "liquidity"` branch between the `cashFlow` branch (`:3203`) and the generic virtual-sections fallback (`:3220`), rendering `<LiquidityPerspective accounts={accounts} ctx={widgetCtx} lensResult={lensResults?.["liquidity"] ?? null} … />`. S4 additionally threads `transactions={spaceTransactions}`, `txCtx={txConversionCtx}`, `period={cashFlowPeriod}`, `onOpenCashFlow={() => setSelectedPerspectiveId("cashFlow")}`, adds `const liquidityWorkspaceActive = activeTab === "PERSPECTIVES" && activePerspectiveId === "liquidity";` beside its siblings (`:2615–2624`), and extends the transactions-fetch guard (`:2774`) from `!cashFlowActive` to `!cashFlowActive && !liquidityWorkspaceActive` (comment updated). Nothing else in this file changes.

**Explicitly untouched:** `liquidity-adapters.tsx`, `BreakdownWidget.tsx`, `SummaryWidget.tsx`, `lib/perspectives.ts` (widgets[] stays for inventory parity), `lib/perspectives/envelope.ts` (§1.5 — the stated constraint), `lib/perspective-engine/**` (lens, core, types, registry), `lib/data/accounts-asof*` , `lib/account-classifier.ts`, `lib/transactions/liquidity*.ts`, `usePerspectiveShellState.ts`, `PerspectiveShell.tsx`, all Wealth/Cash Flow/Investments/Debt/Goals files, Space navigation.

### 3.3 Grid structure

`LiquidityPerspective.tsx` root (mirrors `CashFlowPerspective.tsx:125`):

```tsx
<div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch min-w-0">
  {/* ⓪ Lens lede — slim strip, rendered ONLY when lensResult?.status === "ok" */}
  <div className="min-w-0 lg:col-span-12">…verdict strip…</div>
  {/* ① KPI column: Accessible Cash + Emergency Fund Readiness (quiet sibling) */}
  <div className="min-w-0 lg:col-span-5 xl:col-span-4 flex flex-col gap-4">
    <Panel title="Accessible Cash">…renderAccessibleCash…</Panel>
    <Panel title="Emergency Fund Readiness" subdued>…renderEmergencyFundReadiness…</Panel>
  </div>
  {/* ② Liquidity Ladder — the visually dominant panel (takes the deferred Trend slot's weight) */}
  <div className="min-w-0 lg:col-span-7 xl:col-span-8">
    <Panel title="Liquidity Ladder">…S1: renderLiquidityLadder / S2: <LiquidityLadderTiers/>…</Panel>
  </div>
  {/* ③ Reachability by Type */}
  <div className="min-w-0 lg:col-span-6 xl:col-span-5">
    <Panel title="Reachability by Type">…BreakdownWidget donut over type totals…</Panel>
  </div>
  {/* ④ Liquidity Concentration */}
  <div className="min-w-0 lg:col-span-6 xl:col-span-7">
    <Panel title="Liquidity Concentration">…renderLiquidityConcentration…</Panel>
  </div>
  {/* ⑤ What Changed (S4; S1–S3 render nothing here — the 5-panel grid stays valid) */}
  <div className="min-w-0 lg:col-span-12">
    <Panel title="What Changed"><LiquidityWhatChangedCard …/></Panel>
  </div>
</div>
```

**Specs:**
- Desktop (`xl` ≥1280): lede 12; row 1 = KPI column 4 / Ladder 8; row 2 = Reachability 5 / Concentration 7; row 3 = What Changed 12 (internal rows reflow `sm:grid-cols-2`).
- Tablet (`lg` 1024–1279): lede 12; KPI column 5 / Ladder 7; Reachability 6 / Concentration 6; What Changed 12.
- Mobile (<1024): single column, source order = **Lede → Accessible Cash → Emergency Fund Readiness → Ladder → Reachability → Concentration → What Changed.** (Mockup hierarchy leads with the accessible-cash answer; EFR follows its sibling KPI immediately — deliberate, documented deviation from the generic stack order, which led with the ladder.)
- Heights/overflow: `items-stretch` + `h-full` panels, no fixed heights, no internal scroll, every child `min-w-0`, `gap-4` throughout — identical to the Cash Flow contract.

### 3.4 Lens lede + Reachability donut (presentation-only, landed data)

- **Lede:** renders ONLY on `lensResult?.status === "ok"`. One slim `GlassPanel` row: the `verdict` sentence as the lead text, `provenance.dataAsOf` as a muted "as of" suffix, `≈` prefix when `estimated` (matching `PerspectivesWidget`'s convention), and `provenance.redactions` count as a muted note when present. **It does NOT render the `headline` metric as a KPI tile** — the lens headline is `cashNow` (`liquidity.core.ts:212–218`), the exact figure Accessible Cash leads with; the lede references, never restates (the Cash Flow "duplicate totals" rule). Small local metric formatting only if needed; no import from `components/dashboard/widgets/`. Absent/`empty`/`error` lensResult ⇒ the strip is absent entirely — the grid renders identically minus row ⓪; no placeholder, no fabricated sentence.
- **Reachability by Type:** `BreakdownWidget viewMode="donut"` over five type totals from `classifyAccounts` (`totalChecking`, `totalSavings`, `totalInvestments`, `totalDigitalAssets`, `totalRealAssets`), zero-filtered, with the ladder's existing color language and a "top type" footnote derived from the same items. No new chart system — the donut mode already exists (`BreakdownWidget.tsx:374`).

### 3.5 What Changed panel (S4)

Deterministic, sourced entirely from landed models — no AI, no new classification, no new time model:

- `liquidity-what-changed.ts` exports `buildWhatChangedRows({transactions, accounts, period, ctx})`: `filterByPeriod` (the same `lib/transactions/cash-flow.ts` helper Cash Flow uses) → `groupLiquidityByReason` → top 3 cash-in + top 3 cash-out reason rows (label from `LIQUIDITY_REASON_LABEL`, signed converted amounts). Loading (`transactions == null`) and empty-period sentinels mirror the Cash Flow adapters verbatim.
- **Time posture:** the period is the existing shell-bridged `cashFlowPeriod` — the SAME host state Cash Flow consumes, resolved against `now()`. This is transaction-window filtering relative to today, not an `asOf` balance read — the current-state constraint is untouched, and no second time model is created. The panel header names the window via `periodLabel(period)`.
- The "View all activity in Cash Flow →" row calls `onOpenCashFlow` (host: `setSelectedPerspectiveId("cashFlow")`) — the mockup's own doorway, honoring the doctrine that spending/income analysis lives in Cash Flow, not Liquidity.
- Host cost: the `liquidityWorkspaceActive` fetch-trigger extension (§3.2) so transactions exist when Liquidity opens first; guarded by the existing `spaceTransactions === null` once-only check.

### 3.6 Temporal-model statement (the constraint, restated as design)

Nothing changes. The four balance widgets + donut + lede are point-in-time current; the shell's As Of / Compare To continue to have no effect on this workspace (identical to today's audited behavior); the envelope stays lens-provenance-driven with zero diff. The as-of machinery (`lenses/liquidity.ts` A5-P2 branch, `getAccountsAsOf`) remains landed, tested, kill-switched, and **unconsumed by this UI** until the held-flat reconciliation (`accounts-asof.core.ts:151–153`) lands — likely with the Investments-on-A10 UI work. Any implementation step that finds itself importing `getAccountsAsOf`, passing `asOf`, or computing a historical series is out of scope by definition (stop condition 1).

---

## 4. Slice plan (each independently compilable and shippable)

- **S1 — Layout shell + relocation.** Add `LiquidityPerspective.tsx` (Panel helper + 4-panel grid: KPI column / Ladder via `renderLiquidityLadder` / Reachability slot deferred to S3 if desired — simplest: ship S1 with the four existing widgets only, spans adjusted so the grid is complete without ③/⑤); add the `liquidity` branch in `SpaceDashboard.tsx` passing `accounts`/`ctx`/`lensResult`. Functional parity checkpoint: every widget renders identically to the old stack, including empty states.
- **S2 — Ladder tier presentation.** `LiquidityLadderTiers.tsx` (three tier tiles: total, % of assets, per-tier account rows; footer Total liquidity / Total assets) mounted by the composition; registry adapter untouched. Honest-reduction notes rendered as tile metas (the adapter's existing meta strings).
- **S3 — Lens lede + Reachability donut.** The ⓪ strip and ③ panel per §3.4. No new fetch, no envelope change.
- **S4 — What Changed.** `liquidity-what-changed.ts` (+ test), `LiquidityWhatChangedCard.tsx`, host threading (`transactions`/`txCtx`/`period`/`onOpenCashFlow`), `liquidityWorkspaceActive` fetch-trigger extension.
- **S5 — Responsive audit, tests, polish.** lg/xl spans, mobile order, 360px reachability, no horizontal overflow; optional Concentration footer stats (cut freely); §7 suite green; lint/type clean; STATUS.md note per maintenance rule.

If S4 proves contentious mid-flight, S1–S3+S5 ship as a complete slice (the 5-panel grid stays valid without row ⑤); S4 must not block them.

---

## 5. Risks

- **`SpaceDashboard.tsx` merge risk (HIGH):** single-owner file; A6/A7/A8/P5 streams are active but forbidden from `components/**`. Mitigation: primary branch only, one ~25-line additive branch + one guard-line edit, land S1 promptly, STATUS.md coordination. Re-verify no in-flight edits immediately before starting (stop condition 3).
- **asOf scope creep (the defining risk):** the trend region and every mockup delta invite "just read a little history". Every such read is deferred by decision, with the held-flat disagreement as the recorded reason. The source-scan test makes the constraint mechanical (no `asOf`, no `accounts-asof`, no `getAccountsAsOf` strings in the composition).
- **Duplicate KPI:** lens headline (`cashNow`) ≡ Accessible Cash headline. The lede renders the verdict sentence only (§3.4); if implementation finds the strip visually demanding a number, shrink the strip, never add a second KPI.
- **Lede/widget disagreement at the margins:** lens sums are server-side (KD-19 tiers, lens-date conversion) vs client `classifyAccounts` over host accounts. `liquidity.core.ts` mirrors `classifyAccounts` by design, but BALANCE_ONLY/SUMMARY_ONLY edge cases could differ by small amounts. Pre-existing condition (doorway card vs workspace already coexist); acceptable because the lede is a sentence, not a competing figure. Do not "fix" by recomputing the verdict client-side.
- **Ladder tile density:** three tiles with account rows inside an 8/12 panel; long account lists could stretch row 1. Cap per-tier rows (e.g. top 4 + "+N more" meta) in `LiquidityLadderTiers` — presentation only; never a fixed height.
- **Empty states:** no-assets Spaces must render the adapters' existing empty summaries in the new panels without a lonely stretched card; the lede is absent when the lens returns `empty`. Verify explicitly in S5.
- **What Changed vs Cash Flow overlap:** the panel shows liquidity-axis reasons and points to Cash Flow for detail — it must never grow drill-down drawers or filters (that's Cash Flow's workspace).

## 6. Overengineering check

Confirmed feasible as: **one new composition + one tier presenter + one pure row-builder + one thin card + one host branch.** Rejected: widget registry extension, schema-driven layout, grid engine, a Liquidity trend/history stack, projection models, a per-account table duplicating Concentration, envelope/stamp machinery (already correct), any engine or lens diff, a client-side verdict recomputation. Two landed precedents prove the shape ships and stays maintainable.

## 7. Testing expectations (house pattern: standalone tsx `*.test.ts` via `scripts/run-tests.ts`)

`components/space/widgets/liquidity/LiquidityPerspective.test.ts` (source-scan, template: `cashflow/CashFlowPerspective.test.ts`):
1. All four widget renderers/presenters mounted exactly once (`renderAccessibleCash(`, `renderEmergencyFundReadiness(`, ladder presenter, `renderLiquidityConcentration(`); no duplicate mounts.
2. Grid contract: `lg:grid-cols-12`, `items-stretch`, the §3.3 span pairs, `min-w-0` on every child, no `h-[`/`max-h-[`.
3. Source order = mobile stacking order (lede → Accessible Cash → EFR → Ladder → Reachability → Concentration → What Changed).
4. **Current-state lock:** source contains no `asOf`, no `accounts-asof`, no `getAccountsAsOf`, no `usePerspectiveShellState`, no import from `wealth/` or `cashflow/` component folders.
5. `SpaceDashboard` scan: the `liquidity` branch exists, precedes the generic virtual-sections branch, and passes `accounts`, `ctx`, `lensResult` (+ S4: `transactions`, `txCtx`, `period`, `onOpenCashFlow`).

Plus: S4 `liquidity-what-changed.test.ts` (deterministic fixtures, injected clock via period fixtures; loading/empty sentinels); `lib/perspectives/virtual-sections.test.ts` unchanged and green (widgets[] inventory + doctrine lock); `lib/perspectives/envelope.test.ts` unchanged and green (zero envelope diff); all `lib/perspective-engine/liquidity*.test.ts` and `lib/transactions/liquidity*.test.ts` untouched and green. No diffs outside §3.2's list (assert via `git diff --name-only` in the gate).

## 8. Validation gate (run in order; all must pass)

```bash
npx tsc --noEmit
npx eslint
npm test                       # scripts/run-tests.ts — all *.test.ts under lib/ app/ components/
git diff --name-only           # must contain ONLY the files listed in §3.2
npm run dev                    # manual pass: desktop xl, ~1100px lg, 375px mobile;
                               # parity of all four widgets vs the old stack (incl. empty states);
                               # lede present only on ok lensResult (kill the fetch to verify absence);
                               # As Of / Compare To changes have ZERO effect on this workspace;
                               # shell preset changes re-window ONLY the What Changed panel (S4);
                               # What Changed deep-link lands on the Cash Flow perspective;
                               # no horizontal overflow anywhere
```

## 9. Stop conditions — halt and report instead of proceeding if:

1. Any panel turns out to require `asOf`/`compareTo`/historical balance reads, `getAccountsAsOf`, or a time series — the current-state-only constraint is decided; do not reinterpret it, do not build a "small" exception.
2. Implementation would require touching `lib/perspective-engine/**`, `lib/perspectives/envelope.ts`, `lib/data/accounts-asof*`, `liquidity-adapters.tsx` internals, or replacing/deleting any of the four mounted widgets.
3. `SpaceDashboard.tsx` or `components/space/shell/*` are actively owned by another session/stream (check STATUS.md, `git status`, and in-flight branches first).
4. A mockup region cannot be mapped without fabricating data (trend, outlook, historical deltas, settlement tiers, and coverage multiples are ALREADY declared deferred/omitted — do not attempt them).
5. Scope drifts beyond Liquidity presentation (any diff in Wealth/Cash Flow/Investments/Debt/Goals widgets, Space navigation, the shell time model, or the lens fetch contract beyond the documented trigger extension).

---

**Final instruction to the implementation session:** the attached mockup is a layout and hierarchy reference, not a data spec — several of its regions are historical or projective and are explicitly deferred above. Adapt its composition to the four landed widgets, the landed lens result, and the landed liquidity transaction models; preserve every existing capability; keep the workspace current-state-only (the as-of machinery stays kill-switched and unconsumed); keep the `SpaceDashboard.tsx` footprint to the single documented branch plus the one fetch-guard line. When in doubt, prefer the smaller change and the Cash Flow precedent.
