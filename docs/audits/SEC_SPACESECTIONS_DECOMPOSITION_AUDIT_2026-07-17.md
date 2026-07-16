# SEC — SpaceSections Decomposition Audit

**Date:** 2026-07-17
**Scope:** `components/space/sections/SpaceSections.tsx` (1,585 LOC)
**Mode:** Read-only investigation. No edits, no commits, no push.
**Predecessors:** SD-7 (section subsystem extracted from SpaceDashboard), MSM (ManageSpaceModal decomposed; confirmed GoalsCard is the canonical goal-list authority).

---

## Executive summary

SpaceSections is **not** a grab-bag monolith. It is a **largely cohesive compositor** — a section-key→renderer dispatch table plus the card chrome that mounts it — that carries **one large non-cohesive lodger** (`GoalsCard` + `TrashDrawer`, ~490 LOC) and a **cross-module formatting duplication** (`formatBalance`/`currencySymbol`). The codebase has *already* been moving section renderers out into per-domain adapter files (`debt-adapters`, `wealth-adapters`, `liquidity-adapters`, `cash-flow-adapters`, `debt-perspective-adapters`, `goals-perspective-adapters`); the registry today is mostly thin wiring pointing at those. The correct move is to finish that trajectory for the *one* renderer that is a full feature (Goals) and, optionally, to separate the dispatch table from the card chrome — **not** to shatter the registry or split SectionCard.

**One clean, high-value, safe slice exists (Goals). Everything else is optional and lower-value.** The registry should stay unified.

---

## 1. Responsibility census

| # | Responsibility | Lines (approx) | LOC | Consumers | Shared? | Cohesive with "section subsystem"? |
|---|---|---|---|---|---|---|
| A | **Formatting** — `formatBalance`, `currencySymbol` | 57–70 | 14 | `SpaceDashboard`, `AddGoalModal` (cross-module) | **Yes** | No — generic utilities |
| B | `ACCOUNT_TYPE_LABELS` | 72–79 | 8 | `AccountsCard` only | No | Local to a renderer |
| C | **AccountsCard** renderer | 84–124 | 41 | registry `business_accounts` | No | Yes (a renderer) |
| D | **TrashDrawer** (goals trash modal) | 128–194 | 67 | `GoalsCard` only | No | **No — Goals feature** |
| E | **GoalsCard** — list + lifecycle + trash + check-in + 4 goal-type bodies | 198–625 | 428 | registry `goals_progress` only | No | **No — a full feature capability** |
| F | **ActivityCard** (TimelineWidget wrapper) | 627–629 | 3 | registry `recent_activity` | No | Yes (a renderer) |
| G | **ContextualCard** (empty-state fallback; reads `getWidgetMeta`) | 637–675 | 39 | `SectionCard.renderBody` fallback | No | Yes (compositor fallback) |
| H | **`SectionRenderProps` type** (the renderer contract) | 701–765 | 65 | registry + `SectionCard` | Internal | Yes — the core contract |
| I | **Adapter helpers** — `cfgNum`, `cfgStr`, `toDisplay`, `sumAccounts`, `projectFV` | 767–837 | 71 | local renderers below | No | Yes (renderer support) |
| J | **Local renderers** — `renderNetWorth`, `renderDebtSummary`, `renderInvestmentSummary`, `NetWorthChartSection`, `AllocationSection` | 842–1009 | 168 | registry entries | No | Yes (renderers) |
| K | **SectionRegistry** — the 48-key dispatch map (incl. inline AssetValue/ProgressWidget closures) | 1011–1302 | 292 | `SpaceDashboard.hasRenderer`, `SectionCard.renderBody` | **Yes (export)** | Yes — the compositor's heart |
| L | `SOLID_LEDE_KEYS` | 1312–1320 | 9 | `SectionCard` | No | Yes (chrome policy) |
| M | **SectionCard** — chrome (3 card variants) + collapse + payoff summary + legacy debt overrides + `renderBody` dispatch | 1322–1531 | 210 | `SpaceSectionStack`, `RoutedWorkspaceModal`, `SpaceDashboard` | **Yes (export)** | Yes — the card frame |
| N | **SortableSectionCard** — DnD grip wrapper | 1552–1584 | 33 | `SpaceSectionStack` | **Yes (export)** | Yes — reorder wrapper |

**Where unrelated responsibilities coexist:**
- **Goals feature (D+E, ~495 LOC) inside the compositor.** `GoalsCard`/`TrashDrawer` fetch their own data, own goal lifecycle mutations (complete/archive/unarchive/trash/restore/permanent-delete/check-in), and render four goal-type bodies. This is a *product feature*, not section-dispatch machinery. It is embedded only because it happens to back one registry key (`goals_progress`).
- **Formatting (A, 14 LOC)** is a generic utility that two *other* modules import from here, making the section subsystem an accidental utility host.

Everything else (C, F, G, H, I, J, K, L, M, N) is genuinely the section compositor and belongs together.

---

## 2. Dependency graph

**Public API — exactly 5 exports** (nothing is export-only-but-internal):

| Export | External consumers | Role |
|---|---|---|
| `formatBalance` | `SpaceDashboard.tsx:974`, `AddGoalModal.tsx:347` | utility |
| `currencySymbol` | `AddGoalModal.tsx:360` | utility |
| `SectionRegistry` | `SpaceDashboard.tsx:863` (`key in SectionRegistry` membership only) | dispatch table |
| `SectionCard` | `SpaceSectionStack.tsx`, `RoutedWorkspaceModal.tsx:60`, `SpaceDashboard.tsx` (Perspective stack) | card renderer |
| `SortableSectionCard` | `SpaceSectionStack.tsx:96` | DnD wrapper |

```
SpaceDashboard.tsx ──┬─ SectionCard (Perspective single-column stack)
                     ├─ SectionRegistry  (hasRenderer: `key in SectionRegistry`)
                     ├─ formatBalance
                     └─ toVirtualSections (lib/perspectives/virtual-sections.ts) ─┐
                                                                                  │ feeds
SpaceSectionStack.tsx ─ SectionCard + SortableSectionCard   ← the composition seam │  DashboardSection-
   ↑ mounted by AccountsWorkspace / ActivityWorkspace / OverviewWorkspace          │  shaped rows into
RoutedWorkspaceModal.tsx ─ SectionCard  (+ NoSectionsCard from SpaceSectionStack) ←┘  SectionCard

AddGoalModal.tsx ─ formatBalance + currencySymbol   (awkward: a goal modal importing from the section subsystem)

SectionCard.renderBody:  SectionRegistry[section.key] → renderer(props)  |  miss → ContextualCard → getWidgetMeta()
```

**Public API vs implementation detail:** the 5 exports above are public API. `GoalsCard`, `TrashDrawer`, `ContextualCard`, `AccountsCard`, `ActivityCard`, all `render*` locals, `SectionRenderProps`, `SOLID_LEDE_KEYS`, the adapter helpers — **all internal**. `NoSectionsCard` is **not** in this file (it lives in `SpaceSectionStack.tsx:31`).

**Key structural fact:** the three standard workspaces (Accounts/Activity/Overview) reach SpaceSections **indirectly** through `SpaceSectionStack`. Only `SpaceDashboard`, `SpaceSectionStack`, `RoutedWorkspaceModal`, and `AddGoalModal` import it directly. That is a small, well-defined blast radius (4 files) for any move.

---

## 3. Natural architectural seams

Ranked by cohesion-break (highest = cleanest to cut):

1. **Goals capability (D+E)** — SEAM. Self-contained, single consumer (`goals_progress`), owns its own data/state/mutations. Cuts cleanly: registry entry becomes a one-line import. **This is the real seam.**
2. **Formatting (A)** — SEAM (utility). Generic, cross-module, duplicated (see §6). Cuts cleanly but low value.
3. **SectionCard chrome (M+N+L) ↔ dispatch table + renderers (H+I+J+K)** — a legitimate ownership boundary (card frame vs renderer catalog), coupled only through the shared `SectionRenderProps` type. Medium value; more churn.
4. **Local renderers + helpers (C,F,G,I,J) → a per-domain adapter file** — consistency-only seam (matches the established `*-adapters.tsx` pattern). Lowest value; these are cohesive with the registry and share helpers, so moving them mostly relocates code.

**Clusters that MUST stay together:**
- `SectionCard` + `renderBody` + `SectionRegistry` are joined by the dispatch contract; the registry lookup *is* `SectionCard`'s body. Even if placed in two files, they remain one conceptual unit.
- The adapter helpers (`toDisplay`/`sumAccounts`/`cfgNum`/`cfgStr`/`projectFV`) are shared by the local renderers *and* the inline registry closures — do not scatter them.
- `SortableSectionCard` + `SpaceSectionStack` already jointly own DnD; don't separate the grip from the context.

---

## 4. Registry architecture — evaluation

**Verdict: keep it UNIFIED (single registry) + capability adapter modules. Do NOT split into multiple registries.**

The registry today is **48 entries**, and it is *already* "registry + capability modules": ~30 of the 48 keys delegate to external adapter files (`wealth-adapters`, `liquidity-adapters`, `cash-flow-adapters`, `debt-adapters`, `debt-perspective-adapters`, `goals-perspective-adapters`, `AccountsPerspective`, `AssetValueWidget`, `ProgressWidget`). Only a residual set is defined locally.

Judged against the criteria:
- **Clarity** — one lookup table, one dispatch path (`SectionCard → SectionRegistry[key]`). A reader finds *every* section key in one place. Splitting into per-domain sub-registries would scatter the answer to "what keys exist?" across N files.
- **Extensibility** — adding a section = one line in one map (the header comment's stated contract). Multiple registries would require a compose/merge step and a decision about *which* registry — added change-amplification for zero behavioral gain.
- **Ownership** — the *renderers* already have per-domain owners (the adapter files). The map is pure wiring; wiring belongs in one place.
- **Change amplification** — a unified map has the lowest amplification for the common change (add/rewire a key). Sub-registries raise it.

**Relationship to `WIDGET_REGISTRY` (lib/widget-registry.ts):** these are two *distinct* registries sharing a key namespace, correctly separated:
- `SectionRegistry` = runtime render dispatch (48 keys).
- `WIDGET_REGISTRY` = metadata catalog (~90 keys); only `getWidgetMeta().label` and `.requires[0].reason` are read by shipping code (ContextualCard fallback + virtual-section labels). **They should stay separate** — the "Phase 2/3" aspiration in the header comment (auto-build the render map from metadata) is not implemented and is out of scope here.

---

## 5. Virtual-section architecture — evaluation

**Verdict: already correct — leave as-is.**

Virtual sections (`lib/perspectives/virtual-sections.ts`, 62 LOC) are a **pure mapping** from a Perspective's `widgets[]` to render-only, non-persisted `DashboardSection`-shaped rows (`id` prefixed `virtual:`, sentinel `tab`, `config:null`). They are fed into the **same** `SectionCard`/`SectionRegistry` compositor — deliberately no second renderer, no second layout model. Only `SpaceDashboard` consumes `toVirtualSections`.

This is the *right* placement: virtual-section synthesis lives **outside** the registry (in `lib/perspectives`), and flows **into** the compositor. It correctly does not know about SectionCard internals; it only produces the shape SectionCard consumes and borrows `getWidgetMeta` for labels. **No change recommended.** ("Coming soon" is not a virtual-section concern — it's `ContextualCard`, the registry-miss fallback; also correctly placed.)

---

## 6. Formatting — evaluation

`formatBalance` and `currencySymbol` live at the top of SpaceSections and are imported cross-module by `AddGoalModal` (a workspace overlay) and `SpaceDashboard`.

**Finding — a real 3-way duplication:** `formatBalance` is defined **three** times with drifting defaults:
- `components/space/sections/SpaceSections.tsx:57` — `currency = DEFAULT_DISPLAY_CURRENCY`
- `components/space/manage/manage-shared.ts:64` — `currency = DEFAULT_DISPLAY_CURRENCY` (from MSM)
- `components/space/widgets/accounts/AccountsPerspective.tsx:47` — `currency = "USD"` (**divergent default**)

**Verdict:** This is the one place where Part 6's "don't move just because it's a helper" is *outweighed* by a concrete signal — three copies, one divergent, plus an awkward `AddGoalModal → SpaceSections` dependency purely for a formatter. **Recommend (optional slice SEC-3):** consolidate `formatBalance`/`currencySymbol` into one shared home (`lib/currency` is the natural owner alongside `DEFAULT_DISPLAY_CURRENCY`), repoint all consumers, and delete the duplicates. This is low-risk (pure functions) and removes both the duplication and the cross-module coupling. It is **not** required for the Goals extraction and can land independently. Do **not** move these into a new sections-local module (that just relocates the coupling).

---

## 7. Renderer ownership

| Renderer | Consumers | Extension future | Verdict |
|---|---|---|---|
| `renderNetWorth`, `renderDebtSummary`, `renderInvestmentSummary` | registry (net_worth, debt_summary+3 aliases, investment_summary+2 aliases) | shared across aliases | **Private to compositor.** Cohesive with the map + helpers. May co-locate with the registry if §3.3 split happens; otherwise stay. |
| `NetWorthChartSection`, `AllocationSection` | registry (net_worth_chart, allocation) | Overview lede | **Private.** Overview-specific chart wrappers; keep with the registry. |
| `AccountsCard` | registry (business_accounts) | none | **Private.** Trivial renderer; keep. |
| `ActivityCard` | registry (recent_activity) | none | **Private.** 3-line TimelineWidget wrapper; keep. |
| `ContextualCard` | `SectionCard` fallback | none | **Private — compositor fallback.** Must stay adjacent to the dispatch. |
| Inline AssetValue/ProgressWidget closures (property/vehicle/equipment/trip/emergency/retirement) | registry | config-driven | **Private.** Thin adapters over shared widgets; keep with the map. |
| `GoalsCard` | registry (goals_progress) | **Yes — it IS a capability** | **Extract (SEC-1).** Not a private renderer; a full feature. |
| debt/wealth/liquidity/cash-flow/goals-perspective adapters | registry | per-domain | **Already external — correct.** Precedent for the pattern. |

**Could any local renderer become its own capability?** Only `GoalsCard`. The rest are small, private, single-consumer render helpers with no reuse or platform-sharing pressure. Extracting them buys consistency, not capability; treat as optional (SEC-4) and low priority.

---

## 8. Goals capability — evaluation

**Verdict: YES — Goals rendering should become its own capability home, WITHOUT creating duplicate authority.**

Current Goals landscape (post-MSM):
- **`GoalsCard`** (inside SpaceSections) — the Overview goal card: fetches its own goals, owns lifecycle (complete/archive/unarchive/trash/restore/permanent-delete) + habit check-in + `TrashDrawer` + four goal-type bodies. Backs `goals_progress`. **The canonical goal-list authority** (confirmed by MSM).
- **`AddGoalModal`** (`components/space/workspaces/`) — canonical goal *creation* (four goal types).
- **Goals Perspective adapters** (`components/space/widgets/goals-perspective-adapters.tsx`) — four stateless render fns (`goal_progress`/`goal_on_track`/`goal_required_pace`/`goal_funding_gap`), fed `goals` via props. **Already external.**

So the Goals *Perspective* renderers are already extracted; only the heavy `GoalsCard` + `TrashDrawer` remain embedded in the compositor. **Recommendation:** move `GoalsCard` + `TrashDrawer` to a dedicated home — `components/space/sections/goals/GoalsCard.tsx` — and have the registry entry import it (`"goals_progress": (p) => <GoalsCard .../>`). This:
- relocates the *single* authority (no duplication introduced — MSM already deleted the old divergent copy);
- co-locates the goal *list/lifecycle* renderer next to a clean seam, consistent with the already-external goal-perspective adapters and `AddGoalModal`;
- shrinks the compositor by ~490 LOC of feature code that never belonged to section dispatch.

Placement choice: `sections/goals/` (keeps it a *section renderer* while giving it its own module) is preferred over `workspaces/` (it is not a workspace) and over a top-level `components/goals/` (it is Space-scoped and section-mounted). `AddGoalModal` may later move alongside it, but that is optional and out of SEC's blast radius.

---

## 9. SectionCard architecture — evaluation

**Verdict: do NOT split SectionCard. Keep `SectionCard` + `SortableSectionCard` together.**

- **DnD ownership** is *already* separated: `SortableSectionCard` (the grip + sortable node) + `SpaceSectionStack` (the `DndContext`/`SortableContext`) own reorder. `SectionCard` itself is DnD-agnostic.
- **Editing ownership** (Edit-Layout toggle, sensors, `onDragEnd`) is host-owned and threaded through `SpaceSectionStack` — not in `SectionCard`.
- **Wrapper vs render ownership** inside `SectionCard`: the chrome (3 card variants, collapse, payoff summary, legacy debt-key overrides) and `renderBody` (the registry dispatch) are coupled through **local render state** — `SectionCard` owns `payoffFullscreen`/`collapsed` and passes `closePayoffFullscreen` *into* the render props. Splitting "wrapper" from "renderBody" would prop-drill that state across a new boundary for no gain.

The only defensible cut around SectionCard is the **card ↔ registry** split (§3.3 / SEC-2): `SectionCard.tsx` (chrome + dispatch call) importing `SectionRegistry.tsx` (the map + renderers + `SectionRenderProps`). That separates *how a card looks/collapses* from *what renders inside it* — a real ownership boundary with low coupling (one shared type, one-way import). Recommended as a medium-value slice, **after** Goals.

---

## 10. Dead-code census (classify only — do NOT delete)

| Item | Location | Classification | Rationale |
|---|---|---|---|
| `"net_worth_section"` deprecated alias → `renderNetWorth` | SpaceSections:1052 | **DANGEROUS** | Explicitly "seeded pre-v2". Old DB `SpaceDashboardSection` rows may still carry this key; removing the renderer would regress those Spaces to `ContextualCard`. Keep until a data migration proves zero live rows. |
| `"debt_payoff_snapshot"` in `SOLID_LEDE_KEYS` with **no** `SectionRegistry` entry | SpaceSections:1317 | **INVESTIGATE** | No renderer and no other repo reference found. Harmless (a section with this key would fall to `ContextualCard`, merely with solid chrome), but likely a vestigial key. Confirm no template/DB seeds it, then it can be dropped from the Set in a later cleanup. |
| Duplicate mappings: `debt_payoff_tracker`/`mortgage_tracker`/`auto_loan_tracker` → `renderDebtSummary`; `investment_allocation`/`retirement_accounts` → `renderInvestmentSummary` | SpaceSections:1056–1071 | **SAFE (not dead)** | Intentional shared renderers with TODO upgrades. Keep. |
| `WidgetMeta` fields ~90% unread (`implemented`,`isStub`,`tab`,`icon`,`description`,`configSchema`,`collapsible`,`fullscreenable`,`deprecatedAlias`) | `lib/widget-registry.ts` | **INVESTIGATE — out of SEC scope** | Only `.label` + `.requires[0].reason` read live; the rest kept honest by tests. A `widget-registry` slimming is a separate initiative, not SpaceSections decomposition. |
| `renderWealthByAccount` "intentionally left untouched" (registry uses `renderWealthAccountCards` instead) | comment SpaceSections:1018–1019; symbol in `wealth-adapters` | **INVESTIGATE — out of SEC scope** | Possibly an unused export in `wealth-adapters`; verify importers before touching. Not in this file. |
| Stale comment "debt_payoff_calculator is already registered above" | SpaceSections:1046 | **SAFE (comment rot)** | The entry is actually *below* (line 1068). Cosmetic; fix opportunistically. |

**No renderer or helper inside SpaceSections is unreachable.** Every local renderer is wired into ≥1 registry key; every helper is used by ≥1 renderer. There is no immediately-removable dead code *within SpaceSections itself* — the dead-ish items are DB-seed-risky (net_worth_section), vestigial-but-harmless (debt_payoff_snapshot), or live in other files (widget-registry, wealth-adapters).

---

## 11. Proposed architecture

Derived, not forced. The trajectory the codebase already set (renderers → adapter files; registry = wiring; card = chrome) points here:

```
components/space/sections/
├─ SpaceSections.tsx         ← (choice) dissolve to importers, OR keep as a
│                              deliberate re-export barrel. See note below.
├─ SectionCard.tsx           ← SectionCard + SortableSectionCard + SOLID_LEDE_KEYS
│                              (card chrome, collapse, payoff summary, legacy
│                               debt-key overrides, renderBody dispatch call)
├─ SectionRegistry.tsx       ← SectionRegistry (48-key map) + SectionRenderProps
│                              + local renderers (renderNetWorth/DebtSummary/
│                               InvestmentSummary, NetWorthChartSection,
│                               AllocationSection, AccountsCard, ActivityCard,
│                               ContextualCard) + adapter helpers
│                               (cfgNum/cfgStr/toDisplay/sumAccounts/projectFV)
├─ goals/
│   └─ GoalsCard.tsx         ← GoalsCard + TrashDrawer            ◀ SEC-1
├─ DebtPayoffSection.tsx     ← (already here; unchanged)
└─ (formatting → lib/currency: formatBalance + currencySymbol)   ◀ SEC-3 (optional)
```

**Barrel note:** existing source-scan tests assert these symbols are *defined* in `SpaceSections.tsx` (not merely re-exported), and 4 importers use the `@/components/space/sections/SpaceSections` path. A pure re-export barrel would fail those definition assertions. Prefer **updating the 4 importers + the tests per slice** over a back-compat barrel; the blast radius is small and explicit.

**What stays put:** the single registry (§4), SectionCard+Sortable together (§9), virtual sections in `lib/perspectives` (§5), the per-domain adapters already external (§7), `DebtPayoffSection` (already its own file).

---

## 12. Extraction slices

Each slice compiles, validates, and commits independently, behavior-preserving.

### SEC-1 — Goals capability extraction  **(recommended; high value; low risk)**
- Move `GoalsCard` + `TrashDrawer` → `components/space/sections/goals/GoalsCard.tsx` (verbatim).
- Registry `goals_progress` entry imports `GoalsCard` from the new path.
- Update tests that pin `GoalsCard` inside `SpaceSections.tsx` (see §13).
- **Removes ~490 LOC of feature code from the compositor.** Single registry entry rewired; no behavior change.

### SEC-2 — Card ↔ Registry split  **(recommended-if-justified; medium value; medium churn)**
- `SectionRegistry.tsx` ← the map + `SectionRenderProps` + local renderers + adapter helpers.
- `SectionCard.tsx` ← `SectionCard` + `SortableSectionCard` + `SOLID_LEDE_KEYS`, importing `SectionRegistry` + `SectionRenderProps` from `SectionRegistry.tsx`.
- Update the 4 importers' paths + source-scan tests.
- No cycle: `SectionCard.tsx → SectionRegistry.tsx` is one-way (no renderer imports SectionCard).
- **Separates card-chrome ownership from dispatch/renderer ownership.**

### SEC-3 — Formatting consolidation  **(optional; low value but fixes real dup; low risk)**
- Move `formatBalance` + `currencySymbol` → `lib/currency`; repoint `SpaceDashboard`, `AddGoalModal`, `AccountsPerspective` (drop the divergent `"USD"` default), and `manage-shared.ts` to the single home; delete the 3 duplicates.
- Independent of SEC-1/2.

### SEC-4 — Local-renderer relocation to adapters  **(optional; lowest priority; consistency-only)**
- Move `renderNetWorth`/`renderDebtSummary`/`renderInvestmentSummary` + Overview chart sections + `AccountsCard`/`ActivityCard` into an `overview-adapters.tsx` (mirroring the other `*-adapters` files), dragging the shared helpers with them.
- **Only if** cross-file symmetry is judged worth the churn; SEC-2 already gives these a clean home (`SectionRegistry.tsx`). Recommend **defer** unless a concrete need arises.

**Do NOT do:** split the registry into multiple registries; split SectionCard into wrapper-vs-renderer; touch `net_worth_section`; move virtual sections; restructure `widget-registry` as part of SEC.

---

## 13. Validation strategy

**Existing tests / ratchets that read SpaceSections as source (must be updated per slice):**

| Test | What it asserts | Impact |
|---|---|---|
| `components/space/workspaces/workspaces.test.ts` | SpaceSections *defines* `SectionCard`/`SortableSectionCard`/`SectionRegistry`/**`GoalsCard`** exactly once; host imports from the path | **SEC-1:** drop/repoint the `GoalsCard` assertion to `sections/goals/GoalsCard.tsx`. **SEC-2:** repoint `SectionCard`/`SortableSectionCard`/`SectionRegistry` to their new files. |
| `lib/space-templates/registry.test.ts` | extracts `const SectionRegistry` literal via regex from `SpaceSections.tsx`; every template key has a renderer | **SEC-2:** repoint the `read(...)` path to `SectionRegistry.tsx`. Keep the registry a `const SectionRegistry = {…};` literal. |
| `lib/perspectives/virtual-sections.test.ts` | workspace feeds `toVirtualSections(...)` into `<SectionCard>` | **SEC-2:** verify the `<SectionCard>` reference/import still resolves (path change only). |
| `components/space/widgets/accounts/AccountsPerspective.test.ts` | reads SpaceSections for wiring | Confirm still valid after moves; likely unaffected by SEC-1. |
| `components/space/shell/space-shell.test.ts:50` | lists `"SectionCard"` among expected symbols | **SEC-2:** update expected location if it path-checks. |
| `components/space/manage/manage-space.test.ts:147-148` | asserts canonical `GoalsCard` lives in `SpaceSections.tsx` (from MSM) | **SEC-1:** repoint to `sections/goals/GoalsCard.tsx`. |

**Per-slice safety:**
- **SEC-1:** `GoalsCard`/`TrashDrawer` moved verbatim; only import direction changes (registry → new module). Byte-identical render. tsc catches any missed import; the two source-scan tests are updated to the new path.
- **SEC-2:** verbatim relocation; `SectionRenderProps` becomes an explicit shared import (already the de-facto contract). One-way dependency guarantees no cycle. tsc + the registry-literal test (repointed) guard it.
- **SEC-3:** pure functions moved to one home; tsc guarantees every call site resolves; the `AccountsPerspective` `"USD"`→`DEFAULT_DISPLAY_CURRENCY` change is the *only* behavioral delta and should be verified (all-USD Spaces are identical; the fix only affects a non-USD AccountsPerspective, which was arguably a latent bug — flag explicitly before shipping).

**Runner + gates:** `npm run test:unit` (tsx source-scan suite) + `tsc --noEmit` + `eslint` + the Financial Doctrine Oracle. No new runtime behavior is introduced, so the oracle is unaffected by SEC-1/2/4; SEC-3 touches only label formatting (still oracle-neutral).

**Browser risks:** low. All slices are relocations. The only user-visible risk vector is SEC-3's `AccountsPerspective` default-currency change (non-USD Spaces only). Because localhost browser verification is auth-walled here, validate via tsc + eslint + the source-scan suite; call out the AccountsPerspective default change for manual review if SEC-3 is taken.

---

## 14. Final verdict

**Is SpaceSections a true monolith, or a large cohesive capability?**
It is a **large cohesive compositor with one embedded feature (Goals) and a duplicated utility (formatting)**. Strip those two lodgers and what remains — registry + SectionCard + local renderers + helpers — is one coherent thing (the section dispatch machinery) that *should* stay together. The renderer-extraction pattern is already ~60% done via the external `*-adapters` files; SpaceSections is the wiring hub, not a junk drawer.

**How much should actually move?**
- **Definitely:** GoalsCard + TrashDrawer (~490 LOC) — SEC-1.
- **Worth doing:** the card↔registry file split — SEC-2.
- **Optional cleanup:** formatting consolidation — SEC-3 (also fixes a real 3-way dup).
- **Defer:** local-renderer relocation — SEC-4.

**How much should stay?**
The **single registry**, **SectionCard + SortableSectionCard together**, the **local renderers + shared helpers**, **virtual sections in `lib/perspectives`**, and the already-external adapters. Roughly the compositor core (~600–700 LOC after SEC-1) stays as one unit.

**Estimates:**
- **Before:** `SpaceSections.tsx` = 1,585 LOC (one file).
- **After SEC-1:** `SpaceSections.tsx` ≈ 1,090; `goals/GoalsCard.tsx` ≈ 500.
- **After SEC-1+2:** `SectionRegistry.tsx` ≈ 700 (map + renderers + helpers + props type); `SectionCard.tsx` ≈ 260; `goals/GoalsCard.tsx` ≈ 500; `SpaceSections.tsx` dissolved or thin.
- **Largest remaining file:** `SectionRegistry.tsx` ≈ 700 LOC — cohesive (the compositor's renderer catalog), not a monolith.
- **Ownership improvement:** Goals feature gets its own home; card-chrome vs dispatch-table become distinct owners; formatting gets one authority.
- **Change-amplification reduction:** goal-lifecycle changes stop touching the compositor file; card-chrome changes stop touching the registry; a new section key still costs one line in one map (unchanged — the good property is preserved).
- **Future extensibility:** unchanged-and-preserved (single map is still the extension point); Goals can grow (new goal types, trash policy) without compositor churn.

---

### Answers

**SpaceSections is a true monolith?** → **PARTIAL** (large cohesive compositor + one embedded feature + a duplicated utility).

**Registry should remain unified?** → **YES** (single dispatch table + external capability adapters — already the design).

**Goals should become its own capability?** → **YES** (relocate `GoalsCard`+`TrashDrawer` to `sections/goals/`; single authority preserved, no duplication).

**SectionCard should split?** → **NO** (keep `SectionCard` + `SortableSectionCard` together; DnD already separated). The only defensible cut is card↔registry (SEC-2), not wrapper↔renderer.

**Dead code immediately removable?** → **PARTIAL** (nothing removable *within* SpaceSections without DB-seed risk; the dead-ish items are `net_worth_section` = DANGEROUS/keep, `debt_payoff_snapshot` = INVESTIGATE, and `WidgetMeta`/`renderWealthByAccount` = out-of-scope/other files).

**Safe decomposition available?** → **YES** (SEC-1 is clean, high-value, low-risk; SEC-2/SEC-3 safe and independent).

**Recommended implementation order:**
1. **SEC-1** — Goals capability extraction (`sections/goals/GoalsCard.tsx`). *High value, low risk, do first.*
2. **SEC-2** — Card ↔ Registry file split (`SectionCard.tsx` + `SectionRegistry.tsx`). *Medium value; the substantive architectural cut.*
3. **SEC-3** — Formatting consolidation to `lib/currency` (fixes the 3-way `formatBalance` dup). *Optional; independent.*
4. **SEC-4** — Local-renderer relocation to an `overview-adapters` file. *Defer unless symmetry is judged worth the churn.*

*No implementation performed. No commit. No push.*
