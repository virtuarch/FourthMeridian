# Atlas Glass — Step C · Dashboard Data-View Client Family Checklist

**Status:** Checklist / investigation only. **No implementation, no code edits.** Approval gate before any Step C work.
**Date:** 2026-07-03
**Initiative:** Step C — Atlas Glass Surface Adoption. **First family:** the dashboard data-view clients.
**Scope (locked):** `BankingClient`, `AnalyzeClient`, `InvestmentsClient`, `ArchivedAssetsClient` (one bundled commit) + `DebtClient` (its own commit, due to size). No other surfaces.
**Doctrine (unchanged from B1–B9):** material → Atlas Glass; decorative colour → neutral ink; financial state → semantic accents; interactive → `--accent-info`; data-viz palettes preserved; warning states stay neutral (no `--accent-warning` this initiative). **No new semantic tokens.**
**Evidence base (read for this checklist):** the ratchet baseline; per-file scan of Card imports/usage, size, palette histogram, statefulness, and layout bits (table / `DashboardChrome`).

**Family facts (grounded):**

| File | Violations | Card blocks | Lines | Notes |
|---|---:|---:|---:|---|
| `BankingClient` | 69 | 8 | 521 | Card consumer; `from-gray-700` gradient present |
| `AnalyzeClient` | 71 | 8 | 569 | Card consumer; contains a `<table>`; imports shared `DashboardChrome` |
| `InvestmentsClient` | 78 | 12 | 714 | Card consumer |
| `ArchivedAssetsClient` | 78 | **0** | — | **Not a Card consumer** — palette-only (no DataCard swap) |
| `DebtClient` | 146 | 16 | 1124 | Card consumer; **separate commit** |

---

## 1. Shared migration pattern

Apply the established B1–B9 token playbook uniformly; these are page surfaces, not new primitives, so the mapping is identical:

- **Container:** `Card` → `DataCard`, `CardTitle` → `DataCardTitle`. Preserve any layout classes passed on the `Card` (`col-span-*`, grid placement) by passing them through `className`. `Card`'s `p-4` maps to `DataCard`'s default `padding` (`var(--space-4)`); corner radius shifts 16→20px as the adopted Atlas material (same as every B-series card).
- **Text:** `text-white`→`--text-primary`, `text-gray-400`→`--text-secondary`, `text-gray-500`→`--text-muted`, `text-gray-600/700`→`--text-faint` (applied via inline `style` or token arbitrary classes).
- **Surfaces:** `bg-gray-800/900/950` and their `/opacity` variants → `--surface-inset` / `--surface-muted` / `--glass-thin` / `--modal-surface` by role; borders/dividers → `--border-hairline`.
- **Colour semantics:** financial gain/loss → `--accent-positive`/`--accent-negative`; decorative/type hues → neutral ink; caution/warning → neutral ink (flagged, not tokenised); interactive links/controls → `--accent-info` (FicoCard pattern); hover affordances preserved via token arbitrary classes (`hover:text-[var(--text-secondary)]`, `hover:bg-[var(--surface-hover)]`).
- **Data-viz preserved:** any per-item/per-category chart palettes, gradients, or `rgb()`/hex viz colours stay as-is (e.g. `BankingClient`'s `from-gray-700` needs a judgment call — chrome gradient → tokenise; data-viz gradient → preserve).
- **`ArchivedAssetsClient` exception:** no `Card` → **no DataCard swap**; it's a pure inline-palette token migration (like the hosts). Do not introduce `DataCard` where there was no `Card`.
- **Preserve** all state, interactions, filters, tabs, table structure, and layout. No convergence, no opportunistic refactors, no behavior change.

---

## 2. Common risks

1. **Interactive Cards.** Audit each `<Card onClick=…>` before swapping — those become `DataCard interactive` (with the click target); all others stay inert (default). Do not add hover lift to display Cards (the cardinal B-series rule).
2. **Parent-gap layouts.** Where a `Card` directly parents flex/gap children (as `AccountCard` did), wrap content in an inner `flex` div inside `DataCard` (whose content sits in an inner wrapper) so spacing is preserved.
3. **`AnalyzeClient` `<table>`.** Table cell/row/border palette recurs in the future table family; migrate it **in place** here (tokens only, structure untouched). Don't build a shared table primitive now.
4. **Shared chrome not in scope.** `AnalyzeClient` imports `DashboardChrome` — **do not migrate `DashboardChrome`** (shared shell, separate concern); only touch each client's own palette.
5. **Stateful hover/active states.** Filters, tabs, segmented controls carry `hover:`/`active:` palette classes — preserve the affordance with token arbitrary classes, not by dropping the state.
6. **Decorative-vs-state judgment per file.** Each client mixes true gain/loss (→ accent) with category/type hues (→ neutral); apply the doctrine per occurrence, flag any genuine warning/caution states left neutral.
7. **`DebtClient` size.** 146 violations / 16 Cards / 1,124 lines — highest error surface; its own commit, migrated carefully (likely full-file rewrite with logic copied verbatim, as with `DebtPayoffSection`), and it may reuse the same `debtColor` viz preservation discipline if present.
8. **Import cleanup.** Remove `Card`/`CardTitle` imports once unused; add `DataCard` import. (This reduces the `Card.tsx` consumer count — see §5.)

---

## 3. Commit plan

Per the workflow update (family-level commits; split only the substantially-larger member):

- **C1 — Data-view bundle:** `BankingClient` + `AnalyzeClient` + `InvestmentsClient` + `ArchivedAssetsClient` in **one commit** (comparable size; same playbook) + the lowered baseline.
- **C2 — `DebtClient` alone** (substantially larger; locked separate) + the lowered baseline.

If the C1 diff proves unwieldy in review, it may be split 2+2 (e.g. Banking+Analyze, then Investments+Archived) — but the default is one bundled family commit. Each commit is independently `tsc`/lint/ratchet-green and revert-safe.

---

## 4. Validation plan (per commit)

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean (no new problems).
- Raw-palette grep across the migrated files — none (incl. `bg-<hue>`/`divide-gray`).
- Ratchet: check mode PASS (decrease only) → `--update` (files cleared) → re-check green.
- **Structural/behavior review (no app run available — manual QA points to state):** page renders; layout/grid unchanged; filters/tabs/search still function; `AnalyzeClient` table aligns; no inert Card gained hover; financial gain/loss colours correct; any data-viz palette visually unchanged; light + mobile spot-check.
- Scope proof: `git diff --stat` touches only the family files + baseline — no hosts (`DashboardClient`/`SpaceDashboard`), no `DashboardChrome`, no modals, no `Card.tsx`, no schema/migrations, no `SCAN_DIRS` change.

---

## 5. Ratchet expectations

- **Before:** 20 files / 1046 violations.
- **After C1** (−296: Banking 69, Analyze 71, Investments 78, Archived 78): **16 files / 750**.
- **After C2** (−146: DebtClient): **15 files / 604**.
- Baseline never rises; each cleared file drops out via `--update`. `SCAN_DIRS` unchanged (all five files already tracked).
- **`Card.tsx` consumer count:** 9 → **5** after this family (clears BankingClient, AnalyzeClient, InvestmentsClient, DebtClient; `ArchivedAssetsClient` was never a consumer). Remaining blockers: `SettingsClient`, `SpaceTransactionsPanel`, and the 3 route pages — retirement stays deferred to their families.

---

## 6. Explicit non-goals (this family)

No Material Engine (refraction/physics/highlights). No two-host convergence. No `DashboardChrome` or host edits. No new semantic tokens (warning stays neutral). No `SCAN_DIRS` expansion. No route pages / admin / modals / forms. No layout, behavior, or architecture change — material and colour only.

---

*End of checklist. Investigation/planning only — no implementation performed. Awaiting approval to begin Step C, commit C1 (the four data-view clients), then C2 (`DebtClient`). Stop here per brief.*
