# Space Architecture

*Governs the Space platform: the permanent workspace-agnostic frame, the ownership boundaries between shell / workspace / shared services, and what a Perspective is. These are binding architectural rules, not a status report. See also [Financial Truth Spine](./FINANCIAL_TRUTH_SPINE.md), [Security Model](./SECURITY_MODEL.md), [UI Interaction Model](./UI_INTERACTION_MODEL.md), [money & FX](../systems/money-and-fx.md).*

> **New here? The one mental model.** A **Space** is the universal container primitive
> — a person's, household's, or entity's financial world (and, for internal teams, an
> HQ operating area). Everything renders through one frame:
>
> ```
> Space ── the durable environment (identity · membership · permission boundary · composition)
>   └── SpaceShell ── the permanent, domain-AGNOSTIC frame (nav · URL · time · chrome)
>         ├── PerspectiveShell ── (when a lens is engaged) the time/trust/lens header
>         └── Workspace ── the domain experience (its own data · math · FX · trust)
> ```
>
> A **Space IS**: an identity container · a membership container · a permission
> boundary · a composition container. A **Space is NOT**: a calculation engine · an
> authorization shortcut · a domain-specific application · a database authority · a
> command centre. Financial truth lives in the [Financial Truth Spine](./FINANCIAL_TRUTH_SPINE.md);
> authorization lives in the [Security Model](./SECURITY_MODEL.md). A Space *composes*
> those; it never *owns* them. The §"universal model" (§15) and the §"shell hierarchy"
> addendum below are the load-bearing sections for a newcomer.

This document describes the target architecture and the boundaries every Space
must hold. Where it names a runtime invariant, that invariant holds in the working
tree. The closing "As built" addendum records the architecture as actually shipped.

> **Reading contract.** A concern lives in exactly one tier — SpaceShell, a
> Workspace, or a Shared service. A tier that reaches across the boundary (a
> workspace that writes the URL, a shell that computes a figure, a host that
> assembles a workspace's data from raw arrays) is a boundary violation, not a
> shortcut.

---

## 1. Purpose of SpaceShell

`SpaceShell` is the **permanent application frame** — the single, Space-agnostic
host that every Space (Personal and shared alike) renders through. It is the
surface that persists as the member moves between workspaces; the workspace below
it changes, the shell does not.

SpaceShell **owns**:

- **Navigation** — the fixed rail, the active-tab state, workspace routing.
- **Workspace switching** — selecting which workspace occupies the slot.
- **URL state** — the single authority for every query parameter (§7).
- **Time controls** — the one canonical time model surfaced to the member (§8).
- **Refresh / invalidation** — the cross-cutting data-refresh / currency-change bus.
- **Shell overlays** — shell-level dialogs and drawers (Create Space, transaction detail).
- **Responsive layout** — the desktop/mobile frame; the workspace never re-implements it (§10).
- **Shell-level utilities** — global chrome (header, sidebar, notifications, background).
- **Shared Space capabilities** — Space-wide controls that belong to the frame, not to any one workspace. The display-currency / FX ("view as") control is the current example (§9).

SpaceShell **does not own workspace business logic.** It orchestrates; it never
computes a workspace's figures, never derives a workspace's domain state, and never
reaches into a workspace's result to assemble something on the workspace's behalf.
**It never knows domain semantics** — it cannot name Investments, Job Health, or an
Audit Feed.

---

## 2. Purpose of Workspaces

A **workspace** is an **isolated business domain** — one lens onto the Space's
data, self-contained in its rendering and its domain behavior. Each workspace owns
**only its own rendering and domain behavior** — the widgets it draws, the domain
math it runs, the actions it exposes, how it presents (and converts) its own
values. A workspace is blind to the other workspaces and to the shell's internals.
It receives context; it does not manage the frame.

Personal Finance workspaces: **Overview, Cash Flow, Liquidity, Investments, Wealth,
Debt, Goals, Transactions, Accounts, Activity, Members.**

---

## 3. Ownership Boundaries

Ownership is exclusive. A concern lives in exactly one of the three tiers.

### SpaceShell owns
Navigation · URL authority · deep links · shell dialogs · responsive behavior ·
workspace registry · refresh bus · the FX/display-currency control · layout
composition.

### Workspaces own
Rendering · workspace actions · workspace-specific conversion (native-vs-converted
presentation of their own values) · workspace-specific dialogs · domain
calculations · their own trust/completeness envelope.

### Shared services own
Canonical loaders (`*SpaceData`) · the time reducer · the conversion engine ·
envelopes (trust / completeness) · registries · `SectionRegistry` (the widget
compositor) · data contracts (the typed DTOs).

---

## 4. Workspace Registration Doctrine

Every workspace is declared through a **single registry** (`WORKSPACE_REGISTRY`,
`lib/perspectives.ts`). There is no second place a workspace's identity,
availability, or routing may be defined.

A `WorkspaceDefinition` declares: **identity · label · icon · kind
(`standard` | `perspective`) · routing · render entry · envelope source · dataNeeds
· consumesShellTime · status/group metadata.**

- **The structural base is domain-neutral.** `id`, `label`, `icon`, `kind`, and
  `consumesShellTime` name no financial concept. `kind` is the only semantic
  discriminator and is domain-agnostic.
- **`dataNeeds`, `envelope`, and `routing.targetTab` carry Personal-Finance-scoped
  closed unions.** They are the finance domain's vocabulary, not universal ones.
  They only bite a workspace that opts INTO declarative loading; an HQ / operational
  Standard Workspace registers as `{ id, label, icon, kind: "standard" }` with no
  envelope/routing and no dataNeeds (empty ⇒ self-fetch). No second definition
  system is needed for non-finance domains; the finance-scoped unions segregate onto
  a Personal-Finance specialization when the first non-finance workspace registers.

---

## 5. Data Loading Doctrine

The canonical loader pattern: a **single `load…SpaceData(scope) → …SpaceData`
loader** returns one typed, canonical envelope for a workspace. The host composes
envelopes; it never assembles a workspace's data from raw arrays at render time.

- **`InvestmentsSpaceData`** (`lib/investments/space-data.ts`) and
  **`ConnectionsSpaceData`** (`lib/connections/space-data.ts`) are the canonical
  loader-backed contracts.
- **A `…SpaceData` loader is created only where a stable composition boundary
  justifies it.** `WealthResult` is the canonical Wealth boundary as a pure client
  read-model (`computeWealthTimeMachine → WealthResult`, `lib/wealth/`), over one
  Space-level shared `Snapshot[]` fetch — **no `WealthSpaceData` was created**,
  because Wealth has no multi-read composition graph and a wealth-branded loader
  would only relocate a pure function or duplicate the shared snapshot fetch. A
  parallel loader for a workspace that already has a canonical boundary is a
  prohibited anti-pattern.

---

## 6. Navigation Doctrine

Navigation belongs **exclusively to SpaceShell.**

- The **rail ordering is canonical** and fixed (`SPACE_TAB_ORDER`, `lib/space-nav.ts`) — a cross-Space muscle-memory contract ("Accounts is always third").
- **Workspaces never reorder rails.** A workspace may **only declare its availability** (present / placeholder / manager-only) via its registry entry. It may not add, remove, or re-sequence rail entries.
- A host may choose not to *render* a tab it is allowed to hide (e.g. SETTINGS for non-managers), but it never reorders the tabs it does render.

---

## 7. Deep-Link Doctrine

There is **one URL authority**, owned by SpaceShell. One owner writes browser
history for Space state; one owner listens for Back/Forward. No workspace grabs
`window.history` for itself. All serialization goes through one pure core.

---

## 8. Time-Control Doctrine

There is **one canonical time reducer** (`lib/perspectives/time-range.ts`) owning
`{ preset, asOf, compareTo }`. The shell renders the time controls; workspaces
**read** time context and **never own** it. No time slice may live outside the
canonical reducer.

---

## 9. FX Ownership Doctrine

- **Shell owns:** the FX selector ("view as" control) and the reporting-currency controls — a shared Space capability mounted at the frame boundary. The shell performs **no** FX math; it only renders the host-provided control.
- **Shared services own:** the conversion engine (`lib/money/convert`, `lib/currency-context`) — pure conversion math and the display-currency provider.
- **Workspaces own:** *how* their values are converted — the native-vs-converted presentation decision for their own figures (converted headline sums, native itemized rows). See the [money & FX](../systems/money-and-fx.md) doctrine for the conversion rules themselves.

---

## 10. Responsive Ownership Doctrine

Responsive behavior belongs to **SpaceShell.** The desktop/mobile split (header,
bottom nav, sidebar) is a property of the frame and must **never** be re-implemented
independently inside a workspace. A workspace lays out its own content responsively
within its slot; it does not own or duplicate the frame-level responsive behavior.

---

## 11. Workspace Composition Doctrine

The canonical composition chain, top to bottom:

```
Canonical data
      ↓
   *SpaceData / read-model    (shared service — one typed boundary per workspace)
      ↓
   Workspace                  (consumes its boundary; renders; runs domain math; converts its own values)
      ↓
   SpaceShell                 (orchestrates the frame; places the workspace in the slot)
```

Data flows up through the boundary into the workspace; control flows down from the
shell into the slot. Neither tier reaches across.

---

## 12. Runtime Invariants

1. **Investments — Current vs. Historical, never cross-derived.** `Current → getCurrentPositions()` (A10-at-today). `Historical → A10` (`getInvestmentsTimeMachine`, verbatim). The current view is never derived from the Time Machine, and no surface reaches a historical portfolio through the current seam.
2. **URL — single shell authority.** One owner writes query state. No workspace writes `window.history`.
3. **Time — single reducer.** One `{preset, asOf, compareTo}` owner. No duplicate time state.
4. **FX — shell owns the control.** The conversion engine is a shared service; workspaces own only presentation of their own values.
5. **Transactions — server-side visibility filtering.** Visibility filtering stays inside the server loader (`lib/data/transactions.ts`); it is never re-derived client-side (see [Financial Truth Spine §10](./FINANCIAL_TRUTH_SPINE.md)).
6. **Rail ordering is immutable.** `SPACE_TAB_ORDER` is canonical; workspaces declare availability only.
7. **Envelope ownership.** Trust/completeness envelopes carry no fabricated counts and no percentages; an absent envelope renders an inert "—", never invented detail. Each workspace supplies its own envelope; the shell renders it.
8. **Snapshot honesty.** `fxMiss` snapshot rows are dropped from any plotted series — a shorter honest trend over a silently mixed-magnitude one.
9. **Name resolution order.** Account display names resolve `displayName ?? officialName ?? plaidName ?? name` — the single canonical order shared by every contract.

Supporting mechanism invariants: URL state uses `window.history`, never the
`useSearchParams` hook (which would force a Suspense boundary); time defaults are
SSR-safe (MTD), hydrated from the URL post-mount.

---

## 13. Future Workspace Rules

Every future workspace **must** expose one canonical loader/boundary, one render
entry, one envelope, and declare its `dataNeeds`. Every future workspace **must
never** own URL state, navigation, responsive layout, global refresh, or shell
dialogs.

---

## 14. Explicit Anti-Patterns

Each is a boundary violation the architecture exists to eliminate:

- **Multiple URL writers** — more than one owner of `window.history` / query state.
- **Duplicate time state** — any time slice living outside the canonical reducer.
- **Inline data loading inside the host** — assembling a workspace's data from raw arrays at render time instead of through a loader/boundary.
- **Workspace-owned navigation** — a workspace mutating the rail, tabs, or routing.
- **Duplicate trust builders** — a second envelope/completeness assembler outside the shared envelope service.
- **Client-derived canonical data** — recomputing a figure of record on the client that a canonical loader already owns.
- **Institution-name joins** — joining accounts/connections by institution string instead of stable id.
- **Parallel loader implementations** — a second loader for a workspace that already has a canonical one.

---

## 15. Space / Workspace / Perspective — the universal model

Fourth Meridian's internal HQ surfaces (Platform Operations, Security Operations,
Growth & Revenue, Customer Success) reuse this **same** architecture rather than
fork into a separate admin framework. The definitions below are therefore
domain-neutral.

### Definitions

- **Space** — a durable domain/environment that composes Workspaces. A Personal Finance Space and a Platform Operations Space are the **same architectural primitive**: same `SpaceShell`, same Workspace/navigation architecture; they differ only in domain, Workspace composition, data, and *permitted presentation*. The invariant is **same primitives, same architecture — not pixel-identical presentation.**
- **SpaceShell** — the domain-agnostic visual/runtime frame (§1).
- **Workspace** — a primary functional destination rendered inside the SpaceShell workspace region.
- **Standard Workspace** — a functional/domain Workspace whose primary purpose is operational interaction rather than analytical temporal comparison (Overview, Transactions, Accounts, Activity, Members, Goals).
- **Perspective Workspace** — a specialized analytical Workspace (below).
- **Workspace Registry** (`WORKSPACE_REGISTRY`) — the ONE authority for Workspace *identity* and shell-facing metadata.
- **Space Composition** — the separate authority for *which* registered Workspaces a particular Space exposes. Identity and composition are different concerns: the global registry must not decide that every Space has every Workspace.

### The Perspective definition — domain-neutral

> **A Perspective is a specialized analytical Workspace that presents a canonical
> domain through a particular lens across time and comparative states.**

- **Every Perspective is a Workspace; not every Workspace is a Perspective.** The discriminator is `kind` on `WorkspaceDefinition`.
- **Perspective is distinguished by *purpose*** — analytical, temporal/comparative, a domain lens — not by whether it happens to show time-series data (Goals shows trajectories and is still a Standard Workspace).
- **Perspective is NOT inherently financial.** The domain of a Perspective is determined by its **Space**, not by the abstraction. A future operational or security Perspective (reliability over time, provider health over time, security posture over time) would be temporal by the same semantic rule. Do not couple the abstraction to today's finance-shaped `preset/asOf/compareTo` reducer.
- **Personal Finance implementation.** For a Personal Finance Space the domain is financial; the current Perspectives — **Wealth, Cash Flow, Investments, Debt, Liquidity** — all participate in the canonical time model (`consumesShellTime: true`).
- **A runtime gap is an implementation gap, not a category difference.** A financial Perspective missing full `asOf`/`compareTo` support is an activation task for its extraction, never a reclassification to a non-temporal kind.

### Ratified invariants (domain-neutral)

1. Every primary destination rendered in the SpaceShell workspace region is a Workspace.
2. Every Perspective is a Workspace; not every Workspace is a Perspective.
3. Perspectives are analytical and temporal/comparative by purpose.
4. Perspective is not inherently financial.
5. The domain of a Perspective is determined by its Space.
6. Current Personal Finance Perspectives participate in canonical `preset / asOf / compareTo`.
7. Missing canonical-time support in a current financial Perspective is an implementation gap, not a category difference.
8. Goals is a Standard Workspace, not a Perspective.
9. Workspace Registry defines Workspace identity.
10. Space composition determines which Workspaces a Space exposes.
11. Different Space domains must not require parallel Workspace/navigation architectures.
12. SpaceShell remains domain-agnostic; Workspace business logic never enters SpaceShell.
13. `dataNeeds` is orchestration metadata, not the Workspace's domain contract.
14. Domain-specific Workspace data contracts are created only where stable composition boundaries justify them.
15. Shared Space capabilities belong at the SpaceShell boundary.

---

## 16. Perspective design laws (Personal Finance)

Within a Personal Finance Space, a Perspective is **a question, not a dashboard.**
It answers exactly one question; every visualization inside it answers a
*sub-question* of that one question. The product is organized around **questions**,
not **objects** — competitors navigate by account / transaction / investment and
leave the user to assemble the answer; Fourth Meridian navigates by the questions
themselves and the product assembles the answer.

**The five laws:**

1. **Scalar → Decomposition.** Overview owns the *scalar* (the number); a Perspective owns the *decomposition* (the shape behind it). Overview answers **"what?"**; a Perspective answers **"why?"**. A Perspective that renders a scalar Overview already shows is repeating, not decomposing.
2. **One-Question.** Each Perspective has a single primary question; every widget maps to a sub-question of it. A widget answering a different question belongs to a different Perspective (or is cut).
3. **Verdict-First.** Every Perspective opens with a one-sentence **Verdict** — an AI-computed claim — and the widgets beneath exist to prove it. A verdict must be provable by a widget in the same Perspective (no orphan claims); it degrades gracefully to a neutral description when data is thin, never fabricating. Overview's verdict is the ranked set of the Perspectives' verdicts.
4. **Graph-Projection.** There is one financial graph (accounts → institutions → asset classes → holdings → transactions → merchants → flows → goals → time). A Perspective is a *projection/query* over that graph. New data sources are new graph edges that light up existing Perspectives rather than spawning new ones.
5. **No-Duplication.** No two Perspectives answer the same question. If two lenses fight over a widget, one has the wrong question. (Corollary: Investments is "how well" — returns/positions/fees — never "Wealth's investment slice," which is "where.")

**The Perspective Test** (what earns first-class status): a candidate must be a
**real question** a user would ask in roughly those words, be **irreducible** (not
answerable by re-filtering another Perspective), produce its **own verdict**, and
have a **native grammar** (a hero visualization no other lens uses). Fail
irreducibility or native-grammar ⇒ it is a **widget** inside another Perspective,
not a Perspective. Promote a widget to first-class only when its question becomes
irreducible and earns a native grammar.

---

## Addendum — As built (SD-0A … SD-7)

The architecture as actually shipped, top of stack to bottom:

- **Space** — the durable environment. Personal Finance Spaces and the four HQ Platform Spaces (`Space.platformArea @unique`) are the same primitive; both render `DashboardChrome → SpaceShell → Workspace`.
- **SpaceShell** (`components/space/shell/SpaceShell.tsx`) — the permanent, workspace-agnostic frame: header, rail, toolbar, overlays, and the workspace slot. It mounts shared Space capabilities (the display-currency / FX control) and performs no domain math.
- **One canonical URL authority** — `useSpaceUrl` (`components/space/shell/useSpaceUrl.ts`) over the pure `lib/space/space-url.ts` core is the single writer of Space browser-history state and the single `popstate` owner. The former three independent URL writers (tab/perspective/metric · asOf/compareTo/preset · transaction) all commit through it; no workspace touches `window.history`.
- **One canonical time authority** — `{preset, asOf, compareTo}` in the single time reducer; the former second time state (`cashFlowPeriod`) is folded in and derived, not owned separately.
- **Declarative, dataNeeds-derived workspace loading** — `lib/space/workspace-resources.ts` resolves an open Perspective's lazy loads from its declared `WORKSPACE_REGISTRY[id].dataNeeds` via a pure, domain-agnostic orchestrator. The host's former per-perspective fetch booleans are gone.
- **Workspaces** — the five standard destinations plus Goals live in `components/space/workspaces/`; the five financial Perspectives (Cash Flow, Debt, Investments, Liquidity, Wealth) live in `components/space/widgets/<domain>/…Workspace.tsx`. **Each financial workspace OWNS its own SpaceData/read-model, its per-date display-currency FX conversion, and its trust envelope** (`convertWealthSnapshots`, `convertLiquiditySpaceData`, `convertInvestmentsSpaceData`, `convertDebtHistory`); the host merely composes and relays the envelope. Section subsystem: `components/space/sections/`; view types: `lib/space/dashboard-types.ts`.
- **Standard Workspace vs Perspective** — carried on `kind` in the registry: `standard` for the structural/domain destinations, `perspective` for the analytical temporal lenses. Perspectives are domain-neutral by definition (§15); the financial ones bind to the canonical time model, HQ/operational ones self-fetch.

---

## 17. The shell hierarchy & the workspace contract (as built)

*This section folds in the former `WORKSPACE_CONTRACT_DOCTRINE` and `systems/spaces`
docs so a newcomer has one home. It describes the runtime as shipped (SD-9).*

### 17.1 The shell hierarchy — three responsibilities, precise runtime shape

`SpaceShell → PerspectiveShell → Workspace` is a **responsibility** hierarchy. At
runtime, **PerspectiveShell and the workspace body are siblings** mounted inside
SpaceShell's slot — PerspectiveShell is the perspective *chrome header* rendered
*above* the workspace renderer's output, not a wrapper the workspace nests in.

- **`SpaceShell`** (`components/space/shell/SpaceShell.tsx`) — the permanent,
  domain-agnostic frame. Owns *only* chrome + layout: overlays mount point, header
  (title/subtitle + display-currency slot), toolbar slot, the navigation rail, and
  the workspace slot. Performs **no** FX math, touches **neither** the URL nor time
  authorities, and never names a specific tab or domain. Two frame variants: `space`
  (finance/platform inside a Space) and `utility` (Connections/Settings, global-nav
  peers).
- **`PerspectiveShell`** (`components/space/shell/PerspectiveShell.tsx`) — the
  time/trust/lens chrome for an *engaged* Perspective, and **presentation only**. It
  renders the lens selector (`PerspectiveTabs`), the one canonical time selector
  (`TimelineLens`), and the trust row (`ShellTrustRow`). It converts a `TimelineIntent`
  into a sanctioned `ShellTimeAction` via the unit-tested adapter and routes it back
  through the *same* host callbacks the legacy controls used. It stores **no** copy of
  time — it derives its entire display from canonical state each render — owns no data,
  no envelope authority, no URL writes.
- **`Workspace`** — the registry-identified, renderer-dispatched view. Financial
  Perspectives live under `components/space/widgets/<domain>/`, standard destinations
  under `components/space/workspaces/`. Each **owns its own `*SpaceData` read-model,
  its per-date display-currency FX, and its trust envelope**, which it emits outward
  via `onEnvelopeChange`.

### 17.2 The workspace contract — six questions, one owner each

> A Workspace is a **registry-identified**, **renderer-dispatched** view over a
> **single data authority**, that **consumes canonical Space time** and **emits one
> trust envelope**.

1. **"What am I?"** (identity, routing, kind) → `WorkspaceDefinition` in the one `WORKSPACE_REGISTRY` (`lib/perspectives.ts`). Exactly one registry entry; no parallel host-side identity map.
2. **"What data powers me?"** → exactly one `*SpaceData`/`*Result` authority. Every figure reads a *derived* field; widgets never recompute, re-sum, or re-value.
3. **"How do I consume time?"** → `temporalCapability {asOf, compareTo, period}`, each `full | partial | none`. The workspace owns no local `now`/period state; every window derives from the shell's resolved `{asOf, compareTo}`.
4. **"How do I communicate trust?"** → one `PerspectiveEnvelope` via `resolvePerspectiveEnvelope → TrustIndicator`, using the canonical `CompletenessTier` vocabulary. No hand-authored confidence strings.
5. **"How am I rendered?"** → `WORKSPACE_RENDERERS[id]` (perspectives) or the shell slot (standard).
6. **"What do I need / expose?"** → `dataNeeds[]`, `routing`, `widgets[]`, `envelope` source. **No bypass** — no workspace reads Prisma/`db` directly; every server read routes through the authority's endpoint.

**Two kinds** (`kind` on the registry): `perspective` (a financial lens participating
in canonical time — Wealth, Cash Flow, Investments, Debt, Liquidity; renderer-
dispatched) and `standard` (a structural destination — Overview, Transactions,
Accounts, Activity, Members, Goals; shell-slot). Every Perspective is a Workspace;
not every Workspace is a Perspective. One registry over both.

### 17.3 The four domain classes

A `WorkspaceDefinition.domain` (default `finance`) places a workspace in one class:

| Domain | Owns | Data authority | Time | Trust | Frame |
|---|---|---|---|---|---|
| `finance` | a Space's money | one `*SpaceData`/`*Result` | ✅ | ✅ | `space` |
| `platform` | operating-the-product signals (jobs, providers, security, growth) | self-fetching widgets | ✕ | ✕ | `space`, grant-gated |
| `connections` | credential/provider/sync lifecycle | `loadConnectionsSpaceData` | ✕ | ✕ | `utility` |
| `settings` | user account + preferences | per-section loaders | ✕ | ✕ | `utility` |

`finance` rows answer all six questions; utility rows (`connections`/`settings`)
answer 1/5/6 and are **exempt by class** from 2–4 — the exemption is *declared* via
the domain tag + a per-domain guard test, never silent.

### 17.4 The dashboard is a composition root — not a controller

`SpaceDashboard` reads as **resolve navigation → resolve time → mount runtime →
render shell**. It **must NOT own**: lens loading/fetch, lens state, the lens-refresh
signal, envelope calculation, trust-source selection, FX math, URL writes, or time
state. Each belongs to a mounted seam — `useSpaceNavigation`, `usePerspectiveShellState`,
`useSpaceLensResults`, `useActiveEnvelope`, `useSpaceUrl` — and the renderer dispatch
is registry-driven. `lib/space/space-runtime-ownership.test.ts` asserts the host owns
none of what those seams own.

**Deliberate: tab identity ≠ workspace identity.** `SPACE_TAB_LABELS` owns the tab
rail's order + copy; `WorkspaceDefinition.label` owns workspace identity (the two can
legitimately disagree — the registry `overview.label = "Atlas"` vs the rail's
"Overview").

### 17.5 The anti-framework clause

There is **no** generic `WorkspaceManager` / `WorkspaceResolver` / `DataProviderFactory`,
no new provider/registry/context layer, no base-vs-PersonalFinance type split of
`WorkspaceDefinition`, no `WorkspaceData` supertype. The authorities already exist —
one registry, one renderer map, one time authority, one trust resolver, per-workspace
data authorities. The goal is convergence, **not a seventh authority**.

### 17.6 The experience layer — panels over modals

Detail workflows use **panels, not modals**. A **Panel** (`components/atlas/panels`)
is a persistent contextual surface ("continue working while inspecting"); a **Modal**
(`OverlaySurface`) is an interrupt ("pause and complete a decision" — delete, confirm,
authenticate). Detail drills (a selected transaction, a holding, evidence) are
right-docked panels; browse/context surfaces are left-docked panels. Both share one
behaviour language (`GlassPanel`, `useOverlayBehavior`). Panels are **presentation
primitives, not ownership boundaries** — the panel family knows layout/animation/
a11y and nothing about any domain; a domain composes its detail from the slots. The
full interaction grammar — Preview → Browser → Detail, chart interrogability, and
selection invalidation — is the [UI Interaction Model](./UI_INTERACTION_MODEL.md).
