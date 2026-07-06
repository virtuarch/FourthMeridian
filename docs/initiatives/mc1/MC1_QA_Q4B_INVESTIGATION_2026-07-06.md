# MC1 QA Q4b — SpaceDashboard Residual Currency Propagation: Root Cause & Fix Plan

**Status:** Investigation only — no code changed, no data changed.
**Date:** 2026-07-06, against the working tree with Q1–Q4 applied.
**Trigger:** live QA after Q4 shipped — Remaining Debt headline converts, but the history chart mixes units, and several SpaceDashboard-hosted surfaces still show USD under a non-USD Space. Q6 (live-swap refresh) explicitly out of scope here.

---

## 1. Root cause — Remaining Debt history chart (the mixed-unit bug)

### 1.1 What the code actually does (verified end-to-end)

The path is: `SpaceTrendHero` ← `heroPoints` (SpaceDashboard, `heroDef.value(s)`) ← `GET /api/spaces/[id]/snapshots` ← **`getRecentSnapshots(365, {spaceId})`** (`lib/data/snapshots.ts`).

That reader IS stamp-aware (P4 Slice 4): every row carries `SpaceSnapshot.reportingCurrency` (frozen at write time; historical rows correctly default `"USD"`), off-stamp rows are routed through `convertStampedValues()` at **each row's own date**, and the homogeneous fast path covers same-stamp histories. SpaceDashboard does **not** bypass the stamp-conversion path. There is no chart-adapter math bug and no snapshot-write bug — rows before the currency flip are truthfully stamped USD, rows after are truthfully stamped SAR/JPY.

### 1.2 Where it actually breaks

`resolveStampContext` resolves each off-stamp `(USD, date)` pair through `service.getRateForDate` with a **≤7-day walk-back** (`MAX_STALE_DAYS = 7`, `lib/fx/config.ts`) against the **FxRate archive**. The archive is populated by:

1. the daily cron (P1 Slice 4) — running only since MC1 Phase 1 deployed (~2026-07-01), and
2. `scripts/backfill-fx-rates.ts` (P1 Slice 3) — the historical backfill, which **has not been run in this environment**.

So every June snapshot date sits **more than 7 days before the archive's earliest row** → `RateMiss` → plan D-3 pass-through: the stored **native USD-sized value** is returned with `estimated: true`. July rows are on-stamp (fast path) and render at native SAR/JPY magnitude.

The arithmetic confirms it exactly: ~8k USD × 3.75 ≈ **30k SAR**; ~8k USD ≈ **¥1.24M** — QA's "jump around Jul 1" is the archive's earliest-coverage date, not the currency-flip logic.

### 1.3 Classification (question 2)

Not read-time-conversion code, not snapshot conversion, not the chart adapter, not label-only. It is:

- **(a) a data-coverage gap** — the historical FX backfill was never applied, so honest degradation (D-3) kicks in for every pre-cron date; and
- **(b) a missing presentation guard** — the reader flags these points (`isEstimated`), but `SpaceTrendHero` plots unconvertible off-stamp points in the same series with no distinction. A series that silently mixes units is worse than a shorter honest series ("the trend earns pixels"). Note `isEstimated` alone cannot drive a guard: it conflates D2.x reconstructed history and successful-but-approximate stamp conversions with genuine rate misses.

The same latent gap exists in the Personal dashboard's stamp-aware chart readers (`getPortfolioHistory`); it is only visible on SpaceDashboard today because that is where QA flipped currencies.

## 2. Surface matrix — remaining USD sites under a non-USD Space (questions 3–4)

Every site below was verified in the current tree. Classes: **A** = aggregate/space-native → convert and/or label `Space.reportingCurrency` · **I** = itemized → label `row.currency` · **D** = legitimately deferred.

| # | Surface (host: SpaceDashboard family) | Site | Today | Class | Correct behavior |
|---|---|---|---|---|---|
| 1 | **Remaining Debt history** (SpaceTrendHero series) | `getRecentSnapshots` off-stamp misses | native USD-sized points mixed into SAR/JPY series | **A** | §1: backfill archive + guard unconvertible points out of the hero series |
| 2 | **GoalsCard** (Goals tab + modal) | `SpaceDashboard.tsx` L529–530, 610–618, 645–650, 695 — 9 bare `formatBalance(x)` | USD label on goal amounts | **A** (config/goal values are space-native, no row stamp — label-only, no conversion) | `formatBalance(x, displayCurrency)` via hook |
| 3 | **AddGoalModal** (incl. DEBT_REDUCTION mode — QA's "debt modal") | L1601 `displayCurrency = DEFAULT_DISPLAY_CURRENCY` → "Target amount (USD)" L1763, "Monthly limit (USD)" L1824; `$ Amount` toggle L1861 | hardcoded USD/“$” | **A** (form labels for space-native amounts) | `useDisplayCurrency()` + symbol helper |
| 4 | AddGoalModal debt-account picker | L1848 `{a.name} — {formatBalance(a.balance)}` | USD label on a native balance | **I** | `formatBalance(a.balance, a.currency)` |
| 5 | **ManageSpaceModal** goal rows (Goals section) | L1001, L1027 bare `formatBalance(g.*)` | USD label | **A** (space-native goal values, label-only) | hook currency (account rows L1147/1271 already row-native ✓) |
| 6 | **RecentTransactionsPanel** (Overview transactions preview) | L51 `formatCurrencyExact(Math.abs(tx.amount))` | USD default on tx rows | **I** | `formatCurrencyExact(x, tx.currency ?? undefined)` |
| 7 | SpacesClient / Space cards | — | USD | **D** | Q5, untouched |
| 8 | Live currency swap needing refresh | — | — | **D** | Q6, untouched |

Verified clean (no action): AccountsCard rows (row-native ✓), SpaceTransactionsPanel in the SpaceDashboard host (layout provider + F-6 ctx ✓), SummaryWidget totals / ProgressWidget family / AssetValueWidget / BreakdownWidget / DebtPayoffSection incl. fullscreen modal (Q4 ✓), perspectives route (both lens adapters thread `buildSpaceConversionContextById` ✓), Activity/Timeline surfaces (no money formatting), BreakdownWidget donut centre (count, not money).

So QA items 3–4 ("Accounts tab / account widgets / debt widgets / debt modals still show USD") resolve to exactly: GoalsCard, AddGoalModal (both modes), ManageSpaceModal goal rows, and the Overview transactions preview.

## 3. Minimal fix plan (question 5)

**Step 0 — ops, before/with the slice (data, not schema, not a product write path):**
`npx tsx scripts/backfill-fx-rates.ts` (offline dry-run first, then `--apply`) covering the earliest `SpaceSnapshot.date` onward. Existing P1 deliverable: append-only, idempotent, quota-aware. This alone fixes the June segment of the chart for supported currencies.

**Q4b-1 — honest hero series (one reader + one presenter change):**
- `convertStampedValues` already resolves one rate per row conceptually; extend its result with `missed: boolean` (true when the stamp's resolution was a miss — values passed through native).
- `getRecentSnapshots` maps that to an additive optional DTO field `fxMiss?: true` (Snapshot type, additive — homogeneous histories emit byte-identical objects).
- SpaceDashboard `heroPoints` drops `fxMiss` points from the hero series (a shorter honest trend instead of a mixed-unit one). Nothing else consumes the flag yet.
- No snapshot rewrites, no history regeneration, read-time only.

**Q4b-2 — label fixes (six sites, zero value changes except one itemized label):**
GoalsCard ×9 → hook currency; AddGoalModal → `useDisplayCurrency()` for the two `(USD)` labels + `$` toggle symbol + picker row → `a.currency`; ManageSpaceModal goal rows ×2 → hook currency; RecentTransactionsPanel row → `tx.currency`. All-USD renders identically (hook defaults USD; `formatBalance`/`formatCurrencyExact` defaults unchanged when currency is undefined).

Explicitly NOT in Q4b: Q5 space cards, Q6 broadcast/refresh, personal-dashboard chart-reader hardening beyond the shared `convertStampedValues`/`getRecentSnapshots` change (Personal benefits automatically; `getPortfolioHistory` untouched).

## 4. Validation gates (question 6)

1. **All-USD invariance:** all-USD Space renders pixel-identical (no `fxMiss` emitted on homogeneous histories; hook currencies default USD).
2. **Chart gate (fixture):** stamp-conversion/`getRecentSnapshots`-level test — rows stamped USD with a context that misses → `fxMiss: true` + native values; with a resolving context → converted values, no `fxMiss`. Hero-side: series built from a mixed fixture contains no unconverted off-stamp point.
3. **Label sweep (fixture EUR/SAR Space):** GoalsCard, AddGoalModal (labels, `$` toggle, debt picker), ManageSpaceModal goal rows, Overview transactions preview show the space/row currency; no `$` where a non-USD value renders.
4. `npx tsc --noEmit`, `npm run lint` (4-warning baseline), `npm test` (43 ✓ + kd17 sandbox baseline).
5. **Ops verification (after backfill):** June SAR/JPY chart segment sits at converted magnitude with no ~Jul-1 discontinuity; spot-query the archive's earliest date ≤ earliest snapshot date.

## 5. First implementation prompt

> Implement MC1 QA Q4b per `docs/initiatives/mc1/MC1_QA_Q4B_INVESTIGATION_2026-07-06.md` §3 exactly. (1) Q4b-1: extend `convertStampedValues` (lib/snapshots/stamp-conversion.ts) to resolve the row's stamp once and return `{ values, estimated, missed }`; `getRecentSnapshots` emits additive `fxMiss?: true` on off-stamp miss rows (Snapshot type gains the optional field); SpaceDashboard filters `fxMiss` points out of `heroPoints`. (2) Q4b-2 labels: GoalsCard nine `formatBalance` sites and ManageSpaceModal two goal-row sites format with `useDisplayCurrency()`; AddGoalModal replaces its `DEFAULT_DISPLAY_CURRENCY` constant with the hook (two "(USD)" labels + the `$ Amount` symbol) and the debt-account picker row uses `a.currency`; RecentTransactionsPanel passes `tx.currency ?? undefined` to `formatCurrencyExact`. No schema, no writes, no snapshot rewrites, no history regeneration, no Q5/Q6. Document (do not run in-code) the ops step: `npx tsx scripts/backfill-fx-rates.ts --apply` from the earliest SpaceSnapshot date. Validate per §4 and stop.

---

*End of Q4b investigation. No code or data was modified.*
