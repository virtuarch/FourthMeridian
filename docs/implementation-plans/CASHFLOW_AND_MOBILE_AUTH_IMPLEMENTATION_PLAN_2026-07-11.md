# Fourth Meridian — Implementation Plan

**Branch:** `feature/v2.5-spaces-completion`
**Date:** 2026-07-11
**Scope:** Architecture + implementation plan only. No code was written and no files were modified during this investigation. This document is written for Claude Code to implement directly without repeating the architecture investigation.

The three concerns are kept strictly separate. A recurring, important finding: **most of the Cash Flow work already exists** — All Time is a real period, and "Spending" is a real canonical measure. The remaining work is small, surgical wiring and one bounded-calendar interaction, not new classifiers.

---

## 1. Repository findings

Stack: Next.js 16 (App Router) + React 19 + Prisma 5 + next-auth 4. Drag/reorder uses `@dnd-kit/*`. Charts use `recharts`. App version 2.4.5.

### 1a. Auth surface (Concern A owners)

- Auth pages live in the `app/(auth)` route group: `login/page.tsx`, `forgot-password/page.tsx`, `reset-password/page.tsx`, plus `register`, `verify-email`, `confirm-email-change`.
- **There is no `app/(auth)/layout.tsx`.** Auth pages render directly under the root `app/layout.tsx` (`RootLayout`) → `app/providers.tsx` (`ThemeProvider` → `SessionProvider` → `PlaidProvider`). That provider chain **is** the "shared shell" the report refers to.
- Every auth page uses the identical page wrapper: `min-h-screen bg-gray-950 flex items-center justify-center px-4` with an inner `w-full max-w-sm`. The root `<body>` is `min-h-full flex flex-col`.
- Buttons are ordinary elements: `<button type="submit">` (Sign In, Send Reset Link, reset submission), `<button type="button">` (password toggle, resend, reactivate), and a Next `<Link>` for "Forgot password?".
- The first credentials input has `autoFocus`; TOTP/recovery inputs are auto-focused via effects. This means a user can begin typing **without ever tapping** — relevant to interpreting the bug report.
- `app/layout.tsx` sets `viewport = { maximumScale: 1, userScalable: false, themeColor: "#0a0f1e" }`. No `env(safe-area-inset-*)` handling anywhere on the auth pages; no `dvh`/`svh` units.
- `app/globals.css` decorative layers (`.atlas-field`, `.ai-shimmer`, `.atlas-fresnel-edge`, their `::after`s) are all `pointer-events: none`, mostly `z-index: -1`, and **opt-in** — none is applied to the auth pages. No global overlay DOM is rendered by the Providers.
- `context/PlaidContext.tsx` calls `usePlaidLink` **once, app-wide** (mounted on every route including auth). `isOpen` is derived from `linkToken !== null`.

### 1b. Cash Flow architecture (Concerns B/C owners)

Period model + math (pure, unit-tested): `lib/transactions/cash-flow.ts`.
Shared two-axis projection + **measure registry**: `lib/transactions/cash-flow-projection.ts`.
Context projection: `lib/transactions/cash-flow-context.ts`.
Canonical dataset (privacy/soft-delete): `lib/data/transactions.ts` (`getTransactions`).

State owner: `components/dashboard/SpaceDashboard.tsx`
- `cashFlowPeriod` (line ~2589), `cashFlowPerspective` (~2593), `cashFlowFilterId` (~2594). Single, globally-exclusive state objects.
- `setCashFlowPeriod` is passed to the selector (~3117) and to every widget (~3141–3145) through `SectionCard` → `WIDGET_RENDERERS` (~1349–1354).

Widget consumers (all read the SAME `period`/`perspective`/`filterId`):
- `cash_flow_summary` → `CashFlowSummaryWidget.tsx`
- `cash_flow_history` → `CashFlowHistoryWidget.tsx` (hosts Calendar + Cards + the filter control + Month/Quarter/Year history selects)
- `cash_flow_by_category` → `CashFlowCategoryBreakdown.tsx`
- `income_by_source`, `debt_payments`, `income_vs_spending` → `cash-flow-adapters.tsx`
- Calendar: `CashFlowCalendar.tsx`. Perspective/measure control: `CashFlowFilterControls.tsx`. Period selector: `CashFlowPeriodSelector.tsx` (uses `components/atlas/SegmentedControl.tsx`).

**Key discovery — the important part:**
- An **All Time** period already exists: `RelativeCashFlowPeriod` includes `"ALL"`; `ROLLING_PERIODS` contains `{ id: "ALL", label: "All" }`; `periodLabel("ALL") === "All Time"`; `periodRange("ALL")` returns the sentinel `{ start: "0000-01-01", end: "9999-12-31" }`; `filterByPeriod` keeps the full dataset; `granularityFor("ALL") === "month"`; `periodScale("ALL") === "year"`.
- A **Spending** measure already exists: `CALENDAR_MEASURES.allSpending` (label `"Spending"`, perspective `economic`, `value = economicSpend = max(0, Σcost − Σrefund)`, `rowMatches = isCostFlow || isRefund`), with `creditCardSpending` and `directDebitSpending` as declared subsets. Debt payments are a **liquidity-axis** measure (`debtPayments`, reason `DEBT_PAYMENT`) and are therefore excluded from economic Spending by construction.
- A **Spending filter** already exists in the registry: `CALENDAR_FILTERS` has `{ id: "eco-spend", label: "Spending", perspective: "economic", measures: ["allSpending"] }`, and the perspective toggle labels economic as `"Spending"` (`PERSPECTIVE_LABEL`).

Test harness: `scripts/run-tests.ts` auto-discovers every `*.test.ts` under `lib/` and `app/`; run with `npm test`. Existing relevant suites: `lib/transactions/cash-flow.test.ts` and `lib/transactions/cash-flow-projection.test.ts` (includes reconciliation invariants).

---

## 2. Mobile auth: likely root cause and implementation plan (Concern A)

**Honest evidence status:** at the source level the auth pages are clean — no overlay DOM, no `pointer-events`/`touch-action` traps, no mobile-only wrapper, no disabled/loading logic that would block a tap on a filled form. Therefore **no root cause is proven from source alone.** The plan below ranks hypotheses by structural confidence and front-loads a cheap runtime confirmation step so Claude Code fixes the real cause, not a guessed one.

### Routes / components / layouts involved
- `app/(auth)/login/page.tsx`, `app/(auth)/forgot-password/page.tsx`, `app/(auth)/reset-password/page.tsx` (and `register`, `verify-email`, `confirm-email-change` — same wrapper).
- Shared shell: `app/layout.tsx` (`RootLayout` + `viewport`), `app/providers.tsx`, `context/PlaidContext.tsx`, `app/globals.css`.

### Likely root causes, ranked by confidence

1. **Viewport height + centering places the primary buttons under the browser's bottom chrome (highest structural confidence).**
   Every page uses `min-h-screen` (`100vh`) with `flex items-center justify-center` inside `body min-h-full`, with `maximumScale:1, userScalable:false` and **no** `dvh`/`svh` and **no** `env(safe-area-inset-bottom)`. On mobile Safari/Chrome, `100vh` is taller than the visual viewport, so vertically-centered content pushes the lowest elements (the submit buttons) beneath the address/toolbar or into the home-indicator strip, where a tap lands on browser chrome, not the button. Inputs sit higher and the first input is `autoFocus`, which is exactly why "typing works, buttons don't." *Caveat:* forgot-password's button is higher on the page, so if it also fails outright, cause #1 is incomplete and #2 is the real one — hence the runtime check.

2. **A transparent, viewport-covering layer intercepts pointer/click but not programmatic focus (needs runtime confirmation).**
   If `document.elementFromPoint(cx, cy)` over a button returns anything other than that `<button>`, an overlay is eating taps and only autofocus reaches the inputs. Prime suspect: the always-mounted `usePlaidLink` in `context/PlaidContext.tsx` leaving a `position:fixed; inset:0` container/iframe on auth routes even while closed; secondary: a stray portal. This must be confirmed in DevTools before any fix.

3. **A parent pointer/touch handler or CSS `touch-action`/`pointer-events` rule (lowest — not found in source).** Include only if runtime inspection reveals one; do not pre-emptively code for it.

### Files Claude Code should inspect first
1. `app/(auth)/login/page.tsx` (wrapper + the button block).
2. `app/layout.tsx` (viewport `maximumScale`/`userScalable`, body classes).
3. `app/globals.css` (body/base, confirm nothing global targets `button`).
4. `context/PlaidContext.tsx` + `app/providers.tsx` (always-mounted Plaid on auth routes).
5. `forgot-password/page.tsx`, `reset-password/page.tsx` (identical wrapper).

### Minimal expected correction (apply only after runtime confirmation)
- **If cause #1 confirmed** (`elementFromPoint` returns the button, but it's under the toolbar): change the shared auth wrapper from `min-h-screen … items-center` to a mobile-safe equivalent — `min-h-[100svh]` (or `min-h-dvh`), keep centering only when content fits (e.g. `justify-center` + `py-8` + allow scroll), and add `pb-[env(safe-area-inset-bottom)]`. Optionally relax the viewport (`maximumScale`/`userScalable`). One shared change replicated across the auth pages (or lifted into a new `app/(auth)/layout.tsx` wrapper to fix all at once — smallest true fix).
- **If cause #2 confirmed** (`elementFromPoint` returns an overlay): gate the Plaid mount so `usePlaidLink`/its container is not present on `(auth)` routes, or ensure the idle container is `pointer-events:none`/unmounted when `!isOpen`. Fix the interceptor, not the buttons.

Do not change button `disabled`/loading logic — it is correct (buttons enable once fields are filled).

### Mobile browser reproduction steps
1. Real iPhone (Safari) and Android (Chrome). Load `/login`.
2. Without tapping, confirm the email field is autofocused (this is why typing "works").
3. Fill email + password (keyboard `next`), dismiss keyboard, tap **Sign In** — observe no response.
4. Tap **Forgot password?** and, on `/forgot-password`, tap **Send Reset Link** — observe.
5. In Safari Web Inspector / Chrome remote debug, run `document.elementFromPoint(x, y)` at each button's center and record what is returned. This single reading decides cause #1 vs #2.
6. Toggle Safari's bottom toolbar (scroll) and retry taps to test the height hypothesis directly.

### Regression-test strategy
- Manual device matrix (iOS Safari, iOS Chrome, Android Chrome) across login (credentials/TOTP/recovery), forgot-password, reset-password: all buttons + the "Forgot password"/"Back to sign in" links tappable with keyboard open and closed.
- Desktop responsive emulation is insufficient for the `100vh` cause (it does not reproduce browser-chrome occlusion) — device or true mobile emulation with dynamic toolbar required.
- If lifting to an `app/(auth)/layout.tsx`, verify all six auth routes still render and that server/client hydration is unaffected (`suppressHydrationWarning` already present).

### Acceptance criteria
- On real iOS and Android, every auth-page button and link responds to the first tap, with the keyboard both open and dismissed, and after toolbar show/hide.
- `elementFromPoint` at each button center returns that button.
- No change to auth logic, copy, or desktop layout.

---

## 3. All Time: architecture and implementation plan (Concern B)

### Architectural owner of period state
`components/dashboard/SpaceDashboard.tsx` — `cashFlowPeriod` (~2589), set via `setCashFlowPeriod`, threaded to `CashFlowPeriodSelector` and all widgets. Selection is already globally exclusive (a single value; `CashFlowPeriodSelector` clears the non-active `SegmentedControl` highlight so only one group lights up). **Selecting All Time already unselects all others** and **already updates every widget together** — this is inherent to the single-state design.

### What already works (do not rebuild)
- `"ALL"` period, `periodLabel("ALL") === "All Time"`, sentinel `periodRange`, `filterByPeriod` full-dataset pass, monthly history granularity.
- Summary header already names the active period: `SpaceDashboard.tsx` ~1774 renders `${displayLabel} · ${periodLabel(period)}` for the `cash_flow_summary` lede, so it shows "… · All Time".
- Dataset definition is satisfied by `getTransactions` (`lib/data/transactions.ts`): `deletedAt: null` (soft-delete excluded), KD-15 `TRANSACTION_DETAIL_VISIBILITY` (FULL shares only → Space visibility/privacy preserved), account `deletedAt: null`. Reporting-currency conversion rides via `txCtx` (per-row at row date) and does not change under All Time. **No new query or backfill is required** — All Time = the existing `getTransactions` output with the sentinel range.

### Hidden assumptions that break with unbounded ranges
- `CashFlowCalendar.tsx` computes `range = periodRange(period)` (→ `0000-01-01 … 9999-12-31` for `"ALL"`) then `monthsInRange(range.start, range.end)`. `monthsInRange` (`cash-flow.ts` ~387) hard-caps at 24 grids, so for All Time it would emit **Jan 0000 – Dec 0001** — 24 empty, out-of-range month grids. This is precisely why the current code (`getCashFlowHistoryModes("ALL")` returns `["cards"]`) **forces All Time to cards-only** and forbids the calendar. That guard is the only thing preventing a broken/unreadable calendar today.
- Any future consumer that derives a month/day grid from `periodRange("ALL")` inherits the same 0000–9999 hazard. Treat the sentinel range as **filter-only**, never as a rendering span.

### Minimal UI design (smallest interaction that keeps the calendar usable)
Keep All Time as the **analytical scope** for every widget (Summary totals, History cards, Category, Income by Source, Debt Payments) exactly as today. Add a **bounded, navigable single calendar year** for the Calendar mode under All Time — the concern's recommended "one navigable calendar year at a time within the All Time analytical scope":

1. `lib/transactions/cash-flow.ts`: allow the calendar under All Time — `getCashFlowHistoryModes("ALL")` → `["calendar", "cards"]`. Keep `getDefaultCashFlowHistoryMode("ALL")` = `"cards"` (preserves current default; calendar is opt-in via the mode toggle) unless product prefers calendar-first.
2. Add a pure helper to derive the **data-bearing years** (reuse `availableHistoricalPeriods(...).years`, already newest-first) so year navigation only steps across years that actually contain transactions — no arbitrary cutoff, no empty years.
3. `CashFlowCalendar.tsx`: add an optional prop `viewYear?: number` (or `viewRange?: {start,end}`). When set, the calendar uses that single year for `monthsInRange` and the in-range gating **instead of** `periodRange(period)`; `projectDailyFacts` still runs over the full All-Time rows it is passed (only that year's cells are painted). For all non-ALL periods the prop is unset and behavior is byte-identical to today.
4. `CashFlowHistoryWidget.tsx`: when `period === "ALL"` and mode is calendar, hold a local `viewYear` cursor (init to `availableHistoricalPeriods(rows).years[0]`, the latest data year) with ◀/▶ controls that step across the data-bearing years only (disabled at both ends). Pass `viewYear` to `CashFlowCalendar`. Totals, tooltips, and the day drawer remain the All-Time measure math; only the visible span is bounded.

This preserves every required behavior: period selection stays globally exclusive; All Time totals use the full visible dataset; the calendar is never rendered across all years at once.

### Test plan (Concern B)
- Update `lib/transactions/cash-flow.test.ts`: the existing assertion "ALL history is cards-only (no mega-calendar)" must change to reflect `["calendar","cards"]`; add a test that the data-year helper returns only years with data, newest-first, and that year-stepping stays within bounds.
- `CashFlowCalendar` with `viewYear` renders exactly the 12 grids of that year and gates out-of-year cells.
- Reconciliation (below) as unit tests over multi-year fixtures.

### Reconciliation invariants (Concern B)
- All Time Summary totals == Σ over all History card buckets == aggregate over the full `getTransactions` dataset (per current `projectDailyFacts`→aggregate guarantee, `cash-flow-projection.test.ts` "daily facts sum back to the aggregate").
- Σ over every data-bearing year's calendar day-nets (for a given measure set) == `netOfMeasures(aggregateDayFacts(allRows), measures)`.
- Reporting-currency conversion under All Time equals Σ of per-year converted totals (per-row conversion is date-local and unaffected by range).

### Real-data validation plan (Concern B)
- Open a Space with multi-year, multi-source history (provider + imported + wallet). Select **All Time**.
- Confirm: Summary header shows "· All Time"; Summary/Category/Income/Debt widgets all refresh together; History cards are monthly across all years; the calendar year-nav spans exactly the years that contain data and its per-year totals sum to the All-Time totals.
- Confirm no soft-deleted or non-FULL-shared rows leak in (spot-check a soft-deleted import batch and a BALANCE_ONLY-shared account).

---

## 4. Spending Calendar filter plan (Concern C)

### Exact current projection path
`CashFlowHistoryWidget` (`perspective` + `filterId`) → `activeFilter.measures` → `CashFlowCalendar` (`measures`) → heatmap net via `netOfMeasures(f, measures)`, tooltip lines via `CALENDAR_MEASURES[id].value`, and the day drawer via `rowsForMeasures(dayRows, measures, liqCtx)` (`cash-flow-projection.ts` `rowsForMeasures`, "CF-3B"). All of it reads the two canonical authorities only: `flow-predicates` (economic) + `classifyLiquidity` (liquidity). **There is no Calendar-only classifier and none should be added.**

### What already exists (confirmed)
- **Economic spending:** `CALENDAR_MEASURES.allSpending` (label exactly `"Spending"`, `value = economicSpend`, includes card purchases, fees, interest; refunds netted per doctrine).
- **Credit-card spending / direct-debit spending:** `creditCardSpending`, `directDebitSpending` (declared subsets of `allSpending`).
- **Measure registry:** `CALENDAR_MEASURES` + `CALENDAR_FILTERS` (`eco-spend` = "Spending").
- **Shared perspective controls:** `CashFlowFilterControls` (perspective toggle labels economic as "Spending").
- **Day-drawer filtering:** `rowsForMeasures` already returns exactly the rows behind the selected measures.
- **Exclusions are structural:** debt payments, transfers, investment funding, cash withdrawals, earned income, and investment-related Cash In are all on the liquidity axis or other flow types and are not part of `allSpending`.

### The actual gap
The semantics and data path are done. What's missing is **clarity/discoverability**: today "Spending" requires two steps — toggle perspective to "Spending" (economic), then choose "Spending" from a `<select>` measure dropdown whose default in that perspective is `eco-net` ("Income & spending"). The concern wants a **visible filter labeled exactly "Spending"** that is obviously available on the Calendar.

### Exact control/measure changes needed (no new classifier)
1. `components/space/widgets/CashFlowFilterControls.tsx`: change `defaultFilterFor("economic")` to return `filterById("eco-spend")` (the "Spending" measure) instead of `eco-net`, so switching to the Spending perspective lands directly on **Spending**. (Recommended, smallest change that makes "Spending" the one-tap default.)
2. Optionally, in the same file, render the economic measure options as **visible segmented chips** (reusing the existing perspective-toggle chip styling) rather than a `<select>`, so "Spending", "Credit-card spending", "Direct/debit spending", "Income" are directly tappable and the active one is visibly highlighted. Keep labels exactly as in `CALENDAR_FILTERS`.
3. No changes to `cash-flow-projection.ts` — reuse `allSpending`, its subsets, and `rowsForMeasures`.

Selecting "Spending" then updates, through the existing pipeline: heatmap (`netOfMeasures`), tooltip (per-measure `value`), History cards (shared `bucketDayFacts`), the filtered day drawer (`rowsForMeasures`), and the active control state.

### Pending-transaction policy (identify + match)
`Transaction.pending: boolean` exists (`types/index.ts`). **Nothing in the Cash Flow projection filters on `pending`**, so pending rows are **included** in the heatmap, tooltip, totals, and drawer. The data layer dedups pending→posted (`RelationshipResolver`; a pending row is tombstoned via `deletedAt` once its posted successor exists, and `getTransactions` filters `deletedAt: null`). Consequence: **posted** credit-card purchases appear as economic Spending (cost flow on a liability tier), and Calendar and drawer already agree because both consume the same rows. The plan is to make this policy **explicit and tested**, not to change it — the calendar cell, the day drawer, and Spending by Category must all reflect the same pending policy for the same period.

### Test cases (Concern C)
Add to `lib/transactions/cash-flow-projection.test.ts` (representative real rows): **Lulu Hypermarket, Uber, Hunger Station, Harvey Nichols**.
- Each row typed as a cost flow (SPENDING) contributes to `allSpending.value` and appears in `rowsForMeasures([...], ["allSpending"], liqCtx)`.
- A card purchase (liability tier — e.g. Harvey Nichols on a credit card) appears in Spending **and** in the `creditCardSpending` subset; a debit purchase (e.g. Lulu on checking) appears in Spending and in `directDebitSpending`.
- A debt payment on the same day is **excluded** from Spending (only in `debtPayments`) — the "Spending" day drawer never shows it.
- Fees/interest included; refunds net down the day/category total.
- A `pending` cost-flow row is included in the "Spending" cell and drawer (documents the policy).

### Reconciliation invariants (Concern C)
- "Spending" (`allSpending`) over a period == economic spend `max(0, Σcost − Σrefund)` == Σ of `CashFlowCategoryBreakdown`/`outflowByCategory` category totals for that period (extend the existing `cash-flow-projection.test.ts` "Spending by Category … reconciles with economic spend" invariant).
- `creditCardSpending + directDebitSpending == spendGross` (existing tier-partition invariant), so their combination never double-counts and both are subsets of "Spending".
- Calendar day cell total for "Spending" == Σ of that day's drawer rows' contributions == that day's Spending-by-Category slice.

### Runtime verification steps (Concern C)
- In a Space, open Cash Flow → History → Calendar, choose **Spending**. Confirm the heatmap re-tints, tooltips show a "Spending" line, and clicking a day opens a drawer containing only spending rows (card + debit purchases, fees, interest; refunds netting), with no debt payments/transfers.
- Cross-check a single day's "Spending" cell total against the same day's Spending-by-Category and against a manual sum of the drawer rows.
- Confirm a known posted card purchase (Harvey Nichols) appears; confirm a debt payment that day does not.

---

## 5. Mobile Cash Flow verification plan (Concern D)

Narrow verification only — **not** a page redesign. Verify on real iOS Safari + Android Chrome:

- **All Time chip:** in `CashFlowPeriodSelector`'s rolling `SegmentedControl`, tapping **All** selects it, clears the to-date group's highlight, and updates every Cash Flow widget together; the sliding highlight lands on it.
- **Spending filter:** tapping the "Spending" control (perspective and/or the "Spending" measure) switches the heatmap/drawer and shows the active state clearly.
- **Segmented controls / active state:** `components/atlas/SegmentedControl.tsx` uses a measured sliding highlight (`getBoundingClientRect`) and `overflow-x-auto no-scrollbar` for overflow — verify the highlight tracks correctly after horizontal scroll and on resize/orientation change.
- **Overflow:** confirm the rolling group (now including All) and any measure chips remain reachable via horizontal swipe when they exceed width.
- **Touch targets:** `SegmentedControl` buttons are `px-4 py-2`; `CashFlowFilterControls` buttons are `px-2.5 py-1` (~24px tall). Flag anything below the ~44px iOS target; verify taps still register.
- **Pointer interception / drag interference:** the in-card controls (`CashFlowFilterControls` line ~82, `CashFlowCalendar` cells ~105, `ModeToggle`, `HistorySelect`) already `stopPropagation` on `onPointerDown` to avoid `@dnd-kit` drag capture. **`SegmentedControl` does NOT** `stopPropagation` on pointerdown — but the period selector renders **outside** `SectionCard` (`SpaceDashboard` ~3116), so it is not inside a draggable. Verify on device that in **Edit Layout** mode (dnd-kit drag handles active on section cards) taps on the in-card Cash Flow controls select rather than initiate a drag; if any control is swallowed, the minimal fix is adding `onPointerDown={(e)=>e.stopPropagation()}` to `SegmentedControl`'s track/buttons.

Deliverable: a short pass/fail checklist with device + browser, screenshots of active states, and any control that misses the touch-target or interception check.

---

## 6. Exact files expected to change

**Concern A (pending runtime confirmation of cause #1 vs #2):**
- `app/(auth)/login/page.tsx`, `app/(auth)/forgot-password/page.tsx`, `app/(auth)/reset-password/page.tsx` (and `register/`, `verify-email/`, `confirm-email-change/` if they share the wrapper) — mobile-safe wrapper (`min-h-[100svh]`/`dvh`, safe-area padding). Smallest single-point fix: add `app/(auth)/layout.tsx` with the shared wrapper and simplify each page.
- `app/layout.tsx` — only if relaxing `viewport` `maximumScale`/`userScalable`.
- `context/PlaidContext.tsx` and/or `app/providers.tsx` — only if runtime shows the Plaid mount is the interceptor (gate off `(auth)` routes).
- `app/globals.css` — only if a shared safe-area utility is added.

**Concern B:**
- `lib/transactions/cash-flow.ts` — `getCashFlowHistoryModes("ALL")` → include `"calendar"`; add a data-bearing-years helper (or reuse `availableHistoricalPeriods`).
- `components/space/widgets/CashFlowHistoryWidget.tsx` — `viewYear` cursor + ◀/▶ controls for All Time calendar; pass `viewYear` to the calendar.
- `components/space/widgets/CashFlowCalendar.tsx` — optional `viewYear`/`viewRange` prop bounding `monthsInRange` + in-range gating.
- `lib/transactions/cash-flow.test.ts` — update the "ALL cards-only" assertion; add year-nav/bounds tests.

**Concern C:**
- `components/space/widgets/CashFlowFilterControls.tsx` — default the economic perspective to the "Spending" filter; optionally render economic measures as visible chips.
- `components/space/widgets/CashFlowHistoryWidget.tsx` — only if control layout changes.
- `lib/transactions/cash-flow-projection.test.ts` — representative-row + pending-policy + reconciliation tests.
- **No change** to `cash-flow-projection.ts` (reuse existing measures).

**Concern D:**
- Verification only. Possible one-line `onPointerDown` `stopPropagation` in `components/atlas/SegmentedControl.tsx` **iff** device testing shows drag interference.

---

## 7. Test plan

Run `npm test` (auto-discovers `*.test.ts` under `lib/`/`app/`).

- **B — period/calendar:** `cash-flow.test.ts` updated for `["calendar","cards"]` on ALL; data-year helper returns data-bearing years newest-first; year-stepping bounded; `CashFlowCalendar` with `viewYear` renders 12 grids and gates out-of-year cells.
- **C — Spending semantics:** `cash-flow-projection.test.ts` — Lulu/Uber/Hunger Station/Harvey Nichols each contribute to `allSpending` and to the correct tier subset; debt payments excluded from Spending; refunds net; pending cost-flow row included; "Spending" == economic spend == Σ Spending-by-Category.
- **Reconciliation invariants:** daily/bucketed facts sum to aggregate (existing); Σ per-year calendar nets == All-Time aggregate; subset partition holds.
- **Regression:** existing Cash Flow suites stay green (period identity, `monthsInRange` cap for non-ALL, INVESTMENT excluded from Spending, liquidity-reason partition).
- **A — auth:** no unit layer; device matrix (Section 2) is the test.
- **High-stakes verification:** optionally run a subagent to diff the final change set against this plan and re-run the reconciliation invariants before commit.

---

## 8. Browser / runtime validation plan

- **Concern A:** real iOS Safari + Android Chrome; `document.elementFromPoint` reading at each button center; toolbar show/hide tap test; keyboard-open and keyboard-closed taps across login (all three steps), forgot-password, reset-password.
- **Concern B:** multi-year Space; select All Time; verify header label, simultaneous widget refresh, monthly History cards, and calendar year-nav totals summing to All-Time totals; privacy spot-checks (soft-deleted batch, BALANCE_ONLY account).
- **Concern C:** Calendar → "Spending"; verify heatmap/tooltip/drawer update, posted card purchase present, debt payment absent, day cell reconciles with Spending-by-Category and the manual drawer sum.
- **Concern D:** the Section 5 checklist on device, including Edit Layout drag-vs-tap.

---

## 9. Risks and stop conditions

- **A — stop condition:** do **not** commit an auth fix until the DevTools `elementFromPoint` reading identifies cause #1 (height/occlusion) vs #2 (overlay). Guessing risks changing layout while a Plaid overlay is the real culprit (or vice-versa). Do not touch button `disabled`/loading logic.
- **B — calendar-range risk:** never feed `periodRange("ALL")` (0000–9999) into any month/day renderer; always bound via `viewYear`/`viewRange`. Regression risk: the change to `getCashFlowHistoryModes("ALL")` breaks the existing "cards-only" test — update the test intentionally, do not weaken it.
- **B — performance:** All Time loads the full dataset; `projectDailyFacts` is O(rows) and fine, but confirm no widget enumerates the sentinel range as grids/buckets.
- **C — reconciliation risk:** changing the economic default filter must not alter any total — it changes which measure is preselected, not the math. If any Spending total stops matching Spending-by-Category, stop: a classifier was inadvertently duplicated (forbidden). Reuse `allSpending`/`rowsForMeasures` only.
- **C — pending policy:** do not silently change pending inclusion; if product wants pending excluded from Spending, that is a separate, explicit decision affecting Summary/Category/Calendar/drawer together — out of scope here.
- **D — scope:** verification only; the sole permissible code change is a `stopPropagation` one-liner if drag interference is observed. No redesign.
- **General:** no migrations, no backfills, no data writes (per instructions). Keep the three concerns in separate commits.

---

## 10. Recommended commit split

1. `fix(auth): make mobile auth buttons tappable` — Concern A, after runtime confirmation. Wrapper/safe-area (or Plaid-mount gate) + optional `app/(auth)/layout.tsx`. No logic changes.
2. `feat(cashflow): navigable single-year calendar under All Time` — Concern B. `cash-flow.ts` modes + data-year helper, `CashFlowCalendar` `viewYear` prop, `CashFlowHistoryWidget` year cursor, updated `cash-flow.test.ts`.
3. `feat(cashflow): surface the "Spending" filter clearly in the Calendar` — Concern C. `CashFlowFilterControls` default/visible chips + `cash-flow-projection.test.ts` representative-row/pending/reconciliation tests. Reuses existing measures.
4. `chore(cashflow): mobile control verification` — Concern D. Checklist artifact; include the `SegmentedControl` `stopPropagation` one-liner here only if device testing required it.

Order 2 → 3 is natural (calendar plumbing before the filter default), and 1/4 are independent. Each commit is independently revertable.
