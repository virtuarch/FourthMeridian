# Space Contract Doctrine

**Status:** Ratified 2026-07-16 · Canonical architectural doctrine for the Space platform
**Basis:** PCS Pre-Decomposition Architecture Review (PASS) — the review that validated this doctrine and the decomposition order recorded in §15.
**Scope:** This document is an architectural ratification pass. It describes the target architecture and the approved sequence to reach it. It changes no runtime behavior, no TypeScript, no React, no routing.

> **Reading contract.** Where this document says a thing is **Implemented**, it exists in the working tree today. Where it says **Planned**, it does not exist yet and is a decomposition-phase target. This distinction is load-bearing: nothing here should be read as claiming an unbuilt loader, registry, or authority already exists.

---

## 1. Purpose of SpaceShell

`SpaceShell` is the **permanent application frame** — the single, Space-agnostic host that every Space (Personal and shared alike) renders through. It is the surface that persists as the member moves between workspaces; the workspace below it changes, the shell does not.

SpaceShell **owns**:

- **Navigation** — the fixed rail, the active-tab state, workspace routing.
- **Workspace switching** — selecting which workspace occupies the slot.
- **URL state** — the single authority for every query parameter (see §7).
- **Time controls** — the one canonical time model surfaced to the member (see §8).
- **Refresh / invalidation** — the cross-cutting data-refresh / currency-change bus.
- **Shell overlays** — shell-level dialogs and drawers (Create Space, transaction detail).
- **Responsive layout** — the desktop/mobile frame; the workspace never re-implements it (see §10).
- **Shell-level utilities** — global chrome (header, sidebar, notifications, background).

SpaceShell **does not own workspace business logic.** It orchestrates; it never computes a workspace's figures, never derives a workspace's domain state, and never reaches into a workspace's result to assemble something on the workspace's behalf.

---

## 2. Purpose of Workspaces

A **workspace** is an **isolated business domain** — one lens onto the Space's data, self-contained in its rendering and its domain behavior.

Workspaces:

- **Overview**
- **Cash Flow**
- **Liquidity**
- **Investments**
- **Wealth**
- **Debt**
- **Goals**
- **Transactions**
- **Accounts**
- **Members**

Each workspace owns **only its own rendering and domain behavior** — the widgets it draws, the domain math it runs, the actions it exposes, and how it presents its own values. A workspace is blind to the other workspaces and to the shell's internals. It receives context; it does not manage the frame.

---

## 3. Ownership Boundaries

Ownership is exclusive. A concern lives in exactly one of the three tiers below.

### SpaceShell owns

- Navigation
- URL authority
- Deep links
- Shell dialogs
- Responsive behavior
- Workspace registry
- Refresh bus
- FX control *(future — the selector moves into the shell; see §9)*
- Layout composition

### Workspaces own

- Rendering
- Workspace actions
- Workspace-specific conversion (native vs. converted presentation of their own values)
- Workspace-specific dialogs
- Domain calculations

### Shared services own

- Canonical loaders (`*SpaceData`)
- The time reducer
- The conversion engine
- Envelopes (trust / completeness)
- Registries
- `SectionRegistry` (the widget compositor)
- Data contracts (the typed DTOs)

---

## 4. Workspace Registration Doctrine

Every workspace is declared through a **single registry**. There is no second place a workspace's identity, availability, or routing may be defined.

**Ratified direction:** extend the existing `PerspectiveDef` concept (`lib/perspectives.ts`) into the future **`WorkspaceDefinition`**. `PerspectiveDef` today already declares `id`, `label`, `icon`, `status`, `group`, and optionally `lensId` / `widgets` — it is a *partial* WorkspaceDefinition. The remaining responsibilities are currently hardcoded in the host and must migrate into the definition.

`WorkspaceDefinition` will eventually declare:

- **identity**
- **label**
- **icon**
- **routing** (target tab / modal routing — today spread across `PERSPECTIVE_TARGET_TAB`, `PERSPECTIVE_ROUTED_TABS`, `PERSPECTIVE_MODAL_META`)
- **render entry** (the component — today a hardcoded `if/else` ladder on `activePerspectiveId`)
- **envelope source** (today a per-id switch fed by host-composed results)
- **dataNeeds** (today per-id boolean fetch triggers in the host: `investmentsActive`, `cashFlowActive`, …)
- **consumesTime** (today implicit: Wealth/Investments consume As Of; Liquidity/Debt/Cash Flow do not)
- **status / group metadata**

**Not implemented.** `WorkspaceDefinition` is a Planned contract (decomposition Phase 2, §15). This section ratifies its shape and responsibilities; it does not build it.

---

## 5. Data Loading Doctrine

The canonical loader pattern: a **single server-side `load…SpaceData(scope) → …SpaceData` loader** that returns one typed, canonical envelope for a workspace. The host composes envelopes; it never assembles a workspace's data from raw arrays at render time.

### Implemented (exist in the working tree today)

| Contract | Loader | Owner |
|---|---|---|
| **`InvestmentsSpaceData`** | `loadInvestmentsSpaceData` (composition) · `loadInvestmentsHistory` (A10 historical binding) | `lib/investments/space-data.ts` |
| **`ConnectionsSpaceData`** | `loadConnectionsSpaceData` · `loadConnectionsSyncStatus` | `lib/connections/space-data.ts` |

> **Honest scope note.** The Investments *historical* slice is wired to a runtime consumer (`/api/spaces/[id]/investments/time-machine`). The composed `loadInvestmentsSpaceData` orchestrator is implemented and tested but **not yet consumed by the UI** — the Investments current view still reads the A10-at-today route. That UI rewire is a decomposition-phase task (§15, Phase 5), not a claim of present wiring.

### Planned (do not yet exist — decomposition targets)

- **`CashFlowSpaceData`**
- **`DebtSpaceData`**
- **`WealthSpaceData`**
- **`TransactionsSpaceData`**

> **Current reality of the four Planned workspaces** (recorded so nothing is over-claimed):
> - **Transactions** has an implemented canonical *row* loader — `getTransactions → Transaction[]`, KD-15-enforced in `lib/data/transactions.ts` — but **no composed workspace envelope**. `TransactionsSpaceData` remains Planned.
> - **Wealth** has an implemented client-side *read-model* — `computeWealthTimeMachine → WealthResult` (`lib/wealth/wealth-time-machine.ts`) — but **no server loader**. `WealthSpaceData` remains Planned.
> - **Cash Flow** and **Debt** are assembled **ad hoc** at render (a toolbox of pure functions in `lib/transactions/cash-flow*`; figures glued from `accounts` + `snapshots` + a lede-only `LensResult`). No loader, no envelope. Both remain Planned.

**Rule:** "Implemented" and "Planned during decomposition" are distinct and must stay distinct in every downstream document. Do not imply a Planned loader already exists.

---

## 6. Navigation Doctrine

Navigation belongs **exclusively to SpaceShell.**

- The **rail ordering is canonical** and fixed (`SPACE_TAB_ORDER`, `lib/space-nav.ts`). It is a cross-Space muscle-memory contract — "Accounts is always third" across every Space of every type.
- **Workspaces never reorder rails.** A workspace may **only declare its availability** (present / placeholder / manager-only), via its registry entry. It may not add, remove, or re-sequence rail entries.
- A host may choose not to *render* a tab it is allowed to hide (e.g. SETTINGS for non-managers), but it must never reorder the tabs it does render.

---

## 7. Deep-Link Doctrine

There is **one URL authority**, owned by SpaceShell.

**Finding from the review — today URL ownership is split across three independent writers:**

- `tab` / `perspective` / `metric` — written by the host (`SpaceDashboard.tsx`).
- `asOf` / `compareTo` / `preset` — written by the time hook (`usePerspectiveShellState`).
- `transaction` — written by the shell chrome (`DashboardChrome`, transaction detail drawer).

Three `window.history` writers and three `popstate` readers own disjoint parameters. This is the highest-priority coupling: if a workspace is extracted before a single authority exists, each extracted piece will grab `window.history` for itself and clobber the others' params.

**Ratified:** decomposition **begins** by collapsing these into one shell-owned URL authority. This is **Phase 0A** (§15) — it runs before any workspace is extracted.

---

## 8. Time-Control Doctrine

There is **one canonical time reducer** (`lib/perspectives/time-range.ts`, bound by `usePerspectiveShellState`). It owns:

- `preset`
- `asOf`
- `compareTo`

The shell renders the time controls; workspaces **read** time context and **never own** it.

**Finding from the review:** `cashFlowPeriod` is a **second time state** living outside the canonical reducer, bridged into it by hand (`handleSelectSlice` / `handleCompareToChange`). This duplicate must be **folded into the reducer** before any workspace is extracted — otherwise an extracted workspace that assumes "time is the reducer" will silently desync Cash Flow. This is **Phase 0B** (§15).

---

## 9. FX Ownership Doctrine

- **Shell owns:** the FX selector ("view as" control) and the reporting-currency controls.
- **Shared services own:** the conversion engine (`lib/money/convert`, `lib/currency-context`) — pure conversion math and the display-currency provider.
- **Workspaces own:** *how* their values are converted — the native-vs-converted presentation decision for their own figures (e.g. converted headline sums, native itemized rows).

**Planned move:** the FX selector (`ViewCurrencyOverride`) is today injected into the Overview `overviewTopSlot` by the Personal host. It will move **into SpaceShell** as a first-class shell control, so it is available to the frame rather than threaded through one workspace's slot. This is a decomposition-phase move, not implemented here.

---

## 10. Responsive Ownership Doctrine

Responsive behavior belongs to **SpaceShell.** The desktop/mobile split (header, bottom nav, sidebar) is a property of the frame.

**Rule:** desktop/mobile differences must **never** be implemented independently inside each workspace. A workspace lays out its own content responsively within the slot it is given, but it does not own or duplicate the frame-level responsive behavior.

---

## 11. Workspace Composition Doctrine

The canonical composition chain, top to bottom:

```
Canonical data
      ↓
   *SpaceData          (shared service — one typed envelope per workspace)
      ↓
   Workspace           (consumes its envelope; renders; runs domain math)
      ↓
   SpaceShell          (orchestrates the frame; places the workspace in the slot)
```

- **SpaceShell orchestrates** — it selects, routes, times, and frames.
- **Workspaces consume** — they read one envelope and render.
- **Shared services provide** — canonical loaders, reducers, engines, registries, and contracts.

Data flows up through the loader into the workspace; control flows down from the shell into the slot. Neither tier reaches across the boundary.

---

## 12. Runtime Invariants

The architecture invariants ratified by the review. These hold before, during, and after decomposition.

1. **Investments — Current vs. Historical, never cross-derived.**
   `Current → getCurrentPositions()` (A10-at-today seam). `Historical → A10` (`getInvestmentsTimeMachine`, verbatim). Historical truth belongs exclusively to A10; the current view is never derived from the Time Machine, and no surface reaches a historical portfolio through the current seam. Pinned by `space-data-historical.test.ts`.
2. **URL — single shell authority.** One owner writes query state (§7). No workspace writes `window.history`.
3. **Time — single reducer.** One `{preset, asOf, compareTo}` owner (§8). No duplicate time state.
4. **FX — shell owns the control.** The conversion engine is a shared service; workspaces own only presentation of their own values (§9).
5. **Transactions — KD-15 server-side filtering.** Visibility filtering stays inside the server loader (`lib/data/transactions.ts`); it is never re-derived client-side.
6. **Rail ordering is immutable.** `SPACE_TAB_ORDER` is canonical; workspaces declare availability only (§6).
7. **Envelope ownership.** Trust/completeness envelopes carry no fabricated counts and no percentages; an absent envelope renders an inert "—", never invented detail. Each workspace supplies its own envelope; the shell renders it.
8. **Snapshot honesty.** `fxMiss` snapshot rows are dropped from any plotted series — a shorter honest trend over a silently mixed-magnitude one.
9. **Name resolution order.** Account display names resolve `displayName ?? officialName ?? plaidName ?? name` — the single canonical order shared by every contract.

Supporting invariants (mechanism, not semantics): URL state uses `window.history`, never the `useSearchParams` hook (which would force a Suspense boundary); time defaults are SSR-safe (MTD), hydrated from the URL post-mount.

---

## 13. Future Workspace Rules

Every future workspace **must**:

- expose **one canonical loader** (`load…SpaceData`)
- expose **one render entry**
- expose **one envelope**
- declare **dataNeeds**

Every future workspace **must never**:

- own URL state
- own navigation
- own responsive layout
- own global refresh
- own shell dialogs

---

## 14. Explicit Anti-Patterns

Prohibited. Each is a boundary violation that decomposition exists to eliminate.

- **Multiple URL writers** — more than one owner of `window.history` / query state.
- **Duplicate time state** — any time slice living outside the canonical reducer.
- **Inline data loading inside the host** — assembling a workspace's data from raw arrays at render time instead of through a loader.
- **Workspace-owned navigation** — a workspace mutating the rail, tabs, or routing.
- **Duplicate trust builders** — a second envelope/completeness assembler outside the shared envelope service.
- **Duplicate activity builders** — a second activity/event feed assembler outside its canonical producer.
- **Client-derived canonical data** — recomputing a figure of record on the client that a canonical loader already owns.
- **Institution-name joins** — joining accounts/connections by institution string instead of stable id.
- **Parallel loader implementations** — a second loader for a workspace that already has a canonical one.

---

## 15. Decomposition Blueprint

The approved extraction sequence. This ordering was **validated by the PCS Pre-Decomposition Architecture Review** and is now the approved implementation sequence.

```
Phase 0A — Single URL authority
   Collapse the three URL writers (tab/perspective/metric · asOf/compareTo/preset · transaction)
   into one shell-owned authority.
      ↓
Phase 0B — Single time authority
   Fold cashFlowPeriod into the canonical time reducer.
      ↓
Phase 1 — SpaceShell extraction
   Extract the permanent frame: header · rail · active-tab · URL authority · refresh bus ·
   shell overlays. Renders a workspace slot.
      ↓
Phase 2 — WorkspaceDefinition registry
   Extend PerspectiveDef into WorkspaceDefinition (identity · routing · render entry ·
   envelope source · dataNeeds · consumesTime · status/group).
      ↓
Phase 3 — Declarative workspace data loading
   A dataNeeds-driven loader hook replaces the hardcoded per-workspace fetch triggers
   and the render ladder.
      ↓
Phase 4 — Workspace extraction
   Extract workspaces behind the slot, by contract maturity:
   Investments → Wealth → Debt / Liquidity / Cash Flow.
      ↓
Phase 5 — Promote remaining *SpaceData loaders
   Promote Cash Flow · Debt · Wealth · Transactions to server-side *SpaceData loaders,
   matching Investments/Connections; wire the dormant loadInvestmentsSpaceData into the UI.
      ↓
Phase 6 — Section compositor extraction
   Extract SectionRegistry / SectionCard / ContextualCard into their own module.
   (Orthogonal — may follow any time after Phase 1.)
```

**Why this order:** Phases 0A and 0B remove the two couplings that would otherwise force rework *during* extraction (split URL ownership; duplicate time state). Phase 1 gives the workspaces a slot to move into. Phase 2 gives the slot a declarative registry. Phase 3 kills the host's hardcoded fetch triggers. Only then (Phase 4) is a workspace safe to extract — starting with Investments, which already has the canonical loader, the fetch hook, and an envelope source. Phase 5 brings the remaining workspaces up to the canonical loader pattern. Phase 6 is independent cleanup.
