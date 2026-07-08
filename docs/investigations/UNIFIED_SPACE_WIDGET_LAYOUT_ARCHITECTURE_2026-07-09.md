# Unified Space Widget Layout Architecture

**Date:** 2026-07-09
**Status:** Investigation only. No code, schema, STATUS.md, template, or migration changes.
**Builds on:** `PERSONAL_OVERVIEW_SECTION_BACKED_LAYOUT_INVESTIGATION_2026-07-09.md`, `FOURTH_MERIDIAN_UX-PER-3_PERSPECTIVE_WORKSPACE_RENDERER_INVESTIGATION_2026-07-08.md`, UX-CUST-1A.

---

## 0. Primary answer

**Yes.** Fourth Meridian can and should converge on one model: **every Space tab renders an ordered collection of widget-backed sections**, dispatched through the existing `SectionRegistry`/`SectionCard`, with fixed shell/editorial controls living *outside* the stack via named seams. The codebase is already ~80% of the way there — one dashboard shell (`SpaceDashboard`) already renders every Space and Personal, `SectionCard` + `SectionRegistry` is already the universal compositor, and `order`/`enabled`/`config` already persist per section. The remaining work is **deleting exceptions**, not building a system.

The universal rule:

> **Visible data card = a `SectionRegistry`-keyed widget rendered from a section unit (materialized `SpaceDashboardSection` row, or a virtual section) = ordered = draggable when Edit Layout is active (once the unit is materialized).**
> Fixed shell/editorial controls (currency/view-as, title/header, rail tabs, day-zero onboarding, cross-tab nav) are **not** sections and are never draggable.

There are exactly **two** section-unit backings, and the distinction is the crux of the whole migration:

| Backing | Persists order/enabled/config? | Draggable? | Saved layouts? | Use for |
|---|---|---|---|---|
| **Materialized** `SpaceDashboardSection` row | Yes | Yes | Yes | Overview, Accounts, Debt, Investments, Activity, all "real" tabs |
| **Virtual** section (synthesized at render from `PerspectiveDef.widgets[]`) | No | No | No | Perspective workspaces **until** they need persistence, then promote to materialized |

This is the single lever that keeps the promise "no second layout model, no fake drag/drop": drag/drop and saved layouts require *materialized* rows; virtual sections render identically but are honestly non-draggable until materialized.

---

## 1. Current rendering exceptions (classified)

Every exception in `SpaceDashboard.tsx` / `PersonalDashboard.tsx` that bypasses or special-cases the section model:

| # | Exception | Where | Classification | Rationale |
|---|---|---|---|---|
| 1 | **`renderHero` seam** — Personal Overview body (Net Worth card A, chart B, allocation C) hardcoded in `PersonalHero`; forces `sectionsForTab=[]` on Overview | `SpaceDashboard.tsx:2340`, `PersonalDashboard.tsx:126`, `PersonalHero.tsx` | **DELETE** (convert A/B/C to widget-backed sections) | It is the sole seam that empties the section stack; it's why Edit Layout can't appear on Personal Overview. |
| 2 | **`overviewTopSlot` seam** — currency "view as" control | `PersonalDashboard.tsx:117`, `SpaceDashboard.tsx:2757` | **REMAIN fixed** (shell control) | A control that re-scopes all widgets via `DisplayCurrencyProvider`; not a data card. |
| 3 | **Perspectives doorway** — Overview strip (`PerspectivesWidget variant="row"`) | `SpaceDashboard.tsx:2472` | **REMAIN fixed (transitional)** → becomes navigation into Perspective workspaces | It's cross-tab navigation, not Overview data. Do not drag it. |
| 4 | **Recent Activity doorway** — Overview preview + "View all" → modal | `SpaceDashboard.tsx:2440` | **MOVE to its own tab** (see §3) | Activity is a destination, not an Overview widget. |
| 5 | **Perspective modal routing** — Goals/Debt/Investments/Retirement render as `GlassModal` of that tab's sections | `SpaceDashboard.tsx` `PERSPECTIVE_ROUTED_TABS` (line 206), modal (~2760) | **REPLACE** with Perspective Workspace (virtual sections via `SectionCard`, per UX-PER-3); delete legacy routing over time | UX-PER-3 shows this is already "sections through `SectionCard`, minus the modal." |
| 6 | **Hardcoded Overview cards** — PersonalHero A/B/C | `PersonalHero.tsx:124/143/165` | **BECOME widget-backed sections** (`net_worth` exists; add `net_worth_chart`, `allocation`) | See §2 and the Personal Overview investigation. |
| 7 | **Composition switcher** — `PerspectiveSwitcher` on Overview (Wealth/Cash Flow lenses) | `SpaceDashboard.tsx:2037`, ~2716 | **REMAIN fixed** (a lens/composition control) | A selector, not a card; currently inert unless >1 real composition exists. |
| 8 | **Settings tab remnants** — residual `activeTab !== "SETTINGS"` guards after the rail tab was removed | `SpaceDashboard.tsx:2356/2750/2912` | **DELETE (cleanup)** | Harmless dead conditions now that SETTINGS never renders; remove for clarity. |
| 9 | **Day-zero setup card** — `PersonalHero` `accountCount===0` branch; shell `OverviewSetupCard` | `PersonalHero.tsx:99`, `SpaceDashboard.tsx` | **REMAIN fixed editorial** (empty-state) | Onboarding, not a widget. Preserve via the shell's day-zero path. |
| 10 | **`recent_activity` section on ACTIVITY tab with no rail button** | preset `ACTIVITY_SECTION`; `SpaceDashboard.tsx:2286` | **PROMOTE to a real tab** (see §3) | The section + renderer already exist; the tab just lacks a rail button. |
| 11 | **Page title / header + rail (`SegmentedControl`)** | `SpaceDashboard.tsx` header | **REMAIN fixed shell** | Chrome, never a card. |

**Summary of dispositions:** DELETE (1, 8), REMAIN fixed (2, 3, 7, 9, 11), MOVE to a tab (4, 10), BECOME sections (6), REPLACE with the unified compositor (5). Nothing here needs a *new* rendering system.

---

## 2. Personal Overview migration

Covered in depth in the Personal Overview investigation; summarized for this doc:

- **A — Net Worth summary** → already a materialized `net_worth` section (OVERVIEW, order 0), currently *suppressed* by `renderHero`. Stop suppressing.
- **B — Net Worth over time chart** → new key `net_worth_chart` + `SectionRegistry` renderer wrapping `NetWorthChart`.
- **C — Allocation** → new key `allocation` + renderer wrapping `AllocationChart` (Personal-scoped; misleads at partial scope).
- Enabling change: **thread `snapshots` (and reuse `accounts`/`ctx`) into `SectionRenderProps`** — today the render contract has `accounts`, `spaceId`, `config`, `ctx` but **not** snapshots (the hero closes over them). `goals_progress`/`recent_activity` already self-fetch by `spaceId`, so a self-fetching chart section is also a viable pattern.

**`renderHero`: delete, don't reduce.** Its only job is owning the Overview body. Once A/B/C are sections, delete `renderHero` and the `renderHero && activeTab==="OVERVIEW" ? []` suppression. **Keep `overviewTopSlot`** (currency control) as the small fixed top slot — that is the "reduce to a fixed top slot only" part, but it's a *different, already-separate* seam, so `renderHero` itself goes to zero.

---

## 3. Recent Activity → its own tab

**Findings (exact):**
- A tab id exists for both **`ACTIVITY`** (in `TAB_ORDER`, has the `recent_activity` section + `ActivityCard`/`TimelineWidget` renderer) and **`TIMELINE`** (in `NEW_SPACE_TABS`).
- **Neither has a rail button.** `ACTIVITY` is deliberately buttonless (`SpaceDashboard.tsx:2286`); `TIMELINE` is filtered out of `railOptions` (line 2079).
- The full Activity view is a **`TimelineModal`** overlay gated by `activeTab === "TIMELINE" || "ACTIVITY"` (line 2499), launched from the Overview **doorway's** "View all" (`setActiveTab("TIMELINE")`, line 2452). So today Recent Activity = an Overview preview doorway + a modal. It is **not** a real destination.

**Recommendation:**
- **Give Activity a real rail tab** (re-enable a rail button for `ACTIVITY`/`TIMELINE` in `railVisibleTabs`/`railOptions`), rendering its section stack **inline** (not a modal). The `recent_activity` section already exists and renders through `SectionCard` — so the Activity tab is a section-backed tab for free.
- **Widgets that live there:** `recent_activity` (timeline), and later transaction-activity widgets; all as sections, so they're orderable/draggable like any tab.
- **Overview doorway:** demote to a small optional **preview** or remove it. Opinion: **remove Recent Activity from the Overview** once it's a first-class tab — the doorway exists only because there was nowhere else to see activity. A preview can return later as its own Overview section if desired (section-backed, not a bespoke doorway).
- **Delete `TimelineModal` routing** once the inline tab lands (the modal was a workaround for the missing destination).

This also removes an inconsistency: `recent_activity` is forced non-collapsible in `SectionCard` (line 1413) precisely because it was shoehorned; as a normal tab section that special-case can be revisited.

---

## 4. Perspectives (interaction with UX-PER-3)

UX-PER-3 already ratified the renderer: **synthesize virtual `DashboardSection` objects from `PerspectiveDef.widgets[]` and pass them through the existing `SectionCard` unchanged** (`toVirtualSections()` + a thin `PerspectiveWorkspace` container). This is the *same* compositor — no second layout model.

Alignment with the unified rule:
- **Do NOT** build drag/drop for the current temporary Perspective **card grid** (`PerspectivesWidget`) — those are category-lens launchers, not widget-backed sections, and can't persist. (Matches the Personal Overview investigation's "leave fixed, don't fake it.")
- **Once Perspective workspaces exist**, the widgets *inside* a selected Perspective render as sections through `SectionCard` — so they already use the unified ordered-widget-section model, virtually.
- **Virtual first, materialize when persistence is required (Q4 answer).** Render Perspective workspaces from **virtual** sections initially (no schema, no rows). The moment a Perspective workspace needs **drag/drop reorder or saved layouts**, its virtual sections must be **promoted to materialized rows** keyed per `(space, perspective, widget)` — because `order`/`enabled`/`config` can only persist on real rows. Recommended shape when that day comes: extend `SpaceDashboardSection` with an optional `perspectiveId` discriminator (nullable — null = tab section, set = perspective-workspace section) rather than inventing a parallel table. That keeps **one** section model and lets the *same* reorder endpoint + Edit Layout serve Perspective workspaces. **Do not do this now** — ship virtual/non-draggable first.

So Perspectives converge onto the exact same rule; they simply start virtual (render-only) and materialize later if drag/saved-layouts are wanted.

---

## 5. What must be true before drag/drop is universal

UX-CUST-1A drag/drop works **only** where cards are materialized `SpaceDashboardSection` rows because it requires all four of these, and only materialized rows provide them:

1. **Stable id** — the drag key and the reorder target. Materialized rows have a cuid `id`; virtual sections have a synthetic `virtual:<pid>:<key>` id that is stable per render but has **no server row to write**.
2. **`order`** — the persisted sort integer. Only materialized rows have it; the render sort (`sort((a,b)=>a.order-b.order)`) and the endpoint (`order = index`) both key off it.
3. **Renderer key** — `SectionRegistry[key]`. Both materialized and virtual sections have this (that's why virtual renders fine).
4. **A persistence target** — `PATCH /api/spaces/[id]/sections/reorder` writes `order` to rows. Virtual sections have **nothing to PATCH**, so a drop can't persist.
5. **Fixed controls excluded** — the drag context must contain only section cards, never the currency control, title, rail, or day-zero card.

**Why UX-CUST-1A only works on section-backed cards:** it was built correctly against the section model — `sectionsForTab` (materialized rows) → `SortableContext` → drop → reorder endpoint. Cards that aren't rows (hero A/B/C, Perspective lenses, doorways) satisfy (3) but not (1/2/4), so they can render but cannot be dragged or persisted. Universality is therefore a **backing** problem, not a drag-code problem: make every draggable card a materialized row, and the existing drag code covers it unchanged.

**Universal drag/drop preconditions checklist:** every intended-draggable card is a materialized `SpaceDashboardSection` (real id + order + renderer key), the reorder endpoint accepts its tab (or perspective) scope, and the surrounding DnD context excludes all fixed controls.

---

## 6. Templates and backfill

- **New section keys needed now:** `net_worth_chart`, `allocation` (Personal Overview). Register `SectionRegistry` renderers + `WIDGET_REGISTRY` metadata.
- **Personal template change:** add those two to `PRESET_MAP[PERSONAL]` (OVERVIEW, orders 1/2; `net_worth` stays 0) and the hidden `personal` space-template; **bump template `version`**. Parity tests (`registry.test.ts`, `apply.test.ts`) enforce alignment.
- **Backfill existing Personal spaces:** reuse `scripts/backfill-personal-sections.ts` — additive, idempotent, dry-run-default, no schema migration. It creates exactly the two new rows per existing Personal Space (`net_worth` already present, skipped by `@@unique([spaceId, key])`). **Safe because Personal Overview was never reorderable — zero existing user layout to conflict with.**
- **Activity tab:** `recent_activity` already materializes (universal section); only the rail button is missing — no new key/backfill needed.
- **Future tabs/widgets born section-backed by default:** the rule is "a new widget = (1) `SectionRegistry` key→renderer, (2) `WIDGET_REGISTRY` metadata, (3) a preset entry (per-category or universal)." Doing those three gives it id/order/enabled/config/drag/show-hide automatically. Deleting `renderHero` removes the only bypass, so "born section-backed" becomes the path of least resistance. Add a source-scan **doctrine test** that fails if a data card is rendered directly in a tab body outside the section stack + sanctioned fixed slots.

---

## 7. ManageSpaceModal role

- **Overview (`DashboardTab`) should contain only:** (1) a **refresh** affordance, (2) a **saved-layouts placeholder** (disabled), (3) the single instruction *"To reorder sections, use Edit layout on the dashboard."* Plus keep **section show/hide** (visibility, distinct from layout ordering — currently the only place to hide/show sections).
- **Remove** the "Reset to default layout" disabled control added in the prior slice — it's a dead layout-setting control; reintroduce it only when reset is really implemented.
- **Settings must not exist as an in-space tab** — already done (rail no longer renders SETTINGS; the in-space `SettingsTab` was deleted). Residual `activeTab !== "SETTINGS"` guards should be cleaned up (exception #8).
- ManageSpaceModal is the home for **Space-level** actions (membership, config, currency, danger zone — with Personal delete permanently disabled) and **future saved layouts** — not for per-drag layout editing, which lives on the dashboard via Edit Layout.

---

## 8. Saved layouts (future model — do NOT implement)

Define the model so nothing built now precludes it:

- **A saved layout = a snapshot of:** `{ tab (or perspectiveId), [ { sectionKey, order, enabled, config/presentation } ] }` across the Space's tabs — i.e. the materialized section state, captured and named.
- **Where it lives:** ManageSpaceModal (create/apply/delete named layouts). The dashboard stays the *editing* surface (Edit Layout drag); the modal is the *management* surface.
- **Relationship to templates:** **templates define birth defaults** (materialized once at creation via `planTemplateApplication`); **saved layouts define user-owned arrangements** applied on top. Reset-to-default = re-apply the template order to the live rows.
- **Storage (when built):** a `SpaceLayout` snapshot store (name + serialized section state), applied by rewriting live `order`/`enabled`/`config`. This is additive and needs schema *then* — explicitly out of scope now.
- **Guardrail:** saved layouts operate on the **same** materialized section rows the dashboard already uses; they are a snapshot/restore layer, **not** a second layout representation.

---

## 9. Implementation sequencing

Code evidence supports (and slightly refines) the proposed order:

1. **Thread `snapshots` into `SectionRenderProps`** (enabling, invisible). Smallest prerequisite for chart/allocation sections.
2. **Add `net_worth_chart` + `allocation` renderers** (`SectionRegistry` + `WIDGET_REGISTRY`), reusing existing chart components and the hero's `GlassPanel` treatment for visual parity.
3. **Add the two presets** to Personal template; bump version. (Sections now exist but stay suppressed — still invisible.)
4. **Flip the seam:** delete `renderHero` + the Overview suppression; keep `overviewTopSlot`. **This is the single revertible cutover** that turns on Personal Overview sections + Edit Layout.
5. **Backfill** existing Personal spaces (dry-run → `--apply`).
6. **Verify** Edit Layout on Personal Overview: drag, persist, refresh, currency override intact.
7. **Move Recent Activity to its own tab** (re-enable the rail button; render inline; remove/ą demote the Overview doorway; delete `TimelineModal` routing).
8. **Clean ManageSpaceModal Overview** (§7) and remove Settings remnants (exception #8).
9. **Continue UX-PER-3 Perspective Workspace** (virtual sections via `SectionCard`) — render-only, no drag.
10. **Only then**, if desired, materialize Perspective-workspace sections (`perspectiveId` discriminator on `SpaceDashboardSection`) to extend drag/saved-layouts there.
11. **Saved layouts** — last, its own slice with its own schema.

**Refinement vs. the proposed order:** steps 1–3 are additive/invisible and should land *before* the seam flip (4) so the flip is a clean one-line revert. Recent Activity (7) can proceed in parallel with 1–6 since it's an independent tab change. Everything after 6 is independent of Personal Overview.

---

## 10. Risks

- **Visual regression from `SectionCard` chrome** — section cards add a collapsible header/chevron and faint fill; Personal Overview could read as an inventory list, not a hero. Mitigate by giving the new renderers the hero's `GlassPanel` treatment and reconsidering the forced-collapse rules.
- **Chart state ownership** — `NetWorthChart` interval + expand-modal state currently live in `PersonalDashboard`/`PersonalHero`; as a section they must move into the section component or thread through. Highest-friction item.
- **Personal Overview losing its "hero" feel** — the lede is a brand moment; card-chrome parity and ordering (net worth first) must be preserved.
- **Day-zero onboarding** — the hero owns the `accountCount===0` setup card; the section-based Overview must still show a day-zero story (shell `OverviewSetupCard`).
- **Currency override universality** — must keep `overviewTopSlot` + `DisplayCurrencyProvider` so "view as" still re-scopes every widget.
- **Template/backfill safety** — additive/idempotent; safe now because no Personal Overview customization exists; once shipped, template updates must never overwrite user `order` (existing `planTemplateApplication` doctrine covers this).
- **Perspective workspace interaction** — keep Perspectives virtual until drag/saved-layouts are truly needed; materializing early creates rows with no UI to manage them.
- **Saved-layout scope creep** — easy to over-build; define the snapshot model (§8) but defer all of it.
- **Activity tab move** — ensure deep links / `?tab=` handling and the Overview "View all" targets update when the modal becomes an inline tab.

---

## 11. Recommendation (opinionated)

**Becomes universal:** one compositor — every Space tab renders `sectionsForTab` (materialized rows) or virtual sections (Perspectives) through `SectionCard`/`SectionRegistry`; `order`/`enabled`/`config` persist on materialized rows; Edit Layout drag + the reorder endpoint serve every materialized tab unchanged.

**Remains fixed (never draggable):** currency/view-as control, page title/header, rail/`SegmentedControl`, composition switcher, day-zero onboarding, cross-tab navigation. These live outside the section stack via named seams (`overviewTopSlot` and successors).

**Gets deleted:** `renderHero` and the Overview suppression; the `TimelineModal` doorway workaround (after Activity becomes a tab); the "Reset to default layout" dead control; Settings-tab remnants; eventually the legacy Perspective **modal routing** once the workspace lands.

**Moves to its own tab:** Recent Activity (Activity/Timeline destination), rendered as a section-backed tab; remove it from Overview.

**Becomes section-backed:** Personal Overview Net Worth / chart / allocation; Perspective workspace widgets (virtual → materialized when persistence is required); all future AI / Merchant Ops / Business / Government widgets by default.

**Do NOT implement yet:** saved layouts; materialized Perspective sections; drag/drop on the temporary Perspective card grid; any second layout representation.

**The one rule to converge on:** *every visible data widget/card is section-backed, ordered, and — once materialized — draggable; fixed shell controls are explicitly excluded.* One model for Personal, shared, Business, Merchant Ops, and every internal Space and future tab. No second Personal layout model, no second Perspective layout model, no fake drag/drop.

The decisive point: this is a **subtraction**, not a construction. The section model, compositor, reorder endpoint, drag UI, preset system, and backfill tooling all already exist and already generalize. Universality is achieved by deleting the exceptions (`renderHero` first) and materializing the last few hardcoded cards — after which the product is, by construction, one ordered-widget-section system everywhere.
