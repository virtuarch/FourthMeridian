# UX-PER-2 — Perspective Workspace Architecture

**Status:** Investigation only. No implementation, no code, no schema, no migrations, no STATUS.md change.
**Date:** 2026-07-08
**Scope constraint (honored):** Financial Intelligence, Spaces, Widgets, and Templates are *not* redesigned here. This report determines whether Perspectives should evolve from a card grid into a focused workspace built on the existing reusable architecture, and how.
**Prior art (not re-litigated):** `docs/investigations/PERSPECTIVES_INVESTIGATION.md` (2026-07-03, the *identity* question) and `docs/investigations/PERSPECTIVE_ENGINE_FOUNDATION_INVESTIGATION.md` (the deterministic engine). This report is the *workspace architecture* layer on top of both.

---

## 0. Executive answer

Yes — Perspectives should become a workspace, and the architecture to do it **already exists in skeleton**. The codebase does not need a new system; it needs to finish and unify the three registries it already has and add one missing piece: a **workspace renderer that composes existing widgets for a selected Perspective through the existing section compositor**.

The single most important finding: there is **no need for a new renderer, a new widget system, or per-Perspective business logic.** The proposed "Perspective Definition → Widgets → Workspace renderer" chain maps almost one-to-one onto what is already built:

| Brief's proposed concept | Already exists as | Location |
|---|---|---|
| Perspective registry | `PERSPECTIVE_LIBRARY: Record<string, PerspectiveDef>` | `lib/perspectives.ts` |
| Perspective → category binding | `PERSPECTIVES_BY_CATEGORY` (config-over-branching) | `lib/perspectives.ts` |
| Widgets | `WIDGET_REGISTRY` + `SectionRegistry` compositor | `lib/widget-registry.ts`, `SpaceDashboard.tsx` |
| Deterministic answers (health/verdict) | Perspective Engine lens registry | `lib/perspective-engine/*` |
| Facts to consume | Transaction/Merchant Intelligence, KD-19 data layer | `lib/transactions/*`, `lib/data/accounts.ts` |
| Template → Space blueprint | `SpaceTemplate` registry | `lib/space-templates/*` |

What is missing is the **workspace renderer** and a **`widgets: string[]` field on `PerspectiveDef`** that lets a Perspective *own a composition of existing widget keys*. Everything else is wiring and deletion of legacy routing special-cases.

The recommendation is therefore not "build a workspace" but **"collapse the two competing navigation metaphors into one workspace model, reusing the section compositor you already have."**

---

## 1. Current state (evidence)

### 1.1 Perspectives today are a navigation pattern, not a workspace

`lib/perspectives.ts` already defines a typed registry:

```
PerspectiveDef { id, label, description, icon, status: "available"|"comingSoon", group, lensId? }
```

with `PERSPECTIVE_LIBRARY` (10 entries incl. `overview`/"Atlas") and `PERSPECTIVES_BY_CATEGORY` mapping every `SpaceCategory` to an ordered id list. This is already registry-driven, already config-over-branching — adding a category is a one-line change, not a new code path.

But the *presentation* is fractured across three incompatible behaviors, which the file's own comments document as deliberate "traffic control":

1. **Card launchers** — `investments`, `debt`, `retirement`, `goals` are `status:"available"` and route to a pre-existing legacy tab via `PERSPECTIVE_TARGET_TAB`, rendered as a `GlassModal` (`PERSPECTIVE_ROUTED_TABS`, `PERSPECTIVE_MODAL_META` in `SpaceDashboard.tsx`).
2. **Coming-soon placeholders** — `wealth`, `cashFlow`, `tax`, `property`, `businessHealth` render a static card with a "Soon" chip and no destination.
3. **Lens-backed cards** — `debt`, `liquidity` carry a `lensId` and render a computed headline/verdict from the Perspective Engine via `/api/spaces/[id]/perspectives`.

`PerspectiveSwitcher` adds a *fourth* half-built idea — a composition dropdown atop Overview — that is wired but inert (`COMPOSITION_SWITCHING_ENABLED` is false). The prior investigation named this precisely: *"Perspectives today are a navigation pattern wearing a concept's name."*

There is no per-Perspective *workspace of widgets*. Selecting a Perspective either swaps a whole legacy tab into a modal or shows a one-line headline. That is the gap UX-PER-2 identifies.

### 1.2 The Perspective Engine is a clean, deterministic fact-consumer

`lib/perspective-engine/` is a mature registry of pure lens functions: `registerLens` / `getLens` / `listRegisteredLenses` mirror the AI assembler registry. `LensResult` is a fully-shaped, serializable, name-free contract (`verdict`, `headline`, `metrics`, `assumptions`, `provenance`, `empty`, `error`, plus a `LensTone` of `neutral|positive|warning|danger`). Lenses read *only* through the KD-19 visibility-enforced data layer (`lib/data/accounts.ts#getAccountsWithVisibility`) and are guard-tested to never import Prisma, AI, or encryption directly. Two lenses are registered (`liquidity`, `debt`); `LensId` is a deliberately closed union that grows one approved lens at a time.

This is the correct posture for Q4 and it is already enforced by tests: **Perspectives compute nothing about facts — they do bounded arithmetic over already-redacted reads.**

### 1.3 Widgets already have a registry and a single compositor

`lib/widget-registry.ts` is the source of truth for every section key (`WidgetMeta`: key, label, description, tab, icon, `dataTier`, `requires: DataRequirement[]`, `configSchema`, `collapsible`, `fullscreenable`). `SpaceDashboard.tsx`'s `SectionRegistry` maps `key → render fn` and is the **runtime compositor** for materialized sections. The file's own "Widget Primitive Rule" already forbids widget sprawl: prefer an adapter over a new primitive. Adding a widget is one registry entry, no `switch`.

### 1.4 Templates already own "what a Space is born with"

`lib/space-templates/` defines `SpaceTemplate { id, name, icon, category, sections: SectionPreset[], version, status, featured }`. A template is pure data consumed **once** at Space creation to materialize `SpaceDashboardSection` rows. Crucially the code already states the decoupling doctrine: *"a template implies a category; a category does NOT equal a template."* Every Space — Personal included — renders through the one `SpaceDashboard` shell (per STATUS: *Space → Template → Materialized Sections → Widgets*, Hero as the only sanctioned divergence).

**Net:** four registries already exist (perspectives library, perspective-engine lenses, widget registry, template registry) and one compositor. The workspace idea is an integration, not an invention.

---

## 2. Question-by-question findings

### Q1 — Should Perspectives become a workspace rather than a collection of cards?

**Yes.** The card grid was right for an evolving product and is wrong now for three reasons the brief already senses: six equal-weight cards read as six unrelated dashboards; "available" cards are just second front doors to existing tabs (redundant navigation); and the concept has no *destination* — nowhere that a Perspective's full intelligence lives.

*Advantages of the workspace model:* one focused canvas per question; the selector makes the six-way competition a deliberate choice instead of visual noise; each Perspective becomes a real place that can accrue widgets and intelligence over time; and it lets the codebase **delete** the dual-metaphor routing (§1.1) rather than maintain it.

*Disadvantages / costs:* an extra click to reach content that is one glance away today (mitigated by keeping a compact Overview summary strip); a migration risk moving Debt/Investments/etc. out of modal-routed legacy tabs into widget workspaces (this is the real work); and the perennial danger — flagged in the prior investigation — of drifting toward a configurable-dashboard-builder graveyard. The mitigation for the last is decisive: **ship opinionated defaults, defer customization** (Q8).

The workspace is the right destination-shaped answer. The card grid should survive only as a *selector*, not as the content.

### Q2 — Should this be built around a Perspective registry? Does it fit Space → Template → Sections → Widgets?

**It is already a registry, and it fits almost exactly.** The proposed chain

```
Perspective Definition → Widgets → Workspace renderer
```

is the *same shape* as the settled

```
Space → Template → Materialized Sections → Widgets
```

with one deliberate difference in lifecycle. A **Template** materializes persisted `SpaceDashboardSection` rows at Space birth. A **Perspective** should be a **live, registry-defined view over widgets that is not persisted per-Space** — it is computed at render time from the registry, not written to the database. This is the cleanest possible fit: a Perspective is "a named, ordered subset of widget keys, optionally headlined by a lens," and the workspace renderer is **the existing `SectionRegistry` compositor fed a different list of keys.**

Do **not** build a second renderer. The single most valuable architectural constraint in this whole initiative is: *the Perspective workspace renders through the same compositor that renders materialized sections.* One compositor, two callers (materialized-section tab rendering, and Perspective workspace rendering).

### Q3 — Should Perspectives be first-class product objects?

**Yes, and they nearly are.** `PerspectiveDef` already carries `title`(label), `icon`, `summary`(description), and — via the linked lens — a **health state** (the lens `verdict` + `LensTone`). Promote the object by adding three fields, all still pure config:

- `widgets: string[]` — ordered widget-registry keys this Perspective composes (the missing ownership link).
- `emptyState` — already conventionally available via the lens `empty` shape and space-presets copy; make it explicit on the def for Perspectives with no lens.
- `healthLensId?` — optional; the lens whose tone drives the selector tile's health dot. (Often the same as `lensId`.)

"Future intelligence modules" needs **no new field** — it is just "later this Perspective's `widgets` array gains keys, and/or its `healthLensId` starts resolving." This is strictly cleaner than today's card approach because it removes the three-way behavioral split (§1.1): a first-class Perspective has exactly one behavior — *render my widget set, headline me with my lens* — instead of "sometimes I'm a modal launcher, sometimes a placeholder, sometimes a headline."

### Q4 — Relationship with Financial Intelligence

**Perspectives must be consumers, never owners of facts — and the engine already enforces this.** The Perspective Engine is guard-tested to read only through `lib/data/accounts.ts` and to never import Prisma/AI/encryption. Facts live upstream in Transaction Intelligence (`lib/transactions/transaction-facts.ts`, flow classifier), Merchant Intelligence (`lib/transactions/merchant-*`), Coverage, Financial Health, Cash, and Investment modules. A lens does bounded arithmetic (sums, ratios, payoff estimates) over already-redacted reads; it holds no financial truth of its own.

Recommendation: keep this contract as the **hard boundary of the whole workspace initiative.** Any new Perspective that needs a number the FI layer doesn't yet expose is a signal to add a *fact/module upstream*, not to compute in a lens. Extend the existing engine import-guard test to also forbid a lens computing facts inline (e.g. re-deriving categorization). Perspectives *narrate* intelligence; they do not manufacture it.

### Q5 — Relationship with Spaces (Personal-only vs. reusable capability)

**It should be a reusable Space capability, and structurally it already is.** `PERSPECTIVES_BY_CATEGORY` already keys off `SpaceCategory` and already lists sets for `BUSINESS`, `FAMILY`, `HOUSEHOLD`, `INVESTMENT`, `RETIREMENT`, etc. The engine scope is `{ spaceId, userId }` — Space-generic, never Personal-special. Every Space renders through the one `SpaceDashboard` shell. So "could Business/Family/Merchant Operations have Perspective workspaces?" is answered by the data model today: **yes, by registering a category's id list.** Different templates simply register different Perspective categories — no renderer change. Merchant Operations (`merchant-ops`) is a distinct surface and could register its own Perspective category (Merge Queue, Suggestions, Coverage, Quality) the same way, provided those widgets exist in the widget registry. **Do not make Perspectives Personal-only;** that would fork the one-shell doctrine the Spaces unification just finished establishing.

### Q6 — Relationship with Templates (do Perspective categories belong in templates?)

**The binding belongs at the template/category seam, and the seam already exists — but keep the list in one place.** Today `PERSPECTIVES_BY_CATEGORY` (in `lib/perspectives.ts`) owns "which Perspectives a category gets," and `SpaceTemplate` owns "which sections a Space is born with." These are the two halves of the brief's example (Personal → Wealth/Cash Flow/…; Business → Revenue/Expenses/…).

Opinionated call: **do not duplicate the Perspective list into `SpaceTemplate.sections`.** Templates materialize *persisted* section rows at birth; Perspectives are a *live* view and should stay non-materialized. Instead, let the template *reference* a Perspective category (it already implies a `SpaceCategory`, and `PERSPECTIVES_BY_CATEGORY` already resolves from that). If a future template needs a Perspective set that diverges from its category default, add an optional `perspectiveCategory?: string` (or `perspectives?: string[]`) to `SpaceTemplate` that overrides the category default — **without changing the renderer.** This keeps one renderer, one Perspective registry, and templates as pure birth-time blueprints.

### Q7 — Should widgets become owned by Perspectives?

**Owned by *composition*, not by *duplication*.** A Perspective owns an ordered list of widget-registry *keys* (`widgets: string[]`); it does not own widget implementations. "Wealth → Net Worth + Allocation + Historical Growth + Asset Breakdown" is `["net_worth", "investment_allocation", ...]`, each key already in `WIDGET_REGISTRY`, each already renderable by `SectionRegistry`. This is the only model consistent with the existing "Widget Primitive Rule" (no widget sprawl) and the single widget registry.

This **simplifies customization and drag/drop directly**: reordering a Perspective is reordering a `string[]`; a user override is a per-user `string[]` layered over the registry default. The moment widget ownership is "a list of keys," both customization and drag/drop become list edits rather than new architecture. This is the payoff of not building a parallel widget system.

### Q8 — Customization (does the architecture enable it without being redesigned for it?)

**Yes — the list-of-keys model enables all three named customizations natively, and none should be built now.** Perspective order = user-reordered id list over `PERSPECTIVES_BY_CATEGORY`; default Perspective = a single stored id; widgets-within-a-Perspective = user-reordered `widgets` array over the registry default. Each is a thin per-user override layer over registry defaults, exactly the pattern materialized sections already use. The architecture *enables* customization precisely because the defaults are data, not code. Per the explicit constraint and the prior investigation's configurable-dashboard warning: **enable it, do not implement it.** Ship opinionated defaults; let the shape make customization cheap later.

### Q9 — Hardcoding: too hardcoded, or opinionated default on reusable architecture?

**The *registry* is already the opinionated-default-on-reusable-architecture you want; the remaining hardcoding is the routing traffic-control, and the workspace model deletes it.** There is no `if (wealth)…/if (debt)…` in the Perspective library — it is `Record<string, PerspectiveDef>` + a category map. The hardcoded branching that *does* exist is the dual-metaphor host wiring in `SpaceDashboard.tsx`: `PERSPECTIVE_TARGET_TAB`, `PERSPECTIVE_ROUTED_TABS`, `PERSPECTIVE_MODAL_META`, and the inert composition switcher. Those are special-cases *because* Perspectives don't yet have a uniform workspace behavior. Once every Perspective renders a widget set through the shared compositor, those tables **go away** — Investments/Debt/Goals/Retirement become ordinary widget-set Perspectives. The workspace model *reduces* hardcoding; it does not add it.

### Q10 — Scalability (Retirement, Taxes, Insurance, Real Estate, Business Ownership)

**Each new Perspective is additive registry work, and the workspace scales because it reuses one compositor.** Adding "Taxes" is: one `PerspectiveDef` entry, its `widgets: string[]` (existing keys where possible, new widget-registry entries where not), an optional new lens (which extends the closed `LensId` union — a *deliberate* one-at-a-time gate, not a bottleneck), and inclusion in the relevant category id lists. No renderer change. The selector grid scales through the existing `PERSPECTIVE_GROUPS` sub-nav (All / Financial / Tax / Goals / Retirement / Business / Property) so a Space with 15 Perspectives filters rather than sprawls. The one thing that does *not* auto-scale is quality: every new Perspective needs real widgets behind it or it regresses to today's "Soon" placeholder — which is a content problem, not an architecture one.

### Q11 — Recommendation

Consolidated below.

---

## 3. Recommendation

### 3.1 Recommended architecture

One sentence: **a Perspective is a first-class registry object that names an ordered set of existing widget keys and an optional headline lens, rendered by a workspace renderer that is the existing `SectionRegistry` compositor fed that key set.**

```
Space (category, via Template at birth)
  └─ Perspective set  ← PERSPECTIVES_BY_CATEGORY (registry, live, not persisted)
       └─ PerspectiveDef { id, label, icon, summary, group,
                           widgets: string[],          ← composition of widget-registry keys
                           healthLensId?, lensId?,      ← Perspective Engine (facts, verdict, tone)
                           emptyState }
            └─ Workspace renderer = existing SectionRegistry compositor(widgets)
                 └─ Widgets (WIDGET_REGISTRY) → data layer (KD-19) → Financial Intelligence
```

The selector replaces the six-card grid; the workspace beneath it is the destination. Overview keeps a *compact* Perspective summary strip (headline + tone per Perspective) so nothing is more than one glance + one click away.

### 3.2 Perspective registry proposal

Extend `PerspectiveDef` (config only, no schema, no new system):

- add `widgets: string[]` — the composition (ordered widget-registry keys).
- add `healthLensId?: LensId` — drives the selector tile's health dot from the lens `LensTone`.
- make `emptyState` explicit for lens-less Perspectives.
- keep `status`, but let it be *derived* rather than authored: a Perspective is "available" when it has ≥1 implemented widget or a registered lens; "comingSoon" otherwise. This kills the last hand-maintained boolean.

Add one guard test (mirroring the existing `lensId ↔ registered lens` guard): **every key in a Perspective's `widgets` must exist in `WIDGET_REGISTRY`.** This is the registry-parity discipline that keeps the four registries from drifting.

### 3.3 Widget ownership model

Composition, not duplication (Q7). Perspectives reference widget keys; widgets stay owned by `WIDGET_REGISTRY` and rendered by `SectionRegistry`. No new widget primitives unless the Widget Primitive Rule's test ("can this be an existing primitive + adapter?") fails. Customization and drag/drop become `string[]` edits.

### 3.4 Relationship to Financial Intelligence

Unchanged and enforced: Perspectives/lenses are consumers only, reading through the KD-19 data layer; facts live in TI/MI/Coverage/Health/Cash/Investment. Extend the engine import-guard so a lens cannot inline-compute a fact the FI layer owns. New Perspective needs a new number → add a fact upstream, not logic in a lens.

### 3.5 Relationship to Templates

Templates stay pure birth-time blueprints materializing persisted sections. Perspectives stay live and non-persisted. Bind them at the category seam (already present via `PERSPECTIVES_BY_CATEGORY`); add an optional `SpaceTemplate.perspectiveCategory?`/`perspectives?` override only if a template ever needs to diverge from its category default. No renderer change either way.

### 3.6 Relationship to Spaces

Perspectives are a reusable Space capability, not Personal-only — structurally already true. Business/Family/Merchant-Ops Perspective workspaces are "register a category's id list + ensure the widgets exist." One shell, one compositor, per the finished Spaces unification doctrine.

### 3.7 Implementation sequencing (proposed order — not implemented here)

1. **Prove the renderer.** Build the workspace renderer as a thin caller of the existing `SectionRegistry`, rendering a hardcoded key list for one Perspective (Wealth) from existing widgets (`net_worth`, `investment_allocation`). No registry changes yet — prove "same compositor, different key list."
2. **Add `widgets: string[]` to `PerspectiveDef`** + the widget-key parity guard test. Move Wealth's list into the registry.
3. **Convert the selector.** Make the Perspectives grid open a workspace beneath the selection instead of routing to a modal/tab.
4. **Migrate legacy-routed Perspectives one at a time** (Debt → Investments → Retirement → Goals): each becomes a widget-set Perspective; **delete its entry from `PERSPECTIVE_TARGET_TAB`/`PERSPECTIVE_ROUTED_TABS`/`PERSPECTIVE_MODAL_META` as it lands.** Retire the inert composition switcher.
5. **Attach health.** Wire `healthLensId` → selector tile tone using the existing `/api/spaces/[id]/perspectives` batch.
6. **Extend to other Spaces** as their widget sets exist (Business/Family). Defer customization entirely (Q8).

Each step is independently shippable and reversible; the legacy card behavior degrades gracefully until each Perspective is migrated.

### 3.8 Risks

- **Registry drift** across the four registries. *Mitigation:* parity guard tests (lens↔def already exists; add widget-key↔registry).
- **Migration regressions** moving Debt/Investments out of modal-routed legacy tabs. *Mitigation:* one Perspective at a time, delete routing tables only as each lands, visual-regression per workspace.
- **Configurable-dashboard graveyard** (prior investigation's warning). *Mitigation:* opinionated defaults, customization deferred, no builder UI.
- **Empty destinations.** A Perspective without real widgets regresses to a "Soon" page. *Mitigation:* derive `status` from real content; don't list a Perspective as available until it has ≥1 implemented widget or a registered lens.
- **Boundary erosion** — a lens quietly computing a fact. *Mitigation:* extend engine import/behavior guards.
- **Extra click** costing glanceability. *Mitigation:* keep a compact Overview summary strip.

### 3.9 Validation strategy

- **Architectural test:** the workspace renderer imports/uses `SectionRegistry` and does not reimplement widget rendering ("no second compositor").
- **Registry-parity guards:** every `PerspectiveDef.widgets[]` key ∈ `WIDGET_REGISTRY`; every `lensId`/`healthLensId` ∈ registered lenses (extends the existing `lib/perspectives.test.ts` guard family).
- **Determinism & name-freedom:** inherited from the existing engine test suite (byte-identical results, no account/institution names, fail-shaped).
- **Visibility/privacy:** inherited KD-19 posture; empty states must read identically whether accounts are absent or merely invisible.
- **Migration parity:** each migrated Perspective renders the same real data its legacy tab did (snapshot/behavioral test before deleting the routing entry).
- **Scalability probe:** add a throwaway "Taxes" Perspective in a test to confirm it requires only registry entries + widget keys, no renderer edits.

---

## 4. Bottom line

Perspectives should become a workspace, and the work is mostly **consolidation and deletion, not construction.** The registries, the deterministic engine, the widget compositor, the visibility-enforced data layer, and the per-category binding already exist. The initiative is: add `widgets: string[]` to the Perspective object, render it through the compositor you already have, migrate the four legacy-routed Perspectives into that model, and delete the dual-metaphor routing tables. That turns Perspectives from "six competing dashboard cards" into "a selector over focused, intelligence-backed destinations" — built entirely on the reusable architecture already in the tree, favoring long-term cleanliness over today's UI exactly as the brief asks.
