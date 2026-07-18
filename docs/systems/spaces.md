# Spaces (dashboard architecture)

## Purpose

The Spaces system is the composition architecture behind every Space dashboard.
It separates the permanent visual frame of a Space (header, navigation rail,
toolbar, overlays, the workspace viewport) from the interchangeable *workspaces*
that fill that frame (Overview, Transactions, Accounts, Activity, Members, and
the financial lenses: Wealth, Cash Flow, Investments, Debt, Liquidity, Goals).
The goal is that a workspace owns its own data, currency conversion, and trust
envelope, while the shell knows nothing about any domain — so new workspaces
(and new domains such as Platform Operations) plug in by registration, not by
editing the host.

## Authority

- `components/space/shell/SpaceShell.tsx` — the permanent, workspace-AGNOSTIC
  frame. Owns only chrome + layout: overlays mount point, header (title/subtitle
  + display-currency slot), toolbar slot, the Space-level navigation rail, and
  the workspace slot (`children`).
- `lib/space/space-url.ts` — the ONE canonical Space-URL serialization core
  (pure string arithmetic); `components/space/shell/useSpaceUrl.ts` — the single
  runtime seam owning History writes and the one popstate listener.
- `lib/perspectives.ts` — `WORKSPACE_REGISTRY`, the ONE identity authority over
  every primary destination (standard + perspective + platform), plus
  `WorkspaceDefinition` and the routing helpers.
- `lib/space/workspace-resources.ts` — the declarative resource orchestrator
  that resolves a workspace's `dataNeeds` to activate existing loaders.
- `lib/perspectives/envelope.ts` — `resolvePerspectiveEnvelope`, the per-
  perspective trust-envelope resolver the shell renders.

## Inputs

- The URL query string. The Space-scoped params are `tab`, `perspective`,
  `metric`, `asof`, `compareto`, `preset`, `account`, `transaction`
  (`SPACE_URL_PARAMS`). These carry navigation state, the canonical time window
  (asOf/compareTo), and drawer/selection state.
- The Space's category, which selects the ordered perspective set
  (`PERSPECTIVES_BY_CATEGORY` in `lib/perspectives.ts`).
- Per-workspace data primitives (`accounts`, `snapshots`, `transactions`,
  `lens`, `investmentsHistory`, `goals`, `sections`, `fico`) — declared, not
  imperatively fetched, via `WorkspaceDefinition.dataNeeds`.

## Outputs

- A rendered Space: the shell frame composing the active workspace's body in its
  slot, the display-currency control, and (for perspectives) the trust envelope
  (Completeness + Evidence) surfaced by the shell from whatever the active lens
  supplies.
- Canonical URL transitions (via `useSpaceUrl` / `buildSpaceUrl`) that preserve
  every unrelated param.

## Canonical contracts

- **SpaceShell = frame only.** It is workspace-agnostic; anything domain-
  specific (toolbar buttons, header text, dialogs, the body) arrives as
  props/slots the host composes. The shell performs no FX math and does not
  touch the URL or time authorities.
- **WorkspaceDefinition + WORKSPACE_REGISTRY** are the single identity authority.
  A `WorkspaceKind` is `"standard"` (structural destination rendered directly in
  the slot) or `"perspective"` (a temporal financial lens participating in
  asOf/compareTo). Every Perspective is a Workspace; not every Workspace is a
  Perspective. `PerspectiveDef extends WorkspaceDefinition`. A `domain` field
  (`"finance"` default | `"platform"`) keeps finance vocabularies out of
  Platform definitions without a base/subclass type split.
- **Navigation IA (M2 canonical).** There is ONE Workspace model and two
  navigation planes (global destinations · in-Space workspaces). Perspectives are
  specialized Workspaces selected **through the Overview experience**
  (`?perspective=<id>`), NOT a rail tier — `PERSPECTIVES` is no longer in
  `SPACE_TAB_ORDER`. On Overview, no engaged lens ⇒ the summary; an engaged lens ⇒
  that Perspective's Workspace occupies the content slot (the selector's "Overview"
  item returns to the summary). Depth lives in **Sections** (DB or virtual);
  transient detail in **Panels/Drills**. Debt and Investments have exactly ONE
  runtime destination each (their Perspective) — their former
  `routing.targetTab`/`RoutedWorkspaceModal` overlays are retired; legacy
  `?tab=debt|credit|investments` links canonicalize to `?perspective=…` via
  `legacyTabPerspective` in `lib/space/space-url.ts`. Goals and Retirement remain
  `RoutedWorkspaceModal` surfaces as an explicit, isolated compatibility boundary
  (`ROUTED_WORKSPACE_TABS = {GOALS, RETIREMENT}`) until their product architecture
  is decided.
- **Declarative loading (dataNeeds).** A workspace DECLARES what it may consume;
  the host RESOLVES those needs to activate existing loaders. `dataNeeds` is
  orchestration metadata only — never a DTO, a domain contract, or a fetch. The
  domain envelopes (`InvestmentsSpaceData`, `ConnectionsSpaceData`, future
  `*SpaceData`) stay entirely separate. `workspace-resources.ts` is domain-
  agnostic: any domain that registers a definition is orchestrated by the same
  code.
- **One URL authority.** Every writer routes its next query string through
  `applySpaceUrlUpdate`/`buildSpaceUrl`, which set/delete only the keys named and
  leave every other key byte-for-byte untouched — so no writer clobbers another.
- **One time authority (SD-0B).** The canonical time model is asOf/compareTo.
  Only workspaces with `consumesShellTime: true` (Wealth, Investments, Debt,
  Liquidity) read it; Cash Flow deliberately does not — it has its own
  period/calendar semantics and reads the derived preset dimension instead.
- **Workspace owns data + FX + envelope.** A financial workspace consumes its
  own `*SpaceData` (via a dedicated hook/route), applies display-currency
  conversion through the one canonical money seam, and emits its trust envelope
  outward through `onEnvelopeChange` (see
  `components/space/widgets/investments/InvestmentsWorkspace.tsx`).

## Persistence

- The Spaces architecture is a composition layer, not a data store. It persists
  nothing of its own; navigation/time state lives in the URL, and section
  enablement/order comes from DB-seeded section rows consumed by the section
  subsystem. The registry, URL core, and resource orchestrator are pure
  client-safe config/logic modules with no schema.

## Consumers

- The host (`SpaceDashboard`) composes `<SpaceShell>` and passes the active
  tab's body as `children`.
- Standard workspaces live in `components/space/workspaces/`
  (Overview / Transactions / Accounts / Activity / Members / RoutedWorkspaceModal
  + `SpaceSectionStack`).
- Financial-lens workspaces live under `components/space/widgets/<domain>/`
  (e.g. `investments/InvestmentsWorkspace.tsx`, `wealth/WealthWorkspace.tsx`,
  `debt/DebtWorkspace.tsx`, `liquidity/LiquidityWorkspace.tsx`,
  `cashflow/CashFlowWorkspace.tsx`), each with its own `use<Domain>SpaceData`
  hook.
- The section subsystem (`components/space/sections/SpaceSections.tsx`) provides
  the shared `SectionCard`/`SectionRegistry` compositor that both tab sections
  and perspective "virtual sections" (`lib/perspectives/virtual-sections.ts`)
  mount through.

## Invariants

- The shell never names a specific tab or domain; behavioral branches are
  expressed as neutral props (e.g. `railStatic`, now driven by
  `perspectiveEngaged` — a lens engaged through Overview — rather than a
  `PERSPECTIVES` tab).
- `WORKSPACE_REGISTRY` is composed from disjoint id sets (standard, perspective,
  `platform-*`-namespaced) so no identity is duplicated and no finance helper
  ever sees a Platform entry.
- A `PerspectiveDef` with a `lensId` must be status `"available"` and have a
  registered lens module — a computed answer can never be "coming soon".
- Display currency governs the WHOLE Space, so its control mounts in the shell
  header, not inside any one workspace; the shell still does no FX math.
- Unrelated URL params always survive a navigation.

## Known limitations

- `dataNeeds` is a resource CEILING (what a workspace MAY consume), not a fetch
  schedule. The structural tabs (Overview / Transactions / Accounts) keep some
  category-aware activation in the host; fully declarative loading for them is
  deferred.
- Some workspaces still mount via a dedicated host branch rather than the generic
  virtual-sections path — e.g. Investments' `widgets: ["investments_workspace"]`
  is only a `.length > 0` "has-workspace" marker, not a rendered registry key.
- Goals is doctrinally a `"standard"` workspace but still physically lives in
  `PERSPECTIVE_LIBRARY` (kept there so today's sub-nav card render is unchanged);
  relocation is deferred.
- Debt's `consumesShellTime: true` is the intended contract, but its history
  chart windowing to the shell asOf/compareTo is a documented runtime gap.

## Extension points

- **New workspace:** register a `WorkspaceDefinition` (or `PerspectiveDef`) in
  `lib/perspectives.ts` with its `dataNeeds`, `consumesShellTime`, and
  `envelope`; add the component under `components/space/widgets/<domain>/` (or
  `workspaces/`); the shell, URL authority, resource orchestrator, and envelope
  seam absorb it with no change.
- **New domain (e.g. Platform Operations):** ship a `PLATFORM_WORKSPACES`-style
  module unioned into `WORKSPACE_REGISTRY`; declare `domain: "platform"` and omit
  the finance vocabularies. `workspace-resources.ts` orchestrates it unchanged.
- **New URL param:** add it to `SPACE_URL_PARAMS`; the param-agnostic core needs
  no other change.
- **New envelope source:** wire it in `resolvePerspectiveEnvelope` without
  touching the shell.

## Why the architecture is this way

The system was extracted out of a single monolithic `SpaceDashboard` component
that owned the frame, the tabs, every workspace's data-fetching, the URL writes,
and the time model all at once. That coupling made every new lens a host edit
and produced the failure modes this design removes: multiple independent History
writers clobbering each other's query params (now one non-clobbering URL
authority); per-perspective fetch booleans hardcoding "debt ⇒ snapshots" in the
host (now registry `dataNeeds` the host resolves generically); and workspace-
specific concerns leaking into shared chrome (now the shell is provably
domain-agnostic, which is what let Platform Operations become a second consumer
of the same frame and registry without a parallel system). Making each workspace
own its own `*SpaceData` + FX + envelope keeps money math and trust disclosure
next to the data they describe, so the frame never has to know what any lens
means.
