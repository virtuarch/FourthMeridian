# Fourth Meridian — Cash Flow Perspective Redesign: Investigation & Claude Code Implementation Plan

**Date:** 2026-07-12
**Branch of record:** `feature/v2.5-spaces-completion` (HEAD `bd8b2a5` — Wealth S8/S9 recompose landed)
**Scope:** Composition and presentation redesign of the Cash Flow Perspective to match the reference image's layout hierarchy. No widget replacement, no new time model, no Space-navigation changes.
**Reference:** attached dashboard mockup — top row (Cash Flow Summary · Cash Flow History · Spending by Category), bottom row (Income by Source · Key Insights). Layout/hierarchy reference only, not a literal spec.

**Non-negotiable invariant (user-stated):** the calendar/heatmap's usability stays EXACTLY the same — same modes, filters, drill-downs, year navigation, tooltips, and interactions — while the perspective integrates with the same central knowledge layer (shared Perspective Shell time + trust envelope + canonical read models) the other perspectives use.

---

## 1. Repository findings

### 1.1 Entry point and rendering path

- Host: `components/dashboard/SpaceDashboard.tsx` (3,493 lines). The Perspectives tab branch is at ~`:3117`. `PerspectiveShell` renders at `:3126`; below it, `activePerspectiveId === "wealth"` gets a bespoke composition (`WealthPerspective`, `:3160–3185`), while **every other workspace-backed perspective — including Cash Flow — renders `toVirtualSections(...)` → a vertical `SectionCard` stack (`space-y-3`, single column) at `:3186–3209`.**
- The Cash Flow widget list is `lib/perspectives.ts:115`:
  `widgets: ["cash_flow_summary", "cash_flow_history", "cash_flow_by_category", "income_by_source", "debt_payments"]`
  (`income_vs_spending` is retired from the active list; its renderer is kept in `cash-flow-adapters.tsx` for reuse.)
- `lib/perspectives/virtual-sections.ts` synthesizes render-only sections; `SectionCard` (`SpaceDashboard.tsx:1652`) wraps each in `GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4"` because all five keys are in `SOLID_LEDE_KEYS` (`:1642–1650`). The `cash_flow_summary` header appends the active period: `` `${label} · ${periodLabel(period)}` `` (`:1788–1790`).
- Renderer dispatch: `WIDGET_RENDERERS` (`SpaceDashboard.tsx:1354–1362`) → `components/space/widgets/cash-flow-adapters.tsx` (thin adapters) → widget components.

### 1.2 Widget inventory (all currently mounted, in this order)

| # | Key | Component (file) | Responsibility | Data source |
|---|-----|------------------|----------------|-------------|
| 1 | `cash_flow_summary` | `components/space/widgets/CashFlowSummaryWidget.tsx` (319 ln) | Net cash headline; Cash In/Out axis tiles with reason drill-downs; "Spent on credit"; "Moved, not spent" context (between accounts, unresolved transfers, cash withdrawals); economic⇄liquidity toggle | `deriveCashFlowAxes`, `groupLiquidityByReason`, `aggregateDayFacts`, `groupCashFlowContext` |
| 2 | `cash_flow_history` | `components/space/widgets/CashFlowHistoryWidget.tsx` (373 ln) + `CashFlowCalendar.tsx` (304 ln) | Calendar/Cards modes; perspective+measure filter (`CashFlowFilterControls`); Month/Quarter/Year historical selects; All-Time year nav; day/bucket drill-down drawer | `bucketDayFacts`, `projectDailyFacts` (`cash-flow-projection.ts`) |
| 3 | `cash_flow_by_category` | `components/space/widgets/CashFlowCategoryBreakdown.tsx` (182 ln) via adapter | Allocation strip + category cards (`grid-cols-1 sm:grid-cols-2`, `:120`), drill-down per category | `outflowByCategory` |
| 4 | `income_by_source` | same presenter, income-oriented (adapter `renderIncomeBySource`) | Liquidity: cash-in by reason; economic: income by source | `groupLiquidityByReason` / `incomeBySource` |
| 5 | `debt_payments` | `components/space/widgets/DebtPaymentsWidget.tsx` | Debt payments by creditor (liquidity twin of Spending by Category) | `classifyLiquidity` DEBT_PAYMENT, `groupDebtPaymentsByCreditor` |

Shared sub-components: `CashFlowFilterControls.tsx`, `CashFlowPeriodSelector.tsx` (now mounted INSIDE `PerspectiveShell.tsx:68` as the shared preset row), `TransactionSliceDrawer.tsx`.

### 1.3 Data and time ownership

- **Data fetching:** `SpaceDashboard` owns it all — transactions fetch is triggered by `cashFlowActive` (`:2758–2773`), accounts/snapshots are host state, conversion context is `txConversionCtx` (`:2632`). Widgets are pure over props. No widget fetches.
- **Time:** `usePerspectiveShellState` (`components/space/shell/usePerspectiveShellState.ts`) is the ONE owner of `{preset, asOf, compareTo}` with URL sync. **The legacy period bridge is alive and already bounded:** `cashFlowPeriod` state at `SpaceDashboard.tsx:2512`, synced event-driven from shell preset selection (`handleSelectSlice`, `:2541`) and from compare-to preset inference (`:2536–2540`); under CUSTOM the shell imposes nothing and Cash Flow holds its last period (§3.5 doctrine, `usePerspectiveShellState.ts:89–91`). The History widget's Month/Quarter/Year selects drill explicit periods via `onSelectPeriod` → `setCashFlowPeriod`.
- **Known current behavior (do not change in this slice):** `filterByPeriod` resolves relative periods against `now()`, not `asOf` — moving As Of does not re-window Cash Flow today. `compareTo` is not consumed by any Cash Flow widget.
- **Shell props reaching Cash Flow:** only `period` / `onSelectPeriod` / `perspective` / `filterId` / `onPerspectiveChange` via `SectionCard` (`:3200–3204`). `asOf`/`compareTo` never reach Cash Flow widgets.

### 1.4 Canonical read models

`lib/transactions/cash-flow.ts` (period model, aggregation, `periodLabel`), `cash-flow-projection.ts` (shared two-axis DayFacts projection + measure registry), `cash-flow-context.ts` (moved-not-spent context), `liquidity.ts` / `liquidity-breakdown.ts` (axes + reasons), `debt-payments.ts`. All pure and unit-tested.

### 1.5 `cash-flow-compare.ts` — confirmed orphaned

`lib/transactions/cash-flow-compare.ts` (274 ln, P1 "Cash Flow Time Machine lib phase", landed `d8271e6`) exports `cashFlowStamp()` (Completeness envelope per period) and `compareCashFlow()` (Then-vs-Now deltas: totals + per-category movers + worst-of completeness). **Its only importer is its own test.** This redesign IS the sanctioned first consumer (the Key Insights region), per its own header comments.

### 1.6 Evidence / completeness integration

The shell owns it: `ShellContextRow` + `CompletenessPopover` + `EvidenceDrawer`, fed by `resolvePerspectiveEnvelope` (`lib/perspectives/envelope.ts`). Cash Flow's envelope is currently a **static** honest statement (`envelope.ts:113–121`, tier `observed`, "Complete within transaction depth"). No Cash Flow widget duplicates completeness labels. `cashFlowStamp` is the ready-made dynamic replacement.

### 1.7 Layout primitives, breakpoints, precedent

- Card primitives: `components/atlas/GlassPanel.tsx` (depth/elevation/radius token system), `DataCard.tsx`, `AtlasLiquidCard.tsx`. SectionCard's solid-lede treatment = `GlassPanel depth="thin" elevation="e2" radius="lg" p-4`.
- **The landed composition precedent is `components/space/widgets/wealth/WealthPerspective.tsx`:** `grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0`, mobile stacks in source order, every column `min-w-0`. This plan mirrors it exactly.
- Breakpoints: Tailwind defaults (`sm` 640 / `lg` 1024 / `xl` 1280). Calendar internals already reflow: quarter `grid-cols-1 sm:grid-cols-3`, year/ALL `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4` mini-months (`CashFlowCalendar.tsx:280–287`).

### 1.8 Concurrent-modification constraints

`FOURTH_MERIDIAN_A6_A7_A8_P5_PARALLELIZATION_INVESTIGATION_2026-07-12.md` §9: **`components/dashboard/SpaceDashboard.tsx` is single-owner, "primary, always", HIGH merge risk — never edited in a worktree.** A6/A7/A8/P5 streams are active but forbidden from `components/**`. This work must run on the primary branch, keep the `SpaceDashboard.tsx` diff minimal (one bounded branch swap), and land quickly. `git status` shows only untracked docs — no in-flight code edits.

### 1.9 Tests and conventions

No test framework: standalone `tsx` scripts (`*.test.ts`) under `lib/`, `app/`, `components/`, run by `npm test` → `scripts/run-tests.ts`. Colocated pure component tests are the house pattern (`components/space/widgets/wealth/WealthChangeLedger.test.ts`). Existing coverage that must stay green: `lib/perspectives/virtual-sections.test.ts` (locks the exact Cash Flow widgets[] list, `:71–73`), `lib/perspectives/time-range.test.ts`, `lib/perspectives/envelope.test.ts`, `lib/transactions/cash-flow*.test.ts`.

### 1.10 Requirement classification

| Requirement | Status |
|---|---|
| Shared shell owns preset/asOf/compareTo/evidence/completeness/tabs | **already landed** |
| Cash Flow follows shell preset via bounded period bridge | **already landed** (keep) |
| Summary / History / Spending / Income / Debt Payments widgets | **already landed** — relocation + wrapper only |
| Multi-panel grid composition | **missing** — extraction of the Wealth grid pattern (new component, no new abstraction) |
| Key Insights region | **missing presentation; logic landed & orphaned** (`cash-flow-compare.ts`) |
| Dynamic Cash Flow completeness envelope | **missing consumer; logic landed** (`cashFlowStamp`) |
| Native `{asOf, compareTo}` Cash Flow consumption | **deferred** (temporal cutover is a separate initiative; see §5) |
| `income_vs_spending` | **superseded** (already retired; keep renderer, do not remount) |

---

## 2. Reference-to-repository mapping

| Reference region | Fourth Meridian widget | Fit |
|---|---|---|
| Cash Flow Summary (top-left): net headline, Cash In/Out tiles, "Spent on credit", "Move, not spent", "Between your accounts", "Unresolved transfers", "Cash withdrawals" | `cash_flow_summary` | **Near-exact.** The reference rows are literally this widget's existing content. Internal implementation untouched. |
| Cash Flow History (top-center, dominant): Cash Flow/Spending/Cash In & Out chips, Calendar/Cards toggle, 12-month heatmap, legend | `cash_flow_history` | **Near-exact.** Filter chips = `CashFlowFilterControls`; Calendar/Cards = existing `ModeToggle`; 12-month grid = the ALL-period calendar with year nav. Internal implementation untouched (hard invariant). |
| Spending by Category (top-right): allocation strip + category rows with amounts/% | `cash_flow_by_category` | **Direct.** Allocation strip + cards already exist. Narrow-column presentation tweak only (§3.4). |
| Income by Source (bottom-left): total, composition strip, source rows | `income_by_source` | **Direct.** Perspective-aware (cash-in by reason / income by source) — richer than the reference, preserved as-is. |
| Key Insights (bottom-right): deterministic observations + compare deltas | none mounted | **New thin panel over landed, orphaned `compareCashFlow`/`cashFlowStamp`.** Deterministic only — no AI. See §3.5 and slice S4. |
| — (not in reference) | `debt_payments` | **No reference region — must remain mounted.** Most coherent placement: stacked directly beneath Spending by Category (its documented "liquidity twin"), visually de-emphasized. Never deleted, never duplicated. |

Preservation proof: all five mounted widgets appear exactly once in the target grid; `lib/perspectives.ts` widgets[] is unchanged, so `virtual-sections.test.ts` continues to lock the inventory; internal widget files are untouched except one opt-in presentational prop (§3.4).

---

## 3. Exact implementation design

### 3.1 Approach — smallest honest implementation

One new layout component that mirrors the landed `WealthPerspective` pattern; existing widgets relocated into it unchanged; one bounded branch swap in `SpaceDashboard.tsx`. **No registry, no schema-driven dashboard, no grid engine, no configurable widget metadata, no new design-system layer.** The generic abstraction that already exists (SectionCard/SectionRegistry vertical stack) cannot express a 2D grid; the sanctioned precedent for perspectives that outgrow it is a bespoke composition component (Wealth). We extract nothing new.

### 3.2 Files

**Add:**
- `components/space/widgets/cashflow/CashFlowPerspective.tsx` — the composition (grid + panel wrappers). Presentation only; owns NO state beyond pass-through.
- `components/space/widgets/cashflow/CashFlowInsightsCard.tsx` — S4 only (deterministic insights; §3.5).
- `components/space/widgets/cashflow/cash-flow-insights.ts` + `.test.ts` — S4 only: pure bullet-builder over `compareCashFlow`/`cashFlowStamp` (exported for the colocated test).
- `components/space/widgets/cashflow/CashFlowPerspective.test.ts` — colocated pure/source-scan test (§7).

**Modify:**
- `components/dashboard/SpaceDashboard.tsx` — ONE bounded change in the Perspectives tabpanel (`:3186`): add an `activePerspectiveId === "cashFlow"` branch (before the generic virtual-sections branch) rendering `<CashFlowPerspective …/>` with the exact props the SectionCard path passes today: `transactions={spaceTransactions}`, `txCtx={txConversionCtx}`, `accounts`, `period={cashFlowPeriod}`, `onSelectPeriod={setCashFlowPeriod}`, `perspective={cashFlowPerspective}`, `filterId={cashFlowFilterId}`, `onPerspectiveChange={onCashFlowPerspectiveChange}`. Nothing else in this file changes. (Wealth branch, Space navigation, other perspectives: untouched.)
- `components/space/widgets/CashFlowCategoryBreakdown.tsx` — one optional prop (§3.4). Default behavior byte-identical.
- `lib/perspectives/envelope.ts` — S4 only: `cashFlow` case accepts an optional precomputed `CashFlowStamp` and maps it to the envelope; absent ⇒ today's static text (backward compatible; `envelope.test.ts` extended, not rewritten).

**Explicitly untouched:** `CashFlowSummaryWidget.tsx`, `CashFlowHistoryWidget.tsx`, `CashFlowCalendar.tsx`, `CashFlowFilterControls.tsx`, `CashFlowPeriodSelector.tsx`, `DebtPaymentsWidget.tsx`, `TransactionSliceDrawer.tsx`, `cash-flow-adapters.tsx`, all of `lib/transactions/*`, `lib/perspectives.ts` (widgets[] stays for inventory parity), `usePerspectiveShellState.ts`, `PerspectiveShell.tsx`, all Wealth/Investments/Liquidity/Debt files, Space navigation.

### 3.3 Grid structure

`CashFlowPerspective.tsx` root (mirrors `WealthPerspective.tsx:65`):

```tsx
<div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch min-w-0">
  {/* ① Summary */}
  <div className="min-w-0 lg:col-span-5 xl:col-span-4"> <Panel title={`Cash Flow Summary · ${periodLabel(period)}`}>…summary…</Panel> </div>
  {/* ② History — visually dominant */}
  <div className="min-w-0 lg:col-span-7 xl:col-span-5"> <Panel title="Cash Flow History">…history…</Panel> </div>
  {/* ③ Right column: Spending by Category + Debt Payments (de-emphasized twin) */}
  <div className="min-w-0 lg:col-span-6 xl:col-span-3 flex flex-col gap-4">
    <Panel title="Spending by Category">…category…</Panel>
    <Panel title="Debt Payments" subdued>…debt payments…</Panel>
  </div>
  {/* ④ Income by Source */}
  <div className="min-w-0 lg:col-span-6 xl:col-span-7"> <Panel title="Income by Source">…income…</Panel> </div>
  {/* ⑤ Key Insights (S4; S1–S3 render nothing here — 4-panel grid, Income spans 12 on lg) */}
  <div className="min-w-0 lg:col-span-12 xl:col-span-5"> <CashFlowInsightsCard …/> </div>
</div>
```

`Panel` is a local (non-exported) helper inside `CashFlowPerspective.tsx` — `GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 h-full min-w-0"` with the same `text-sm font-semibold` header line SectionCard renders today (`SpaceDashboard.tsx:1792–1795`). This preserves the exact card language; it is NOT a new card system. `subdued` renders the header in `text-[var(--text-muted)]` — de-emphasis only, full functionality retained.

**Specs:**
- Desktop (`xl` ≥1280): row 1 = 4/5/3 (Summary / History / Spending+Debt column); row 2 = 7/5 (Income / Insights). History is the widest single panel and the visually dominant region.
- Tablet (`lg` 1024–1279): row 1 = Summary 5 / History 7 (dominant panel gets the larger span); row 2 = Spending+Debt column 6 / Income 6; Insights full-width 12.
- Mobile (<1024): single column, source order = **Summary → History → Spending → Debt Payments → Income → Insights.** (Debt Payments follows its twin immediately — a deliberate deviation from the generic order, justified by the widgets' documented pairing.)
- Row spans: none (the right column is a flex stack, not a grid row-span — avoids fragile `row-start` coupling to variable panel heights).
- Heights: **no fixed heights, no internal scroll, no clipping.** `items-stretch` + `h-full` panels balance rows; content defines height. Minimum heights: none (empty states are already short and honest).
- Gap: `gap-4` (16px) everywhere, matching Wealth.
- Overflow: every grid child and panel is `min-w-0`; calendar mini-month grids already reflow internally; nothing scrolls horizontally.

### 3.4 Wrapper / prop changes (presentation-only)

- `CashFlowCategoryBreakdown.tsx`: add optional `cardGridClassName?: string` (default: current `"grid grid-cols-1 sm:grid-cols-2 gap-2"`, `:120`). The perspective passes `"grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-2"` for the two right-column instances (Spending, Debt Payments) so category cards go single-column in the narrow xl column and stay two-column when the panel is full-width. No data, ordering, or drill-down change.
- The perspective calls widget components directly (`CashFlowSummaryWidget`, `CashFlowHistoryWidget`, `CashFlowCategoryBreakdown` via the same data helpers the adapters use — **prefer importing and reusing the adapter functions `renderCashFlowSummary` / `renderCashFlowHistory` / `renderCashFlowByCategory` / `renderIncomeBySource` / `renderDebtPayments` from `cash-flow-adapters.tsx`** so the data contracts stay single-sourced).
- All in-widget controls stay where they are: the perspective/measure chips and Calendar/Cards toggle and M/Q/Y history selects remain INSIDE the History widget; the Summary keeps its compact toggle. This is the calendar-usability invariant — zero control relocation, zero interaction change.

### 3.5 Key Insights panel (S4)

Deterministic, sourced entirely from landed models — no AI, no new classification:

- `cash-flow-insights.ts` exports `buildCashFlowInsights(args)` returning typed bullet rows from: (a) `compareCashFlow` then-vs-now deltas **when a "then" period is derivable**, (b) top spending category / top income source from the existing breakdowns, (c) credit usage (`facts.creditCardSpending`), (d) unresolved-transfer presence from `groupCashFlowContext`, (e) a completeness caveat from `cashFlowStamp` when tier is `incomplete`.
- "Then" derivation: a small pure helper `previousEquivalentPeriod(period, now)` — previous calendar month/quarter/year for explicit and to-date periods; `null` for rolling and ALL (then the compare bullets are honestly omitted, never fabricated). Unit-tested. This makes the redesign the first real consumer of the orphaned `cash-flow-compare.ts`, exactly as that module's header anticipated — the correct consumer, not deferred.
- The card renders 3–5 bullets max; when nothing noteworthy is derivable it says so plainly. Evidence caveats here NEVER duplicate the global Evidence drawer — one status sentence max, pointing to the shell chip.
- Envelope upgrade (same slice): `resolvePerspectiveEnvelope` `cashFlow` case consumes a host-computed `cashFlowStamp({transactions, period, now})` (memoized in `SpaceDashboard` alongside the existing envelope call) so the shell's Completeness chip becomes dynamic for Cash Flow. This is the "central knowledge layer" integration: the calendar and every Cash Flow panel now sit under the SAME shell trust envelope Wealth/Liquidity/Debt use, with zero change to calendar internals.

### 3.6 Temporal-model recommendation

**Option 1 + 3: keep the landed bridge, layout-only now, native cutover later.** Repository evidence: the bridge is already the bounded adapter the constraint asks for (shell preset → `cashFlowPeriod`, event-driven, CUSTOM-hold documented in `usePerspectiveShellState.ts:44–52`); `filterByPeriod` resolves against `now()` not `asOf`; every widget takes `CashFlowPeriod`, and arbitrary `{asOf, compareTo}` date pairs are NOT supportable today without touching the period model in `lib/transactions/cash-flow.ts`. Mixing that rewrite into a layout slice is exactly what the constraints forbid.
- Preset changes: shell → `handleSelectSlice` → `cashFlowPeriod` → all panels re-window (unchanged).
- `asOf`: no effect on Cash Flow (unchanged, documented).
- Compare mode: surfaces ONLY through the Key Insights panel's derived previous-equivalent-period comparison (honest, deterministic); shell `compareTo` continues to influence Cash Flow only via the existing preset inference (`SpaceDashboard.tsx:2536–2540`). Full `{asOf, compareTo}` consumption is honestly deferred to the Cash Flow Time Machine initiative.
- Current-period-only: everything remains relative/explicit-period based; nothing regresses.

---

## 4. Slice plan (each independently compilable and shippable)

- **S1 — Layout shell + relocation.** Add `CashFlowPerspective.tsx` (4-panel grid: Summary/History/Spending+Debt/Income; Income spans the remaining width; no Insights yet) reusing the adapter renderers; add the `cashFlow` branch in `SpaceDashboard.tsx`. Functional parity checkpoint: every interaction from the old stack works identically.
- **S2 — Panel treatment.** `Panel` headers (period label on Summary), Debt Payments de-emphasis, `cardGridClassName` prop + narrow-column usage, spacing/weight polish. No behavior change.
- **S3 — Responsive audit.** Verify lg/xl spans, mobile order, calendar at 5/12 and full width (single month, quarter, year, ALL + year nav), no horizontal overflow, toggles reachable at 360px, no clipped cards. Fix with wrapper classes only.
- **S4 — Key Insights + dynamic envelope.** `cash-flow-insights.ts` (+ test), `previousEquivalentPeriod` (+ test), `CashFlowInsightsCard.tsx`, envelope `cashFlow` case upgrade (+ extend `envelope.test.ts`), host memo for the stamp. First consumer of `cash-flow-compare.ts`.
- **S5 — Tests & polish.** §7 suite green, lint/type clean, STATUS.md note per maintenance rule.

If S4 proves contentious mid-flight, S1–S3+S5 ship as a complete layout slice with a 4-panel composition (grid stays valid); S4 must not block them.

---

## 5. Risks

- **`SpaceDashboard.tsx` merge risk (HIGH):** single-owner file per the A6/A7/A8/P5 ownership matrix; A5-S4 and P5/B4 UI phases plan to touch it. Mitigation: primary branch only (never a worktree), one ~20-line additive branch, land S1 promptly, coordinate via STATUS.md.
- **Legacy period bridge:** keep it; do NOT reintroduce widget-local date state and do NOT create a second time model. The perspective component receives `period` and never stores it.
- **Calendar sizing:** ALL-period 12-mini-month grid inside a 5/12 column (~480–540px) renders 4 minis/row via its existing `lg:grid-cols-4`; verify legibility — if cramped, widen History to `xl:col-span-6` and shrink Summary to 3 BEFORE touching calendar internals (which are off-limits).
- **Card-height mismatches:** Summary is tall with context rows expanded; `items-stretch` handles rows, but verify empty states don't produce a lonely stretched panel. Never fix with fixed heights.
- **Duplicate totals:** Summary net vs History bucket nets vs category totals already coexist by design (different axes/measures); the new Insights card must reference, not restate, the Summary headline (one net figure as prose delta, not a second KPI).
- **Insights data availability:** rolling/ALL periods yield no then-period — the card must degrade to non-compare bullets, never fabricate a window.
- **Concurrent-session ownership:** confirm no other active session holds `SpaceDashboard.tsx` or shell files before starting (stop condition below).

---

## 6. Overengineering check

Confirmed feasible as: **one new layout component + existing widgets + one local Panel helper + one optional prop + one host branch.** Rejected: widget registry extension, schema-driven layout, generic grid engine, per-widget layout metadata, new card primitives. The Wealth composition precedent proves this shape ships and stays maintainable.

## 7. Testing expectations (house pattern: standalone tsx `*.test.ts`, discovered by `scripts/run-tests.ts`)

`components/space/widgets/cashflow/CashFlowPerspective.test.ts` (pure/source-scan, like the wealth colocated tests):
1. Source-scan: the component references all five renderers/widgets exactly once each (no dropped widget, no duplicate mount).
2. Source-scan: grid classes `lg:grid-cols-12`, the specified `lg:`/`xl:` spans, and `min-w-0` on every child exist; no fixed `h-[`/`max-h-` on panels.
3. Source-scan: source order (= mobile stacking order) is Summary, History, Spending, Debt, Income, Insights.
4. Source-scan: no import from `components/space/widgets/wealth/` and no import of `usePerspectiveShellState` (time stays host-owned).
5. `SpaceDashboard` scan: the `cashFlow` branch passes `period`, `onSelectPeriod`, `perspective`, `filterId`, `onPerspectiveChange`, `transactions`, `txCtx`, `accounts` (shell props still reach the host path).

Plus: `lib/perspectives/virtual-sections.test.ts` unchanged and green (widgets[] inventory lock); `lib/perspectives/time-range.test.ts` green (no time-model change); S4 tests for `previousEquivalentPeriod` and `buildCashFlowInsights` (deterministic fixtures, injected clock); extended `envelope.test.ts` (static fallback preserved, stamp-driven path correct); all existing `cash-flow*.test.ts` untouched and green. No Space-navigation or Wealth/Investments file diffs (assert via `git diff --name-only` in the validation gate).

## 8. Validation gate (run in order; all must pass)

```bash
npx tsc --noEmit
npx eslint
npm test                       # scripts/run-tests.ts — all *.test.ts under lib/ app/ components/
git diff --name-only           # must contain ONLY the files listed in §3.2
npm run dev                    # manual pass: desktop xl, ~1100px lg, 375px mobile;
                               # calendar month/quarter/year/ALL(+year nav), Cards mode,
                               # filter chips, M/Q/Y selects, every drill-down drawer,
                               # preset changes from the shell, CUSTOM hold behavior
```

## 9. Stop conditions — halt and report instead of proceeding if:

1. Implementation would require replacing or deleting any existing Cash Flow widget or changing `CashFlowCalendar.tsx` / `CashFlowHistoryWidget.tsx` internals beyond zero.
2. Temporal behavior turns out to require backend or `lib/transactions/cash-flow.ts` period-model rewrites.
3. `SpaceDashboard.tsx` or `components/space/shell/*` are actively owned by another session/stream (check STATUS.md and in-flight branches first).
4. The reference cannot be mapped without fabricating data a widget doesn't have (the Insights card must be buildable from `cash-flow-compare.ts` + existing breakdowns alone).
5. Scope drifts beyond Cash Flow presentation (any diff in Wealth/Investments/Liquidity/Debt widgets, Space navigation, or the shell time model).

---

**Final instruction to the implementation session:** the attached image is a layout and hierarchy reference. Adapt its composition to the widgets and tokens above; preserve every existing capability and interaction (the calendar especially — byte-identical usability); consume the canonical Perspective Shell; keep the `SpaceDashboard.tsx` footprint to the single documented branch. When in doubt, prefer the smaller change and the Wealth precedent.
