# UI Convergence Roadmap

*Architectural migration plan. Investigation only — nothing in this document has been
implemented. The goal is to move the remaining application surfaces onto the Space/Workspace
architecture and the Atlas primitive layer, so Fourth Meridian stops feeling like "a dashboard
with pages" and starts feeling like an operating system built around Spaces.*

**Status:** proposed. **Track prefix:** to be allocated in
[`initiative-naming.md`](./initiative-naming.md) — suggested `UIC-x` (UI Convergence),
distinct from `UI-x` (Atlas design-system) and `SD-x` (SpaceDashboard decomposition), which it
extends. **Scope authority for this plan:** the Space doctrine in
[`../systems/spaces.md`](../systems/spaces.md) and the Platform Ops doctrine in
[`../systems/platform-ops.md`](../systems/platform-ops.md).

---

## The load-bearing fact

**This migration has already been executed once, in production.**
`components/platform/PlatformSpaceDashboard.tsx` renders Platform Operations, Security
Operations, Growth & Revenue, and Customer Success **through the same `SpaceShell` and the same
universal `WORKSPACE_REGISTRY`** the financial Spaces use — with `domain: "platform"` workspace
definitions, its own widget registry, and zero finance imports. The shell + registry + URL + trust
layer was built domain-neutral, and Platform is the standing proof.

Everything below is therefore **"follow the worked example,"** not "invent an abstraction." The
seam between neutral and financial is already drawn and already load-bearing:

| Layer | Coupling | Reuse for a non-financial surface |
|---|---|---|
| `SpaceShell` (`components/space/shell/SpaceShell.tsx`) | **Neutral** | **As-is** — Platform already mounts it |
| `WorkspaceDefinition` + `WORKSPACE_REGISTRY` (`lib/perspectives.ts`) | **Neutral** (union across domains) | **As-is** — add `domain`-tagged, namespaced definitions |
| `PLATFORM_AREA_WORKSPACES` composition pattern (`lib/platform/workspaces.ts`) | Neutral template | **Copy the pattern** for the new domain |
| `useSpaceUrl` + `lib/space/space-url.ts` (param-agnostic core) | **Neutral** | **As-is** — name your own params |
| `TrustIndicator` + `CompletenessTier` + `PerspectiveEnvelope` | **Neutral** | **As-is** — hand-build an envelope |
| `PerspectiveShell` (asOf/compareTo/Completeness/Evidence instrument) | Financial (types + controls) | Not as-is; only Spaces that need time-travel take it |
| `useSpaceData` (`/api/spaces/*` endpoints) | Financial | Not reusable — write a surface-specific fetch |
| `useSpaceNavigation` (finance tab vocabulary) | Financial | Parallel hook, or route via `useRouter` like Platform does |
| `WORKSPACE_RENDERERS` / `WorkspaceRenderCtx` | Financial | Parallel renderer/widget map (Platform has `PLATFORM_WIDGET_REGISTRY`) |
| `SectionRegistry` / finance `widgets/*` | Financial | Reuse the *pattern*, supply your own registry |

**Reading of the seam:** *neutral* = the frame, the identity/registry, the URL authority, and the
trust contract. *Financial* = the data hooks, the nav vocabulary, the time instrument, and the
section/widget registries. A new surface reuses the four neutral pillars and brings its own of the
rest — exactly what Platform did.

---

## Part 1 — Current State (UI inventory)

Three authenticated shells coexist today, plus an inline auth pattern and an isolated marketing
tree.

| Route | Route group / layout | Top-level shell | Classification | LOC |
|---|---|---|---|---|
| `/dashboard` | `(shell)` → `dashboard/layout` | `SpaceDashboard` / `PersonalDashboard` | **DashboardChrome + SpaceShell** | 108 |
| `/dashboard/platform/[area]` | `(shell)` | `PlatformSpaceDashboard` | **DashboardChrome + SpaceShell** ✅ already converged | 89 |
| `/dashboard/connections` | `(shell)` | `ConnectionsList` (flat) | DashboardChrome, no rail | 58 |
| `/dashboard/spaces` | `(shell)` | `SpacesClient` (Space picker) | DashboardChrome | 214 |
| `/dashboard/settings` (+ 6 subroutes) | `(shell)` | `DataCard` index → route-per-section | DashboardChrome, no rail, **route-per-section** | ~1,210 |
| `/dashboard/credit`, `/dashboard/analyze` | `(shell)` | `DebtClient`, `AnalyzeClient` | DashboardChrome | 41 / 52 |
| `/dashboard/brief` | **`(brief)`** (own layout) | `DailyBriefClient` | **Brief standalone shell** (no chrome, by design) | ~2,530 |
| `/login` `/register` `/forgot-password` `/reset-password` `/verify-email` `/confirm-email-change` | `(auth)` — **no group layout** | inline centered card, each re-implemented | **auth-shell (inline, duplicated)** | ~1,570 |
| `/` `/about` `/security` `/request-access` `/legal/*` | `(public)` | `MarketingNav` + `Container` | **Marketing shell** (isolated by boundary test) | ~285 |
| `/admin` (+ 7 subroutes) | `admin/layout` | custom dark tables/cards | **Admin shell** (own theme, own nav, firewalled) | ~3,780 |
| `/merchant-ops` | none (bare) | `MergeReviewList` | **bare** | 40 |
| `/plaid-oauth-return` | none (bare) | Plaid Link callback | bare (transient) | 204 |
| `/prototype/*` | mixed | design experiments | out of scope | — |

**Key observations**

- **No `SpaceShell` at the layout level.** Space-vs-personal branching lives *inside*
  `app/(shell)/dashboard/page.tsx`. `DashboardChrome` (the global frame:
  `GlobalHeader` + transforming `ContextualNavbar` + `BottomNav`) is already the prototype's target
  chrome, shipped.
- **Three shells, one target.** `DashboardChrome` (all dashboard routes), the **Admin shell** (a
  separate app tree on a hardcoded dark palette with ~1 Atlas import across the whole folder), and
  the **Brief standalone shell** (deliberately escapes chrome).
- **Auth has no shared shell** — six pages each re-implement the same `bg-gray-950` centered card.
- **Settings has no `layout.tsx`** — it is a *directory of routes*, one server loader per section,
  no rail.
- **Admin conceptually overlaps Platform HQ** — users, providers, security, audit, and
  platform-access are the same operator concerns already modeled as Platform areas.

---

## Part 2 — Classification (Space / Workspace / standalone)

The organizing distinction the app already uses: **Spaces are destinations reached through the
transforming rail; Workspaces fill a Space's viewport; global utilities (Connections, Settings) are
user-owned destinations, not per-Space tabs.** Ownership decides placement — a connection and a
preference belong to the *user*, not to any one financial Space (see
[`../systems/connections.md`](../systems/connections.md): connections are `userId`-scoped, never
Space-visibility scoped).

### Type A — Should be a Space (rides `SpaceShell` + registry)

| Surface | Status | Notes |
|---|---|---|
| Personal / Business / Family customer Spaces | ✅ Already Spaces | The financial baseline |
| Platform HQ: Operations · Security · Growth · Customer Success | ✅ Already Spaces | `PlatformArea` enum, `PlatformSpaceDashboard`. **The template.** |
| **Admin → fold into Platform HQ** | ⛔ Recommend *retire, not migrate* | See Part 2.1 |
| Merchant Operations (future) | Planned | New `PlatformArea` member + area workspaces; do **not** build a fourth shell |

### Type B — Should be a Workspace / utility Space (reuse `SpaceShell`, own the body)

| Surface | Target | Cost |
|---|---|---|
| **Connections** | A **global utility Space** (`SpaceShell` + a small rail: Overview · Accounts · Activity · Diagnostics). It is user-owned, so it is its own destination, **not** a per-Space tab. Already uses `getSpaceContext()` + `loadConnectionsSpaceData` and is Atlas-native — closest surface to done. | **Low** |
| **Settings** | A **global utility Space**: collapse the 6 route-per-section pages into one `SpaceShell` host whose **rail options are the sections** (Account · Security · Preferences · Notifications · Data · Archived Assets). Leaf form components port cleanly; the route directory and per-page loaders are the rebuild. | **Medium** |

### Type C — Remain standalone (identity does not yet exist, or immersion is the point)

| Surface | Keep standalone because |
|---|---|
| Login / Register / Forgot / Reset / Verify / Confirm-email-change | They run **before identity exists** — no Space context, no rail. *But:* consolidate the six duplicated inline cards behind one `app/(auth)/layout.tsx` + shared `AuthCard`. |
| Marketing / public (`/`, `/about`, `/legal/*`, `/request-access`, `/security`) | Server-only marketing boundary (enforced by a boundary test); splittable to its own deploy. Leave as-is. |
| `/plaid-oauth-return` | Transient OAuth bounce; no shell. |
| **Brief** | Purpose-built immersive surface that deliberately escapes the chrome. Its Atlas-material usage (`GlassPanel`, Liquid) is already consistent — the only convergence that matters here. **Do not force it into `SpaceShell`.** Keep as a first-class global destination with its own layout. |

### Part 2.1 — Admin: retire into Platform HQ, do not re-theme

Admin is the single largest surface (~3,780 LOC) *and* the furthest from the target (its own dark
palette, its own sidebar, its own table idiom, ~1 Atlas import). Re-theming it in place would be
the most expensive migration for the least architectural gain — and it would **preserve a second
operator UI that overlaps the one we already built well.** Its pages map almost 1:1 onto existing
Platform areas:

| Admin page | Platform HQ home |
|---|---|
| `/admin/users`, `/admin/platform-access` | **Growth & Revenue** (user management already has routes there) |
| `/admin/security`, `/admin/audit` | **Security Operations** (auth posture, sessions, audit already modeled) |
| `/admin/providers` | **Platform Operations** (provider health already a first-class authority) |
| `/admin/spaces` | **Customer Success** (or a new Platform Ops workspace) |

**Recommendation:** treat Admin as *content to be re-homed as Platform workspaces*, gated on
`PlatformGrant` (the axis is already orthogonal to Space membership), and delete the `app/admin/*`
tree and its bespoke shell when each concern lands in its area. This is a **decision to ratify
before Wave 4**, not a mechanical port — flagged explicitly so it isn't smuggled in as "migrate
admin."

---

## Part 3 — Primitive reuse audit

**Mature layers (reuse as-is).** Material/overlay/control/chrome are strong and near-complete:
`GlassPanel`, `Surface`, `DataCard`, `GlassButton`, `SegmentedControl`, `Chips`, `Dropdown`,
`OverlaySurface` (+ `Dialog`/`FormModal`/`ConfirmDialog` presets), `tones.ts`; and the chrome —
`DashboardChrome`, `GlobalHeader`, `ContextualNavbar`, `BottomNav`, `UserMenu`. The 5-destination
nav model (Spaces · Brief · AI · Connections · Settings) already ships.

**Space pillars (reuse as-is, per the seam table above):** `SpaceShell`,
`WorkspaceDefinition`/`WORKSPACE_REGISTRY`, `useSpaceUrl`/`space-url` core,
`TrustIndicator`/`CompletenessTier`/`PerspectiveEnvelope`.

**Where each candidate surface adopts them**

- **Connections** → `SpaceShell` (rail), keeps `loadConnectionsSpaceData`; a `TrustIndicator`
  reading a hand-built envelope maps cleanly onto **sync freshness / coverage completeness** (the
  `observed | derived | estimated | incomplete | unknown` tiers fit data-health directly).
- **Settings** → `SpaceShell` (rail = sections), Atlas `DataCard` + a **new shared form-field kit**
  (today only a one-off `InlineField`).
- **Platform (Admin re-home)** → follow `PlatformSpaceDashboard` exactly: new area workspaces +
  `PLATFORM_WIDGET_REGISTRY` entries; no new shell.

---

## Part 4 — Design-system gap analysis (what blocks full migration)

The material/overlay/control/chrome layers are done. **The content/data-display and form layers are
largely un-primitized** — this, not the shell, is the real blocker. Building these once unblocks
Connections, Settings, and the Admin re-home simultaneously.

| Capability | Status | Impact / owner |
|---|---|---|
| **Form-field kit** (Field/Label/Input/Select/Toggle) | ⛔ Missing (one-off `settings/InlineField`) | **Blocks Settings.** Highest-leverage gap. |
| **Empty-state primitive** | ⛔ Missing (duplicated private fns) | Blocks every workspace's zero-data view |
| **Data table / datagrid** | ⛔ Missing (ad-hoc tables everywhere) | **Blocks Admin re-home** (users, audit, sessions) |
| **Toast / `useToast`** | ⛔ Missing (`--z-toast` token exists, no consumer) | Cross-cutting; forms and actions need it |
| **Domain-neutral viz family** (`Stat` · `Bars` · `Status`/`Meter` · `ActivityTimeline`, with the observed/reconstructed/never-observed *honesty vocabulary*) | ⛔ Prototyped only (`components/viz/` in `prototype-claude`) | Blocks Platform/Connections operator views; the prototype's biggest un-shipped idea |
| **Permission / role-gate component** (`<Can>` / `<RoleGate>`) | ⛔ Missing (server-side only) | Needed for Platform/Admin grant-gated UI |
| **Notification list / center** | 🟡 Bell only | Needed if notifications become a destination |
| **Command palette · global search** | ⛔ Missing (header center empty by doctrine) | Deferred — not on the migration critical path |
| **`SidePanel` / `PanelHost`** (edge-aware pull-out; one shell-level drill host) | 🟡 Prototyped; prod has only the single txn drawer | Enables "insight action opens the same panel a widget click would" |

**Token caveats to resolve first (from `app/globals.css`):** the **light theme is unfinished**
(`html[data-theme="light"]` is labeled *"reserved — not wired up"* while `ThemeProvider` offers
"Light Glass" — a real discrepancy to reconcile); the Material-Engine depth ladder and several
`DataCard`/`--accent-*` tokens are **additive-but-unconsumed** ("provisional, review"); one
hardcoded warning amber isn't sourced from a ramp. None block Wave 1, but the light-theme
discrepancy should be settled before broad new-surface work so surfaces aren't built twice.

---

## Part 5 — Parallelization analysis

The surfaces are **file-disjoint**, which is what makes wide parallelism safe. The only shared
files are `lib/perspectives.ts` (the registry union) and `initiative-naming.md`.

### Safe parallel slices

| Slice | Touches | Depends on | Conflict surface |
|---|---|---|---|
| **A — Form-field kit + Empty-state + Toast** (`components/atlas/*` additive) | `components/atlas/` | nothing | New files only. **Start immediately; unblocks B & D.** |
| **B — Settings utility Space** | `app/(shell)/dashboard/settings/*`, `components/settings/*` | Slice A (form kit) | Registry entry (one line in `lib/perspectives.ts`) |
| **C — Connections utility Space** | `app/(shell)/dashboard/connections/*`, `components/connections/*`, `lib/connections/*` | Empty-state (A, optional) | Registry entry |
| **D — Data table + viz family** (`components/atlas/*` or `components/viz/*` additive) | new primitive files | nothing | New files only. **Unblocks E.** |
| **E — Admin re-home into Platform HQ** | `components/platform/*`, `lib/platform/workspaces.ts`, later delete `app/admin/*` | **Decision 2.1 ratified** + Slice D (table) | `PLATFORM_AREA_WORKSPACES`, `PLATFORM_WIDGET_REGISTRY` |
| **F — Auth layout consolidation** | `app/(auth)/*` (new group layout + `AuthCard`) | nothing | Fully standalone; no registry, no Space |

### Dependency conflicts to respect

1. **`lib/perspectives.ts` registry union is a shared write.** Every new domain adds a
   `...NEW_WORKSPACES` spread and a namespaced id set. Land these as **small, separate,
   single-line commits with explicit pathspec** (per the concurrent-branch commit discipline) to
   avoid clobbering — the ids are disjoint, so the conflict is textual, not semantic.
2. **Slice A is a hard predecessor of B** (Settings is mostly forms) and a soft predecessor of C/E.
   Ship the form kit + empty-state + toast first, or B/C/E each hand-roll fields and diverge — the
   exact fragmentation this whole effort exists to end.
3. **Slice E must not start before Decision 2.1.** "Re-theme Admin in place" and "retire Admin into
   Platform HQ" are mutually exclusive and touch different trees; picking after work begins wastes a
   full surface's worth of effort.
4. **Brief and Marketing are inert** — they can be touched anytime or never; they participate in no
   registry and share no files.

**Practical concurrency:** ~4–5 agents/engineers can run at once — A and D (primitive builders) up
front, then B, C, F fully in parallel, with E trailing behind D + the decision gate.

---

## Part 6 — Target architecture

```
components/
  atlas/                  # material + overlay + control primitives (mature)
    + fields/             # NEW: Field/Label/Input/Select/Toggle (Slice A)
    + EmptyState.tsx      # NEW (Slice A)
    + Toast.tsx           # NEW (Slice A)
    + DataTable.tsx       # NEW (Slice D)
  viz/                    # NEW: domain-neutral viz family, honesty vocabulary (Slice D)
    Stat · Bars · Status/Meter · ActivityTimeline
  ui/                     # global chrome (DashboardChrome, GlobalHeader, ContextualNavbar, BottomNav)
  space/
    shell/                # SpaceShell (neutral) · PerspectiveShell (finance)
    workspaces/           # finance renderers
    sections/ widgets/    # finance section/widget registries
    trust/                # TrustIndicator (neutral) · CompletenessTier
  platform/               # Platform HQ Spaces (Ops · Security · Growth · Customer Success)
    workspaces/           # + re-homed Admin concerns (Slice E)
    widgets/              # PLATFORM_WIDGET_REGISTRY (+ new Admin widgets)
  connections/            # Connections utility-Space body (Slice C)
  settings/               # Settings utility-Space body + section components (Slice B)
  brief/                  # standalone immersive surface (unchanged)
  marketing/              # isolated public tree (unchanged)

app/
  (shell)/dashboard/
    settings/             # collapses 6 route-per-section pages → 1 SpaceShell host
    connections/          # SpaceShell host
    platform/[area]/      # unchanged (the template)
  (auth)/
    layout.tsx            # NEW: one shared AuthCard shell (Slice F)
    login · register · forgot-password · reset-password · verify-email · confirm-email-change
  (public)/               # marketing (unchanged)
  (brief)/                # brief (unchanged)
  admin/                  # DELETED after Slice E re-home
```

`lib/`: one registry authority (`lib/perspectives.ts` union) gains
`SETTINGS_WORKSPACES` and `CONNECTIONS_WORKSPACES` (namespaced ids, `domain`-tagged) beside
`PLATFORM_WORKSPACES`; `PLATFORM_AREA_WORKSPACES` gains the re-homed Admin compositions.

---

## Migration waves (gated by exit criteria, not feature lists)

Consistent with [`../plans/ROADMAP.md`](../plans/ROADMAP.md): each wave's exit criteria are the
next wave's entry criteria.

### Wave 0 — Primitive foundation *(Slices A + D)*
Build the missing content/form/viz primitives once, additively, wired to nothing.
**Exit:** shared form-field kit, `EmptyState`, `Toast`/`useToast`, `DataTable`, and the
`components/viz/` family (with the observed/reconstructed/never-observed honesty vocabulary) exist,
are storybook/test-covered, and are consumed by at least one real surface. Light-theme
discrepancy reconciled or explicitly deferred with a recorded reason.

### Wave 1 — Connections utility Space *(Slice C)*
The cheapest real migration; proves the "non-financial surface on `SpaceShell`" pattern a second
time (after Platform) on a user-owned surface.
**Exit:** `/dashboard/connections` renders inside `SpaceShell` with a rail; keeps
`loadConnectionsSpaceData`; sync-health surfaced via `TrustIndicator`; no regression in the sync
poller; one registry entry landed via explicit-pathspec commit.

### Wave 2 — Settings utility Space *(Slice B)*
Collapse the route-per-section directory into one host; sections become rail options.
**Exit:** the 6 settings subroutes render as one `SpaceShell` host; every leaf form uses the Wave 0
field kit; per-section server loaders consolidated; no lost functionality (archived-assets
included); legacy sub-URLs redirect to the workspace rail.

### Wave 3 — Auth + shell hygiene *(Slice F)*
**Exit:** one `app/(auth)/layout.tsx` + shared `AuthCard`; the six auth pages stop re-implementing
the centered card; no visual regression; marketing/brief untouched.

### Wave 4 — Platform HQ completion + Admin retirement *(Slice E — gated on Decision 2.1)*
Re-home Admin concerns (users, providers, security, audit, spaces, platform-access) as Platform
workspaces under the correct areas, grant-gated; delete `app/admin/*` and its bespoke shell.
**Exit:** each former Admin page has an equivalent Platform workspace on Atlas primitives + the Wave
0 `DataTable`; `PlatformGrant` gating verified; `app/admin/*` and `components/admin/*` deleted; the
dark admin palette no longer ships. **Entry gate:** Decision 2.1 ratified.

### Wave 5 — Ambient/panel polish *(optional, post-convergence)*
Ship the prototype's `PanelHost`/`SidePanel` (one shell-level drill host) and the
`fact → interpretation → action → drill` insight progression so an insight's action opens the same
panel a widget click would.
**Exit:** a single shell-level panel host replaces per-workspace panel state; at least one surface
demonstrates insight-action → shared-panel reuse.

---

## Constraints

**Do not:**
- Rewrite the working financial systems (the SD-x decomposition is done — don't re-open it).
- Create a duplicate shell. There is exactly one target frame (`DashboardChrome` + `SpaceShell`);
  Admin's second shell is a thing to **remove**, not to copy.
- Create a second design system. New surfaces route through Atlas; the palette-ratchet fence
  already exempts `admin`/`merchant-ops`/`marketing` — those exemptions shrink as waves land, they
  don't get formalized.
- Build generic abstractions before a second consumer exists. Platform + one migrated surface is
  the bar for "extract"; one consumer is not.

**Prefer:**
- Reuse the four neutral pillars (shell · registry · URL · trust) exactly as Platform does.
- Reuse Atlas primitives; add the missing content/form primitives once (Wave 0), not per surface.
- Thin adapters over new hierarchies (own fetch hook, own widget registry — not a base-class split).
- Incremental, file-disjoint, explicit-pathspec commits so concurrent slices don't collide.

**North star:** every surface a user reaches after login is a Space or a workspace inside one,
composed from one registry, framed by one shell, on one design system — reached through one
transforming rail. The dashboard-with-pages becomes an operating system of Spaces.

---

## Appendix — Evidence base

This plan is grounded in a read-only audit of `app/` and `components/` (routing/layouts, the Space
primitive seam, the current Settings/Connections/Admin/Platform/Brief implementations, the Atlas
primitive inventory, and the `prototype-claude` target design language). Key references:
`components/platform/PlatformSpaceDashboard.tsx` (the worked example),
`components/space/shell/SpaceShell.tsx`, `lib/perspectives.ts`, `lib/platform/workspaces.ts`,
`lib/space/space-url.ts`, `components/space/trust/TrustIndicator.tsx`,
`lib/connections/space-data.ts`, `app/(shell)/dashboard/settings/*`, `app/admin/*`,
`components/atlas/*`, `app/globals.css`, and `prototype/prototype-claude/README.md`.
