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

---

## Addendum — Workspace / Perspective doctrine (SD-2B · ratified 2026-07-16)

Clarified during the SD-2B review and **ratified** at the close of the SD-2 family
(alongside Addendum II). The canonical workspace registry (`lib/perspectives.ts`,
`WORKSPACE_REGISTRY`) encodes this.

1. **Every primary destination rendered within the SpaceShell workspace region is
   a Workspace.** The five structural destinations (Overview, Transactions,
   Accounts, Activity, Members) and Goals are `kind: "standard"`.

2. **Every Perspective is a Workspace, but not every Workspace is a Perspective.**
   `kind: "perspective"` vs `kind: "standard"` on the base `WorkspaceDefinition`.

3. **Perspectives are specialized analytical Workspaces over a canonical domain,
   temporal and comparative by purpose.** *(Broadened in Addendum II — the earlier
   wording "temporal **financial** lenses" was too narrow; Perspective is not
   inherently financial. See Addendum II §B.)* For a **Personal Finance** Space the
   domain is financial, and every current Perspective participates in the canonical
   `asOf` / `compareTo` model — viewing past states, current states, and comparisons
   between them. The current Personal-Finance Perspectives are: **Wealth, Cash Flow,
   Investments, Debt, Liquidity** (all `consumesShellTime: true`).

4. **Missing canonical-time behavior in a Perspective is an implementation gap,
   not a different architectural category.** The registry describes the intended
   contract; it never fossilizes an incomplete implementation as a non-temporal
   kind. Current gap: **Liquidity** is `consumesShellTime: true` by contract but
   current-state only at runtime — historical/as-of support is an activation task
   for the Liquidity workspace extraction (Phase 4+). **Debt** clips its
   Balance-Over-Time to the shell window as a smaller follow-up in the same slice.

5. **Goals is a standard/domain Workspace, not a Perspective** (goal management —
   progress/forecasting/projections/guidance may come later; none of that makes it
   a temporal financial lens). It is retained in `PERSPECTIVE_LIBRARY` today so the
   Perspectives sub-nav card + workspace render are byte-unchanged; physical
   relocation to `STANDARD_WORKSPACES` (and out of the sub-nav) is deferred to the
   Goals workspace slice to avoid a navigation/functionality change now.

---

## Addendum II — Universal Space / Workspace / Perspective model (SD-2 final reconciliation · ratified 2026-07-16)

**Status:** **Ratified** at the close of the SD-2 family (SD-2/2B/2C/2E). A
reconciliation pass to confirm the new universal Workspace model is not accidentally
personal-finance-specific — because Fourth Meridian already operates real internal
HQ surfaces (Platform Operations, Security Operations, Growth & Revenue, Customer
Success) that reuse this same architecture rather than fork into a separate
admin-dashboard framework. The long-term thesis is **Fourth Meridian operating Fourth
Meridian** on one Space substrate. SD-2E made the Platform Spaces the second real
consumer of the universal frame (§C). This addendum broadens definitions, records a
code census, and pins invariants; the only runtime change in the SD-2 family beyond
identity metadata is SD-2E's render-layer convergence.

### A. Definitions (domain-neutral)

- **Space** — a durable domain/environment that composes Workspaces. A Personal
  Finance Space and a Platform Operations Space are the **same architectural
  primitive**: they share the same foundational `SpaceShell` and Workspace/navigation
  architecture, and differ only in domain, Workspace composition, data, and
  *permitted presentation*. The invariant is **same primitives, same architecture —
  not pixel-identical presentation.** A Platform Space may legitimately evolve denser
  navigation, status regions, alert strips, operational controls, or different
  composition without becoming a separate architecture.
- **SpaceShell** — the domain-agnostic visual/runtime frame for a Space (§1). It
  owns identity, Workspace navigation, URL/time authority, shared Space
  capabilities, overlays, and the Workspace slot. **It never knows domain
  semantics** — it cannot name Investments, Job Health, or Audit Feed.
- **Workspace** — a primary functional destination rendered inside the SpaceShell
  workspace region.
- **Standard Workspace** — a functional/domain Workspace whose primary purpose is
  operational interaction rather than analytical temporal comparison. Personal
  Finance: Overview, Transactions, Accounts, Activity, Members, Goals.
- **Perspective Workspace** — a specialized analytical Workspace (§B).
- **Workspace Registry** (`WORKSPACE_REGISTRY`, `lib/perspectives.ts`) — the ONE
  authority for Workspace *identity* and shell-facing metadata.
- **Space Composition** — the separate authority for *which* registered Workspaces
  a particular Space exposes (§D). Identity and composition are different concerns.
- **Domain contracts** — domain-specific typed data envelopes (`InvestmentsSpaceData`,
  `ConnectionsSpaceData`, and future justified contracts such as an operational or
  security envelope). These stay domain-specific by design (§F).
- **SpaceShell capabilities** — Space-wide capabilities that belong to the shell
  boundary, not to any one Workspace. Current example: display-currency / FX control
  (§9, SD-2C). The shell owns the *control boundary*; the conversion math is a shared
  service, never the shell's.

### B. The universal Perspective definition

> **A Perspective is a specialized analytical Workspace that presents a canonical
> domain through a particular lens across time and comparative states.**

Every Perspective is a Workspace; not every Workspace is a Perspective. A Perspective
is distinguished by *purpose* — analytical, temporal/comparative, a domain lens — not
by whether it happens to show time-series data (Goals shows trajectories and is still
a Standard Workspace; §5 of the SD-2B addendum). **The domain of a Perspective is
determined by its Space, not by the abstraction.** Perspective is not inherently
financial.

- **Personal Finance implementation (current, unchanged).** For a Personal Finance
  Space the domain is financial, and every Perspective — Cash Flow, Liquidity,
  Investments, Debt, Wealth — participates in the SD-0B canonical time model
  (`preset` / `asOf` / `compareTo`). This financial contract is **not weakened**:
  all five remain `consumesShellTime: true` and temporal by contract.
- **Universal semantic rule vs. current implementation are distinct.** The universal
  rule is "analytical + temporal/comparative + domain lens." The *current* Personal
  Finance implementation additionally binds to the specific SD-0B `preset/asOf/
  compareTo` reducer. A future operational or security Perspective (e.g. reliability
  over time, provider health over time, security posture over time) would be temporal
  by the same semantic rule, but is **not** required to consume today's finance-shaped
  time implementation verbatim. Do not couple the abstraction to today's reducer.
- **Runtime gaps remain implementation gaps, not category differences** (restated
  from SD-2B §4): **Liquidity** is temporal by contract but current-state only at
  runtime; **Debt** has history but its `asOf`/`compareTo` clipping is incomplete.
  Both are activation tasks for the respective Workspace extractions, never a
  reclassification to a non-temporal kind.
- No speculative Perspectives are created in this slice. The future operational
  examples above are illustrative of domain-neutrality, not a backlog.

### C. Fourth Meridian HQ — census and model verdict

A fresh repo census (evidence in §H) found the internal operating surface split
across **three architecturally distinct systems**, not one:

| System | Route | Primitive | Uses SpaceShell? | Temporal? | Perspectives? |
|---|---|---|---|---|---|
| **Platform Spaces** (the four HQ domains) | `/dashboard/platform/[area]` | System-singleton **Space** per `PlatformArea` (`Space.platformArea @unique`), seeded by `lib/platform/seed.ts`; sections are `SpaceDashboardSection` rows | **Yes (SD-2E)** — renders through the shared `SpaceShell` frame; the Overview Workspace body is the existing self-fetching grid via local `PLATFORM_WIDGET_REGISTRY` (`widget-kit.tsx`) | No (windows hardcoded server-side) | No |
| **Admin Panel** | `/admin/*` | Group of `SYSTEM_ADMIN`-only pages; own shell + `AdminNav` | No | No | No |
| **Merchant Ops** | `/merchant-ops` | Standalone one-off review page, Space-membership gated (`MERCHANT_OPS_SPACE_ID`) | No | No | No |

Per-domain: **Platform Operations** (job health, rate limits, env, API usage,
connection health) and **Security Operations** (audit feed, auth posture, sessions,
anomalies) are the most built; **Growth & Revenue** has signups/activation + a
beta-request queue but *no revenue data source until v3.0 billing*; **Customer
Success** is a single `SyncIssue` widget ("no purpose-built CS primitives exist
yet"). **Merchant Operations is NOT one of the four `PlatformArea` HQ domains** — it
is a separate, older pattern; it is neither invented nor folded into the HQ model in
this slice.

**Model verdict — Model B, and it is already true in the data model.** Fourth
Meridian HQ is a *container/environment*, not one giant Space. Each HQ domain is
**already its own Space** (`Space.platformArea` is a real per-area singleton). So the
long-term structure is:

```
Fourth Meridian HQ  (environment: the platform-area axis + /dashboard/platform/*)
   ├─ Platform Operations   Space → its Workspaces (+ future operational Perspectives)
   ├─ Security Operations    Space → its Workspaces (+ future security Perspectives)
   ├─ Growth & Revenue       Space → its Workspaces
   └─ Customer Success        Space → its Workspaces
```

The remaining gap was the **render layer**, and **SD-2E closed it**: the Platform
Spaces now render through the shared `SpaceShell` frame (`components/platform/
PlatformSpaceDashboard.tsx`) instead of a forked shell. Each Platform Space exposes a
single **Overview Workspace** — the existing self-fetching section grid placed in the
shell's workspace slot — so `DashboardChrome → SpaceShell → Workspace` now holds for
both customer and Platform Spaces. This was a *frame convergence only*: the platform
widgets, APIs, sections, self-fetching, and the grant-derived authorization axis
(`PlatformGrant` / `hasPlatformAccess`, orthogonal to `SpaceMemberRole`) are all
unchanged.

**Still deferred (later slices, deliberately not built in SD-2E):** registering the
Platform Overview in the canonical Workspace Registry and driving its composition from
there (it lives platform-locally today via `PLATFORM_AREAS` + the local widget
registry); a `PlatformSpaceData` contract / declarative loading (SD-3+); and future
analytical views (reliability/provider/posture over time) as operational/security
**Perspectives**. No HQ domain is redesigned and no operational Perspective is created
here (§14).

### D. Space composition ownership

> **Workspace Registry defines what a Workspace is. Space composition defines which
> Workspaces a particular Space exposes.**

The global registry must **not** decide that every Space has every Workspace. That
seam already exists and is correct in direction, though split across sources today:

- **Which lenses/Workspaces a finance Space exposes** — `PERSPECTIVES_BY_CATEGORY`
  (per `SpaceCategory`) for Perspectives, and `railVisibleTabs(host)`
  (`lib/space-nav.ts`) for standard rail tabs.
- **Which sections a finance Space is born with** — `PRESET_MAP` / `getPresetsForCategory`
  (`lib/space-presets.ts`); the `SpaceTemplate` registry (`lib/space-templates/`)
  exists as the intended long-term owner but is **dormant** ("nothing in the app reads
  this registry yet" — rewire deferred to SP-2).
- **Which sections an HQ Space exposes** — `PLATFORM_AREAS[area].sections`
  (`lib/platform/policy.ts`).

**Intended long-term owner:** a Space Definition / Space Template that lists Workspace
ids per Space (family), consumed by SpaceShell — collapsing the finance axes above and
the HQ axis into one composition primitive. The primitive (`SpaceTemplate`) already
exists; activating it is a later slice. This addendum ratifies the *ownership
direction* and preserves the seam; it builds no dynamic composition framework now
(§14).

### E. WorkspaceDefinition universality — verdict

The current contract (`lib/perspectives.ts`):

```ts
interface WorkspaceDefinition {
  id: string; label: string; icon: string;
  kind: "standard" | "perspective";
  routing?: WorkspaceRouting;              // targetTab in finance legacy tabs
  dataNeeds?: readonly WorkspaceDataNeed[];// closed finance union
  consumesShellTime?: boolean;
  envelope?: WorkspaceEnvelopeSource;      // closed finance union
}
```

- **The structural base is already domain-neutral.** `id`, `label`, `icon`, `kind`,
  and `consumesShellTime` name no financial concept. `kind` is the only semantic
  discriminator and is domain-agnostic.
- **Three *optional* fields carry Personal-Finance-scoped closed unions:**
  `dataNeeds` (`WorkspaceDataNeed`), `envelope` (`WorkspaceEnvelopeSource`), and
  `routing.targetTab` (`RoutedWorkspaceTab`). These are **not universal vocabularies**
  — they are the Personal-Finance domain's, and this addendum records them as such
  (transitional; see §H).
- **An HQ Standard Workspace is representable *today*, with zero contract change.**
  Because those fields are optional and `dataNeeds` empty ⇒ *self-fetch*, an HQ
  Workspace registers as `{ id, label, icon, kind: "standard" }` with no
  envelope/routing and no dataNeeds — exactly the shape `members` already uses
  (`dataNeeds: []`), and exactly how HQ widgets already fetch (`widget-kit`'s
  `useWidgetFetch`). The finance-scoped unions only *bite* a Workspace that opts INTO
  declarative loading (SD-3). **No second definition system is needed** for HQ.
- **Therefore no contract generalization is made in this slice.** Widening or
  parameterizing the base type now — with no HQ Workspace yet registered and SD-3 not
  built — would be speculative machinery ahead of its second consumer. The correct
  move is to *document* the finance-scoped fields honestly and generalize them WHEN
  the first non-finance Workspace registers (SD-3), not before. `envelope` and the
  finance `dataNeeds`/`routing` unions should at that point live on a Personal-Finance
  specialization, leaving the universal base carrying only domain-neutral fields.

### F. dataNeeds is orchestration metadata, not a domain contract

> `dataNeeds` is NOT the Workspace's domain data contract.

`dataNeeds` is a declarative *orchestration* vocabulary that SD-3 will read to gate
fetches. It is deliberately **not** the typed domain envelope. Domain contracts
(`InvestmentsSpaceData`, `ConnectionsSpaceData`, and future justified ones like an
operational or security envelope) remain domain-specific composition boundaries,
created only where a stable boundary justifies them — never collapsed into one
universal mega-object, and never inflated into a financial ontology on the shared
`WorkspaceDataNeed` union.

**SD-3 extensibility answer:** the data-needs mechanism grows *across domains by
domain registration* — each domain contributes its own need vocabulary and its own
loaders/contracts, dispatched by the orchestrator — not by expanding one global
finance union. HQ needs (jobs, provider status, API usage, audit/auth events,
customers, sync issues) are added as a domain's vocabulary + loaders when that domain
registers Workspaces, without redesigning the Workspace architecture. Until then, HQ
Workspaces self-fetch (as they already do), so SD-3 is unblocked for finance and
extensible for HQ.

### G. Ratified invariants

1. Every primary destination rendered in the SpaceShell workspace region is a
   Workspace.
2. Every Perspective is a Workspace; not every Workspace is a Perspective.
3. Perspectives are analytical and temporal/comparative by purpose.
4. Perspective is not inherently financial.
5. The domain of a Perspective is determined by its Space.
6. Current Personal Finance Perspectives participate in canonical
   `preset / asOf / compareTo`.
7. Missing canonical-time support in a current financial Perspective is an
   implementation gap, not a category difference.
8. Goals is a Standard Workspace, not a Perspective.
9. Workspace Registry defines Workspace identity.
10. Space composition determines which Workspaces a Space exposes.
11. Different Space domains must not require parallel Workspace/navigation
    architectures.
12. SpaceShell remains domain-agnostic; Workspace business logic never enters
    SpaceShell.
13. `dataNeeds` is orchestration metadata, not the Workspace's domain contract.
14. Domain-specific Workspace data contracts are created only where stable
    composition boundaries justify them.
15. Shared Space capabilities belong at the SpaceShell boundary.

### H. Transitional state — recorded honestly (nothing over-claimed)

The universal model is established in *identity and doctrine*; the following are known,
deliberate gaps, each a later-slice activation, not a category defect:

- **HQ Platform Spaces now render through the shared `SpaceShell` frame (SD-2E)** —
  the render-layer fork is gone. What remains deferred is *registry/composition
  participation* (the Platform Overview is a Workspace in the shell slot but is not
  yet a `WORKSPACE_REGISTRY` entry; composition stays platform-local) and future
  operational Perspectives (§C). Admin Panel and Merchant Ops remain separate internal
  surfaces, out of scope here.
- **The finance-scoped unions (`WorkspaceDataNeed`, `WorkspaceEnvelopeSource`,
  `RoutedWorkspaceTab`) are still typed onto the universal `WorkspaceDefinition`
  base** as optional fields. Segregating them onto a Personal-Finance specialization
  is an SD-3 task, done when the first non-finance Workspace registers (§E).
- **`SpaceTemplate` (the intended long-term composition owner) is dormant** — composition
  today is `PERSPECTIVES_BY_CATEGORY` + `railVisibleTabs` (finance) and
  `PLATFORM_AREAS[area].sections` (HQ). Seam preserved; activation is SP-2 (§D).
- **Goals remains physically in `PERSPECTIVE_LIBRARY`** (tagged `kind:"standard"`);
  relocation to `STANDARD_WORKSPACES` is deferred to avoid navigation churn (SD-2B §5).
- **`consumesShellTime`, `getWorkspaceForTab`, and the registry routing helpers are
  declared/consumed for identity but the SD-3 declarative loader is not built** —
  these describe the intended contract, not a shipped loader (consistent with the
  Implemented/Planned reading contract).

**Census evidence:** `prisma/schema.prisma` (`enum PlatformArea`, `Space.platformArea
@unique`), `lib/platform/policy.ts` (`PLATFORM_AREAS`), `lib/platform/seed.ts`,
`app/(shell)/dashboard/platform/[area]/page.tsx`, `components/platform/
PlatformSpaceDashboard.tsx`, `components/platform/widget-kit.tsx`, `lib/perspectives.ts`
(`WORKSPACE_REGISTRY`, `WorkspaceDefinition`), `lib/space-nav.ts` (`railVisibleTabs`),
`lib/space-presets.ts` / `lib/space-templates/` (`SpaceTemplate`), `lib/merchant-ops-
access.ts`, `app/admin/*`.
