# Compact dashboard redesign: Phase 1 architecture investigation and plan

**Date:** 2026-10-26
**Mode:** read-only investigation. Nothing implemented, committed or deployed.
**Base:** `develop` @ `830dbab`, identical to Production `main` @ `43768b5` apart from docs.
**Scope:** My Space and shared Space Overview on compact screens. Desktop is unchanged.

---

## 1. What exists today

### 1.1 Component map
```
app/(shell)/dashboard/layout.tsx           Server: session, TOTP gate, DisplayCurrencyProvider, DashboardChrome
└─ components/ui/DashboardChrome.tsx       GlobalHeader · ContextualNavbar (lg+) · <main> · BottomNav (<lg)
   └─ app/(shell)/dashboard/page.tsx       composeFinancialInitialWorkspace → PersonalDashboard | SpaceDashboard
      └─ components/dashboard/PersonalDashboard.tsx   ("view as" currency override) → SpaceDashboard
         └─ components/dashboard/SpaceDashboard.tsx   (1,055 LOC host: useSpaceNavigation, usePerspectiveShellState,
            │                                           useSpaceData, useSpaceLensResults; publishes the sidebar)
            └─ components/space/shell/SpaceShell.tsx  header row (<lg) · rail: Overview·Activity·Accounts·Transactions·Members
               ├─ OVERVIEW → components/space/shell/PerspectiveShell.tsx   TimelineLens · PerspectiveTabs (<lg)
               │   └─ components/space/workspaces/workspaceRenderers.tsx   WORKSPACE_RENDERERS[id] in WorkspaceExplorationHost
               │       ├─ wealth   → components/space/widgets/wealth/WealthWorkspace.tsx      (Total · Assets · Debt)
               │       │            ├─ Assets: liquidity/LiquidityWorkspace (embedded) · investments/InvestmentsWorkspace
               │       │            │          · wealth/RealAssetsSection
               │       │            └─ Debt:   debt/DebtWorkspace
               │       ├─ cashFlow → components/space/widgets/cashflow/CashFlowWorkspace.tsx
               │       └─ markets  → WorkspaceComingSoon (registry status "comingSoon")
               └─ ACTIVITY / ACCOUNTS / TRANSACTIONS / MEMBERS workspaces
```

**Authorities:**
- **Registry:** `WORKSPACE_REGISTRY` in `lib/perspectives.ts:520`. The ids are `wealth` (shown as "Net Worth"), `cashFlow` and `markets`.
- **Rail order:** `lib/space-nav.ts` (`SPACE_TAB_ORDER`), documented as fixed.
- **Net Worth modes:** `lib/wealth/wealth-mode.ts`. `WealthMode` is total|assets|debt, and `AssetsSlice` is all|cash|investments, which **changes only the chart series**.
- **Markets modes:** `lib/markets/markets-mode.ts`.
- **URL:** `lib/space/space-url.ts` (`SPACE_URL_PARAMS`).
- **History writes:** `components/space/shell/useSpaceUrl.ts` is the sole writer. A workspace switch is a push; a view, metric or slice change is a replace.

### 1.2 Breakpoints and responsive behaviour
- **Tailwind v4** with **default breakpoints**: there is no `@theme` and no custom screens. sm is 640, md 768, **lg 1024**, xl 1280.
- **Everything structural already switches at `lg`, in CSS only.** Both copies stay mounted, and there is no `useMediaQuery`.

| Element | Below 1024px | 1024px and up |
|---|---|---|
| `ContextualNavbar` (212px: Space name, currency/Manage, Net Worth / Cash Flow / Markets with their views, Leave Space) | hidden | shown |
| `BottomNav` (primary nav) | shown | hidden |
| `SpaceShell` header row (name, subtitle, `SpaceControls`) | shown | hidden |
| `PerspectiveTabs` lens row (Net Worth / Cash Flow / Markets) | shown | hidden |
| Net Worth view chips (Total / Assets / Debt), Markets view chips | shown | hidden |

- **Widget grids** collapse to one column below `lg`:
  - `WealthWorkspace` 7/5 grid (`:507`)
  - `LiquidityWorkspace` 3-column resilience grid (`:385`)
  - `DebtWorkspace` 2-column grids (`:301`, `:329`)
  - `CashFlowWorkspace` 2-column spending grid (`:412`)
- **Charts** are hand-built SVG on `widgets/charts/TrendChart.tsx`. They measure their width with a ResizeObserver, have a fixed height, and use no chart library.

### 1.3 What a phone shows today (the problem)
1. **Five control rows** before any content: Space header, rail, TimelineLens, lens row, view chips.
2. **Assets is one long scroll.** About 4 wealth blocks, plus Cash (5 sub-blocks), Investments (up to 8) and Real assets, roughly 20 blocks. The section anchors exist (`assetsSections()`, `#wealth-cash`, `#wealth-investments`, `#wealth-real-assets`) but **no navigation to them is rendered** in customer Spaces.
3. **Debt is one long scroll** with six sections (`debtSections()`): summary, history, liabilities, cost & risk, payoff, credit health.
4. **Leave Space is only reachable in the desktop sidebar.** Whether the Spaces page offers an alternative wasn't confirmed (P0 check).

### 1.4 State and persistence (unchanged by this plan)
- **Space:** the `fintracker_space` cookie, re-validated on the server.
- **Display currency:** the Space's reporting currency, resolved on the server. The personal "view as" override is in-memory.
- **URL:** tab, lens, metric, slice, Markets view and time (`asof` / `compareto` / `preset`). These survive reload and Back/Forward.
- **Session-only component state:** the Cash Flow liquidity/economic toggle, calendar filter and calendar/cards mode.

---

## 2. Recommended breakpoint: keep **`lg` (1024px)**

1. **It's already the app's single structural seam.** The sidebar, bottom nav, lens row and view chips all switch at `lg`, and tests pin those as **exact complements** (`space-workspace-nav.test.ts`, `site-nav-in-space.test.ts`, `chrome.test.ts`). Any other threshold creates a band where neither the desktop sidebar nor the compact selector exists, or where both do.
2. **It matches the devices.** Phones and portrait tablets (768–1023px) get the purpose-built compact layout. Landscape tablets and laptops (1024px and up) keep the sidebar experience.
3. **There's no need for a custom breakpoint**, a JS media query or a hydration-sensitive branch.

**Rule:** compact = `lg:hidden`, desktop = `hidden lg:…`. **Never** branch on viewport in JavaScript: SSR can't know the width, and it would break the hydration rules (`docs/operations/hydration-rules.md`).

---

## 3. Proposed compact navigation hierarchy (below 1024px)

```
GlobalHeader (unchanged)
Space header row ── [ Net Worth ▾ ]  (upper-left view selector)     Space name · currency / Manage (SpaceControls)
Rail ── Overview · Activity · Accounts · Transactions · Members  (unchanged; the selector applies to Overview)
TimelineLens (only when the selected view declares time: Net Worth asOf/compare, Cash Flow period; never Markets)
── content ──
BottomNav (unchanged)
```

**The selector:**
- **What it is.** A compact menu button showing the current view ("Net Worth ▾"). It opens a small list: Net Worth · Cash Flow · Markets (Markets shows "Coming soon").
- **What it replaces below 1024px.** It replaces today's `PerspectiveTabs` lens row, saving one row. It writes **exactly the same navigation** as the lens row: `openWorkspaceDefault`, a push. No new URL vocabulary.
- **Where it lives.** In the `SpaceShell` compact header row, the upper-left spot under the primary navigation. That row is already `lg:hidden`.
- **Accessibility.** A menu button with `aria-haspopup="menu"`, `aria-expanded` and arrow-key navigation, with a large enough touch target. A native `<select>` is an acceptable first version if the menu proves fragile.

**Within each view, one row of contextual chips** replaces stacked controls. Detail is in §4.

**Net effect on a phone:** header with the selector, the rail, time (where applicable), and one chip row. That's 3–4 rows instead of 5, and content starts sooner.

**Leave Space:** add it to the compact Space menu (`SpaceControls`) if P0 confirms it's unreachable on compact screens today.

---

## 4. Layout plans

### 4.1 Net Worth (compact)
```
[ Total | Assets | Debt ]                         (existing view chips, unchanged semantics: ?metric=)
HERO  — WealthHero (prominent; existing component, compact spacing variant)
CHART — WealthTrendChart (existing; taller on compact via a height prop; slice chips stay in its header)
Assets only:  [ All | Cash | Investments | Real assets ]   ← NEW contextual tabs
Debt only:    [ Overview | Accounts | Cost & risk | Payoff | Credit ]   ← NEW contextual tabs
SECTION CONTENT — the existing sections, unchanged, one at a time on compact
```

**Assets tabs.** The real categories are **Cash, Investments (crypto is part of Investments) and Real assets**. There's no separate retirement section.

| Tab | Shows on compact | Chart series |
|---|---|---|
| **All** (default) | Today's full Assets stack: composition, What moved it, then all three sections | total assets |
| **Cash** | `#wealth-cash` (embedded `LiquidityWorkspace`, unchanged) | `cash` (sets `slice=cash`) |
| **Investments** | `#wealth-investments` (`InvestmentsWorkspace`, unchanged) | `invested` (sets `slice=investments`) |
| **Real assets** | `#wealth-real-assets` (`RealAssetsSection`, unchanged, with per-asset valuation history) | total assets. There's **no real-assets series** (`wealthSeriesKey`), so the existing slice isn't extended. |

**Debt tabs** are the existing `debtSections()` groups:

| Tab | Sections |
|---|---|
| **Overview** | `DebtHero` + `DebtBalanceHistory` |
| **Accounts** | `LiabilitiesLedger` |
| **Cost & risk** | utilisation + interest cost |
| **Payoff** | the payoff calculator, whose modal already has a mobile layout |
| **Credit** | credit health inputs |

A tab only appears when its section would render: for example, Cost & risk needs debt, and Accounts needs liability accounts.

**Mechanism (the desktop-safety core).**
1. **Sections are filtered in CSS, not remounted.** Each section wrapper gets `data-section` plus a class. Non-selected sections are `hidden lg:block`, so **desktop always shows every section exactly as today**. On compact only the selected one is visible.
2. **No double mounting.** The same React tree serves both, so there's no extra data fetching, no hydration branch, and calculations, interactions and drilldowns are untouched.
3. **Tab state goes in the URL as one new, desktop-inert parameter, `?section=`.** For Assets: cash|investments|real-assets. For Debt: accounts|cost|payoff|credit. It's registered in `SPACE_URL_PARAMS`, written with **replace** (a view-level change, per the history contract), and cleared when the metric changes.
4. **Coherence with the chart.** Choosing Cash or Investments also sets the existing `slice`, so the chart and the content agree. A desktop user who changes the slice chip isn't affected, because desktop ignores `?section=`.
5. **Old deep links** (`?perspective=liquidity|investments|debt`), which scroll to anchors today, map to the matching tab on compact.

**Total** is unchanged: hero, chart, composition, What moved it, explanation. It gets the compact hero and chart spacing only.

### 4.2 Cash Flow (compact): upper presentation only
```
TimelineLens (existing, unchanged; period presets / dates)
HERO  — CashFlowHero (existing; prominent compact spacing; the liquidity ⇄ economic toggle kept)
SUMMARY CARDS — 2×2 compact cards: Cash In · Cash Out · Charged on credit · Moved, not spent
                (economic view: Income · Spending + the same two context cards)
──────── unchanged below this line ────────
#cashflow-activity  CashFlowHistoryWidget → CashFlowCalendar / CalendarHeatmapGrid (unchanged)
#cashflow-spending · #cashflow-income · #cashflow-insights (unchanged)
```

- **The summary cards are a compact-only presentation variant** of `CashFlowSummaryWidget`'s existing data: the same `facts`, `breakdown` and slice handlers (`openReasonSlice`, the Charged-on-credit and Moved-not-spent drawers).
- **Labels are kept exactly.** "Charged on credit (no cash moved at purchase)" becomes "Charged on credit" with its current subtitle as secondary text, and "Moved, not spent" is unchanged.
- The existing summary block renders as `hidden lg:block`, and the compact cards as `lg:hidden`. **No calculation, classification or date logic moves.**
- **The calendar heatmap and everything below it are untouched.** They're already responsive (month grids `grid-cols-1 → sm:3 → lg:4`, tap a day to open it).

### 4.3 Markets (compact)
- The selector entry opens Markets, which keeps today's **`WorkspaceComingSoon`**.
- **No time control:** the registry declares `asOf`, `compareTo` and `period` all `"none"`.
- **No Net Worth or Cash Flow chips.**
- The existing Markets view chips (`MarketsWorkspace`, portfolio…watchlist, `wrap={false}`) stay **dormant** while the status is `comingSoon`. That chip row is the future Markets inner navigation, and it already fits the compact one-row pattern. Nothing to build now.

---

## 5. Components preserved unchanged
- **Shell:** `TimelineLens` and all time logic (`usePerspectiveShellState`), `SpaceControls`, the rail, `BottomNav`, `GlobalHeader`, the `ContextualNavbar` desktop sidebar, `useSpaceUrl` (sole writer), the history contract, and the registry.
- **Charts and grids:** `TrendChart` and its wrappers (`WealthTrendChart`, `LiquidityBalanceHistory`, `InvestmentsBalanceHistory`, `DebtBalanceHistory`, `AssetValuationHistory`), `CalendarHeatmapGrid`, `CashFlowCalendar`, `CashFlowHistoryWidget`.
- **Workspaces and sections:** `LiquidityWorkspace`, `InvestmentsWorkspace`, `RealAssetsSection`, `DebtWorkspace` sections, `DebtPayoffSection`, and the ledgers.
- **Panels, drawers and the rest:** `TransactionSliceDrawer`, `EvidenceDrawer`, the Panel bottom sheets, `WorkspaceComingSoon`, `MarketsWorkspace`.
- **Data and maths:** `useSpaceData`, the data needs, all `lib/` finance logic, conversions and classifications. **Not one line of financial logic changes.**

## 6. New or compact-only presentation pieces (all `lg:hidden`)
| Piece | Where | Notes |
|---|---|---|
| `CompactViewSelector` | `components/space/shell/` | Replaces `PerspectiveTabs` below `lg`; writes the same navigation |
| `SectionTabs` (generic) | `components/space/shell/` or `widgets/shared/` | Chip row driven by the existing `assetsSections()` / `debtSections()` lists, filtered by what renders |
| `CompactCashFlowSummary` | `widgets/cashflow/` | Presentation only over `CashFlowSummaryWidget`'s facts and handlers |
| Hero/chart spacing variants | existing heroes / `TrendChart` | A `density`/`height` prop, defaulting to today's values, so desktop output is byte-identical |

## 7. Risks and regression tests
| Risk | Guard |
|---|---|
| Desktop regression | Every compact element is `lg:hidden` and every filtered section is `hidden lg:block`. New pins assert each compact class string, and that **desktop markup is unchanged**: render the workspaces at default props and compare against the current output (snapshot of the class lists). |
| Breaking the exact-complement pins | Update `space-workspace-nav.test.ts` deliberately. The lens row is replaced by the selector, and the selector and sidebar must remain exact complements (`lg:hidden` ↔ `hidden lg:block`). |
| History or Back-button behaviour | Extend `space-history.test.ts`: the selector is a push (same as the lens row); `?section=` is a replace; changing the metric clears `section`; Back after a section change returns to the previous workspace, not the previous tab. |
| New URL parameter drift | `space-url.test.ts`: `section` is registered, parsed with an allowlist, and ignored on desktop. Old deep links map to tabs. |
| Hidden sections still fetch | Same as today: the Assets sections already fetch when Assets is active. Document it; optionally gate fetches on the active tab later (a perf follow-up, measured). |
| Chart height on small screens | A `TrendChart` height prop with today's default. A render test pins the default value. |
| Hydration | No viewport JS. The section state comes from the URL, which is already read post-mount by `useSpaceUrl`. |
| Accessibility | Selector menu semantics and keyboard; section tabs as a `tablist`/`tab` with `aria-controls` → section ids; focus is managed on tab change; 44px targets; reduced motion respected. |
| Platform Spaces | They use `railVisibility="belowLg"` and `SectionsNav`. Scope the compact selector to customer Spaces, and pin that Platform is unchanged. |
| Existing source pins | `WealthWorkspace.test.ts`, `DebtWorkspace.test.ts`, `CashFlowWorkspace.test.ts`, `space-markets-nav.test.ts`, `chrome.test.ts` read source text. Each touched pin is updated in the same commit, with the reason. |

**Manual verification each phase:** Preview on a phone width (below 640px), a portrait tablet (768–1023px) and desktop at 1024px and 1440px. Desktop screenshots must be compared before and after, and must match.

## 8. Sequential implementation phases (each its own PR into `develop`)
| Phase | Content | Desktop impact |
|---|---|---|
| **P0** (small) | Confirm Leave Space reachability below `lg`. Add the desktop-markup baseline pins (snapshot of the current class lists for the four workspaces and the shell) **before any change**. | none (tests only) |
| **P1** | `CompactViewSelector` in the `SpaceShell` compact header row, replacing `PerspectiveTabs` below `lg`. Same navigation writes. | none |
| **P2** | `?section=` param + `SectionTabs` + Assets tabs (All / Cash / Investments / Real assets) with CSS section filtering and slice coherence | none (`hidden lg:block`) |
| **P3** | Debt tabs (Overview / Accounts / Cost & risk / Payoff / Credit) | none |
| **P4** | Cash Flow compact hero spacing + `CompactCashFlowSummary` 2×2 cards; lower sections untouched | none |
| **P5** | Hero and chart density/height polish for Net Worth and Cash Flow; accessibility pass; phone and tablet Preview verification | none (default props) |
| **P6** (optional) | Measure, and if needed, defer fetches for hidden compact sections | none |

Markets needs no implementation beyond P1 (the selector entry).

## 9. Boundaries that prevent desktop regressions (non-negotiable)
1. **No JavaScript viewport branching.** Compact versus desktop is CSS at `lg` only.
2. **Every new visible element is `lg:hidden`. Every section that compact filters is `hidden lg:block`.** Desktop renders every section as today.
3. **No change** to: financial logic, data hooks, the registry, rail order, time controls, `useSpaceUrl` as the sole writer, the push/replace contract for existing params, the sidebar, BottomNav, or Platform Spaces.
4. **New presentation props default to today's values** (density, chart height), so desktop output is byte-identical.
5. **The only new URL state is `?section=`**, compact-only in effect and replace-written.
6. **Desktop baseline pins land first (P0).** Any PR that changes desktop markup fails CI unless it updates those pins deliberately.

## 10. Owner decisions
1. **Breakpoint:** keep `lg` / 1024px (recommended), or a custom value (not recommended, see §2).
2. **Selector form:** a menu button (recommended) or a native `<select>` for the first iteration.
3. **`?section=`:** keep it compact-only (recommended). Desktop could adopt the same tabs later, but that's a deliberate desktop change.
4. **Debt tabs:** approve the five-tab grouping, or merge "Cost & risk" into "Overview" for a four-tab version.
5. **Real assets tab chart:** show total assets (recommended; there's no real-assets series), or hide the trend chart on that tab.

---

## 11. Owner decisions (2026-10-26). These supersede §4.1, §6 and §10 where they differ.

1. **Breakpoint:** `lg` (1024px). Compact below, desktop unchanged at 1024px and up. CSS only.
2. **Compact navigation:** a dropdown in the upper-left of the Space header replaces the Net Worth / Cash Flow / Markets row. Leave Space must be reachable on compact (P0 confirmed it isn't for members and viewers today).
3. **Assets: exactly three tabs.**
   - **All** is the complete existing experience, including Real assets.
   - **Cash** is the complete Cash/Liquidity section.
   - **Investments** is Investments (incl. crypto) **plus Real assets as a distinct subsection**. That's navigation only: no reclassification, no invented aggregate series, and the chart is never presented as Real-assets performance.

   The tabs are carried by the existing `?slice=` (all|cash|investments). It already holds exactly these three values and already drives the chart series, so chart and content can't disagree.
4. **Debt: exactly three tabs.**
   - **All** is the complete existing experience.
   - **Credit** and **Loans** are filtered by the existing `classifyDebt` rule (`debt-ledger-util.ts`), with no new classification.
   - Shared analytics stay in **All**.
   - The state is a new desktop-inert `?section=` (credit|loans), replace-written.
5. **Cash Flow:** a compact hero and 2×2 summary cards (Cash In · Cash Out · Charged on credit · Moved, not spent) over the existing facts and handlers. The calendar heatmap and every lower section are unchanged.
6. **Markets:** Coming soon, reachable from the dropdown, with no other controls.
7. **P6 (lazy loading)** is not in this effort.

## 12. P3 stop condition: Credit/Loans withheld (2026-10-26)

**Live verification on Preview** (`dpl_2Sc3Ue9v`, after #39) showed the Credit tab listing a *Home Equity Line of Credit* under "Credit cards", and the Loans tab empty, while 3 liabilities sat in "Other".

**Read-only data check.**
- `FinancialAccount.debtSubtype` is unpopulated on **every** liability (0 of 23).
- So the existing `classifyDebt` only ever uses its fallback, "credit limit ⇒ card": HELOCs become Credit, and mortgages, student and auto loans become Other, never Loans.
- The raw Plaid `providerSubtype` is present on some accounts, but the existing rule doesn't read it. Mapping it would be a new classification.

**Action, per the owner's rule ("if existing debt classification cannot reliably distinguish Credit from Loans, STOP that portion"):**
- `DEBT_CATEGORY_TABS_ENABLED = false` (`lib/wealth/wealth-mode.ts`).
- The compact Debt view shows its complete content (All), with no category tabs.
- `?section=` is ignored and cleaned.
- Everything else (the compact hierarchy, Assets, Cash Flow, Markets, the selector, Leave) is preserved.

**To enable later:** a reviewed debt-subtype classification (e.g. a mapping from `providerSubtype`, populated server-side), then flip the flag. The truth tables and tests in `components/space/compact/` already cover the tabs.
