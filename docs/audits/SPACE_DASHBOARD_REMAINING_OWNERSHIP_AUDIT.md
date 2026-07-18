# SpaceDashboard Remaining Ownership Audit (Read-Only)

**Subject:** `components/dashboard/SpaceDashboard.tsx` after SD-7 → SD-9 convergence.
**Size:** 1,015 lines — but **~315 are comments and ~68 blank, so real code ≈ 632 LOC.**
**Date:** 2026-07-18 · **Scope:** read-only. No implementation, no refactor, no commit.

---

## Verdict (the question this audit answers)

> *Is the remaining 1,015 LOC legitimate composition, or is there still hidden ownership?*

**Overwhelmingly legitimate composition.** SpaceDashboard is already a composition
root: it composes hooks, resolves navigation/runtime context, mounts `SpaceShell`,
materializes **one** render context, dispatches workspaces, and composes overlays.
It uses **no providers, managers, resolvers, or registries**, and it **duplicates
no authority** — data (`useSpaceData`), navigation (`useSpaceNavigation`), lens
results (`useSpaceLensResults`), trust (`useActiveEnvelope`), and time
(`usePerspectiveShellState`) are all delegated.

**Hidden ownership is confined to ~40 LOC** in one place — the **Overview hero
assembly** (an emergency-fund runway *calculation*, a snapshot `fxMiss` trust
*filter*, and a debt-account preview *filter*) — plus **one residual network call**
(`handleLeave`). Everything else is composition, navigation, chrome *publishing*,
runtime *wiring*, or rendering *dispatch*. The Workspace Contract Doctrine boundary
is **satisfied**, with one small, well-scoped P1 cleanup remaining.

The headline number is misleading: **a third of the file is doctrinal comments**
documenting prior extractions (every `SD-x` rationale). The composition root is
smaller than 1,015 implies.

---

## 1. Current responsibility map

| Responsibility | Location | Classification | Action |
|---|---|---|---|
| Hook composition (`useSpaceLensResults`, `useDisplayCurrency`, `useSpaceNavigation`, `useSpaceData`, `usePerspectiveShellState`, `useActiveEnvelope`, `useSpaceChromePublisher`) | 164–508 | **1 Composition Root** | KEEP |
| `availablePerspectives` / `perspectiveItems` / `perspectiveDoorwayItems` / `lensSelectorItems` derivations | 176–350 | **2 Navigation** (derivation) | KEEP |
| `activePerspective` / `perspectiveEngaged` resolution | 255–262 | **2 Navigation** | KEEP |
| Declarative activation gates (`openPerspectiveDataNeeds` → `perspectiveNeeds*`) | 269–272 | **1 Composition** | KEEP |
| `useSpaceData` call + `wantSnapshots` / `wantTransactions` gates | 278–294 | **1 Composition** (data delegated) | KEEP |
| `newestAccountUpdate` (max `lastUpdated` reduce) | 300–302 | **6 Data** (timestamp agg, trivial) | KEEP (minor) |
| Shell time (`usePerspectiveShellState`) + Cash-Flow period derivation + handlers | 362–408 | **5 Runtime** (canonical time seam) | KEEP |
| `useActiveEnvelope` wiring | 426 | **5 Runtime** (trust publication) | KEEP |
| `txConversionCtx` rehydrate memo | 441–444 | **5 Runtime** (context) | KEEP |
| `handleLeave` → `fetch DELETE /members/[id]` | 446–458 | **6 Data** (network mutation) | **REVIEW → P1** |
| `applyInitialTab` coordination effect | 476–478 | **2 Navigation** (coordination) | KEEP |
| `hasRenderer` / `enabledSections` / `tabs` derivation | 487–496 | **2 Navigation** (tab derivation) | KEEP |
| Chrome publish (`chromeSubtitle`/`chromeUpdated` + `publishSpace` + `publishCurrencyControl`) | 508–532 | **3 Chrome** (publishes, ≠ renders) | KEEP |
| Loading guard | 538–544 | **1 Composition** | KEEP |
| `sectionsForTab` | 550–552 | **4/5 Rendering prep** | KEEP |
| `heroPoints` (`fxMiss` filter + `heroDef.value`) | 558–560 | **6 Semantic/trust transform** | **REVIEW → P1** |
| `previewTransactions` (debt-account filter) | 565–570 | **6 Semantic filter** | **REVIEW → P1** |
| Emergency-fund months-covered calc | 578–589 | **6 Financial calculation** | **REVIEW → P1 (clearest leak)** |
| Doorway nodes (`recentTransactionsDoorway`, `perspectivesDoorway`) | 596–629 | **1 Rendering composition** | KEEP |
| `sectionCardBundle` prop bundle | 633–643 | **5 Runtime** (prop bundle) | KEEP |
| `renderCtx` construction | 650–677 | **5 Runtime assembly (valid, type A)** | KEEP |
| `<SpaceShell>` mount + title/subtitle/currency/rail props | 680–763 | **1 Composition Root** (mount shell) | KEEP |
| Overlays: `AddGoalModal` / `ManageSpaceModal` / `ConfirmDialog` | 683–737 | **4 Overlay** (host-owned state) | KEEP |
| Perspective-engaged block: `PerspectiveShell` + `WORKSPACE_RENDERERS` dispatch + virtual-sections | 786–862 | **1 Rendering dispatch** | KEEP (inline virtual path = P2) |
| Standard-tab dispatch (`TRANSACTIONS`/`MEMBERS`/`OVERVIEW`/`ACCOUNTS`/`ACTIVITY`) | 879–998 | **1 Rendering dispatch** | KEEP |
| `RoutedWorkspaceModal` (Goals/Retirement legacy modal) | 903–917 | **4 Overlay** (modal rendering a workspace) | **REVIEW → panel-migration P1** |
| `fm-view-enter` transition + `<style>` | 770, 1001–1012 | **Presentation** | KEEP |

---

## 2. Remaining LOC breakdown

Estimates over ~632 lines of real code (comments/blank excluded):

| Bucket | ≈ LOC | Notes |
|---|---|---|
| **Navigation** | ~90 | perspective/lens/doorway derivations, `applyInitialTab`, `onSelectTab`, rail + tab derivation |
| **Chrome** | ~35 | subtitle/updated derivation + 2 publish effects + shell header props (all *publishing*) |
| **Runtime** | ~150 | shell time + Cash-Flow period, envelope wiring, `txCtx`, activation gates, `sectionCardBundle`, `renderCtx` |
| **Rendering (dispatch)** | ~230 | `SpaceShell` body, perspective-engaged block, 5 standard-tab branches, transition |
| **Overlays** | ~65 | 3 modal blocks + open-state + `handleLeave` |
| **Legacy / residual** | ~40 | **Overview hero assembly** (EF calc + `fxMiss` filter + debt preview) + `RoutedWorkspaceModal` branch |
| **Boilerplate** | ~130 (of the comment/blank/props total) | imports, `Props` interface, heavy `SD-x` rationale comments |

The **~40 LOC "Legacy/residual"** bucket is the only material hidden ownership.
Everything else is composition, wiring, or dispatch.

---

## 3. Violations (actual — not aesthetic)

Only genuine boundary breaks are listed. No "abstract this for tidiness" items.

**V1 — Emergency-fund runway *calculation* in the host (lines 578–589). [real]**
`months = heroPoints[last].value / monthlyExpenses`, reading section config, is a
**financial calculation** executed in the composition root. It is the single
clearest violation of section-6 ("no business calculations"). Small (~11 LOC) but
unambiguous domain logic.

**V2 — Overview hero *semantic/trust transforms* in the host (lines 558–560, 565–570). [soft]**
- `heroPoints` drops `fxMiss` snapshot points — a **trust-honesty transformation**
  (which points are defensible to plot) living in the host, not in a trust/hero
  authority.
- `previewTransactions` filters transactions to debt-account ids for `DEBT_PAYOFF`
  — a **semantic filter** ("what counts as a debt-payment preview").
Both are render-phase and small, but they are workspace-body semantics that leaked
into the host rather than into `OverviewWorkspace` / `lib/space-hero`.

**V3 — Residual network mutation in the host (line 449). [very soft]**
`handleLeave` issues `fetch DELETE …/members/[id]`. It is a leaf *lifecycle action*
(not a data fetch or calculation), wired to `ConfirmDialog`. It is the **only**
network call left in the host. Borderline: acceptable as an overlay action, but it
is the last place the host touches the network directly.

**No other violations.** No providers/managers/resolvers/registries. No duplicated
registry/renderer/time/trust authority. Navigation, data, lens, envelope, and time
are all delegated. Chrome is *published*, not rendered. `renderCtx` assembly + `WORKSPACE_RENDERERS[id](ctx)` is valid composition (type A), not hidden workspace
ownership (type B).

---

## 4. Future extraction candidates

**P0 — Must move:** **None.** No hard violation blocks the composition-root
contract. The host is already contract-legal. (V1 is a genuine but ~11-LOC calc;
it does not rise to "must move now.")

**P1 — Good next slice:**
1. **Overview hero assembly → `OverviewWorkspace` (or a pure `lib/space-hero` helper).**
   Move `heroPoints` (incl. the `fxMiss` filter), the emergency-fund months calc
   (`heroHeadlineOverride`/`heroSublineNote`), and `previewTransactions`/`previewScopeNote`
   out of the host. This removes **all** of V1+V2 in one cohesive move — the host
   would pass raw `snapshots`/`accounts`/`category` and let the Overview workspace
   own its own hero. Net: the composition root stops computing money.
2. **Unify dispatch into one `<WorkspaceRenderer>`.** Today standard tabs
   (`TRANSACTIONS`/`MEMBERS`/`OVERVIEW`/`ACCOUNTS`/`ACTIVITY`) dispatch via inline
   `{activeTab === "X" && …}` while perspective lenses dispatch via
   `WORKSPACE_RENDERERS[id](ctx)`. A single renderer keyed on `(activeTab,
   activePerspectiveId)` collapses ~230 LOC of body JSX into one `<WorkspaceRenderer
   ctx={renderCtx} />`. This is the **largest structural simplification** and makes
   the end-state tree literal — but it is optional (current dispatch is legal).
   *Not a new registry* — it reuses `WORKSPACE_RENDERERS` and adds standard-tab keys.
3. **`RoutedWorkspaceModal` (Goals/Retirement) → in-place workspace / RightPanel.**
   A workspace rendered inside a legacy modal is the one remaining anti-pattern.
   Gated on the deferred Goals/Retirement product-architecture decision (noted in
   code at 896–902) — see §5.

**P2 — Leave alone (do not extract for aesthetics):**
- `handleLeave` (V3) — ~10 LOC leaf action; moving it buys little.
- **`SpaceOverlays.tsx` grouping** — the overlay *state* (`showAddGoal`,
  `showManage`, `confirmLeave`, `leaveBusy`) is legitimately host-owned; extracting
  only the JSX is cosmetic. Compose overlays inline until there's a functional
  reason. The doctrine's "compose overlays" is already satisfied.
- Inline **virtual-sections** render path (831–851) — could fold into a renderer,
  but it's a small, honest fallback.
- `railOptions` / subtitle-string derivations — trivial config mapping.

---

## 5. Panels migration impact (Atlas Panel primitive)

New primitive: `Panel`, `LeftPanel`, `RightPanel`, `PanelStack`/`usePanelStack`,
`WorkspaceLayout` (`components/atlas/panels`). Doctrine: **Panel = "keep working
while inspecting"; Modal = "pause & decide."** Mapping the host's four overlays:

| Overlay | Current | Correct destination | Priority |
|---|---|---|---|
| `RoutedWorkspaceModal` (Goals/Retirement) | GlassModal rendering a **workspace** | **`RightPanel` / `WorkspaceLayout`** — it's inspection of workspace content, not a decision | **P1** (gated on Goals/Retirement architecture) |
| `ManageSpaceModal` | Full modal | **`RightPanel`** candidate — space config is "inspect/edit alongside", though a heavy multi-tab modal is defensible as-is | P2 |
| `AddGoalModal` | Modal | **Stay Modal** — a create/submit flow is "pause & decide" | — |
| `ConfirmDialog` (leave) | Modal | **Stay Modal** — confirmation is definitionally "pause & decide" | — |

Only **`RoutedWorkspaceModal`** is a clear migration (a workspace does not belong
in a modal). `ManageSpaceModal` is a weaker candidate. `AddGoal`/`ConfirmLeave` are
correctly modals and should **not** become panels. **Do not implement** — recorded
for the eventual Goals/Retirement + panels wave.

---

## 6. End-state prediction

The proposed tree is **directionally correct but over-specified.** The runtime is
*already* decomposed into cohesive hooks; bundling them into a single
`useSpaceRuntime()` would re-hide the very seams SD-9 exposed and cuts against the
anti-framework doctrine. `SpaceOverlays` is optional. The one real consolidation is
`WorkspaceRenderer`.

**Actual end-state (what SpaceDashboard should become):**

```
SpaceDashboard  (composition root — no providers/managers/resolvers/registries)
 ├── useSpaceNavigation()          ✓ exists   (URL ⇄ tab/lens/metric/deep-link)
 ├── useSpaceData()                ✓ exists   (sections/accounts/snapshots/tx/ctx)
 ├── useSpaceLensResults()         ✓ exists  ┐
 ├── usePerspectiveShellState()    ✓ exists  ┤ the "runtime" — already three named
 ├── useActiveEnvelope()           ✓ exists  ┘ hooks; do NOT fuse into useSpaceRuntime
 ├── useSpaceChromePublisher()     ✓ exists   (publish identity/controls to navbar)
 └── <SpaceShell title subtitle rail overlays={…}>
      └── <WorkspaceRenderer ctx={renderCtx} />   ← P1: fold standard + perspective
                                                     dispatch (the only worthwhile
                                                     structural consolidation)
```

**Confirmation of the proposal:**
- `useSpaceNavigation()` / `useSpaceData()` — **needed, and present.**
- `useSpaceRuntime()` — **NOT needed.** It already exists as three cohesive hooks;
  fusing them would reduce clarity, not increase it.
- `SpaceShell` — **present.**
- `WorkspaceRenderer` — **the one genuine P1** (optional; current inline dispatch is
  contract-legal). Would make the tree above literal and remove ~230 LOC of body.
- `SpaceOverlays` — **optional (P2)**, cosmetic; overlay *state* stays host-owned.

**Bottom line:** the remaining ~632 LOC of code is legitimate composition-root work.
The only hidden ownership is the ~40-LOC Overview hero assembly (one financial calc
+ two semantic/trust filters, **P1**) and one membership-mutation fetch (**P2/soft**).
Remove the hero assembly and the composition root computes no money, filters no
trust, and issues no calculations — a clean root. No structural refactor is required
for contract compliance; `WorkspaceRenderer` is an optional clarity win, not a fix.
