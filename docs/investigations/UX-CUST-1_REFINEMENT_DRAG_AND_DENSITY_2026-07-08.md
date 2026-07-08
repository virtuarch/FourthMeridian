# UX-CUST-1 — Refinement: Drag/Drop Reorder + Section Density

**Date:** 2026-07-08
**Status:** Investigation only. No code, schema, or STATUS.md changes made.
**Supersedes the UX/scope section of:** `UX-CUST-1_SECTION_REORDER_INVESTIGATION_2026-07-08.md` (findings there still hold).

---

## Verdict: split it

**Recommend splitting UX-CUST-1 into two slices:**

- **UX-CUST-1A — Drag/drop section reorder** (snap-back vertical ordering)
- **UX-CUST-1B — Section density modes** (expand/condense, responsive auto-condense)

They *look* like one feature ("customize the dashboard") but sit on different layers, carry different risk, and 1B has an unresolved architectural question that must not block 1A.

| | 1A — Drag reorder | 1B — Density modes |
|---|---|---|
| **Data layer** | `order` (already exists, already written by PATCH) | `config` JSON (exists, free-form) **or** a per-user store (open question) |
| **New dependency** | Yes — `@dnd-kit` | None |
| **Design surface** | One interaction over one list | Per-widget condensed views across ~6 widget families + responsive gate |
| **Open architectural question** | None | Is density *shared* (config) or *per-viewer* (new store)? |
| **Risk** | Low, mostly infra | Medium — touches every widget's render + breakpoints |
| **Blocks the other?** | No | No |

Ship **1A first** (fast, low-risk, `order` is already wired), then **1B**. Trying to land both as one PR couples a dependency-add + list interaction to a cross-widget rendering refactor and an unresolved preference-scope decision.

---

## Q1. Can `SpaceDashboardSection.order` support drag/drop reorder?

**Yes, unchanged from the prior investigation.** Drag/drop is just a nicer *input method* for writing the same `order` integers the ▲/▼ controls would write. The data model is already complete: `order Int`, sorted at fetch (`orderBy: [{tab},{order}]`) and at render (`.sort((a,b)=>a.order-b.order)`), and the section PATCH already accepts `order`.

**"Snap-back vertical ordering"** — the animated settle where a dragged card returns to a slot and the list reflows — is a **client-only animation concern**, fully handled by `@dnd-kit/sortable`'s transform/transition system. Nothing in the schema constrains or enables it; it never touches the server until drop. On drop, persist the new order (batch endpoint recommended for atomicity, per prior doc §2). No schema change.

One implementation note: because sections sort by `order` within a tab, dropping mid-list means rewriting the `order` of the moved card and its neighbors. Simplest robust approach: on drop, reassign `order = index` for every card in that tab in one transaction. Keeps values dense and gap-free; avoids fractional-index drift.

---

## Q2. Can `config` support density mode, or is schema needed?

**No schema change is needed to *store* density.** `SpaceDashboardSection.config` is `Json?` (free-form) and already carries per-section settings (`viewMode`, `accountId`, `currency`, `totalBudget`, `monthlyExpenses`). A `config.density: "expanded" | "condensed"` value fits with zero migration, read exactly like `viewMode` is today (`cfgStr(p.config?.viewMode)`).

**But there is a real architectural question `config` forces:** `config` (like `order` and `enabled`) is **shared across all members** of a Space and edited under `section:edit` (ADMIN). That is correct for reorder — layout is a shared property of the Space. It is **questionable for density**, which reads more like a *per-viewer reading preference* ("I like my dashboard dense") than a shared structural decision.

Two clean options:

- **(A) Density is a shared Space setting → store in `config`. No schema.** Simplest. Admin sets it for everyone, consistent with `enabled`/`order`. Recommended for 1B v1.
- **(B) Density is a per-user preference → needs a new small store** (e.g. a per-(user,section) preference row, or a per-user JSON blob). This is a schema addition and a bigger slice.

**Recommendation:** ship 1B v1 as **(A) shared, in `config`, no schema** — it matches the existing customization doctrine and keeps 1B schema-free. Treat per-user density (B) as a *later* slice only if users actually ask for divergent per-member density. Do not build (B) preemptively; it reintroduces exactly the kind of per-user layout state the unified architecture avoided.

This shared-vs-per-user decision is the main reason to split 1B out of 1A: 1A needs no such decision.

---

## Q3. Which existing widgets are safely expandable/condensable?

The primitive **already exists**: `SectionCard` has a `collapsed` `useState` (click title / chevron to toggle) and a fullscreen **"Expand"** mode for the debt payoff calculator. Today collapse is ephemeral (not persisted) and binary (shown/collapsed). Density adds a *middle* state (condensed = summary-only) and persists it.

Widgets sorted by how cleanly they support a condensed (summary) vs expanded (detail) split:

**Safely condensable — they already have a summary/detail split in their props:**
- `net_worth`, `debt_summary`, `investment_summary` (SummaryWidget family) — condensed = `primary` headline + `stats`; expanded = full `rows`. Natural fit.
- `retirement_progress` (ProgressWidget) — condensed = `primary`; expanded = `stats`.
- `goals_progress` (GoalsCard) — condensed = active goals only / first N; expanded = completed + archived + trash affordances.
- `accounts_overview`, `business_accounts` (AccountsCard) — condensed = totals per type; expanded = itemized rows.
- `recent_activity` (TimelineWidget, `pageSize={10}`) — condensed = fewer rows (e.g. 3); expanded = full page.

**Binary only (collapse yes, condense no) — atomic content, no partial view:**
- `debt_breakdown_chart` — a donut/bar; the code already renders it with a **non-collapsible header**. Condensed is meaningless; leave it out of density.
- `property_value` / `vehicle_value` / `equipment_value` (AssetValueWidget) — a single number; already minimal, nothing to condense.
- `debt_payoff_calculator` — already has its own fullscreen Expand; density should defer to that existing affordance, not add a competing one.

**Implication for 1B scope:** density is a **per-widget capability, not universal**. Widgets declare whether they support a condensed view; those that don't only ever offer collapse. This is a natural extension of the existing `WIDGET_REGISTRY`/`SectionRegistry` metadata pattern — add a `supportsCondensed` flag rather than special-casing in `SectionCard`.

---

## Q4. How should responsive auto-condense work?

**Two layers, kept separate:**

1. **Pure presentation (CSS-first):** the dashboard already uses Tailwind breakpoints (`md:grid md:grid-cols-2`, etc.) for reflow. Column count, padding, and grid behavior should stay CSS-driven. No JS needed.

2. **Content density (render-time gate, not a write):** below a breakpoint, small screens should **force the condensed rendering regardless of the persisted `config.density`** — and must **not** overwrite the stored value. The persisted preference is "what the user wants on a roomy screen"; the small screen simply overrides at render:

   ```
   effectiveDensity = isSmallScreen ? "condensed" : (config.density ?? default)
   ```

   There is currently **no general `useMediaQuery` hook** (only `matchMedia` for color-scheme in `ThemeProvider`). 1B needs a tiny `useIsSmallScreen()` hook (SSR-safe, mount-gated like ThemeProvider does) — a small, self-contained addition, not a framework.

**Key rule:** auto-condense is a one-way render override on small screens. It never persists, never round-trips, never mutates `config`. Resize the window back up and the user's expanded preference returns intact.

---

## Q5. Density: per-section, per-widget, or per-template default?

**Per-section for the stored value; per-widget for the *capability*; per-template for the *seed default*.** These are three different roles, not competing choices:

- **Stored value → per-section.** The `SectionCard` is the density unit, and there is effectively one widget per section. Persist `config.density` on the section row. Per-widget storage would be finer than the UI unit and pointless.
- **Capability → per-widget.** Whether a section *can* condense is a property of its widget type (`supportsCondensed`, Q3), read from the registry.
- **Seed default → per-template (optional, later).** A preset could seed `config.density` so, e.g., a Merchant Operations template ships denser by default. Nice-to-have; not required for 1B v1 (default everything to "expanded" and let users condense).

So: **store per-section, gate per-widget, optionally seed per-template.** Do not introduce per-widget *storage*.

---

## Q6. Should mobile ignore expanded mode?

**Yes.** Below the small-screen breakpoint, force condensed and ignore the stored expanded value (Q4). Rationale: expanded views add row counts and detail that make mobile scroll interminable, and the whole point of density is a calmer default — mobile is where "calm" matters most. The forced condense is a render override only; the user's expanded preference is preserved for when they return to a larger screen. Do not offer an expand toggle that fights the breakpoint on mobile — it invites a layout that doesn't fit.

(Consistent with the prior doc's stance that drag reorder itself should also be available on mobile via the dnd-kit touch sensor, but the *density* dimension is where mobile diverges: mobile reorders, mobile does not expand.)

---

## Q7. Drag/drop library

**Use `@dnd-kit` (`@dnd-kit/core` + `@dnd-kit/sortable`).** Confirmed **no** drag library is currently installed (`package.json` and `package-lock.json` both clean of dnd-kit / react-dnd / sortablejs). dnd-kit is the right pick:

- Built-in **sortable** preset gives exactly the snap-back vertical reordering requested, with transform/transition animations, out of the box.
- **Touch + keyboard + pointer sensors** — one interaction serves desktop and mobile, and it's accessible (keyboard reordering, ARIA live regions) — matching the "works on both" requirement without a separate mobile path.
- Small, tree-shakeable, no legacy HTML5-drag pitfalls (which degrade badly on touch).

Do **not** hand-roll HTML5 `draggable`, and do **not** reach for React Flow / grid engines (explicitly banned and unnecessary for a 1-D list). This dependency belongs to **1A only** — 1B needs no library.

---

## Q8. How do we avoid building a dashboard builder?

The guardrails are structural, not willpower. Each keeps a discrete, bounded model instead of a free canvas:

- **Fixed unit.** The draggable/condensable unit is always the whole **section card**. No sub-card targets.
- **1-D, not 2-D.** Reorder is a single vertical axis. No x/y, no coordinates, no grid — so there is nothing to "lay out."
- **Discrete density, not resize.** Density is a **2–3 state enum** (expanded / condensed / collapsed), *not* a continuous resize handle. This is the critical distinction: resize handles imply a canvas; a toggle implies a mode. No pixel dragging of edges.
- **No structural edits.** No create, no delete (hide via `enabled` already exists), no cross-tab moves (tab = semantic classification, not a slot), no widget-level drag, no moving widgets between sections.
- **Mode-gated.** Editing lives in an explicit "Edit layout" mode; the read view is never a live editor.
- **The data model stays flat.** As long as customization only writes `order` (1A) and a `config.density` enum (1B), no schema grows toward a layout engine. The moment someone proposes a coordinate or a span, that's the line — refuse it.

If a change can't be expressed as "reorder this list" or "pick a density enum," it is out of scope by construction.

---

## Q9. Smallest implementation sequence

**UX-CUST-1A — Drag/drop reorder (ship first):**
1. Add `@dnd-kit/core` + `@dnd-kit/sortable`.
2. Add batch endpoint `PATCH /api/spaces/[id]/sections/reorder` (ordered ids → `order = index` in one transaction, `section:edit`). *(Fallback: per-section PATCH already accepts `order`.)*
3. "Edit layout" mode toggle in the section-card stack; wrap the stack in a dnd-kit `SortableContext`; drag handle per card; snap-back on drop.
4. Optimistic reorder → single Save write; Cancel discards; Reset-to-template rewrites preset order.

**UX-CUST-1B — Density modes (ship second):**
1. Decide density scope — **recommend shared, in `config`, no schema** (Q2/A).
2. Add `supportsCondensed` to the widget registry; give the ~5 condensable widgets a summary view (Q3).
3. Persist `config.density` per section (reuse PATCH `config`); default "expanded".
4. Add `useIsSmallScreen()` and the render-time auto-condense override (Q4/Q6) — never persists.
5. Extend "Edit layout" mode with a per-section density control (expanded / condensed), collapse remaining as the existing ephemeral toggle or promoted to a third persisted state.

**Optional micro-slice (could precede 1B):** persist the *existing* ephemeral `collapsed` state into `config.collapsed`. Tiny, reuses everything, and validates the "density-in-config" approach before the larger condensed-view work.

---

## Risks specific to this refinement

- **Coupling density to shared `config`** may surprise members if one admin condenses everyone's view. Mitigate with clear "applies to all members" copy (as `enabled` already carries), and keep per-user density (Q2/B) as a known future option.
- **Per-widget condensed views are real design work** — ~5 widgets each need a truthful summary that doesn't hide something material. This is the bulk of 1B and the main reason it's not bundled with 1A.
- **`useIsSmallScreen` SSR/hydration** — must mount-gate like `ThemeProvider` to avoid a flash of the wrong density.
- **dnd-kit + collapse interaction** — a collapsed card is a smaller drag target; ensure the drag handle stays present in the collapsed header.

---

## Bottom line

- **Q1:** Yes — `order` fully supports drag/drop; snap-back is a client animation via dnd-kit. No schema.
- **Q2:** Density *stores* in `config` with no schema; the open question is shared-vs-per-user, which is why 1B is separate. Recommend shared/config for v1.
- **Q3:** ~5 widgets (SummaryWidget family, ProgressWidget, GoalsCard, AccountsCard, TimelineWidget) condense cleanly; charts/single-value widgets are collapse-only.
- **Q4:** CSS for reflow; a render-time small-screen override for content density that never persists.
- **Q5:** Store per-section, gate per-widget, optionally seed per-template.
- **Q6:** Yes — mobile forces condensed, ignores stored expanded, preserves the preference.
- **Q7:** `@dnd-kit` (core + sortable); none installed today; 1A only.
- **Q8:** Fixed unit, 1-D reorder, discrete density enum (not resize), mode-gated, flat data model.
- **Q9:** 1A (dnd-kit + batch reorder + edit mode) → 1B (config density + per-widget summaries + responsive gate).

**Split into UX-CUST-1A and UX-CUST-1B. Ship 1A first.**
