# Cash Flow Workspace — Editorial Convergence Audit

**Status:** Read-only investigation + plan. NOT implemented.
**Scope:** Presentation convergence only. Adopt the Fourth Meridian editorial Workspace language ([[debt-workspace-editorial-redesign]], [[investments-ui-redesign]], [[liquidity-workspace-redesign-audit]]) while preserving every Cash Flow utility surface — above all the calendar heatmap.
**Non-goal:** A rebuild. No cash-flow math, no aggregation paths, no `DayFacts`, no time semantics, no `CalendarHeatmapGrid` logic changes.

---

## 0. Core principle — Cash Flow is an OPERATIONAL surface

Cash Flow is deliberately different from its siblings, and the redesign must not flatten that difference into a research/decision dashboard:

| Workspace | Surface type | User verb chain |
|-----------|--------------|-----------------|
| Investments | Research | Overview → analysis → detail |
| Debt | Decision | Overview → obligations → strategy |
| **Cash Flow** | **Operational** | **Monitor → investigate → understand** |

The calendar heatmap is *why users rely on this workspace*. Convergence means it should **feel** like Fourth Meridian (editorial hero, Blocks, panels, shared trust) while every operational affordance — the calendar, the perspective toggle, the drill-downs, the mode switch, the historical selectors — survives byte-for-byte.

---

## 1. Current architecture

### 1.1 Composition boundary (PRESERVE VERBATIM)

`CashFlowWorkspace` (`components/space/widgets/cashflow/CashFlowWorkspace.tsx`) is already a clean composition root:

- It builds `CashFlowSpaceData` **once** via `buildCashFlowSpaceData` (`lib/transactions/cash-flow-space-data.ts:132`) — "composes, computes none" — and fans the single windowed projection into every panel. No panel re-windows or re-folds.
- It owns the workspace-local **control state**: the perspective toggle (`liquidity` "Cash Flow" ⇄ `economic` "Spending") and the measure `filterId` (`CashFlowWorkspace.tsx:111-116`). Calendar/Cards mode, the All-Time year cursor, and every drill live inside the child widgets.
- It owns the completeness **stamp** and emits the trust envelope (`CashFlowWorkspace.tsx:138-146`) via `onEnvelopeChange` → shell chip.

This contract is the redesign's foundation and does **not** change. The redesign only replaces the *presentation shell* wrapped around it.

### 1.2 Current presentation shell (WHAT CHANGES)

The workspace today is a **12-column `GlassPanel` grid** with a local `Panel` helper (title + `GlassPanel depth="thin" elevation="e2"`, `CashFlowWorkspace.tsx:59-68`, `:213`):

| # | Panel | Grid span (`lg` / `xl`) | Widget |
|---|-------|--------------------------|--------|
| ① | Cash Flow Summary · {period} | `col-span-5` / `col-span-4` | `CashFlowSummaryWidget` |
| ② | Cash Flow History | `col-span-7` / `col-span-5` | `CashFlowHistoryWidget` (calendar/cards) |
| ③ | Spending by Category **+** Debt Payments | `col-span-6` / `col-span-3` | `CashFlowCategoryBreakdown` + `DebtPaymentsWidget` |
| ④ | Income by Source | `col-span-6` / `col-span-7` | `CashFlowCategoryBreakdown` |
| ⑤ | Key Insights | `col-span-12` / `col-span-5` | `CashFlowInsightsCard` |

This is a *dashboard grid*, not the editorial *vertical stack*. It also does **not** publish sidebar section anchors (`useSpaceSectionsPublisher`) the way Debt/Investments do.

### 1.3 Widget inventory

| File | Role | Notes |
|------|------|-------|
| `CashFlowSummaryWidget.tsx` | Net headline + Cash In/Out `AxisTile`s (expandable → reason breakdown) + credit-card context + "moved not spent" / "needs classification" + perspective toggle | Dense & highly interactive |
| `CashFlowHistoryWidget.tsx` | Multi-mode time lens: **Calendar** / **Cards**; hosts mode toggle, Month/Quarter/Year historical selectors, All-Time year nav, measure filter | The operational centerpiece host |
| `CashFlowCalendar.tsx` | Domain content for the heatmap: per-day net + tooltip breakdown; delegates all rendering to `CalendarHeatmapGrid` | **DO NOT TOUCH LOGIC** |
| `shared/CalendarHeatmapGrid.tsx` | Metric-agnostic month-grid heatmap primitive | **Shared** — also used by `TransactionsCalendarHeatmap`. Frozen. |
| `CashFlowCategoryBreakdown.tsx` | Allocation strip + category cards (drill → `TransactionSliceDrawer`) | Used for BOTH Spending and Income |
| `DebtPaymentsWidget.tsx` | DEBT_PAYMENT rows by creditor | Reuse as-is |
| `cashflow/CashFlowInsightsCard.tsx` | Deterministic then-vs-now bullets (`buildCashFlowInsights`) | No AI, no header |
| `CashFlowFilterControls.tsx` | Perspective toggle + measure select | Reuse as-is |

### 1.4 Temporal model — a KEY differentiator (PRESERVE, and it is already honest)

Unlike Debt and Liquidity (whose headlines render *present-day* figures inside a historical `asOf` view and must say "balances are current"), **Cash Flow is genuinely historical.** It is transaction-based: the whole window travels with `asOf` (`asOfClock`, `CashFlowWorkspace.tsx:122`; `periodRange(period, asOf)`). Cash In/Out/Net for a historical period reconstruct correctly from the rows in that window.

**Consequence for the redesign:** Cash Flow has **no dual-authority / "balances are current" honesty debt to carry.** A period-over-period `DeltaBadge` (vs `compareTo`) is safe on the same basis as the headline — no delta suppression needed. This is the opposite situation from Debt (`debt-workspace-editorial-redesign`, delta dropped when historical). Do not import that caveat here.

---

## 2. Surfaces worth preserving

| Surface | Current role | Verdict | Convergence action |
|---------|--------------|---------|--------------------|
| **Calendar heatmap** | Daily operational view | **PRESERVE — untouched** | Only re-place (make central) + editorial Block header + responsive container. Zero logic change. |
| Cards mode | Bucket grid alt to calendar | Preserve | Rides along inside the History block |
| Mode toggle / historical selectors / All-Time nav | Time navigation | Preserve | Move into the Block header `action` slot; behavior unchanged |
| Perspective toggle (Cash Flow ⇄ Spending) | Axis selection | Preserve | Relocate into the Hero (like a metric switcher) |
| Summary Net + Cash In/Out | Current-state headline | **Redesign** | Becomes the editorial Hero; interactive `AxisTile` breakdown + context preserved below the lede |
| Spending by Category | Spending analysis | **Fix layout (issue #1)** | Top-N inline + "View all →" LeftPanel; RightPanel per-category detail |
| Income by Source | Inflow analysis | Fix layout (twin of above) | Same treatment |
| Debt Payments | Liquidity twin of spending | Preserve | Subdued Surface, reused |
| Key Insights | Interpretation | Refine | Becomes a `Block`; no AI, no new classification |

**The calendar heatmap invariant is absolute:** no change to bucketing, date semantics, tooltip behavior, color/intensity (`cellBg`/`cellText`, `CalendarHeatmapGrid.tsx:30-44`), day facts, or time handling. Placement and responsiveness only.

---

## 3. UI issues found

### 3.1 Issue #1 — Spending by Category overflow (confirmed in code)

**Root cause is structural, not a missing scrollbar.** In the current grid, Spending sits in the narrow right column (`xl:col-span-3`) and is passed `cardGridClassName="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-2"` (`CashFlowWorkspace.tsx:162`) — i.e. **a single column of *every* category at `xl`.**

`CashFlowCategoryBreakdown` only truncates on **mobile**: `mobileTopN = 4` (`:64`) with overflow cards marked `hidden sm:flex` (`:131`). At `≥sm` **every card renders, always** — there is no desktop "View all" affordance and no cap.

The wrapping `Panel` is `h-full min-w-0` (`CashFlowWorkspace.tsx:61`) with **no `max-height` and no scroll**. Combined with the grid's `items-stretch` (`:213`), a user with 12+ spending categories produces an unbounded single-column list that stretches the whole row and unbalances the layout.

- Container sizing issue? **Yes** — fixed narrow column + unbounded child.
- Missing scroll? **Yes** — no overflow region.
- Missing expand/collapse? **Yes on desktop** — collapse exists only for mobile.
- Fixed-height card? No. **Unbounded-height** card is the problem.

**Do not hide information** — the full list must remain reachable.

### 3.2 Issue #2 — Cash In / Cash Out overflow (confirmed in code)

`AxisTile` renders its total as `text-lg font-semibold tabular-nums` (`CashFlowSummaryWidget.tsx:110`) inside a `grid grid-cols-2 gap-3` (`:263`); the Net headline is `text-3xl font-bold` (`:247`). None of these have `min-w-0`, truncation, responsive down-sizing, or a wrap rule. `tabular-nums` will **not** break, so in the narrow Summary column (`xl:col-span-4`) a large converted value (e.g. `+$128,450.00`) escapes its tile. The `AxisTile` label span (`:104-108`) is likewise un-truncated.

This is a **design-system-level** gap (responsive number typography), not a one-off. It recurs anywhere a big currency figure meets a narrow flex child.

### 3.3 Issue #3 — the shell is a grid, not the editorial stack

The 12-col `GlassPanel` grid and local `Panel` helper diverge from the established idiom (`space-y-8 sm:space-y-10` vertical stack of `<Surface>`/`<Block>`, bare Hero, `useSpaceSectionsPublisher` anchors). This is the primary convergence gap and the parent of issues #1/#2 (both are aggravated by cramped grid columns).

---

## 4. Proposed layout

Adopt the editorial vertical stack, **operational variant** — the calendar is central and gets the most vertical room, not tucked into a grid cell.

```
<div className="space-y-8 sm:space-y-10 min-w-0">   ← editorial stack, replaces the 12-col grid

  ① CASH FLOW — Hero (bare <section>)
     eyebrow "Net cash flow · {period}"  ·············  <TrustIndicator variant="compact">
     <Figure size="hero"> +$4,250 </Figure>  <DeltaBadge vs {compareLabel}>   (safe — same basis)
     Cash In  $8,200   ·   Cash Out  $3,950     ← the two AxisTiles, drill-downs PRESERVED
     [perspective toggle: Cash Flow ⇄ Spending]  ← relocated from the panel corner
     · credit-card-on-credit context · moved-not-spent / needs-classification  (preserved)

  ② ACTIVITY — Block label="Activity" action=[mode toggle · Month/Quarter/Year · All-Time nav]
     ┌─────────────────────────────────────────────┐
     │           CALENDAR HEATMAP  (central)         │   ← CashFlowHistoryWidget, UNTOUCHED
     │         daily investigation · Cards alt       │      wider container than today
     └─────────────────────────────────────────────┘

  ③ SPENDING — Block label="Spending" hint={n} action="Bar shows share"
     allocation strip + top-N category cards
     View all N categories →   ← LeftPanel browser · RightPanel per-category detail   (fixes #1)

  ④ INCOME — Block label="Income by source" (twin of ③)   ·   Debt payments (subdued Surface)

  ⑤ INSIGHTS — Block label="What changed"
     deterministic bullets (CashFlowInsightsCard) — no AI
</div>
```

### 4.1 Hero (①)

Adopt the "bare lede" skeleton (`DebtHero`/`InvestmentsHero`): eyebrow + compact `TrustIndicator`, `<Figure size="hero">` for **Net**, inline `DeltaBadge` (vs `compareTo`; `goodDirection="up"`, and — per §1.4 — **not** suppressed in historical view). Color the Net figure by sign (positive/negative), which is a genuine claim.

**Crucially, this Hero is not just a number.** Cash Flow is operational, so the Hero **absorbs the interactive top of `CashFlowSummaryWidget`**: the two `AxisTile`s (Cash In / Cash Out, still expandable into their reason breakdown and drill slices), the perspective toggle (relocated here as a metric-switcher affordance), the credit-card context row, and the moved-not-spent / needs-classification sections. Preserve information density (mission requirement) — converge the *headline treatment*, not the utility.

### 4.2 Activity / Calendar (②) — the centerpiece

The calendar becomes the widest, most prominent Block, not a `col-span-5` cell. Wrap `CashFlowHistoryWidget` in `<Block label="Activity">` and move its control cluster (mode toggle, historical selectors, All-Time nav) into the Block header `action` slot for an editorial header. **Everything inside `CashFlowHistoryWidget` / `CashFlowCalendar` / `CalendarHeatmapGrid` is untouched** — this is placement + header chrome only. A wider container lets `heatmapGridCls` (`CalendarHeatmapGrid.tsx:65-69`) breathe (quarter = 3-up, year = 4-up) instead of being squeezed.

### 4.3 Spending / Income (③④) — ledger + panel drill

Keep `CashFlowCategoryBreakdown`'s allocation strip + cards (they're good), but apply the **ledger + LeftPanel/RightPanel** idiom to fix overflow:

- Inline: allocation strip + **top-N** category cards (a real cap on *all* widths, e.g. top 5–6).
- **"View all N categories →"** → `LeftPanel` browser rendering the full `CashFlowCategoryBreakdown` list (optionally with a search box, à la `HoldingsLedger`).
- Selecting a category → `RightPanel` detail (its transactions; a small trend is optional/omit-if-not-tracked, never fabricated). The existing `sliceFor` drill data feeds this directly; `TransactionSliceDrawer` content can become the RightPanel body, or the drawer can be kept and a panel added — either preserves drill-down.
- Income by Source gets the identical treatment (it already reuses the same component). Debt Payments stays a subdued `Surface`.

### 4.4 Insights (⑤)

`CashFlowInsightsCard` → wrapped in `<Block label="What changed">`. Refine to the Block idiom (it already carries no header). **No AI, no `DataCard`-as-decoration, no new classification** — it stays the deterministic `buildCashFlowInsights` bullet list. (A future AI bridge is explicitly out of scope.)

---

## 5. Panel opportunities

Use **Atlas panels** (`components/atlas/panels/`) — never a bespoke `CashFlowPanel` (the ownership guard, `panels.test.ts:41-67`, forbids domain-named panel files and any `@/lib`/domain import inside the dir anyway).

| Panel | Content | Trigger |
|-------|---------|---------|
| `LeftPanel` (context) | All spending categories / all income sources (full list, optional search) | "View all N →" |
| `RightPanel` (detail) | Category (or source) detail: transactions, share, optional trend | Select a category card / browser row |
| `RightPanel` (detail) | *Optional:* day detail migrated from the calendar's `TransactionSliceDrawer` | Click a heatmap day |

Compose via `LeftPanel`/`RightPanel` + `PanelHeader`/`PanelContent`, one-panel-at-a-time from the browser, RightPanel stacking above LeftPanel via `PanelStack` (wrap the ledger in `WorkspaceLayout` if nesting — as `LiabilitiesLedger` does).

**Note the day-drill is optional and lower priority:** the calendar's day click currently opens `TransactionSliceDrawer` (part of the heatmap interaction contract). Migrating it to a RightPanel is a *consistency* nicety, not required, and must not alter the heatmap's own behavior — leave it for last, or leave it as-is.

---

## 6. Responsive fixes (design-system level, not one-off CSS)

1. **Big-number typography (fixes #2).** Adopt the shared `Figure` primitive (`components/atlas/Surface.tsx:89`, `tabular-nums tracking-tight`, `size` union incl. `hero`) for the Net headline and give the `AxisTile` totals a responsive size + `min-w-0` + truncation-with-`title` (or a controlled wrap). The label spans get `truncate`. This is the same big-number discipline the other Heroes already use, applied to the two `AxisTile`s. Fix it *in the widget*, so it holds at every column width.
2. **Category list bounding (fixes #1).** Replace the "render every card, always" rule with a top-N cap + "View all →" panel (§4.3). If any inline overflow remains, the inline region gets `max-h` + `overflow-y-auto` — but the panel is the primary answer, not the scrollbar.
3. **Calendar container.** The editorial stack gives the Activity Block full width; `heatmapGridCls` already handles the internal responsive grid. Verify month/quarter/year/All-Time at mobile widths (per project memory, the mobile calendar layout has historically been under-verified).
4. **Stacked mobile order.** The vertical stack is mobile-first by construction (source order = visual order): Hero → Activity → Spending → Income/Debt → Insights.

---

## 7. Shared components to reuse (no reinvention)

| Component | Location | Use |
|-----------|----------|-----|
| `Surface` / `Block` / `Figure` | `components/atlas/Surface.tsx` | The editorial stack, section headers, big numbers |
| `TrendChart` | `components/space/widgets/charts/TrendChart.tsx` | *Only if* a category/source detail trend is added — the ONE chart. Cash Flow's primary time view stays the calendar. |
| `DataCard` | `components/atlas/DataCard.tsx` | Analytical breakdown surfaces if needed (not required) |
| `TrustIndicator` | `components/space/trust/TrustIndicator.tsx` | Hero confidence chip (`variant="compact"`), fed the existing envelope |
| `DeltaBadge` | `components/space/widgets/wealth/wealth-ui.tsx:30` | Hero period-over-period delta. **Domain-scoped today** → promote to a shared location (see CF-0) |
| Atlas panels | `components/atlas/panels/` | LeftPanel/RightPanel drill |
| `GlassPanel` | `components/atlas/GlassPanel.tsx` | Underlies Surface/DataCard/panels; not used directly |
| `CalendarHeatmapGrid` | `components/space/widgets/shared/CalendarHeatmapGrid.tsx` | **Reused untouched** |

`CashFlowSpaceData` / `buildCashFlowSpaceData`, `CashFlowInsightsCard`, `DebtPaymentsWidget`, `CashFlowFilterControls`, `TransactionSliceDrawer` — all reused verbatim.

There is **no shared Hero primitive** — each workspace hand-rolls one from `Figure` + `TrustIndicator` + `DeltaBadge`. `CashFlowHero` will be bespoke, same as the others.

---

## 8. Implementation slices

Mirrors the Debt/Liquidity slicing. Each slice is presentation-only, tsc + eslint + `test:unit` green, browser-verified before the next.

| Slice | Change | Risk |
|-------|--------|------|
| **CF-0** *(enabler)* | Promote `DeltaBadge` to a shared location (or import from `wealth-ui`); confirm a period-over-period Net delta source (reuse `compareCashFlow` / `CashFlowInsightsCard`'s comparison, don't invent one). No visual change yet. | Low |
| **CF-1** | `CashFlowHero.tsx` — editorial lede absorbing the Summary headline + `AxisTile`s + perspective toggle + context. Drill-downs preserved. | Med (dense widget) |
| **CF-2** | Convert the shell: 12-col grid → `space-y-8` stack of `Block`s; add `useSpaceSectionsPublisher` anchors + `scroll-mt-20` ids. | Med |
| **CF-3** | Calendar → central `Activity` Block; move controls into header `action`. **Zero logic touch** to History/Calendar/Grid. | Low (placement) |
| **CF-4** | Spending + Income → top-N cap + "View all →" `LeftPanel` browser + `RightPanel` detail. **Fixes issue #1.** | Med |
| **CF-5** | Responsive big-number typography via `Figure` on Net + `AxisTile`s. **Fixes issue #2.** | Low |
| **CF-6** | Insights → `Block` refinement. No AI. | Low |
| **CF-7** | Compose + full browser verification (present-day + historical `asOf` + calendar month/quarter/year/All-Time + mobile stack + category panel + Escape). | — |

Recommended order: **CF-0 → CF-5 first** (it fixes issue #2 cheaply and de-risks the Hero), then CF-1, then CF-2/CF-3 together (the shell + calendar re-placement), then CF-4 (issue #1), then CF-6/CF-7. CF-3 and CF-4 are the highest-value slices for "feels like Fourth Meridian."

---

## 9. Constraints (do-not-cross)

- **Do NOT** replace or rewrite `CalendarHeatmapGrid` / `CashFlowCalendar` logic — no change to bucketing, date semantics, tooltip behavior, color/intensity, day facts, time handling. (It is also shared with `TransactionsCalendarHeatmap` — a logic change would regress two surfaces.)
- **Do NOT** move Cash Flow calculations or create a new aggregation path — `buildCashFlowSpaceData` stays the sole fold; widgets keep consuming its slices.
- **Do NOT** modify `DayFacts` or the projection authorities.
- **Do NOT** change the canonical time behavior (`asOfClock` window travel).
- **Do NOT** convert operational widgets into decorative cards — the Hero keeps the interactive `AxisTile`s + context; Spending keeps its allocation strip + drill; the calendar keeps every control.
- **Do NOT** create a `CashFlowPanel` — use Atlas `LeftPanel`/`RightPanel`.
- **Do NOT** introduce AI into Insights.

**Goal:** make the Cash Flow workspace feel like Fourth Meridian while preserving *why users rely on it* — the calendar-first, monitor→investigate→understand operational loop.
