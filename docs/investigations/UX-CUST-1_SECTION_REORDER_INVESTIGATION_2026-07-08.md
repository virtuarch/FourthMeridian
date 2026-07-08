# UX-CUST-1 — Section Reorder — Investigation

**Date:** 2026-07-08
**Status:** Investigation only. No code, schema, or STATUS.md changes made.
**Scope:** The first customization feature for the unified Spaces architecture.

---

## TL;DR

Section reorder is not a new feature to build — it is a **capability that already exists in the data model and is 90% wired**, waiting for a UI to turn it on. Ordering flows end-to-end today: `SpaceDashboardSection.order` is a first-class schema column, presets set it, template materialization carries it, the API sorts by it, the dashboard renders by it, and the section-edit PATCH endpoint **already accepts and writes `order`**.

The smallest useful first slice is therefore an **"Edit layout" mode inside the shared `SpaceDashboard` shell that reorders the section-card stack within a tab**, persisting new `order` values to the existing materialized rows. It requires **zero schema changes**, one small (optional) batch endpoint for atomicity, and one reorder interaction. Because sections live on every Space and render through the shared shell, this is automatically a **Space capability**, not a Personal one — Personal, Business, Family, and Merchant Operations get it with no special-casing.

**Recommendation:** ship section reorder as described. Keep widget drag/drop firmly deferred — it has no positional model in the codebase and would require a schema, a grid engine, and a new honesty story.

---

## 1. Current architecture

### How SpaceDashboard renders sections

`components/dashboard/SpaceDashboard.tsx` is now the single shell for every Space, Personal included (Personal injects a hero via the `renderHero` seam; otherwise byte-identical). It fetches `SpaceDashboardSection` rows from `GET /api/spaces/[id]/sections` and renders them per tab.

The ordering pipeline, top to bottom:

1. **Fetch, already ordered** — `app/api/spaces/[id]/sections/route.ts`:
   ```ts
   orderBy: [{ tab: "asc" }, { order: "asc" }]
   ```
2. **Tabs derived from enabled sections** — `enabledSections` → `tabSet` → `tabs = TAB_ORDER.filter(...)`. Tab *presence* is data-driven; tab *order* is a fixed constant (`TAB_ORDER`).
3. **Per-tab section stack, re-sorted at render** — line ~2307:
   ```ts
   const sectionsForTab = enabledSections
     .filter((s) => s.tab === activeTab)
     .sort((a, b) => a.order - b.order);
   ```
4. **Rendered as a `SectionCard` stack** — `sectionsForTab.map((s) => <SectionCard .../>)`, dispatched through `SectionRegistry[section.key]`.

### Where ordering comes from

`order` originates in `lib/space-presets.ts` (`SectionPreset.order`, "0 = first, relative within the preset") and is materialized once at Space creation.

### Does order already exist in schema?

**Yes — fully.** `prisma/schema.prisma`, `model SpaceDashboardSection`:
```prisma
order   Int  @default(0)   // ascending sort order within the tab
@@unique([spaceId, key])
@@index([spaceId, tab])
```
The schema comment is explicit: *"Members with OWNER/ADMIN role can toggle, reorder, or add custom sections."* The reorder capability was designed in from the start.

### Do templates materialize order?

Yes. `lib/space-templates/apply.ts` copies `order` through unchanged at creation, and its doctrine already protects customization: *"Additive only: never updates, disables, reorders, or deletes existing sections. User customizations are untouchable."*

### Do sections have stable identifiers suitable for drag/drop?

Yes, two of them:
- `id` — a cuid, stable per row (ideal React/drag key).
- `key` — machine identifier, `@@unique([spaceId, key])`, stable across template updates.

Everything a reorder interaction needs — stable keys, a persisted integer order, a sorted render — is already present.

---

## 2. Can section reorder ship without schema changes?

**Yes.** No schema change is required. Order already exists as a column and is already read and rendered.

The write path also largely exists. `PATCH /api/spaces/[id]/sections/[sectionId]` **already accepts `order`**:
```ts
...(body.order !== undefined && { order: body.order }),
```
gated behind `section:edit` (ADMIN, per `lib/spaces/policy.ts`).

So a naive implementation could reorder today with **zero backend work** by issuing one PATCH per moved section. The only thing worth adding is a **batch reorder endpoint** for atomicity and to avoid N round-trips / transient mixed-order flicker:

> **Smallest justified addition (API only, not schema):**
> `PATCH /api/spaces/[id]/sections/reorder` — body: an ordered array of section ids (scoped to one tab). Writes all `order` values in a single `db.$transaction`, gated by the existing `section:edit`. This is a convenience/consistency wrapper over behavior the per-section PATCH already permits.

No new columns, no new table, no migration.

---

## 3. Scope — the correct first version

Be opinionated. The reorderable unit is the **materialized section** (`SpaceDashboardSection`), and the first slice reorders **section cards within a single tab**.

**In scope (v1):**
- ✅ Reorder the section-card stack within a tab, persisted to `order`.

**Out of scope (explicitly deferred):**
- ❌ Resize sections
- ❌ Drag widgets / move widgets across sections (§8)
- ❌ Create sections
- ❌ Delete sections (hide already exists via `enabled`)
- ❌ Move sections between tabs (tab is a semantic classification, not a layout slot)
- ❌ Reordering rail *tabs* (`TAB_ORDER` is fixed IA, not customization)

**One honesty caveat about the Overview tab.** The `OVERVIEW` tab is not a plain sorted stack — it is a composed editorial layout (hero, Perspectives doorway, Recent Activity doorway, composition switcher) with the section stack as its *tail*. Reorder in v1 applies to the **section-card stack**, i.e. the trailing Overview stack and the section stacks on other tabs / Perspective-routed modals. The hero and doorway slots are deliberately fixed and are **not** part of reorder v1. State this plainly in the UI scope; do not try to make the whole Overview a free canvas.

This keeps v1 to a single, truthful promise: *"reorder the cards, nothing else."*

---

## 4. UX — the simplest interaction

**Mode, not always-on.** An explicit **"Edit layout"** mode (enter → reorder → Save / Cancel) is correct. Dashboards are read-first; drag handles that are always live invite accidental moves, especially on touch. A mode also gives a clean home for **"Reset to template order."**

**Where it lives.** The `SettingsTab` already lists sections grouped by tab and already toggles `enabled` via PATCH. Reorder is the same surface, the same permission (`section:edit`), the same `onUpdate()` refresh. Put the first version *there* — it is the smallest, most consistent home and needs no new tab.

**Interaction, desktop vs. mobile — pick the smallest that works on both:**

- **Recommended v1 (smallest, no dependency): up/down move controls.** In edit mode, each section row shows ▲/▼ buttons that swap `order` with its neighbor. Zero new libraries, fully accessible, identical on desktop and mobile, keyboard-friendly, no drag physics, no touch-scroll conflicts. This is the truly minimal useful version.
- **Optional polish (v1.1): drag handles.** If drag is wanted, add `@dnd-kit/sortable` (no dnd library is currently installed — verified in `package.json`). It is accessible, supports touch and keyboard, and is the standard lightweight choice. Do **not** hand-roll HTML5 drag — it degrades badly on mobile.

**Do not build:** layout builders, resize handles, free-form grids, masonry, CSS-grid editors, React Flow, Notion-style canvases. All explicitly out of bounds and none are needed for a 1-D list reorder.

**Save semantics:** Save writes the batch order; Cancel discards local state (no writes); Reset re-applies template order (recompute from the Space's template preset and write). Optimistic local reorder with a single Save write is the calmest model.

---

## 5. Persistence — where customized order lives

**Modify the materialized `SpaceDashboardSection.order` rows. Leave templates untouched.**

This is exactly the settled doctrine: *templates define defaults; materialized sections define reality.* Templates are pure data consumed once at birth (`lib/space-templates/types.ts`: *"Editing a template never changes existing Spaces"*). Reordering is a mutation of *reality*, so it belongs on the materialized rows — the same rows `enabled` and `config` already mutate. Nothing about templates changes.

Reorder should **overwrite the existing `order` integers** on the affected rows (within one tab). No shadow "user order" column, no override layer — the materialized row *is* the user's copy already. Adding a parallel order field would reintroduce the template/reality split the unified architecture just removed.

---

## 6. Template interaction — the long-term question

Scenario: a Personal template ships v2.7 with a new section; the user reordered six months ago.

The existing `planTemplateApplication` already answers this correctly, *if and only if* template re-application is ever wired up (today templates are consumed only at creation):

- **Existing order remains.** Re-application is additive-only and idempotent — it filters out keys already present (`@@unique([spaceId, key])`), so the user's reordered rows are never touched.
- **New sections insert, but naively.** New keys are appended carrying their *template* order value. Because the user has re-sequenced existing rows, a raw template order of, say, `2` may now collide or land mid-stack unpredictably.

**Recommendation for the long term (not v1):** when template re-application lands, new sections should append at the **end of their tab** (max existing `order` + 1) rather than inheriting raw template order, so they arrive visibly "new" and never silently reshuffle a customized dashboard. Template updates should **never overwrite** existing `order`, `enabled`, or `config`. This is a one-line refinement to the *future* apply-to-existing planner and does not block UX-CUST-1.

For v1: no template re-application exists, so there is no conflict to resolve yet. Just don't regress the additive-only doctrine.

---

## 7. Architecture — Space capability, not Personal capability

**It is inherently a Space capability, for free.** Reorder touches only `SpaceDashboardSection` (every Space has these rows) and lives in the shared `SpaceDashboard` shell (every Space, Personal included, renders through it since the 2026-07-08 shell unification). There is no Personal-specific code path to add.

It works without special cases for Personal, Business, Family, Merchant Operations, and any future internal Space, because:
- the ordering pipeline is category-agnostic (sort by `order`, dispatch by `key`);
- `section:edit` authorization is uniform across Space types;
- the only per-Space divergence sanctioned by the architecture — the hero — is deliberately outside reorder scope.

One small note: `section:edit` requires **ADMIN**. For Personal the sole member is OWNER (which satisfies ADMIN-or-higher), so Personal reorder works; for shared Spaces, VIEWERs correctly cannot reorder. No change needed — just be aware reorder is an owner/admin action that affects all members, consistent with how `enabled` already behaves.

---

## 8. Widgets — why they must stay non-draggable

**Section reorder is a 1-D reordering of a list that already has an order column. Widget drag/drop is a 2-D layout problem with no model in the codebase.** They are not the same feature at a different scale — they are different classes of problem.

| | Section reorder | Widget drag/drop |
|---|---|---|
| **Positional model** | Exists: `order Int` per row | None — widget layout is editorial, hardcoded in `SectionRegistry` render fns |
| **Persistence** | Reuse existing rows/column | Needs a new schema (per-widget coords/size/section membership) |
| **Interaction dimensionality** | Linear list (▲/▼ or single-axis drag) | Grid: x/y, spans, collision, reflow |
| **Mobile UX** | Trivial — a vertical list reorders cleanly | Hard — 2-D grids collapse to one column on mobile, so "placement" becomes meaningless or needs a separate mobile layout |
| **Honesty model** | Preserved — "data defends what appears" is untouched; cards only move | Broken — resize/placement implies a canvas the data model doesn't back |
| **Maintenance** | Near-zero — one interaction over existing plumbing | High — grid engine, collision, breakpoint layouts, new migrations |
| **Future extensibility** | Clean base for hide/show, collapse, saved layouts | Locks in a grid abstraction that's hard to walk back |

Widget drag/drop would require a grid engine (or React Flow — explicitly banned), a widget-layout schema/migration, and a new mobile layout story, all to solve a problem no user has after section reorder ships. **Widget drag/drop should remain deferred.** State it plainly: sections move; widgets do not.

---

## 9. Future roadmap — sequencing only (not designs)

If section reorder lands first, the natural, cheapest-to-most-expensive sequence is:

1. **Hide/show sections** — already exists as `enabled`; v1 essentially subsumes it. Nearly free.
2. **Collapse sections** — per-section boolean in `config`, pure client state → persisted. Small.
3. **Per-section config surfacing** — expose the `config` JSON edits that widgets already read (e.g. chart type). Small, reuses PATCH.
4. **Saved layouts** — snapshot the `order`/`enabled` set. Moderate; needs a snapshot store.
5. **Multiple layouts per Space** — depends on (4). Larger.
6. **Widget resizing / placement** — last, and only if genuinely demanded; requires the deferred 2-D model from §8.

Sequencing principle: each step reuses the previous step's plumbing and defers the schema/grid work as long as possible. Do not reorder this list to pull widget layout forward.

---

## 10. Recommendation

### Proposed architecture
Reorder mutates `SpaceDashboardSection.order` on the materialized rows, within a tab, through the shared `SpaceDashboard` shell, gated by the existing `section:edit` policy. Templates remain pure, consumed-once data. No schema change.

### Implementation sequence
1. **(Optional, recommended) Batch endpoint** — `PATCH /api/spaces/[id]/sections/reorder`, ordered ids → one transactional order rewrite, `section:edit`. (Fallback: reuse per-section PATCH, which already accepts `order`.)
2. **Edit-layout mode in `SettingsTab`** — a toggle that reveals ▲/▼ move controls per section row, plus Save / Cancel / Reset-to-template.
3. **Optimistic local reorder + single Save write**; `onUpdate()` re-fetches.
4. **(v1.1, optional) drag handles** via `@dnd-kit/sortable` if drag is desired.

### Smallest first slice
Edit-layout mode with **up/down move controls** in `SettingsTab`, persisting via the existing per-section PATCH `order` write. No new dependency, no schema, works identically on desktop and mobile. This is the minimum that delivers real customization.

### Risks
- **Overview composition confusion** — users may expect the hero/doorways to move. Mitigate with copy scoping reorder to "cards," and by initially exposing reorder where the stack is a plain list.
- **Shared-Space blast radius** — reorder affects all members (like `enabled` today). Acceptable and consistent; label it.
- **Non-atomic writes** if the per-section fallback is used — mitigated by the batch endpoint.
- **Future template re-application** appending new sections into a customized order — pre-empt with the §6 "append at end of tab" rule when that planner is built.

### Validation strategy
- **Unit:** reorder planner (ids → order map) is pure and testable, mirroring the existing `apply.test.ts` style; assert order permutation, tab-scoping, and idempotence.
- **API:** `section:edit` gating (VIEWER denied, ADMIN allowed), tab-scoped writes only, transactional atomicity.
- **Doctrine test:** a reorder followed by a (future) template application leaves user `order` untouched — extend the additive-only invariant tests.
- **Manual/E2E:** reorder → refresh → order persists; Reset-to-template restores preset order; mobile move controls; VIEWER sees no edit affordance.

### The inevitability check
This feature should feel like it was always part of `Space → Template → Materialized Sections → Widgets`: templates define the default order, materialization makes it real, and reorder simply lets the user edit the *reality* layer the architecture already isolated for exactly this purpose. It is not bolted on — the `order` column, the additive-only template doctrine, and the shared shell were built anticipating it.
