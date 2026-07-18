# DS-0 — Global Space UI / UX Inventory

**Date:** 2026-07-17
**Posture:** Read-only architecture investigation. Not a redesign, not an implementation plan.
**Method:** Five parallel read-only sweeps (navigation · surfaces+tokens · components · visualizations · interaction+responsive) over `app/**` (196 files) + `components/**` (271 files, 46,917 LOC) + `lib/space*` / `lib/perspectives*`, plus a first-hand read of the Space spine and the governing doctrine. Every headline claim was re-verified against the live working tree with direct greps; the radius finding was verified by compiling Tailwind in-memory. Claims that could not be confirmed are marked **UNCERTAIN**. **No repository file was modified** — the only write is this document.
**Question answered:** *What actually exists in the Global Space UI today, what is duplicated, what must be preserved, and is the product ready to begin a holistic UI/UX composition initiative (DS-1)?*
**Scope note:** Browser verification was not attempted — MCP Chrome is not authorized for localhost+auth in this environment. All responsive/visual claims are static-analysis-based.

---

## Executive summary

Fourth Meridian's Space layer rests on an unusually real architectural spine: a genuinely domain-agnostic `SpaceShell`, a single non-clobbering URL authority, one canonical time reducer, one workspace registry, and a 312-line binding doctrine whose invariants are enforced by executable source-scan tripwires. The Atlas design system is real and adopted (`GlassPanel` 29 importers, `platform/widget-kit` 25), with a well-designed 5-tier glass material engine, a correct dual-theme mechanism, and global `prefers-reduced-motion`.

The presentation layer splits into **two clearly separable maturity zones**. `components/atlas/**`, `components/space/**`, `components/dashboard/**`, and `components/brief/**` are fully tokenized (zero raw `gray-*`), carry `focus-visible` rings, and route modals through a real primitive. `app/admin/**` and `app/(auth)/**` are a pre-system island — 496 raw palette classes hardcoding a dark-gray theme that parallels but does not match `--ink-*`, plus a duplicated shell and horizontally-scrolling tables.

The three findings that most constrain DS-1 are: (1) the `--radius-*` tokens **silently override Tailwind's scale**, producing a non-monotonic result where `rounded-xl` (28px, 280 uses) renders larger than `rounded-2xl` (16px, 51 uses) — compile-verified and invisible in source; (2) the token layer is **disconnected from the utility layer** (no `@theme`), so every token access is arbitrary-value syntax (1,933 uses) and `--space-*` is ~100% bypassed; (3) **navigation ownership never left** the 1,483-LOC `SpaceDashboard.tsx` host, even though rendering did.

Verdict in one line: **the substrate is design-ready; DS-1's job is to finish distributing the system that already exists, not to invent one.**

---

## DS-0A — Global Space Architecture Diagram

### Composition (as built)

```
app/(shell)/dashboard/layout.tsx          Server Component (owns runtime/preferredRegion)
└─ DisplayCurrencyProvider                 lib/currency-context.tsx
   └─ DashboardChrome                      components/ui/DashboardChrome.tsx (170 LOC)
      ├─ Sidebar            (hidden lg:flex, 572 LOC)   ── global nav, desktop
      ├─ AtlasField         (ambient globe background)
      ├─ mobile header      (lg:hidden, sticky top-0 z-40, h-14)
      ├─ desktop header     (hidden lg:flex, sticky top-0 z-40, h-14)
      ├─ <main px-4 lg:px-8 pt-5 pb-24 lg:pb-8>
      │  └─ page.tsx  ──┬─ PersonalDashboard (100 LOC wrapper) ─┐
      │                 ├─ SpaceDashboard ────────────────────  ├─▶ SpaceShell
      │                 └─ PlatformSpaceDashboard (237 LOC) ────┘
      ├─ BottomNav          (lg:hidden, fixed bottom-0 z-50, 64 LOC)
      ├─ TransactionDetailDrawer   ← THE single instance, Suspense-bounded
      └─ CreateSpaceModal          ← THE single instance
```

```
SpaceShell (components/space/shell/SpaceShell.tsx — 146 LOC)
├─ overlays              slot   (host owns WHAT; shell owns WHERE)
└─ max-w-5xl mx-auto
   ├─ header             title · subtitle · displayCurrencyControl slot · toolbar slot
   ├─ rail               SegmentedControl, floating pill (FloatingNavWrapper) or static
   └─ children           ← the workspace slot
```

### Ownership table

| Layer | Owns it | Consumes it | Responsibility |
|---|---|---|---|
| **App chrome** | `DashboardChrome` | all `/dashboard/**` | sidebar, headers, bottom nav, the *single* tx drawer + create-space modal, background |
| **Space frame** | `SpaceShell` | 2 hosts (`SpaceDashboard`, `PlatformSpaceDashboard`) | header, rail, toolbar, overlay mount, workspace slot. **Provably domain-agnostic** |
| **Host / orchestration** | `SpaceDashboard` (1,483 LOC) | `page.tsx`, `PersonalDashboard` | **all** nav state, 12 fetch sites, 31 `useState`, 18 `useEffect`, 14 `setActiveTab` |
| **Navigation (order/copy)** | `lib/space-nav.ts` | host | `SPACE_TAB_ORDER` (fixed, 9 tabs) + labels **only** |
| **Workspace identity** | `WORKSPACE_REGISTRY` (`lib/perspectives.ts`, 493 LOC) | host, `workspace-resources` | id · label · icon · kind · routing · envelope · dataNeeds |
| **URL** | `useSpaceUrl` → `lib/space/space-url.ts` | 4 writers | single history writer, single popstate listener, non-clobbering by construction |
| **Time** | `usePerspectiveShellState` → `lib/perspectives/time-range.ts` | shell + workspaces (read-only) | one `{preset, asOf, compareTo}` reducer |
| **Refresh** | window `CustomEvent` bus (`lib/space-nav.ts:133-152`) | 9 dispatch/listen sites | `space-accounts-changed` · `space-currency-changed` · `space-data-refreshed` |
| **Scroll** | the **window** (no nested scroller) | `FloatingNavWrapper`, sticky headers | `position: sticky` pins against document scroll |
| **Active Space** | **a cookie** (`fintracker_space`) + `getSpaceContext()` | server | ambient — see below |
| **Section rendering** | `SectionRegistry` (783 LOC) + `SectionCard` | host | key → renderer dispatch. Contains **no navigation** (verified) |
| **Workspace data** | each workspace | itself | 3 `*SpaceData` loaders (connections/investments/liquidity) + 2 read-models (Wealth, Debt) |

### The one fact that shapes everything

**Space switching is cookie-based, not URL-based.** There is no `/dashboard/space/[id]` route. `POST /api/space/switch` sets `fintracker_space`; the server resolves it in `getSpaceContext()` (`lib/space.ts:110-142`, `cache()`-deduped). `/dashboard` means *"whatever Space the cookie points at."*

This ambient design requires **three compensating mechanisms**, all present in the tree:

1. `router.refresh()` after switch (`SpacesClient.tsx:1130`)
2. a **nested** `DisplayCurrencyProvider` overriding the layout's (`app/(shell)/dashboard/page.tsx:55,92`)
3. `key={ctx.spaceId}` force-remount so client state can't leak across Spaces (`page.tsx:58,95`)

The switch transition itself is **duplicated verbatim** in `Sidebar.tsx:173-191` and `SpacesClient.tsx:1113-1136` — same 5 steps, same order, with a self-aware `"(parity with Sidebar.handleSwitch)"` comment at `:1129`.

### Verified boundary integrity

`SpaceShell` has exactly **two real mounting hosts**. The apparent references in `CashFlowWorkspace.tsx:6`, `DebtWorkspace.tsx:10`, and `LiquidityWorkspace.tsx:11` are **docstrings only** — no workspace imports the shell. The doctrine's boundary holds in the tree.

---

## DS-0B — UI Component Catalog (by architectural owner)

### The primitive layer is `components/atlas/` — not `components/ui/`

| Primitive | LOC | Importers | Maturity |
|---|---|---|---|
| `GlassPanel` | 228 | **29** | Real. Polymorphic (`as`), fully tokenized. **Most-reused component in the repo** |
| `OverlaySurface` | 403 | 8 direct (+9 via presets) | Real. Portal · scrim · focus trap · scroll lock · Escape · reduced-motion · `dvh` mobile intent |
| `GlassButton` | 96 | 14 | Real. `forwardRef`, `tone × size × fullWidth` |
| `DataCard` | 123 | 13 | Real. Composes GlassPanel; doesn't re-implement glass |
| `SegmentedControl` | 213 | 8 | Real. Measured sliding highlight, `role="tab"`/`aria-selected`. **Tested** |
| `FormModal` / `Dialog` / `ConfirmDialog` | 29/29/89 | 9/3/3 | Thin presets over OverlaySurface |
| `AtlasLiquidCard` / `AtlasLiquidCta` | 139/97 | 5/3 | WebGL accent material (doctrine-gated) |
| `platform/widget-kit.tsx` | 145 | **25** | **2nd-most-reused module.** A genuine mini design system |

`components/ui/` is misnamed app chrome: 8 files, **5 single-use**, zero primitives, zero tests. `AtlasField.tsx` is *not* a form field — it is a decorative globe background (actively misleading name).

### Adoption gap — the central component finding

| Concept | Primitive | Bypasses |
|---|---|---|
| Button | `GlassButton` (38 JSX uses) | **325 raw `<button>`** → **~10.5% adoption** |
| Input | **none exists** | 85 raw `<input>` + 45 `<select>` + 5 `<textarea>` → **0%** |
| Badge/chip | **none exists** | **169 inline `rounded-full`** |
| Modal | `OverlaySurface` | **17 total impls**: 4 canonical + 4 wrappers + **9 hand-rolled** |
| Spinner | **none exists** | **107 `animate-spin` across 61 files** |
| Skeleton | 1 (`BriefSkeleton`) | 9 raw `animate-pulse` → **spinner:skeleton ≈ 12:1** |
| Empty state | `NoSectionsCard` (4 importers) | 6 impls, only 1 exported |

**Worst raw-`<button>` offenders:** `DebtClient.tsx` (22), `app/admin/security/page.tsx` (19), `TotpSection.tsx` (18), `GoalsCard.tsx` (13).

### Duplication ledger (selected, all cited)

| Duplicated job | Implementations |
|---|---|
| Async-action button | `RefreshButton` · `SyncWalletButton` · `ConnectAccountButton` · `ReconnectAccountButton` · `AccountRefreshButton` · `ImportHistoryButton` — **6 impls, 371 LOC** |
| Portal | `OverlaySurface.tsx:303` vs `BriefModal.tsx:186` |
| Globe background | `AtlasField.tsx` (86) vs `EarthBackground.tsx` (287) |
| Logo | `AppLogo` (80) vs `BriefLogo` (58) vs `Wordmark` (36) |
| Turnstile | `ui/TurnstileWidget` (131) ≡ `marketing/TurnstileWidget` (125) |
| Perspective tabs | `PerspectiveTabs` (67) vs `PerspectiveSwitcher` (172) |
| KPI strip | `DebtKpiStrip` (138) vs `InvestmentKpiStrip` (162) |
| Dialog preset | `atlas/Dialog` (29) vs `dashboard/widgets/GlassModal` (79) |
| Calendar heatmap | `CalendarHeatmapGrid` (281) vs `CashFlowCalendar` (142) vs `TransactionsCalendarHeatmap` (124) |
| Hero | `WealthHero` (135) vs `SpaceTrendHero` (220) vs `BriefHero` (287) |

### The widget system is live and load-bearing (not dead code)

`lib/widget-registry.ts` — 1,107 LOC, **53 entries (43 implemented, 10 placeholder)**, typed contract (`DataRequirement`, `ConfigField`, `WidgetMeta`), **test-enforced** (`lib/space-templates/registry.test.ts:94` asserts every template key exists; `lib/perspectives/virtual-sections.test.ts:33` asserts keys are implemented and non-deprecated). It carries its own "Widget Primitive Rule" doctrine at `:11-23`.

Architecture: **5 primitives** (`AssetValueWidget`, `ProgressWidget`, `BreakdownWidget`, `SummaryWidget`, `TimelineWidget`) + **6 adapter modules** mapping domain data → primitives. This is the most mature subsystem in the repo.

**Caveat:** only `getWidgetMeta` is consumed by production code (2 call sites — `SectionRegistry.tsx:24`, `lib/perspectives/virtual-sections.ts:20`). The 1,107 LOC is a declarative catalog serving one accessor — verbose, but not dead.

A second, parallel registry exists: `PLATFORM_WIDGET_REGISTRY` (`PlatformSpaceDashboard.tsx:73`). The fork is deliberate and documented at `:69`.

### System-wide: there are no render tests

**39 component test files. All are `.test.ts`. Zero `.test.tsx`. Zero `@testing-library`. Zero `render(`** — independently verified. Tests are *source-text scans* (`readFileSync` + string assertions); `SegmentedControl.test.ts:15` states the convention explicitly ("Source-scan (house convention, no RTL)").

**No component in this repository has a behavioural or render test.** This is the single most important fact for DS-1 risk.

---

## DS-0C — Design Token Inventory

### Setup

Tailwind **4.3.2**, CSS-first. **No `tailwind.config.*`. No `@theme` block anywhere** (0 hits for `@theme|@plugin|@config|@source|@utility|@apply`). Only 2 CSS files: `app/globals.css` (549 lines) + a 29-line vendored `card.css`.

### The root architectural fact

`globals.css:1` is `@import "tailwindcss";` followed by a bare **`:root`** at `:3`. **The tokens are plain custom properties never registered with Tailwind.** Consequence: no generated utilities, no opacity modifiers, no IntelliSense. Every access is arbitrary-value syntax — **1,933 `[var(--…)]` uses across 72 distinct tokens**.

The token layer is genuinely *adopted* (194/259 tsx files use tokens). It is simply **disconnected from the utility layer by construction**.

Top consumed tokens: `--text-muted` (383), `--text-secondary` (301), `--text-primary` (234), `--text-faint` (158), `--border-hairline` (126), `--meridian-400` (96), `--surface-hover` (81).

### Tokens defined — 121 distinct

| Category | Lines | Contents |
|---|---|---|
| Palette | `12-70` | ink 0–950 · brass · meridian · emerald · coral · violet · paper (47 total) |
| **Radius** | `73-78` | xs 6 · sm 10 · md 14 · lg 20 · xl 28 · full 999 |
| **Spacing** | `81-92` | `--space-1…12` (4→96px) |
| **Motion** | `95-104` | 4 easings (`standard`/`enter`/`exit`/`spring`) · 6 durations (instant 100 → ambient 2400) |
| **Glass engine** | `162-178` | 5 tiers × blur/sat/bright + 5 combined `--glass-filter-*` (blur 14/22/46/68/84px, sat 185/172/150/138/132%) |
| Shadow / z / type | `107-124` | `--shadow-e1…e4` · `--z-modal:100…critical:300` · `--font-ui`/`--font-data` |
| Themes | `183-273` | `html[data-theme="dark"]` (default) + `html[data-theme="light"]` |

The **5-tier glass material scale** is genuinely well-designed and is the system's best asset.

### Verified defects

**1. `--radius-*` silently overrides Tailwind's scale.** Compile-verified in-memory through `@tailwindcss/postcss`:

```
--radius-lg   => ["0.5rem", "20px"]   ← Tailwind (layered) then globals (unlayered) — 20px wins
--radius-xl   => ["0.75rem", "28px"]  ← 28px wins
--radius-2xl  => ["1rem"]             ← never overridden — stays 16px
--radius-3xl  => ["1.5rem"]           ← never overridden — stays 24px
```

Per CSS cascade, unlayered `:root` beats `@layer theme`. Effective scale is **non-monotonic**:

| Class | Tailwind default | **Actual** | Uses |
|---|---|---|---|
| `rounded-sm` | 4px | **10px** | 3 |
| `rounded-md` | 6px | **14px** | 9 |
| `rounded-lg` | 8px | **20px** | **157** |
| `rounded-xl` | 12px | **28px** | **280** |
| `rounded-2xl` | 16px | **16px** (not overridden) | **51** |
| `rounded-3xl` | 24px | **24px** (not overridden) | 2 |

`rounded-xl` (28px) renders **larger** than `rounded-3xl` (24px) and `rounded-2xl` (16px). Invisible in source. `DataCard.tsx:54`'s comment ("radius `lg` ≈ legacy rounded-2xl") is consequently **wrong** (20px vs 16px). Corollary: `rounded-lg` ≡ `rounded-[var(--radius-lg)]` ≡ `rounded-[20px]` — three spellings of one value, all in use (157 / 5 / 3).

**UNCERTAIN whether deliberate** — nothing in `globals.css:72-78` mentions Tailwind, and the 2xl/3xl gap suggests not.

**2. `bg-[var(--accent)]` is undefined** — independently confirmed. `--accent` exists nowhere; only `--accent-positive/negative/neutral/info/warning`. `RebuildHistoryButton.tsx:173,183` → two primary buttons ("Done", the confirm) render **transparent with white text**. `var(--accent)` with no fallback is invalid at computed-value time → `background-color` falls back to transparent.

**3. The `--z-*` ladder is defined and ignored.** `z-[var(--z-modal)]` used **once**; actual: `z-50` ×16, `z-[100]` ×4, `z-[200]` ×2, `z-[9999]` ×1. The comment at `:121-124` claims it *replaced* the ad-hoc ladder. It did not. `CreateSpaceModal.tsx:666,673` passes literal `zIndex={300}`.

**4. `blur(30px) saturate(160%)` is a fossil** in 4 chrome surfaces (`BottomNav.tsx:43`, `Sidebar.tsx:453`, `PerspectiveShell.tsx:68-69`, `SegmentedControl.tsx:119-120`) — cloned from a GlassPanel recipe that has since been migrated to tokens (`globals.css:172-173` documents the old state). Nothing in the token ladder is 30px.

**5. `BriefModal` wraps `GlassPanel` then overrides every material prop inline** (`:229-236`) — background, backdropFilter (56px vs the token's 68px), border, boxShadow. Every prop passed is discarded.

**6. 10 hand-rolled scrims, 5 distinct fills** for one concept: `var(--scrim)`, `rgba(0,0,0,0.55)`, `black/95`, `black/70`, `black/60`. The `--scrim` token exists (`:196`) and is used by 3 of 11. `app/admin/security/page.tsx` alone contains three (`:122`, `:201`, `:291`).

### Defined-but-unconsumed

| Token | Uses |
|---|---|
| `--font-ui`, `--font-data` | **0** — `body:280` hardcodes a *different* stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI'`) |
| `--space-1…12` (12 tokens) | **3** — against **3,716** Tailwind spacing classes (~100% bypassed) |
| `--ease-exit` | 0 (⇒ no exit animations exist anywhere) |
| `--dur-moderate`, `--dur-ambient` | 0 |
| `--glass-floating` family | 0 (self-documented "additive + unconsumed") |
| `--z-modal-nested/toast/critical` | 0 |
| `--paper-100`, `--shadow-e1` | 0 direct |

### Missing token categories

- **Font size** — no tokens. 16 distinct sizes; **380 arbitrary-px uses** (`text-[10px]` ×198, `text-[11px]` ×145, `text-[9px]` ×11, …) vs `text-xs` ×796 / `text-sm` ×575. `--font-ui`/`--font-data` define *family* only.
- **Chart / data-viz series palette** — none. This is the **direct cause** of 164 raw hex literals: Recharts cannot take Tailwind classes and there is no JS token export, so every chart re-picks colors by hand.
- Font-weight / line-height / tracking · icon sizes · focus ring · scrim blur · non-glass elevation (`shadow-2xl` ×13 bypasses `--shadow-e*`).

### Hardcoded values

| Metric | Count |
|---|---|
| Raw hex `#rrggbb` | **164** (41 distinct) |
| **Raw Tailwind palette** (`text-gray-500`, …) | **1,176** |
| Arbitrary px/rem/vh/% brackets | 477 |
| `bg-white/*`, `/[0.nn]` arbitrary opacity | **0** ✅ (already migrated to `--surface-*` per `globals.css:198-207`) |

**Several hexes are near-misses against existing tokens:** `#3B82F6` (×19) *is* `--meridian-500`; `#34D399` (×20) *is* `--emerald-400`; `#22C55E` (×10) *is* `--emerald-500`; `#8B5CF6` (×5) *is* `--violet-500`. But `#F59E0B` (×23 — the most common hex) has **no token** (`--accent-warning` is a different amber, `#FBBF24`), and six near-identical brass variants exist, none matching `--brass-400 #D4A938`.

### The tokenization boundary is precise

| Zone | Raw `gray-*` |
|---|---|
| `components/atlas`, `space`, `dashboard`, `brief` | **0** |
| `components/ui` / `charts` / `notifications` | 13 / 9 / 11 |
| `components/admin` / `security` | 58 / 67 |
| `app/(auth)` | 96 |
| **`app/admin`** | **400** |

The token-free island is **`app/admin` + `app/(auth)`** (and secondarily `components/admin`/`security`), which hardcode a dark-gray theme that *parallels but does not match* `--ink-*`. Worst files: `app/admin/security/page.tsx` (108), `app/admin/audit/page.tsx` (75), `app/(auth)/login/page.tsx` (45).

### Theming

`html[data-theme]` attribute, applied post-mount by `ThemeProvider` (`:119`) for hydration safety; a bare `html` selector fallback means SSR never mismatches. Persistence: `localStorage["fm-theme-mode"]`.

**Light theme is unreachable** — `ThemeProvider.tsx:109` pins `const resolvedTheme: ResolvedTheme = "dark"` with the note "*DARK-MODE ONLY for now… re-enabling themes later is a one-line revert*". This leaves **~55 lines of maintained-but-dead light CSS** (`globals.css:235-273`, `:364-369`, `:391-394`, `:513-521`), still being extended.

---

## DS-0D — Visualization Catalog

### There are two disjoint charting stacks

**Recharts (declared `^3.8.1`, installed 3.9.1) is a minority implementation — only 3 importers:** `NetWorthChart`, `NetWorthChartModal`, `SpaceTrendHero`. **Every dominant workspace chart is hand-rolled SVG or CSS-div geometry.**

The choice is *documented and defensible* where it appears — `SpacesClient.tsx:307`: *"intentionally hand-rolled SVG rather than recharts; a card grid of 20+ Spaces rendering 20+ chart instances is exactly the case a 12-line polyline beats a charting library for."* It was never bounded to that case.

### Catalog

| Visualization | File (LOC) | Workspace | Type | Interaction | Drill-down |
|---|---|---|---|---|---|
| **NetWorthChart** | `charts/NetWorthChart.tsx` (201) | sections (`net_worth_chart`) | Recharts area | hover tooltip; 6 interval buttons | → modal via `Maximize2` |
| **NetWorthChartModal** | (271) | expand | Recharts multi-line | **series toggles** (the only true selection model in the app) | — |
| **SpaceTrendHero** | `dashboard/widgets/` (220) | Overview | Recharts area | hover only | none |
| **WealthTrendChart** | `space/widgets/wealth/` (358) | Wealth | hand SVG line+area | **richest**: scrub tooltip, metric switcher | **click → sets shell `asOf`** |
| **PortfolioValueChart** | `investments/` (109) | Investments | hand SVG | **NONE** (`aria-hidden`) | none |
| **DebtHistoryPanel** | `debt/` (109) | Debt | **CSS divs** (`flex items-end gap-0.5 h-24`) | none found | none |
| **AllocationChart** | `charts/` (201) | sections | SVG donut | hover ↔ legend linked, center-label swap | none |
| **BreakdownWidget** | `space/widgets/` (380) | **8+ registry keys** | donut/bar/list | donut hover only | none |
| **CalendarHeatmapGrid** | `shared/` (281) | Cash Flow + Transactions | heatmap | hover **+ keyboard focus** | **the only chart→drawer drill-down** |
| **CashFlowHistoryWidget** | (385) | Cash Flow | calendar + card grid | period select/step, mode toggle, filters | → `TransactionSliceDrawer` |
| **CashFlowSummaryWidget** | (329) | Cash Flow | expandable numeric rows | expand/collapse | — |
| **TimelineWidget** | (339) | Activity | event feed | filter, paginate | — |
| **ProgressWidget** | (264) | 4 registry keys | progress bar | — | — |

**Coverage:** Net Worth ✅(×3) · Cash Flow ✅ (but **no time-series line/bar** — bars were removed in favor of cards, `CashFlowHistoryWidget.tsx:190`) · Investments ✅ · Allocation ✅(×4) · Calendar/Heatmap ✅ (calendar-heatmap only; no matrix heatmap) · Tables ✅ · Activity ✅ · Breakdowns ✅ · Historical ✅(×5) · Debt payoff ✅ (calculator only — the amortization loop **computes the full month-by-month trajectory and discards it**, `DebtPayoffSection.tsx:79-92`).

### No shared chart primitive

Every time-series re-implements its own axes/tooltips/legend:

- **3 divergent axis formatters** — 2× `Intl` compact, 1× hand-rolled `M`/`k` string concat (`SpaceTrendHero.tsx:54-60`)
- **4 tick formatters** with different outputs
- **5 tooltip implementations** — 3 Recharts `contentStyle` with 3 different styles (`#1f2937` / `var(--glass-thick)` / `rgba(17,24,39,0.95)`), 1 hand-built HTML, 1 CSS group-hover. `PortfolioValueChart` has none.
- **3 bespoke legends**; no Recharts `<Legend>` anywhere
- 2 duplicated `<linearGradient>` defs with different ids, identical stops

**Verified verbatim duplication** — `AllocationChart` *is* `BreakdownWidget`'s DonutView hardcoded to 5 classes:

| `AllocationChart.tsx` | `BreakdownWidget.tsx` |
|---|---|
| `SIZE = 180` | `DONUT_SIZE = 180` |
| `MID_R = 62` | `DONUT_RADIUS = 62` |
| `STROKE = 22` | `DONUT_STROKE = 22` |
| `CIRC = 2π·MID_R` | `DONUT_CIRC = 2π·DONUT_RADIUS` |
| `(1.5/360)*CIRC` gap | `(1.5/360)*DONUT_CIRC` gap |

`AllocationChart.tsx:48` admits the lineage: *"SVG donut geometry (matches DebtBreakdownCard)"*.

Other duplication: `INTERVALS` is byte-identical in `NetWorthChart.tsx:35-42` and `NetWorthChartModal.tsx:32-39` while the modal *already imports* `cutoffForInterval` from that file. `BreakdownWidget`'s `DEFAULT_PALETTE` is manually mirrored by `CashFlowCategoryBreakdown.tsx:30`, admitted at `:28`.

### Estimated-data handling is fragmented — and loses information

**Three competing markers**, each with 1–2 consumers: `EstimatedChip` ("est.", 1 consumer — `DebtClient`, 7 call sites), `EstimatedHistoryBadge` ("Estimated history", 1 consumer — `NetWorthChart`), plus inline text variants ×3.

The consequential defect: `NetWorthChart:122` correctly ORs **both** estimation causes (backfilled `isEstimated` **and** FX-missing). `NetWorthChartModal:210-214` re-implements the disclosure inline covering **FX only** — so **expanding the chart silently drops the backfill disclosure**. `SpaceTrendHero` plots the same `isEstimated`-capable series with **no disclosure at all**.

For a product whose stated differentiator is honesty-as-UI, this is the highest-value finding in DS-0D.

Loading/empty are equally fragmented: 6 different empty states, 4 different loading treatments, `ChartFirstDayPlaceholder` has **1 consumer** while `SpaceTrendHero:163-168` re-implements the identical concept inline.

### Genuine strengths to preserve

- **`WealthTrendChart`'s gap honesty** — line *and* area fill break at real data gaps via `detectRuns`/`medianSpacingDays` (`:52-72`, `:234-255`); estimated points are hollow dashed markers; explicit legend: *"Gaps between points are real — history isn't interpolated."* Fully token-driven; `vectorEffect="non-scaling-stroke"`; aria-labels on every dot.
- **`CalendarHeatmapGrid`** — the best-factored primitive in the repo. Metric-agnostic, tested, accessible (`aria-label` per cell including the drill affordance, focus-visible ring, collision-aware tooltip placement), and the only layer distinguishing *"outside loaded range"* (faint) from *"in range, no activity"* (neutral) as **two separate facts**.
- **`SpaceTrendHero`'s honesty ladder** (`:16-23`) — loading → spinner; 0 pts → `null`; 1 pt → "Your history starts today"; 2+ → chart. Delta only with a labeled baseline window; no baseline ⇒ no delta at all. `framing`-aware coloring (down-good for debt) while the line stays neutral.
- **`CashFlowSummaryWidget`'s two-axis honesty** — liquidity primary, economic preserved behind disclosure; unresolved transfers surface as "Unresolved movement" rather than being mislabeled.

---

## DS-0E — Interaction Pattern Inventory

**No motion library.** No framer-motion / react-spring / auto-animate / react-transition-group (0 hits). All motion is CSS.

| Pattern | State |
|---|---|
| **Hover** | 460 uses, ~67 distinct values. Token-based dominates (`hover:bg-[var(--surface-hover)]` ×76, `hover:text-[var(--text-primary)]` ×59) but a raw `gray-*` stratum coexists in the admin zone. **4 different lift distances** for one gesture (`-translate-y-[1px]` ×8, `-0.5`, `-[2px]`, `-[3px]`) |
| **Focus** | `focus-visible:` 85 uses / 22 files — canonical recipe is real (`outline-none` + `ring-2` + `ring-[var(--meridian-400)]`). **30 files strip `focus:outline-none` with no `focus-visible` replacement**, and there is **no global `:focus-visible` fallback in globals.css** (0 hits). Affected: all four auth pages, five admin pages, `CreateSpaceModal`, `AddWalletModal`, `TotpSection`, `InlineField`, `AddGoalModal` |
| **Selection** | **5 distinct idioms**: `role="tab"`+`aria-selected` (SegmentedControl) · 3 hand-rolled tablists · `aria-pressed` ×3 · `aria-checked`+`role="menuitemradio"` ×3 · 23 purely-visual ternaries with no ARIA. `aria-current` appears **once** in the entire app (`SpaceTransactionsPanel.tsx:797`) — notably **not** on `Sidebar` or `BottomNav`. `data-state`/`data-active`/`data-selected`: **0** |
| **Motion tokens** | 4 easings — **100% tokenized** in `ease-*` classes. Durations 68% tokenized (23/34); 11 raw (`duration-200` ×6, `duration-300` ×5 — neither matches any token). **`transition-colors` ×354 = 79% of all motion** silently gets Tailwind's default 150ms — an **undeclared 6th duration that dominates by volume** |
| **Keyframes** | Exactly **3**, all in globals.css, all token-eased: `atlas-globe-drift` (70s), `presence-pulse` (2.6s), `meridian-shimmer` (6s) |
| **Page transitions** | **NONE.** 0 `loading.tsx`, 0 `template.tsx`, 0 `error.tsx`, 0 `not-found.tsx`. `Suspense` (37 uses / 13 files) is used for component-level data boundaries, not route transitions |
| **Modal transitions** | Enter: opacity + `translateY(8px)` over `--dur-base`/`--ease-enter`, rAF-triggered. **Exit: does not exist** — `OverlaySurface.tsx:235` returns `null` synchronously on close; `--ease-exit` is defined and used **once**. **Every modal in the app fades in and hard-cuts out** |
| **Loading** | spinner:skeleton ≈ **12:1** (107 `animate-spin` / 61 files vs 1 real skeleton, `BriefSkeleton`). The 8 other `animate-pulse` uses are generic gray bars |
| **Microinteractions** | Real but thin: sliding segmented highlight (spring-eased, `getBoundingClientRect`-measured, re-measured on resize), presence pulse, AI shimmer (2 consumers), 70s globe drift, AI typing indicator (3 staggered dots), `active:scale-[0.97]` (×8 of 325 buttons), dnd-kit drag (3 files), `touch-manipulation` ×23 |

### Accessibility (as a maturity signal)

`aria-*` 115 (`aria-label` 96 · `aria-hidden` 62 · `aria-expanded` 9 · `aria-selected` 5 · `aria-modal` 4 · `aria-current` **1**) · `role=` 43 · `tabIndex` 16 (11 are `-1`; only 5 are `0`) · `onKeyDown` 28/14 files · Escape 32/20 files · `sr-only` 6.

**Focus trapping exists in exactly 2 places** — `OverlaySurface.tsx:238-256` (inherited by its 17 consumers) and `BriefModal`'s local copy (whose header admits the duplication). The ~9 hand-rolled overlays have **no trap, no portal, and no dialog role** (7 dialog roles vs ~22 modal-named files). `role="button"` ×10 vs `tabIndex={0}` ×5 ⇒ **≥5 clickable non-buttons are keyboard-unreachable**.

`prefers-reduced-motion` **is handled globally and correctly** (`globals.css:540-548` → `0.01ms !important`, plus explicit kills for `.atlas-globe`/`.presence-dot`), with a JS `usePrefersReducedMotion` in `OverlaySurface.tsx:143-155`. A `prefers-reduced-transparency` block exists at `:529` but is documented as inert.

### Consistent / duplicated / missing

**Consistent:** hover intent · easing tokens · modal behaviour *for the 17 OverlaySurface consumers* · reduced-motion · Escape-to-close (universal, if duplicated ~20×).

**Duplicated:** two hover vocabularies · 4 lift distances · 4 tablist implementations · 5 "active" idioms · ~20 Escape handlers · 2 focus traps · 6+ hand-rolled overlays · 11 raw durations.

**Missing:** page transitions · **exit animations everywhere** · focus rings in 30 files · global `:focus-visible` fallback · skeletons · `aria-current` on both nav components · portal for 6 overlays · any `data-*` state convention.

---

## DS-0F — Responsive Assessment

**Breakpoints:** stock Tailwind v4 (no config, no `@theme`, no `--breakpoint-*`). **Zero hand-written responsive media queries** — the only 2 `@media` blocks in globals.css are the a11y ones.

| Prefix | Uses |
|---|---|
| `sm:` | 124 |
| `lg:` | 79 |
| `md:` | 61 |
| `xl:` | 28 |
| `2xl:` | **0** |

≈292 responsive utilities across 259 files ≈ **1.13 per file — sparse**. Only **19 `hidden↔visible` pairs** and **9 `*:hidden` occurrences across 8 files** exist in the entire app.

| Tier | Behaviour |
|---|---|
| **Desktop (≥1024)** | `Sidebar` (`hidden lg:flex`, fixed `w-64`, no collapse/rail variant, no hamburger) + desktop header (`hidden lg:flex`, h-14) |
| **Tablet (768–1023)** | **No tier exists.** Both Sidebar (`lg:flex`) and BottomNav (`lg:hidden`) key off 1024 only ⇒ **a 900px iPad renders mobile chrome at near-desktop width**. `md:` (61) is almost entirely padding |
| **Mobile (<1024)** | `BottomNav` (`lg:hidden`, fixed, h-16, 4 tabs) + mobile header. `main`'s `pb-24` (96px) correctly clears the 64px nav; `lg:pb-8` drops it |
| **Ultrawide (>1280)** | Nothing adapts — `2xl:` unused; 7 `max-w-[1400px]` clamps ⇒ whitespace, not density |

**Mechanism is 100% CSS.** No `useMediaQuery`/`useWindowSize` hooks exist (0 hits). The only `matchMedia` uses are non-layout: theme, reduced-motion, reduced-transparency. **This is a coherent, defensible choice** — SSR-safe, no hydration-mismatch class of bug, no layout flash. The cost: nothing can *restructure* per viewport, only reflow or hide.

### Adapts well

- **`OverlaySurface`** — the best responsive work in the codebase. Intent-driven (`:261-274`): `intent="dialog"` → bottom sheet on mobile (`items-end sm:items-center`, `max-h-[92dvh]`); `form`/`workspace` → full-screen (`h-[100dvh] sm:h-auto`); `size="full"` → `sm:h-[92dvh]`. Uses `dvh` not `vh` — correct for mobile URL bars.
- `AllocationChart.tsx:106` — 3-tier donut sizing (`w-[180px] sm:w-[220px] lg:w-[264px]`) with `max-w-full`.
- Brief surfaces — consistent `px-6 md:px-10 xl:px-16 max-w-[1400px]` gutters (the only place `xl:` does real work).
- **`min-w-0` used 179×** — heavy, correct flexbox-overflow discipline. This is *why* the app reflows as well as it does despite few breakpoints.

### Known gaps

1. **Connections is unreachable from mobile nav.** `Sidebar` has 8 destinations, `BottomNav` has 4; the sets **diverge**. There is no shared source of truth for global destinations (contrast: Space tabs *do* have one in `lib/space-nav.ts`). Mobile also has no Space switcher — it must route through `/dashboard/spaces` (documented as intentional at `BottomNav.tsx:6-10`).
2. **Admin tables overflow horizontally.** 7 `<table>`s (all but one in `app/admin`), strategy = `overflow-x-auto` wrapper, with **exactly one** responsive column-shed in the entire set (`app/admin/audit/page.tsx:184`, `hidden xl:table-cell`). 16 files add `whitespace-nowrap`, compounding it.
3. **BottomNav ignores `env(safe-area-inset-bottom)`** (`:39-46`) — on notched iPhones the 4 tabs sit in the home-indicator zone. The codebase knows the API (`OverlaySurface.tsx:393` uses it — the only site).
4. **6 hand-rolled modals get no mobile sheet/full-screen treatment** — `AddGoalModal.tsx:193` is `fixed inset-0 flex items-center justify-center px-4`: always centered, no `dvh` cap, no scroll body. It has 3 field groups and will clip on short viewports. This is exactly the defect class `OverlaySurface.tsx:31-33` was built to fix.
5. **Chart heights are hardcoded JS constants** — `NetWorthChart.tsx:103` → `fill ? 260 : 180`. Charts stretch horizontally, never shorten. **UNCERTAIN** whether acceptable at 375px — not browser-verified.
6. **`app/admin` duplicates the entire shell** (`layout.tsx:51,73,79`) — same `lg:` contract, different width (`w-52` vs `w-64`), different z (40 vs 50), raw `bg-gray-950` instead of glass tokens.
7. **`ProviderDiagnosticsDrawer`** is `fixed inset-0` **without a portal** — latent containing-block bug under `backdrop-filter` ancestors (the exact bug documented at `OverlaySurface.tsx:19-25`). **UNCERTAIN** whether live; admin uses raw backgrounds, so probably latent.

---

## DS-0G — Technical Constraints (Product Design must preserve)

These are **binding**. Most are enforced by executable tripwires that fail CI on drift.

| # | Constraint | Authority | Enforcement |
|---|---|---|---|
| 1 | **SpaceShell is domain-agnostic.** It may never name Investments/Wealth/Debt or compute a figure | doctrine §1 | `space-shell.test.ts:74-89` bans workspace/FX/URL/time names; `:49-53` pins the exact slot-API key set; `:95-97` forbids the host importing `SegmentedControl`/`FloatingNavWrapper` directly |
| 2 | **One URL authority.** One history writer, one popstate listener, all serialization through the pure core | doctrine §7 | `space-url-authority.test.ts:35-56` — no direct `history.*State`, exactly one popstate, no `useSearchParams` |
| 3 | **One time reducer** owning `{preset, asOf, compareTo}` | doctrine §8 | `time-range.test.ts`; `cashFlowPeriod` pinned as *derived*, not owned (`:64-67`) |
| 4 | **Rail order is immutable.** `SPACE_TAB_ORDER` is a cross-Space muscle-memory contract ("Accounts is always third") | doctrine §6 | `lib/space-nav.ts:11-15` |
| 5 | **Workspaces declare availability only** — never add/remove/reorder rail entries | doctrine §6 | registry |
| 6 | **One registry** for workspace identity; **Space composition is a separate authority** | doctrine §4, §15 | `workspace-definition.test.ts:113` |
| 7 | **Envelope honesty** — no fabricated counts, no invented percentages; absent envelope ⇒ inert "—" | doctrine §12.7 | `envelope.test.ts` |
| 8 | **Snapshot honesty** — `fxMiss` rows dropped from any plotted series (a shorter honest trend over a silently mixed-magnitude one) | doctrine §12.8 | — |
| 9 | **FX split** — shell owns the *control*, shared services own the *math*, workspaces own their own *presentation* | doctrine §9 | `space-shell.test.ts` |
| 10 | **No `useSearchParams`** in the shell path — would force a Suspense boundary | mechanism invariant | `space-url-authority.test.ts:54-56` |
| 11 | **SSR-safe time defaults** (MTD), hydrated from URL post-mount | mechanism invariant | — |
| 12 | **Atlas Liquid is a scarce accent** — never on grids/data/modals/forms/chrome/admin/ops/settings; always with a Glass fallback; one-per-view | `ATLAS_LIQUID_PLATFORM_DOCTRINE.md` §6 | doctrine sign-off |
| 13 | **Theme must be dual** — every surface needs `data-theme` light+dark tokens; SSR carries no attribute | `ThemeProvider` | hydration safety |
| 14 | **`prefers-reduced-motion`** must survive any motion work | `globals.css:540` | — |
| 15 | **The window is the scroll container** — no nested scroller; `position: sticky` depends on it | `FloatingNavWrapper.tsx:22-25` | — |
| 16 | **Investments — Current vs Historical, never cross-derived** | doctrine §12.1 | — |
| 17 | **Transactions — server-side visibility filtering**, never re-derived client-side | doctrine §12.5 | — |

**Performance-sensitive areas:** each Atlas Liquid surface is a live WebGL canvas (N canvases = battery/FPS failure — doctrine §1) · the hand-rolled sparkline choice was made *because* 20+ Recharts instances in a card grid is a real cost (`SpacesClient.tsx:307`) · `SpaceDashboard` already carries 12 fetch sites · nothing in the app is precomputed or cached (EXEC-1: "every screen is recomputed on request").

**Do not casually redesign:** the three-tier ownership model (shell / workspace / shared services) · the `*SpaceData` loader boundaries · the trust-envelope contract · the fixed rail order · the honesty ladder in charts (gap-breaking, estimated markers, "history starts today") · `WealthResult` having no `WealthSpaceData` loader (a deliberate doctrine decision, §5 — a parallel loader is a named anti-pattern).

---

## DS-0H — Architectural Opportunities (strictly evidence-based)

Ordered by *evidence strength × leverage*. **Not a plan** — an inventory of what the evidence supports.

### Tier 1 — verified defects (correctness, not taste)

1. **`--accent` undefined** → 2 transparent primary buttons. `RebuildHistoryButton.tsx:173,183`. One-line fix.
2. **Non-monotonic radius scale** (compile-verified) → `rounded-xl` (28px, 280 uses) > `rounded-2xl` (16px, 51 uses). Silent. **Any radius decision made today is made on a scale nobody can see.**
3. **`NetWorthChartModal` drops the backfill disclosure** that its own parent shows — an honesty regression on expand, in the product whose thesis is honesty.
4. **Dead link:** `SpacesClient.tsx:1245` → `/dashboard/spaces/public` 404s (route does not exist; verified by `find`).
5. **`?tab=settings` on Personal renders a blank frame** — `SETTINGS` is a valid `SpaceTabId`, filtered from the rail at `SpaceDashboard.tsx:361`, with no render branch. `mapLegacyTabToShell` can produce it. **UNCERTAIN** if reachable from a live link (no emitter found).
6. **`RoutedWorkspaceModal`'s Back button re-opens the modal it just closed** — close sets `activeTab="OVERVIEW"` (`:1407`), which the sync effect (`:434-447`) pushes as a new history entry. The app's *other* modal-as-route (`useTransactionDrawer:50-57`) does `router.back()` — **opposite close semantics for the same pattern**.
7. **Connections unreachable from mobile nav** — high-impact, one-line, independently flagged in EXEC-1.

### Tier 2 — structural (the real DS-1 substrate)

8. **Navigation ownership never left the host.** SD-1/5/6/7 moved *rendering* out; `SpaceDashboard.tsx` still owns tab + lens + metric + account-seed + cashflow-override + 14 `setActiveTab` sites + every doorway callback, at 1,483 LOC / 31 `useState` / 18 `useEffect` / 12 fetches (independently verified). **DS-1 cannot redesign navigation without confronting this file.**
9. **Seven overlapping tab vocabularies across 4 files** (verified): `SPACE_TAB_ORDER` (`lib/space-nav.ts:35`) · `URL_SYNCED_TABS` (`SpaceDashboard.tsx:133`) · `URL_TAB_ALIAS` (`:139`) · `TAB_ORDER` (`:172`) · `NEW_SPACE_TABS` (`:208`) · `ROUTED_WORKSPACE_TABS` (`lib/perspectives.ts:471`) · `mapLegacyTabToShell` (`page.tsx:21`). `lib/space-nav.ts` claims canonicity but owns only order+copy — not URL slugs, aliases, section-tab order, or the routed set. Also: `parseTabParam` coerces any invalid value to `OVERVIEW` (not `null`), silently suppressing the section-derived default.
10. **The token layer is disconnected from the utility layer** — no `@theme`, so 1,933 arbitrary `[var(--…)]` uses, `--space-*` ~100% bypassed (3 uses vs 3,716 Tailwind classes), `--font-ui`/`--font-data` at 0 uses while `body` hardcodes a different stack. **Registering tokens in `@theme` is the single highest-leverage token move** — it would make the design vocabulary the *default* rather than the *verbose alternative*, and would resolve the radius collision as a side effect.
11. **No chart primitive** — 5 "value over time" impls in 4 technologies (Recharts ×2 separate, hand SVG ×2, CSS divs ×1); 3 axis formatters, 4 tick formatters, 5 tooltips, 3 legends. `CalendarHeatmapGrid` proves the team can build a good metric-agnostic primitive.
12. **No chart color tokens** → 164 raw hexes, concentrated in data-viz, *because* Recharts cannot take Tailwind classes and there is no JS token export. Several hexes are exact matches for existing tokens (`#3B82F6` = `--meridian-500`, `#34D399` = `--emerald-400`).
13. **Missing primitives with the highest duplication cost:** Input (0%, 85 raw), Badge (169 `rounded-full`), Spinner (107 uses / 61 files), Skeleton (1), Empty state (6 impls). Precedent exists: `SpaceSectionStack`'s `emptyState: ReactNode` slot is a real IoC seam.
14. **`app/admin` + `app/(auth)` are a token-free island** — 496 raw grays + a duplicated shell + 30-file focus-ring gap concentrated here. Bringing them onto Atlas is bounded, mechanical, and low-risk.

### Tier 3 — cheap consolidations with clear evidence

15. Space-switch duplicated verbatim (`Sidebar.tsx:173-191` ≡ `SpacesClient.tsx:1113-1136`, self-annotated "parity with").
16. 2 near-duplicate hand-rolled tablists (`CashFlowFilterControls:82-115` ≈ `CashFlowHistoryWidget:76-100`) inside a Space that already renders 3–4 `SegmentedControl` tracks simultaneously.
17. `AllocationChart` = `BreakdownWidget` DonutView + 5 hardcoded classes (verbatim constants).
18. 6 async-action buttons, 371 LOC, one job.
19. `blur(30px)` fossil in 4 chrome surfaces · 10 hand-rolled scrims / 5 scrim fills · z-token ladder used once · `BriefModal` overriding every GlassPanel prop.
20. **A 5th URL writer bypasses SD-0A** — `SpacesClient.tsx:1088` raw `history.replaceState` for the `?left=` toast. It sits outside the Space shell, so `space-url-authority.test.ts` (which reads only 3 files) does not catch it.
21. **Stale docs to correct:** `SpaceDashboard.tsx:6` ("Rendered for any non-PERSONAL space" — Personal routes through it via `PersonalDashboard`) · `Dialog.tsx:18` / `FormModal.tsx:22` ("Phase 1: additive, wired to nothing" — they have 3 and 9 importers) · `DataCard.tsx:54` (radius claim is wrong).

### Explicitly not an opportunity

- The widget registry (1,107 LOC) is **live and test-enforced** — verbose, not dead.
- CSS-only responsive is **coherent**, not a gap — it buys SSR safety.
- Hand-rolled sparklines in card grids are **justified and documented**.
- `WealthResult` having no `WealthSpaceData` loader is a **deliberate doctrine decision** (§5), not an omission.
- `PLATFORM_WIDGET_REGISTRY` forking from `SectionRegistry` is **deliberate and documented** (`PlatformSpaceDashboard.tsx:69`).

---

## DS-0I — Readiness Assessment

> **Is Fourth Meridian ready to begin a holistic Global Space UI / UX Composition initiative?**

### Yes — with three named pre-conditions.

**Why yes.** DS-1 needs an architectural spine to compose *onto*, and this repository has an unusually real one — not aspirational, and verified in the tree:

- **The ownership model is genuine and enforced.** `SpaceShell` is provably domain-agnostic; workspaces do not import it (verified — the only references are docstrings). Two hosts, one frame, including the HQ Platform Spaces. The doctrine's central claim holds.
- **The hard problems are already solved once, correctly.** One URL authority (non-clobbering by construction), one time reducer, one registry, one section compositor, three `*SpaceData` loaders + two deliberate read-models.
- **The constraints are written down and executable.** A 312-line binding doctrine with ratified invariants and named anti-patterns, plus source-scan tripwires that fail CI on drift. DS-1 will not have to *discover* the rules.
- **The design system exists and is adopted.** Atlas is real (`GlassPanel` 29 importers, `widget-kit` 25), doctrine-backed (4 documents in `docs/design-system/`), with a well-designed 5-tier glass engine, a correct dual-theme mechanism, and global `prefers-reduced-motion`.
- **There is a defensible product thesis to design *toward*.** The honesty architecture (trust envelopes, gap-breaking charts, "history isn't interpolated", never-fabricated counts) is, per EXEC-1, the most defensible idea in the repo. DS-1 has a north star, not a blank canvas.

**Three pre-conditions — resolve before or in DS-1's first slice**, because each will silently corrupt design decisions made on top of it:

1. **Fix the radius collision** (Tier-1 #2). Compile-verified, invisible in source, affects 331 call sites. Every radius decision DS-1 makes today is made on a non-monotonic scale that nobody — including the designer — can see. This is the one finding that actively poisons DS-1's output.
2. **Decide the token↔Tailwind seam** (Tier-2 #10). Registering tokens in `@theme` vs. keeping the arbitrary-value convention is a *fork in the road*, not a cleanup: it determines whether DS-1's vocabulary is the default or the verbose alternative. Deciding it after DS-1 means rewriting DS-1's output.
3. **Scope DS-1 against `SpaceDashboard.tsx` explicitly** (Tier-2 #8). Navigation ownership never left the 1,483-LOC host. DS-1 must either (a) exclude navigation from scope, or (b) budget for the host decomposition. Discovering this mid-initiative is the most likely way DS-1 stalls.

**One risk to accept consciously, not fix:** **there are no render tests.** 39 component test files, all source-text scans, zero RTL, zero `.test.tsx` — verified. The tripwires protect *architecture* (who owns what) but nothing protects *behaviour*. A UI/UX composition initiative is precisely the kind of work that breaks behaviour invisibly. Combined with no browser verification available in this environment, DS-1's verification story is currently: typecheck + source-scan + eyeballs. That is a real gap — but it argues for a **verification decision**, not a blocker.

**What is not blocking, despite looking alarming:** the 325 raw buttons, 17 modal impls, 169 chips, 164 hexes, and 1,176 raw grays are *volume*, not *risk*. They are mechanical, bounded, and concentrated (496 of the grays are in `app/admin` + `app/(auth)` alone). They are DS-1's **workload**, and the fact that the primitives to absorb them already exist and are adopted is the strongest single readiness signal in this report.

### Honest summary

The financial and architectural substrate is **launch-grade and design-ready**. The presentation layer is **two clearly separable maturity zones**: a real, tokenized, accessible, doctrine-backed system (`atlas/` + `space/` + `dashboard/` + `brief/`), and a pre-system island (`app/admin` + `app/(auth)`, plus older hand-rolled overlays) that never migrated.

DS-1's job is not to invent a system — it is to **finish distributing the one that already exists**, and to close the grammar questions (Perspective vs Workspace, routed-modal vs rail, three modal state models) that the code has formalized but the *user* still experiences as two vocabularies.

---

*Read-only. No redesign proposed, no implementation planned. The next phase (DS-1 — Global Space UI / UX Composition) is performed separately.*

**Note:** Tier-1 items #1 (`--accent`) and #4 (dead `/dashboard/spaces/public` link) are live user-facing defects, not design debt. They are outside DS-0's read-only mandate and are reported only; they do not require DS-1 to be fixed.
