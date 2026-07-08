# Personal Overview Section-Backed Layout Investigation

**Date:** 2026-07-09
**Status:** Investigation only. No code, schema, STATUS.md, or template changes made.
**Related:** UX-CUST-1A (drag/drop section reorder), SP-2A-4 (Personal shell unification).

---

## TL;DR

Personal Overview can't be dragged because **its visible cards are not sections** — they're hardcoded inside `PersonalHero`, injected through the `renderHero` seam, which also forces `sectionsForTab = []` on the Overview. So there is literally nothing section-backed to reorder there, and `canReorderTab` is always false.

The fix is not a second layout model. It is to **make the three Personal Overview cards (Net Worth summary, Net Worth chart, Allocation) into `SpaceDashboardSection`-backed widgets**, delete the `renderHero` Overview-owning seam, and keep only a small fixed top slot for the currency "view as" control. Once those cards are sections, the **existing** reorder endpoint and Edit Layout button light up on Personal Overview with zero changes to the drag/persistence code. The machinery to do this already exists (SectionRegistry, presets, `planTemplateApplication`, the additive/idempotent `backfill-personal-sections.ts`). The only genuinely new work is writing two `SectionRegistry` renderers and threading snapshot/classification data into the section render context.

**Opinion:** do this. It deletes the one architectural exception (`renderHero`) that lets a Space bypass the section model, and makes "visible card = section" true by construction — which is what makes drag/drop real for every future widget, not just today's.

---

## 1. Inventory — what is NOT backed by `SpaceDashboardSection` today

Traced through `PersonalDashboard.tsx` → `SpaceDashboard.tsx` → `PersonalHero.tsx`.

| Visible Overview piece | Rendered by | Section-backed? | Notes |
|---|---|---|---|
| **Currency "view as" control** | `overviewTopSlot` seam (`ViewCurrencyOverride`, `PersonalDashboard.tsx:117`) | **No** | A control, not a data card. Correctly a fixed top slot. |
| **Card A — Net Worth summary** | `PersonalHero.tsx:124` (`SummaryWidget` in a `GlassPanel`) | **No (but shadowed by one)** | A `net_worth` section IS materialized on OVERVIEW (preset order 0) but is **suppressed** because `renderHero` forces `sectionsForTab=[]`. The hero hardcodes an equivalent card. Net worth is effectively rendered twice in concept, once in code. |
| **Card B — Net Worth over time chart** | `PersonalHero.tsx:143` (`NetWorthChart`) | **No** | No `net_worth_chart` key or `SectionRegistry` renderer exists anywhere. Purely hardcoded. Owns interval + expand-modal state. |
| **Card C — Allocation donut** | `PersonalHero.tsx:165` (`AllocationChart`) | **No** | No general portfolio `allocation` section key/renderer exists (`investment_allocation` maps to `renderInvestmentSummary`, not a donut). Hardcoded; derived from `classifyAccounts`. |
| **Day-zero setup card** | `PersonalHero.tsx:99` | **No** | Editorial empty-state shown when `accountCount === 0`. |
| **Perspectives strip** | `perspectivesDoorway` (`SpaceDashboard.tsx:2472` → `PerspectivesWidget variant="row"`) | **No** | Category-derived **lenses** (`getPerspectivesForCategory`), no `order`. A cross-tab doorway/preview, not Overview content. |
| **Recent Activity doorway** | `recentActivityDoorway` (`SpaceDashboard.tsx:2440` → `SpaceTimelinePanel` [+ `RecentTransactionsPanel` on flow categories]) | **No** | Previews of the Timeline / Transactions tabs. Not sections. |

**Section rows a Personal Space actually materializes today** (preset `PERSONAL` + `UNIVERSAL_SECTIONS`): `net_worth` (OVERVIEW), `debt_summary` (DEBT), `investment_summary` (INVESTMENTS), `goals_progress` (GOALS), `accounts_overview` (ACCOUNTS), `recent_activity` (ACTIVITY). **Only `net_worth` is on OVERVIEW — and it never renders on Personal because the hero suppresses the stack.**

The single root cause, in code (`SpaceDashboard.tsx:2340`):

```ts
const sectionsForTab =
  renderHero && activeTab === "OVERVIEW" ? [] : enabledSections.filter(...).sort(...);
```

---

## 2. Which of those should become materialized Overview sections?

**Cards A, B, C — yes.** They are data widgets and belong in the section model:

- **A — Net Worth summary** → already has a section (`net_worth`) and a renderer (`renderNetWorth`). *Stop suppressing it; render it via the section path.* Net new work: near-zero (reconcile card chrome, see risks).
- **B — Net Worth chart** → new key `net_worth_chart` + a new `SectionRegistry` renderer wrapping `NetWorthChart`.
- **C — Allocation** → new key `allocation` (or `net_worth_allocation`) + a new renderer wrapping `AllocationChart`.

**Everything else stays non-section (see §4).** The currency control is a control; the doorways are cross-tab previews; the day-zero card is an empty-state.

---

## 3. Should the `renderHero` seam be reduced or eliminated?

**Eliminate it for the Overview body.** `renderHero` exists only so Personal can own the whole Overview and bypass sections — it is *the* mechanism that empties `sectionsForTab`. Once A/B/C are sections, `renderHero` has no remaining job and should be deleted, along with the `renderHero && activeTab === "OVERVIEW" ? []` suppression. Keep the **`overviewTopSlot`** seam — it carries the currency control, which is a legitimate fixed control, not a data card. (Note: `overviewTopSlot` and `renderHero` are two different seams; only `renderHero` should go.)

Deleting `renderHero` also removes the escape hatch that made this bug possible and answers Q5 structurally: with no seam to bypass sections, new Overview content *has* to be a section.

---

## 4. What should remain fixed / editorial?

Deliberately fixed, with rationale:

1. **Currency "view as" control** (`overviewTopSlot`) — a control that re-scopes every widget via `DisplayCurrencyProvider`. Not reorderable content; pinned at top.
2. **Perspectives strip and Recent Activity doorways** — these are *doorways*: previews of other tabs (Perspectives lenses, Timeline, Transactions), shared by every Space type, rendered below the section stack. Making them section-backed is a different, larger concept (they aren't Overview data — they're navigation). Keep them fixed **below** the reorderable section stack for now; revisit later if there's demand to reorder them relative to sections.
3. **Day-zero setup card** — an empty-state, not a widget. Preserve as the shell's existing `OverviewSetupCard`/day-zero path (see risks — the hero currently owns this branch).

Everything a user would think of as a "widget/card with data" (net worth, chart, allocation) becomes section-backed; everything else is a control, a doorway, or an empty-state.

---

## 5. How to ensure every future widget is section-backed by default

- **Delete `renderHero`** (§3): removes the only sanctioned bypass.
- **Doctrine + guard:** establish "a visible dashboard data card == one `SectionRegistry` entry rendered from a `SpaceDashboardSection` row." Add a test/lint tripwire (mirroring the existing source-scan test style) asserting the Overview body renders cards only through the section stack + the sanctioned fixed slots (top slot, doorways) — i.e. no new hardcoded `GlassPanel` data card appears directly in the Overview body.
- **One-way street for new widgets:** adding a widget = (1) a `SectionRegistry` key→renderer, (2) a preset entry (per category or universal), (3) it now inherits `order`, drag, persistence, show/hide for free. Document this as the only path.

---

## 6. Convert Personal Overview to section rows + a small fixed top slot?

**Yes — this is the recommended architecture and the whole point of the investigation.** Target composition of Personal Overview:

```
overviewTopSlot (currency control)        ← fixed, small
────────────────────────────────
net_worth        (section, order 0)       ← draggable
net_worth_chart  (section, order 1)       ← draggable
allocation       (section, order 2)       ← draggable
────────────────────────────────
Perspectives doorway                      ← fixed
Recent Activity doorway                   ← fixed
```

No custom hero owning the Overview. No second Personal layout model. Personal becomes "just a Space" whose Overview is a section stack, exactly like every other Space — which is the SP-2A doctrine finally completed.

---

## 7. Template / preset changes

- **Add two presets to `PRESET_MAP[PERSONAL]`:** `net_worth_chart` (OVERVIEW, order 1) and `allocation` (OVERVIEW, order 2); `net_worth` stays order 0. Register both keys in `SectionRegistry` with renderers (component wiring, **no schema**).
- **Mirror in the hidden `personal` space-template** (`lib/space-templates`) so `registry.test.ts`/`apply.test.ts` parity holds, and **bump the template version** (the `version` field exists for exactly this).
- **Scope decision (opinionated):** keep `net_worth_chart` and `allocation` **Personal-only** at first. `allocation` is a whole-portfolio donut that misleads at partial scope (the presets already avoid it on HOUSEHOLD for this reason), so do not make it universal. `net_worth_chart` could later extend to other chartable categories, but ship Personal-first.
- **`SectionRenderProps` gap:** the new renderers need `snapshots` (chart) and `classifyAccounts` output (allocation). Today `SectionRenderProps` carries `accounts`, `spaceId`, `config`, `ctx` — **not** snapshots. The shell already fetches snapshots for the hero; they must be threaded into the section render context (or the section fetches them). This is the main non-trivial wiring.

---

## 8. Backfill for existing Personal spaces

Reuse the existing **`scripts/backfill-personal-sections.ts`** — it already applies the `personal` template's sections to every existing Personal Space via `planTemplateApplication`, is **additive-only, idempotent, dry-run by default**, and needs **no schema migration**. After adding `net_worth_chart` + `allocation` to the template, a backfill run creates exactly those two new rows per existing Personal Space (`net_worth` already exists and is skipped by the `@@unique([spaceId, key])` guard).

**Key safety property:** because Personal Overview has *never* been reorderable (the stack was always suppressed), **no existing user layout customization exists to conflict with**. New rows can be inserted at their template order with zero risk of clobbering user intent. This is the safest possible moment to do this migration.

Sequence: `npx tsx scripts/backfill-personal-sections.ts` (dry run, confirm "2 sections planned per space") → `--apply`.

---

## 9. Interaction with UX-CUST-1A drag/drop

This is the payoff. Once A/B/C are OVERVIEW sections and `renderHero` is gone:

- `sectionsForTab` on Personal OVERVIEW = `[net_worth, net_worth_chart, allocation]` (no longer forced `[]`).
- `sectionsForTab.length > 1` → **true** → `canReorderTab` → **true** → the **Edit Layout button appears** on Personal Overview (`SpaceDashboard.tsx:2571`).
- Dragging uses the **existing** `handleSectionDragEnd` → the **existing** `PATCH /api/spaces/[id]/sections/reorder` → `order = index` → persists → survives refresh.

**No changes to the drag, endpoint, or persistence code.** UX-CUST-1A was built correctly against sections; it simply had nothing to act on for Personal. Section-backing the cards is what makes it real.

---

## 10. Smallest safe migration path

1. **Thread data into `SectionRenderProps`** — add `snapshots` (and reuse `accounts`/`ctx` for `classifyAccounts`) to the section render context. Smallest enabling change; nothing user-visible yet.
2. **Add `SectionRegistry` renderers** for `net_worth_chart` (wrap `NetWorthChart`) and `allocation` (wrap `AllocationChart`), reusing the existing chart components and the hero's `GlassPanel` treatment so visuals match.
3. **Add the two presets** to `PRESET_MAP[PERSONAL]` + the `personal` template; bump template version. (Existing tests enforce parity.)
4. **Flip the seam:** delete `renderHero` and the `renderHero && activeTab==="OVERVIEW" ? []` suppression; keep `overviewTopSlot`. Personal Overview now renders the section stack.
5. **Backfill** existing Personal Spaces (dry-run → `--apply`).
6. **Verify** Edit Layout appears, drag persists, refresh holds, currency override still re-scopes.

Steps 1–3 are additive and invisible (sections exist but are still suppressed by the hero); the whole thing only "turns on" at step 4. That makes step 4 the single revertible flip — the smallest safe cutover.

---

## Risks

- **Chart interactive state.** `NetWorthChart` interval + the expand-to-modal flow are owned by `PersonalDashboard`/`PersonalHero`. As a section, that state must move into the section component (or be threaded), or the interval/expand UX regresses. Highest-friction item.
- **Visual parity / card chrome.** Hero cards use solid `GlassPanel`; `SectionCard` adds a collapsible header (chevron) and faint fill. Converting naively could make the Overview read as an "inventory list," not a hero-led page. The section renderers (or `SectionCard`) must preserve the hero's card treatment.
- **Net worth double-render during rollout.** `net_worth` section + hero card A both exist until step 4; must land the seam flip and the hero-card removal together.
- **Day-zero.** The hero owns the `accountCount === 0` consolidated setup card. Section-based Overview must preserve a day-zero story (the shell already has `OverviewSetupCard`; ensure it triggers when the section stack would be all-empty).
- **Currency universality.** The "view as" override re-scopes every widget via `DisplayCurrencyProvider` in the Personal host — must remain (keep `overviewTopSlot` + the provider wrapper).
- **Template-update vs. future customization.** Once shipped and users reorder, later template updates must stay additive (never overwrite `order`) — the existing `planTemplateApplication` doctrine already guarantees this; don't regress it.
- **Allocation scope.** Do not let `allocation` leak into partial-scope Spaces (HOUSEHOLD/FAMILY) where a whole-portfolio donut misleads. Keep Personal-scoped.

---

## Validation plan

- **Unit:** `SectionRegistry` has renderers for `net_worth_chart` + `allocation`; `registry.test.ts` / `apply.test.ts` parity holds; template version bump reflected.
- **Backfill:** dry-run reports exactly 2 planned sections per existing Personal Space; re-run is idempotent (0 planned).
- **Integration:** Personal Overview renders 3 section cards; Edit Layout button appears (`canReorderTab` true); drag reorders and persists via `/sections/reorder`; refresh preserves order; currency "view as" still re-scopes all three.
- **Regression:** shared Spaces byte-identical (never had `renderHero`); `net_worth` no longer double-rendered; day-zero still shows the setup card; personal delete invariant untouched.
- **Visual QA:** Overview still reads as a hero-led page, not a flat list (card chrome parity).
- **Doctrine guard:** add a source-scan test asserting no hardcoded data card is rendered directly in the Overview body (only section stack + fixed slots).

---

## ManageSpaceModal → Overview cleanup recommendation (do NOT implement yet)

Current `DashboardTab` (Manage → Overview) contains: section show/hide list, an **added "Reset to default layout" (disabled) control**, a "Saved layouts" placeholder, and a reorder-instruction line.

**Recommended target** — Manage → Overview should carry only:

1. **Refresh** (reload the sections/layout state).
2. **Saved layouts placeholder** (disabled; future slice).
3. **One instruction line:** *"To reorder sections, use Edit layout on the dashboard."* — this should be the **only** layout guidance in the modal.

**Changes to recommend:**
- **Remove the "Reset to default layout" control** added in the prior slice. It is an extra layout-setting control, and reset-to-default is not implemented — it should not sit in the modal as a dead affordance. When reset ships, it can return here deliberately.
- **Keep section show/hide** — that is *visibility*, not layout ordering, and it is currently the only place to hide/show sections now that the Settings rail tab is gone. (Flag for confirmation: if the product intends show/hide to also move elsewhere, call it out; otherwise it stays.)
- **Keep** the single reorder-instruction line and the saved-layouts placeholder; **add** an explicit refresh affordance.

Net effect: the modal Overview stops competing with the on-dashboard Edit Layout as a "layout settings" surface and becomes a thin visibility + guidance + future-saved-layouts panel. Defer implementation.

---

## Bottom line

Personal Overview drag/drop is missing because the cards were built *outside* the section model, behind the one seam (`renderHero`) that bypasses it. Make the three cards sections, delete the seam, keep a small fixed currency slot, and reuse the existing preset/backfill/reorder machinery. The result: Edit Layout works on Personal Overview for free, and "visible card = section" becomes true by construction for every widget we build next — no second Personal layout model, one architecture.
