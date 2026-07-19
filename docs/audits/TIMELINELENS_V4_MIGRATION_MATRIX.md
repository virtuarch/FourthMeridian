# TimelineLens v4 — Migration Matrix

Status: **investigation complete, no code changed**
Date: 2026-07-19
Scope: inventory of every time-control implementation, and what a v4 migration would touch.

---

## 0. Headline finding — the premise needs correcting

**There are no workspace-specific time slicers.** Wealth, Investments, Cash Flow, Debt, and Liquidity render *zero* time UI between them. All canonical time control lives in **one shared block, at one render site**:

```
SpaceDashboard.tsx:805          ← the ONLY render site
  └─ PerspectiveShell.tsx:85-97 ← renders both controls, once, for every Perspective
       ├─ ShellContextRow.tsx        As of · ⇄ swap · Compare to · clear   (capability-gated)
       └─ CashFlowPeriodSelector.tsx WTD·MTD·QTD·YTD | 1W·1M·3M·6M·1Y·ALL  (UNIVERSAL, never gated)
```

Gated at `SpaceDashboard.tsx:796` by `activeTab === "OVERVIEW" && perspectiveEngaged`.

This is *good news* — the system is cleaner than the migration brief assumed — but it has three consequences that change the plan's shape:

1. **This is one migration, not seven.** The five financial workspaces are **verification surfaces**, not migration targets. Nothing in `components/space/widgets/{wealth,investments,debt,liquidity,cashflow}/` changes.
2. **"Wealth first, don't continue until parity is proven" is not directly executable.** The control is shared, so swapping it for Wealth swaps it for all five simultaneously. Incremental rollout requires a deliberate per-Perspective opt-in flag — see §6.
3. **The unit of success shifts.** The brief's criterion — "one fewer time implementation per page" — is already true at the Perspective layer: there is exactly one implementation. The genuine reductions available are the *legacy islands* (§4), which are a separate, larger effort.

Existing tripwire tests already pin the no-duplicate-authority property: `DebtWorkspace.test.ts:70`, `LiquidityWorkspace.test.ts:80`, `WealthWorkspace.test.ts:70-71`, `CashFlowWorkspace.test.ts:93`, `space-shell.test.ts:102`.

---

## 1. The migration matrix

| Surface | Current control | Current actions | Replace? | Adapter |
|---|---|---|---|---|
| **Wealth** | *(none of its own)* — shared shell block | `selectPreset`, `setAsOf`, `setCompareTo`, `clearCompareTo`, `swap` | **Yes — via the shared shell** | `PerspectiveTimeAdapter` (one, shared). Raw `compareTo`, incl. forward comparison. |
| **Investments** | *(none of its own)* — shared shell block | same | **Yes — via the shared shell** | Same shared adapter. `historicalCompareTo` clamp stays downstream at `workspaceRenderers.tsx:147`. |
| **Cash Flow** | *(none of its own)* — shared shell block; date inputs hidden by capability | `selectPreset` only (asOf/compareTo inputs gated off) | **Yes — via the shared shell** | Same shared adapter + `capability={{custom:false}}`. `CUSTOM` hold via `lastRelativePeriod` untouched. |
| **Debt** | *(none of its own)* — shared shell block | same | **Yes — via the shared shell** | Same shared adapter. `temporalCapability` is `partial` on asOf+compareTo → controls still render. |
| **Liquidity** | *(none of its own)* — shared shell block | same | **Yes — via the shared shell** | Same shared adapter. Same partial-capability note. |
| **Transactions** | `SpaceTransactionsPanel.tsx:513-549` — `ToolbarMenuButton` (all/90d/30d/7d/custom) + 2 date inputs | *(none — local `useState`, no shell actions)* | **Defer — separate local adapter** | `TransactionRangeAdapter`. Must NOT touch Perspective time. See §3. |
| **Activity** | *(no time affordance at all)* | *(none)* | **No — blocked** | Blocked on the 60-row recency cap. See §3. |
| *Calendar (sub-surface of Cash Flow)* | `CashFlowHistoryWidget.tsx:328-330` Month/Quarter/Year drills + `AllTimeYearNav` | `selectPreset` (relative only) via `handleSelectSlice` | **No — leave as peer control** | Already correctly coupled. See §5. |

---

## 2. What actually changes (the real work list)

### 2.1 Split `ShellContextRow` — it is two components fused

`ShellContextRow.tsx` (224 lines) is **time controls + trust surfaces** in one file:

| Lines | Concern | Fate |
|---|---|---|
| `:124-138` | As-of date input | → TimelineLens |
| `:141-153` | ⇄ swap button | → TimelineLens |
| `:156-183` | Compare-to input + clear button | → TimelineLens |
| `:187-221` | Completeness chip + popover, Evidence chip + drawer, FX warning chips | **stays** |

The trust half is independent of temporal gating (documented at `:33-34`: *"The trust chips always render regardless"*). So this is a split, not a replacement — extract `ShellTrustRow` and let `PerspectiveShell` compose `TimelineLens + ShellTrustRow`.

### 2.2 The adapter seam already exists

`SpaceDashboard.tsx:398-408` already has exactly the shape v4 needs — three handlers that each map to one sanctioned action:

```ts
handleAsOfChange      = (next) => shell.actions.setAsOf(next);
handleCompareToChange = (next) => { shell.actions.setCompareTo(next); /* + CF override clear */ };
handleSelectSlice     = (slice) => {
  if (isExplicitPeriod(slice)) { setCashFlowExplicitPeriod(slice); return; }  // CF-local drill
  shell.actions.selectPreset(slice);
  setCashFlowExplicitPeriod(null);
};
```

The v4 adapter is a four-case switch over `TimelineIntent` that calls these. **No new reducer action is required** — this is the payoff of the instant-commit model.

> ⚠️ `handleSelectSlice` has **two callers**: the shell slicer (relative presets only) and `CashFlowHistoryWidget` (explicit Month/Quarter/Year). TimelineLens replaces only the relative path. The `isExplicitPeriod` fork must survive intact.

### 2.3 Option table — exact parity required

From `lib/transactions/cash-flow.ts:55-71`. Ten presets, two groups:

| Group | id | Current label | Proposed lens label |
|---|---|---|---|
| To date | `WTD` | WTD | This week · Week to date |
| To date | `MTD` | MTD | This month · Month to date |
| To date | `QTD` | QTD | This quarter · Quarter to date |
| To date | `YTD` | YTD | This year · Year to date |
| Rolling | `PAST_WEEK` | 1W | Last 7 days · Rolling week |
| Rolling | `PAST_MONTH` | 1M | Last 30 days · Rolling month |
| Rolling | `PAST_QUARTER` | 3M | Last 90 days · Rolling quarter |
| Rolling | `PAST_6_MONTHS` | 6M | Last 6 months · Rolling half-year |
| Rolling | `PAST_YEAR` | 1Y | Last 12 months · Rolling year |
| Rolling | `ALL` | ALL | All history · Since first record |

`CUSTOM` is never an option — it is an *inferred* state (`presetValue={timePreset === "CUSTOM" ? null : timePreset}`), rendered as "no option selected".

### 2.4 Parity gaps in the v4 prototype (must fix before integration)

1. **`max={today}` missing on both date inputs.** Production sets it on As-of (`ShellContextRow.tsx:133`) *and* Compare-to (`:164`). Without it the lens permits future dates that the current UI forbids. (The reducer clamps `asOf` but **not** `compareTo` — so this is a genuine behavior change, not a redundant guard.)
2. **Empty-input fallback.** Production does `onAsOfChange(e.target.value || today)` — empty As-of becomes *today* at the control layer, before `clampAsOf`. v4 passes `""` through.
3. **Capability shape.** v4's `{custom, comparison}` booleans must be derived from the registry's three-valued per-axis `TemporalCapability`, not re-declared. `temporalControlVisibility()` is the existing mapper.

### 2.5 Tripwire test that will break — deliberately

`lib/perspectives/workspace-definition.test.ts:234-239` asserts on **source text**:

```ts
check("PerspectiveShell renders the CashFlowPeriodSelector slicer",
      shellSrc.includes("<CashFlowPeriodSelector"));
```

This fails the moment the control is swapped. It must be **rewritten, not deleted** — the property it protects (the slicer is universal and never capability-gated) remains true and valuable. Replacement assertion: `shellSrc.includes("<TimelineLens")` plus the existing `!shellSrc.includes("vis.period")` guard.

Also verify: `space-url-authority.test.ts:30,70,72` (no second `cashFlowPeriod` writer), `space-shell.test.ts:89,102,114` (host owns time).

---

## 3. Transactions and Activity — defer, and here is why

Both are **structurally** outside canonical time, not merely unconnected:

- Both are `kind: "standard"` in `lib/perspectives.ts` (`:504`, `:512`) with **no `temporalCapability`** → `workspaceConsumesShellTime()` returns `false`.
- Both render from bare `activeTab ===` branches (`SpaceDashboard.tsx:889`, `:996`), **outside** `WorkspaceRenderCtx` — the only carrier of `asOf`/`compareTo`/`today`.
- `PerspectiveShell` is not mounted on either tab, so there is no canonical time UI on screen to reconcile with.

**Transactions — defer, and sequence it *after* TX-2/TX-3.** Filtering is currently a pure client-side predicate (`SpaceTransactionsPanel.tsx:268-289`) over fully-loaded rows (`lib/data/transactions.ts:132-154` has no `take`, no date `where`). A range change costs nothing today.

> ⚠️ **Cross-dependency.** The TX-1 read-scale audit identifies this exact unbounded `getTransactions` as the load-bearing risk (breaks around 10–15k rows; power users already exceed it), with a roadmap of TX-2 bounded loaders → TX-3 server-paged browsing. **If TX-3 lands, the "free client-side filter" assumption dies** and a lens range becomes a query parameter — different adapter, different loading semantics, different error states. Building a TimelineLens adapter against today's all-rows-in-memory model would be building against a contract that is already scheduled to change. Sequence Transactions after TX-2/TX-3, or design its adapter to emit a resolved `{start, end}` that works either way.

Three semantic decisions the adapter must make explicit regardless:
- `cutoffForRange` uses `new Date()` per render (`:126-131`) and is **UTC**-based, while `periodRange` is **local-midnight** based — they can disagree by a day.
- Current presets are rolling-N-days; canonical presets are calendar-aligned. Reusing the canonical vocabulary silently redefines `"90d"`.
- `compareTo` has no meaning here.

**Activity — blocked, not merely deferred.** It has *no* date affordance today, only category filtering and mount-pinned date banding (`ActivityWorkspace.tsx:50`). The blocker is data semantics: the feed is capped at **60 rows by recency** (`app/api/spaces/[id]/activity/route.ts:505`), not by date. A range control over a recency-capped set makes "no events in this window" indistinguishable from "truncated before this window" — and unlike Transactions, the user cannot tell which. Adding the control without either a server-side date param or an explicit oldest-loaded-event boundary would make the UI lie. **Do not ship a range control here without resolving the cap first.**

> Latent footgun found: `temporalControlVisibility(undefined)` returns **both controls visible** (`lib/perspectives.ts:217-224`). Inert today only because `PerspectiveShell` never mounts on these tabs. Any future shell chrome on Transactions/Activity without an explicit `temporalCapability: {asOf:"none", compareTo:"none", period:"none"}` will render dead date inputs.

---

## 4. Out of scope — the legacy islands

Five independent time-filter implementations with their own vocabularies. **None import `lib/perspectives/time-range.ts`.** These are where the real "one fewer implementation" wins live, but each is its own migration:

| File | Vocabulary | Notes |
|---|---|---|
| `components/dashboard/DebtClient.tsx:201,1049-1060` | `7d/1m/3m/6m/1y/all` | Credit-tab transaction filter |
| `components/security/SecurityHistory.tsx:34-40,72,172` | `24h/7d/30d/1y/all` | `<select>`, security event log |
| `components/charts/NetWorthChart.tsx` + `NetWorthChartModal.tsx:97` + `SectionRegistry.tsx:433` | `7D/1M/3M/6M/YTD/1Y` | Chart zoom — arguably a different axis, not a filter |
| `app/admin/audit/page.tsx:240-241,457,470` | raw from/to | Admin audit filter |
| `components/dashboard/RebuildHistoryButton.tsx:256,261` | raw from/to | Rebuild window (an *operation* input, not a view filter) |

Plus a dangling sixth: `lib/widget-registry.ts:690` declares a persisted `timeRange` config key (`1M/3M/6M/1Y/all`) that no shell code reads.

---

## 5. Known second authorities (name them, don't fix them here)

| Location | State | Verdict |
|---|---|---|
| `SpaceDashboard.tsx:380,386,391` | `cashFlowExplicitPeriod`, `lastRelativePeriod` | **Legitimate.** Explicit calendar periods (a specific Month/Quarter/Year) are inexpressible in the relative canonical model. `lastRelativePeriod` only mirrors. Documented at `:370-386`; pinned by `space-url-authority.test.ts:71-75`. |
| `CashFlowHistoryWidget.tsx:294` | `viewYear` | **Legitimate and load-bearing.** ALL-scoped only, restricted to data-bearing years, self-correcting. It is the guard that stops the `ALL` sentinel range (`0000-01-01`→`9999-12-31`) reaching `monthsInRange` and emitting ~120,000 month grids. Leave as a peer control. |
| `SectionRegistry.tsx:433` | `Interval` (net-worth chart) | Disconnected from `asOf`/`preset` entirely. Chart zoom, not canonical time. Out of scope. |

**Calendar is already correctly coupled** and must not be decoupled: `asOf` → `asOfClock` (`CashFlowWorkspace.tsx:129`) → `CashFlowHistoryWidget:376` → `CashFlowCalendar:79` `periodRange(period, now?.())`. A historical As-of genuinely paints the historical month. Note the visible range is also an input to the heatmap's tint scale (`CashFlowCalendar.tsx:107-113`), not just a viewport.

---

## 6. Proposed sequencing (requires a decision)

The shared control makes per-Perspective rollout impossible without an opt-in. Two options:

**Option A — atomic swap.** One commit changes `PerspectiveShell`; all five Perspectives move together. Simplest, no temporary code, but the verification gate is all-or-nothing.

**Option B — per-Perspective opt-in flag.** `PerspectiveShell` renders `TimelineLens` for Perspectives in an allowlist, old controls otherwise. Delivers the brief's intent (prove Wealth, then extend) at the cost of temporarily rendering two implementations in the codebase — though never both on screen at once, so the "no duplicate controls" rule holds per-render.

Recommended slice order once decided:

```
Slice 0  Extract ShellTrustRow from ShellContextRow          (pure refactor, no behavior)
Slice 1  Promote TimelineLens → components/atlas/TimelineLens + ownership guard test
Slice 2  PerspectiveTimeAdapter + intent-mapping regression tests   (pure, no UI)
Slice 3  Wire into PerspectiveShell (+flag if Option B); update the tripwire test
Slice 4  Verification gates: Wealth → Investments → Cash Flow → Debt/Liquidity
Slice 5  Delete CashFlowPeriodSelector + the time half of ShellContextRow
```

Slices 0–2 are safe under either option and change no behavior.

---

## 7. Verification checklist (per gate)

Behavior parity means identical **canonical state**, **URL**, **chart range**, **API inputs**, **calculations**. Specifically:

- [ ] All 10 presets produce byte-identical `{preset, asOf, compareTo}`
- [ ] `CUSTOM` renders as no-option-selected
- [ ] `ALL` resolves `compareTo` from `coverageFrom`, including **async arrival** (`usePerspectiveShellState.ts:116-118`)
- [ ] Future `asOf` clamps to today; **future `compareTo` still blocked by `max`** (§2.4)
- [ ] Forward comparison (`compareTo > asOf`) still permitted — Wealth depends on it
- [ ] `historicalCompareTo` strict clamp unchanged for the four window-constrained lenses
- [ ] Swap disabled when `compareTo === null`; clear → `CUSTOM` + null
- [ ] URL params (`asof`, `compareto`, `preset`) unchanged; **one history entry per interaction**
- [ ] Browser back/forward restores state *and* the lens readout follows (derived, not stored)
- [ ] Deep link hydration unchanged
- [ ] Cash Flow `CUSTOM` hold behavior preserved; explicit drill still CF-local
- [ ] Capability gating: Cash Flow hides date inputs, preset strip still renders
- [ ] No workspace renders both old and new controls

---

## 8. Open decisions

1. **Option A or B** for sequencing (§6) — blocks Slice 3.
2. **Trust row placement** — does `ShellTrustRow` sit beside the lens, or inside its closed readout? Recommendation: beside. Data honesty and time window are different concerns.
3. **Activity's 60-row cap** — route change or explicit boundary annotation. Blocks any Activity work.
4. **Transactions vocabulary** — keep rolling-N-days, or adopt calendar-aligned canonical presets and accept the redefinition?
5. **Transactions ordering vs. TX-2/TX-3** — confirm Transactions waits for the bounded/paged loader work rather than being built against the current all-rows-in-memory contract.
