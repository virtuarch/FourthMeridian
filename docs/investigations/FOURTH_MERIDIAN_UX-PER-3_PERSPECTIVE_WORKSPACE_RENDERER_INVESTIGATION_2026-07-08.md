# UX-PER-3 — Perspective Workspace Renderer Architecture

**Status:** Investigation only. No implementation, no code, no schema, no migrations, no STATUS.md change.
**Date:** 2026-07-08
**Predecessor:** `FOURTH_MERIDIAN_UX-PER-2_PERSPECTIVE_WORKSPACE_INVESTIGATION_2026-07-08.md` (proved the direction: `PerspectiveDef.widgets[] → existing SectionRegistry compositor`).
**Constraints honored:** no schema, no new widget system, no second renderer where the compositor can be reused, no drag/drop, no widget customization, no template/FI/Platform-Ops work.

---

## 0. Executive answer

Render a Perspective by **synthesizing virtual `DashboardSection` objects from `PerspectiveDef.widgets[]` and passing them through the existing `SectionCard` unchanged.** Not `SectionRegistry` directly, not materialized DB rows, not a new wrapper around section rendering, and not a second dashboard system.

The decisive evidence: **the modal-routed Perspectives already do exactly this today, minus one coupling.** When a user clicks the Debt/Investments/Goals/Retirement Perspective card, `SpaceDashboard` renders that tab's sections through `SectionCard` inside a `GlassModal` (lines 2609–2646). The workspace is that same rendering, freed from two accidents: (1) the modal, and (2) the fact that section membership is decided by `section.tab === activeTab` instead of by a Perspective. Replace "which sections have this tab" with "which widget keys this Perspective names," synthesize section-shaped objects for them, and feed the *same* `SectionCard`. That is the whole renderer.

This is why the workspace should feel inevitable: it is not a new abstraction, it is the deletion of a coupling. The recommended architecture **adds one component and one ~30-line mapping function, reuses `SectionCard`/`SectionRegistry`/`WIDGET_REGISTRY`/`ContextualCard` unchanged, and lets the legacy routing be deleted over time.**

Recommended shape:

```
PerspectiveDef.widgets = ["net_worth", "investment_summary"]
        │
        ▼
toVirtualSections(widgets)               // NEW — ~30 lines, pure
   → DashboardSection[] { id:"virtual:<pid>:<key>", key, label(from WIDGET_REGISTRY),
                          tab:"—", enabled:true, order:i, config:null }
        │
        ▼
<PerspectiveWorkspace>                    // NEW — thin container component
   maps each virtual section → <SectionCard …/>   // EXISTING chrome + dispatch, unchanged
        │
        ▼
SectionCard → SectionRegistry[key](props) // EXISTING compositor, unchanged
```

---

## 1. Existing rendering path (exact trace)

Every non-trivial fact below is from `components/dashboard/SpaceDashboard.tsx`.

**Section shape.** `DashboardSection = { id, key, label, tab, enabled, order, config: Record<string,unknown>|null }` (line 68). These are the materialized `SpaceDashboardSection` DB rows, fetched by the host via `GET /api/spaces/[id]/sections` into `sections` state (line 2140), i.e. one array per Space.

**Selection & ordering.** `enabledSections = sections.filter(s => s.enabled && hasRenderer(s.key))` (line 2323). Per tab: `sectionsForTab = enabledSections.filter(s => s.tab === activeTab).sort((a,b) => a.order - b.order)` (line 2342). So **enabled** is a persisted per-row boolean toggled from the Settings tab (`PATCH /api/spaces/[id]/sections/:id`, line 2547); **order** is a persisted integer; **tab** is what buckets a row onto a rail tab.

**The chrome — `SectionCard`** (line 1373). Props: `{ section, accounts, spaceId, category, canManage, onAddGoal, ctx }`. It owns:
- **Collapse:** local `useState(collapsed=false)` (line 1391) — *ephemeral, not persisted*. Header click toggles; collapsed body is unmounted (line 1522). Debt Breakdown / Activity are forced non-collapsible (`isDebtBreakdown`, line 1412).
- **Fullscreen:** local `useState(payoffFullscreen)` (line 1392) — *ephemeral*. Only the debt payoff calculator surfaces an "Expand" control (line 1501); `fullscreenable` in `WIDGET_REGISTRY` is the metadata flag.
- **Config handling:** passes `section.config` straight into the render fn (line 1465).
- **Card container:** `bg-[var(--surface-muted)]` rounded panel with a title header (`displayLabel`), collapse chevrons, and a few debt-space legacy label overrides (lines 1406–1414).

**Widget dispatch — `renderBody()`** (line 1449): `SectionRegistry[section.key]({ accounts, spaceId, canManage, onAddGoal, payoffFullscreen, closePayoffFullscreen, config: section.config, ctx })` (line 1465). Unknown/unimplemented keys fall back to `<ContextualCard>` (line 1466). `SectionRegistry` (line 1117) is the `key → render fn` compositor; `SectionRenderProps` (line 937) is the data contract.

**Data dependencies (`SectionRenderProps`).** `accounts: SpaceAccount[]` and `ctx: ConversionContext` are fetched **once by the host** and passed down to every card. Two widgets **self-fetch** by `spaceId` instead: `goals_progress → <GoalsCard spaceId=…>` and `recent_activity → <ActivityCard spaceId=…>` (lines 1132–1133). Perspective Engine lens results are host-fetched in one batch (`GET /api/spaces/[id]/perspectives`) and keyed by `lensId`. So the data model is: **account/currency data lifted to the host and passed as props; goals/activity self-fetch; lens headlines batch-fetched.**

**Where Perspectives render today.** `perspectiveItems` (from `getPerspectivesForCategory`) render as `<PerspectivesWidget variant="row">` on Overview (line 2438) and `variant="grid">` on the PERSPECTIVES rail tab (line 2563). A card's `onSelect` sets `activeTab` to a `PERSPECTIVE_ROUTED_TABS` value, which renders that tab's `sectionsForTab` through `SectionCard` inside a `GlassModal` (lines 2609–2646). The `PerspectiveSwitcher` (line 2659) is the inert composition dropdown, gated off unless a second *available* composition exists.

**Conclusion of the trace:** the compositor already accepts "an array of section-shaped objects + host data props" and renders full chrome. Nothing about it requires those objects to come from the database or to carry a real `tab`. That is the seam the workspace uses.

---

## 2. Virtual sections — can a workspace safely synthesize them? (Q2)

**Yes, and this is the recommended path.** A `PerspectiveDef.widgets` array of registry keys maps cleanly to synthetic `DashboardSection` objects:

```
"net_worth" → { id: "virtual:wealth:net_worth", key: "net_worth",
                label: getWidgetMeta("net_worth").label, tab: "—",
                enabled: true, order: 0, config: null }
```

fed to the existing `SectionCard`. This **preserves the architecture** (same chrome, same dispatch, same fallback) and **avoids schema entirely** (nothing is written; the objects live for one render). Assessment of each risk the brief names:

- **Section ids:** synthetic, `virtual:<perspectiveId>:<key>` — deterministic, unique, valid React keys. The *only* rule: they must never reach a mutation path (`PATCH /sections/:id` would 404). v1 gives the workspace **no toggle/settings affordance**, so no write is ever issued. Low risk, explicitly gated.
- **Config:** synthetic rows carry `config: null`, so config-driven widgets fall back to defaults. This is the **one real limitation** — `retirement_progress`, `property_value`, `emergency_fund`, and the asset trackers read per-Space config that only materialized rows hold. Resolution: **v1 composes only config-light, account-reading widgets** (`net_worth`, `debt_summary`, `investment_summary`, `investment_allocation`, `accounts_overview`) plus lens headlines. Config-bearing widgets stay on their materialized tabs until a later "config hydration" slice (§3). This keeps v1 pure-virtual and safe.
- **Enabled state:** virtual rows are always `enabled: true` — correct, because *the Perspective* owns membership, not a per-Space toggle. Enable/disable is a Perspective-definition or (later) per-user concern, not a shared-row flag.
- **Order:** the `widgets[]` array index — deterministic and owned by the Perspective. This is strictly cleaner than the shared persisted `order` integer.
- **User customization:** none in v1. The synthetic `order`/`enabled`/`id` fields are precisely the hooks a future per-user overlay writes into (§9). Virtual sections don't block customization; they enable it.

The virtual approach reuses `SectionCard`, not merely `SectionRegistry` — so collapse, fullscreen, config pass-through, and the `ContextualCard` fallback all come for free. That is the difference between "reuse the compositor" and "reuse a fragment of it."

---

## 3. Materialized sections — should the workspace reuse real rows instead? (Q3)

**No.** Reusing actual `SpaceDashboardSection` rows buys per-Space config/order/enabled for free, but the costs are structural and permanent:

- **Couples Perspectives to template materialization.** A widget could only appear in a Perspective if the Space's template happened to seed a row for it. "Wealth → Historical Growth" would be impossible until a template materialized a `historical_growth` row — inverting the UX-PER-2 doctrine that a Perspective is a *live registry view*, not a birth-time artifact.
- **One row, many Perspectives — ambiguous.** The same `net_worth` row would be shared by Overview, Wealth, and any other Perspective, sharing one collapse state, one `order`, one config. A Perspective can't order or configure a widget independently if it's borrowing a tab-scoped row.
- **Sections were designed for tabs.** Rows are keyed and bucketed by `tab`; repurposing them as nested workspace members overloads a field that already means something.
- **Customization would entangle members.** Per-user widget reordering inside a Perspective would become writes to *shared* rows — one member's Perspective layout would move another member's tab. Virtual sections keep customization as a per-user overlay over registry defaults (§9).

**Decision: virtual sections, not materialized rows.** Where per-Space config is genuinely needed later, the clean hybrid is to let a virtual section *optionally hydrate* its `config` by looking up a materialized row of the same key (virtual shell, real config) — but that is a deferred slice, not v1, and it stays a read, never a shared write.

---

## 4. Renderer location — cleanest boundary (Q4)

**A separate `PerspectiveWorkspace` component under `components/dashboard/perspectives/`, invoked by `SpaceDashboard`.** Not inside `SpaceDashboard` (already ~2,800 lines), and not "call `SectionRegistry` directly" (that discards the `SectionCard` chrome and forces reimplementation of collapse/fullscreen/fallback).

There is one structural prerequisite worth stating plainly: **`SectionCard`, `SectionRegistry`, `SectionRenderProps`, the adapter helpers, and the `DashboardSection` type currently live *inside* `SpaceDashboard.tsx` as module-private members.** For a sibling component to reuse them, they must be **extracted into a shared module** (e.g. `components/dashboard/sections/`). This extraction is a pure, mechanical move with no behavior change and is the single enabling refactor for the whole initiative. (Pragmatic fallback: v1 could keep `PerspectiveWorkspace` *inside* `SpaceDashboard.tsx` to skip the extraction, then extract later — but extraction-first is cleaner and testable by parity.)

Boundary summary:

| Concern | Owner |
|---|---|
| Which widgets a Perspective shows, in what order | `PerspectiveDef.widgets[]` (`lib/perspectives.ts`) |
| Key → virtual section mapping | `toVirtualSections()` (new, pure, ~30 lines) |
| Workspace container (selector-driven, lays out cards) | `PerspectiveWorkspace` (new) |
| Card chrome + widget dispatch | `SectionCard` + `SectionRegistry` (existing, extracted) |
| Widget metadata (label, icon, config schema, requires) | `WIDGET_REGISTRY` (existing) |
| Data (accounts, ctx, lens results) | `SpaceDashboard` host, passed down (existing) |

---

## 5. Data flow (Q5)

**Pass the same props the normal `SectionCard` path passes — nothing new.** For the config-light, account-reading widgets in v1 scope, the required inputs (`accounts`, `ctx`, `spaceId`, `canManage`, `onAddGoal`) are **already fetched once by the host** and are in scope where `SpaceDashboard` would mount `PerspectiveWorkspace`. The workspace forwards them straight through. No new endpoint, no new fetch, no FI change.

Self-fetching widgets (`goals_progress`, `recent_activity`) will continue to self-fetch by `spaceId` if composed into a Perspective — acceptable in v1 (they already do this on their tabs). The one caveat: if the *same* self-fetching widget appears both on Overview and in an open workspace, it double-fetches; this is benign and non-simultaneous in practice.

**Should Perspective widgets be forbidden from fetching independently?** Recommendation: **forbid *new* independent fetching; tolerate the two existing self-fetchers.** The direction is host-lifted data passed as props (the dominant pattern). Re-plumbing goals/activity to lifted data is out of scope for this renderer work (it touches those widgets, not the renderer) and should not gate v1. State the rule for future widgets: a Perspective-composable widget takes its data via `SectionRenderProps`, it does not open its own fetch.

---

## 6. Fullscreen / collapse / chrome (Q6)

**v1: reuse the exact `SectionCard` chrome — same collapse, same fullscreen, same card container.** This is free (it's the same component) and it makes a widget look and behave identically whether it sits on a tab or in a workspace, which is the entire "feel inevitable" goal. Collapse (ephemeral local state) and fullscreen (payoff Expand, ephemeral local state) both work unchanged because they live inside `SectionCard`, not in the host.

Do **not** build a lighter/denser workspace chrome in v1 — that would be a second presentation system, exactly what the constraints forbid. A denser visual treatment for workspaces (e.g. removing per-card collapse when a workspace is already a focused view) is a legitimate *later* visual pass, decided once real workspaces exist. v1 answer: identical chrome.

---

## 7. Overview relationship (Q7)

Recommended information architecture, reusing the rail slot Perspectives already own (tab #2):

- **PERSPECTIVES tab becomes the destination:** a selector at the top (the existing grid, or a compact selector) + the **inline `PerspectiveWorkspace` beneath it** for the selected Perspective. This **replaces the current grid on that tab** — the grid stops being terminal content and becomes navigation into a workspace. Selecting a Perspective expands its workspace under the selector, in place.
- **Overview keeps a compact summary strip:** the existing `variant="row"` Perspectives strip with lens headlines/tone stays as a *glanceable* teaser. Each item deep-links to the PERSPECTIVES tab with that Perspective selected. Overview does **not** host a full inline workspace — that keeps Overview calm and avoids duplicating the destination.
- **Not a new top-level page.** Perspectives is already a rail tab; adding a separate page would fork navigation. The workspace lives on the tab that already exists.

So, answering the sub-questions directly: Perspectives remain an Overview *summary* section (not a full workspace there); selecting a Perspective expands an inline workspace under the selector **on the Perspectives tab**; it does not become a separate page; and the workspace replaces the card grid **on the Perspectives tab** while the Overview strip persists as a summary.

---

## 8. Legacy routing deletion — migration map (do not delete now) (Q8)

Everything below is *mapped*, not touched.

| Legacy construct | Location | Retire when |
|---|---|---|
| `PERSPECTIVE_TARGET_TAB` | line 187 | its last routed Perspective has `widgets[]` and renders via workspace |
| `PERSPECTIVE_ROUTED_TABS` | line 197 | same — remove entries per migrated Perspective |
| `PERSPECTIVE_MODAL_META` | line 201 | same |
| GlassModal routing block | lines 2609–2646 | after the last routed tab is migrated |
| Inert composition switcher (`PerspectiveSwitcher`, `getCompositionSwitcherItems`, `composition`/`activeComposition` state, `SpaceComingSoonPanel` block) | lines 2656–2669, `lib/perspectives.ts` | after the workspace ships (it superseded this) |

Migration path: (1) ship `PerspectiveWorkspace` for one config-light Perspective (Wealth); (2) migrate the routed financial Perspectives **one at a time** — Debt → Investments → Goals → Retirement — giving each a `widgets[]` and rendering the workspace instead of the modal, **deleting its `PERSPECTIVE_TARGET_TAB`/`ROUTED_TABS`/`MODAL_META` entry in the same change**; (3) delete the GlassModal block when nothing routes through it; (4) delete the inert composition switcher (it was a placeholder for precisely this). Each step is independently shippable and reversible, and each *removes* code rather than adding a parallel path.

---

## 9. Customization compatibility (Q9)

The virtual-section model supports all four later customizations **natively, with no schema and nothing implemented now**, because each is a transform over the `widgets[]` array / Perspective id list:

- **Perspective order:** reorder the per-category id list from `PERSPECTIVES_BY_CATEGORY` via a per-user overlay.
- **Default Perspective:** a single stored id the tab opens to.
- **Widget order within a Perspective:** reorder `widgets[]` → drives the synthetic `order` → drives layout.
- **Hide/show widgets in a Perspective:** filter `widgets[]` (or flip the synthetic `enabled`) via a per-user overlay.

The reason this works is exactly *why virtual beats materialized* (§3): defaults are data (registry arrays), and per-user customization becomes a thin overlay over those arrays — never a write to a shared row. The synthetic `id`/`order`/`enabled` fields are the forward hooks. None of this is built in v1; the renderer simply doesn't foreclose it.

---

## 10. Recommendation

**Recommended renderer architecture.** A Perspective renders by mapping `PerspectiveDef.widgets[]` → virtual `DashboardSection[]` (`config:null`, `enabled:true`, `order:index`, `id:"virtual:<pid>:<key>"`, `label` from `WIDGET_REGISTRY`) → the **existing, extracted `SectionCard`**, fed the host's already-fetched `accounts`/`ctx`/`spaceId`/`canManage`/`onAddGoal`. No `SectionRegistry`-direct call, no materialized rows, no new widget system, no second compositor.

**Component boundaries.** New: `PerspectiveWorkspace` (`components/dashboard/perspectives/`) + a pure `toVirtualSections()` helper. Extracted (pure move): `SectionCard`, `SectionRegistry`, `SectionRenderProps`, adapter helpers, `DashboardSection` → `components/dashboard/sections/`. Unchanged: `WIDGET_REGISTRY`, `ContextualCard`, the host's data fetching, `lib/perspectives.ts` (plus the `widgets[]` field from UX-PER-2).

**Data flow.** Host lifts `accounts`/`ctx`/lens results once and passes them down, identical to the tab path. New Perspective widgets take props; they do not self-fetch. The two existing self-fetchers (goals/activity) are tolerated as-is.

**Virtual vs materialized.** **Virtual.** Materialized couples Perspectives to template birth, shares one row across Perspectives, and turns customization into shared-row writes. Virtual keeps Perspectives a live registry view and customization a per-user overlay. Config-bearing widgets are deferred out of v1 rather than solved by materialization.

**Migration path.** Ship workspace for Wealth → migrate routed Perspectives one at a time (deleting routing-map entries per migration) → delete the GlassModal block → delete the inert switcher. Removal, not accretion.

**Risks & mitigations.**
- *SectionCard extraction from a 2,800-line file* → parity snapshot test, pure move, no logic change.
- *Config-light-only limitation* → gate config-required widget keys out of v1 `widgets[]`; defer a config-hydration slice.
- *Synthetic ids reaching a mutation path* → no toggle/settings affordance in the workspace; guard `virtual:` ids from mutations.
- *Self-fetch double-fetch* → benign in v1; direction is lifted data.
- *Dual entry points mid-migration* → migrate + delete the modal entry in one change.
- *`tab` meaningless on virtual rows* → sentinel value; workspace never dispatches on `tab`.

**Validation plan.**
- Parity: virtual section for key X renders byte-identically to the materialized `SectionCard` for key X (same props) — snapshot.
- Guard (from UX-PER-2): every `widgets[]` key ∈ `WIDGET_REGISTRY`.
- "No second renderer": `PerspectiveWorkspace` imports `SectionCard`/`SectionRegistry` and defines no widget render map of its own.
- Synthetic-id safety: workspace issues no section `PATCH`; `virtual:` ids absent from mutation code paths.
- Config gate: v1 `widgets[]` contain no config-required keys (or their defaults render safely).
- Migration parity: a migrated Perspective's inline workspace shows the same sections its modal did, before the modal entry is deleted.

**Smallest implementation sequence.**
1. **Extract** `SectionCard` + `SectionRegistry` + `SectionRenderProps` + helpers + `DashboardSection` into `components/dashboard/sections/` (pure move; prove parity).
2. **Add** `PerspectiveDef.widgets: string[]` (UX-PER-2) + widget-key parity guard; populate **Wealth** with config-light keys (e.g. `net_worth`, `investment_summary`).
3. **Build** `PerspectiveWorkspace` + `toVirtualSections()`; render Wealth's virtual sections through `SectionCard`.
4. **Mount** selector + `PerspectiveWorkspace` on the PERSPECTIVES tab (replace the grid); keep the Overview summary strip.
5. **Migrate** Debt → Investments → Goals → Retirement into `widgets[]`, deleting each routing-map entry as it lands.
6. **Delete** the GlassModal routing block and the inert composition switcher once unreferenced.

---

## 11. Bottom line

The renderer already exists — it is `SectionCard`, and the modal-routed Perspectives already drive it with section arrays. The whole of UX-PER-3 is: synthesize the section array from `widgets[]` instead of from `section.tab`, feed it the same `SectionCard`, and mount it inline instead of in a modal. One new component, one pure mapping function, one enabling extraction — and a standing invitation to delete the legacy routing a Perspective at a time. That is the smallest architecture that makes the Perspective workspace feel inevitable rather than parallel.
