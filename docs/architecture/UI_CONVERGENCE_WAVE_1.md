# UI Convergence — Wave 1: Connections + Settings Workspace Migration

*Architecture proposal. Investigation complete; **nothing implemented**. Extends
[`UI_CONVERGENCE_ROADMAP.md`](./UI_CONVERGENCE_ROADMAP.md) Wave 1. Preserve every existing
capability — this is a presentation + ownership migration onto the Workspace model, not a feature
rewrite.*

Grounded in a file-level read-only audit of both surfaces and the proven template
(`components/platform/PlatformSpaceDashboard.tsx`, the second, non-financial consumer of
`SpaceShell` + the universal `WORKSPACE_REGISTRY`).

---

## The five determinations (answers up front)

1. **Can Connections reuse `SpaceShell` directly?** **Yes, as-is.** It is already Atlas-native
   (`DataCard`/`AtlasLiquidCard`/`GlassButton`/`FormModal`) and already loads through
   `getSpaceContext()` + the canonical `loadConnectionsSpaceData`. It has no rail today; wrapping
   the existing flat list in `SpaceShell` is nearly mechanical.

2. **Can Settings become a utility Workspace?** **Yes** — and it's the higher-value migration,
   because Settings today is a route-per-section hub-and-spoke with **no rail** and a duplicated
   back-link. Its five sections become a persistent `SpaceShell` rail. The migration splits cleanly
   into a **shell/nav slice (unblocked)** and a **form-kit slice (blocked on Wave 0 primitives)**.

3. **What shared primitives are missing?** For Settings: a **form-field kit**
   (`Field`/`Label`/`Input`/`Select`/`Toggle`/`HelpText`/`FieldError`), a **Toast / save-status**
   primitive, an **InlineBanner**, and a **SettingsSection** container — today the five sections
   hand-roll **four different save idioms**. For Connections: essentially none for Wave 1; an
   **EmptyState** primitive and (forward) the **TrustIndicator** envelope for sync health.

4. **Promote vs keep domain-specific?** **Promote:** the form-field kit, Toast, InlineBanner,
   EmptyState, SettingsSection (all cross-cutting; Admin needs them next). **Keep domain-specific:**
   `ConnectionCard` (provider semantics), the `ConnectionsList` poller (Plaid resume ladder),
   `ImportHistoryWizard`, the `SyncStatus` contract, and each Settings section's domain logic
   (password rules, notification matrix, currency). **Decompose:** `InlineField` — its generic
   input/select/edit-toggle behavior promotes into the kit; its call sites stay in Account/Preferences.

5. **What do the `WorkspaceDefinition` entries look like?** Two new namespaced, `domain`-tagged
   registries (`CONNECTIONS_WORKSPACES`, `SETTINGS_WORKSPACES`) unioned into `WORKSPACE_REGISTRY`,
   exactly like `PLATFORM_WORKSPACES`. Concrete entries in [§Target model](#target-workspace-model).

---

## Current state map

### Connections — *user-owned provider/sync layer, already Atlas-native*

```
app/(shell)/dashboard/connections/page.tsx  (58 LOC, server)
  getSpaceContext() → userId            (user-scoped; ignores spaceId)
  loadConnectionsSpaceData(userId) → { status: SyncStatus, accountsByConnectionId }
  └─ <ConnectionsActions/>              (header: Connect institution · Add wallet)
  └─ <ConnectionsList initialStatus accountsByConnectionId/>   (client poller)
        └─ <ConnectionCard/> × N        (AtlasLiquidCard | DataCard; state: importing/ready/needs_reauth/error)
              ├─ ReconnectAccountButton · EnableInvestmentsButton · SyncWalletButton
              └─ ImportHistoryButton → ImportHistoryWizard (FormModal · ConfirmDialog)
```

- **Data contract** (`lib/connections/space-data.ts`): `ConnectionsSpaceData = { status: SyncStatus;
  accountsByConnectionId: Record<connectionId, AccountLite[]> }`. `SyncStatus = { building: boolean;
  connections: SyncConnection[] }`; `SyncConnection = { id, provider: "PLAID"|"WALLET", institution,
  state: "importing"|"ready"|"needs_reauth"|"error", lastSyncedAt, errorCode, investments }`. One
  unified id space across providers. Shared verbatim with the `GET /api/sync/status` poller so poll
  and first render can't diverge.
- **Ownership boundary (load-bearing):** Connections = the **credential/sync layer**, `userId`-owned
  (`PlaidItem.userId` / `Connection.userId`). `FinancialAccount` = the **money layer**,
  Space-visibility-scoped via `SpaceAccountLink`. `AccountConnection` is the join; its sync fields
  are a mirror only. **The surface never reads balances, valuations, credit limits, `debtProfile`,
  minimum payments, or position counts** — `AccountLite = {id,name,type}` only. This is the exact
  cross-member leak PCS-2 fixed and must not regress.
- **Chrome today:** flat `DashboardChrome` page, `<h1>` + subtitle, no rail.

### Settings — *route-per-section hub-and-spoke, no rail, four save idioms*

| Route | Loader → | Component | LOC |
|---|---|---|---|
| `settings/` (index) | session only | `DataCard` + `Link` list (5 rows) + Archive icon button | 66 |
| `settings/account` | `getAccount()` | `AccountSettings` (7× `InlineField`) | 14 |
| `settings/security` | `getSecurity()` | `SecuritySettings` (password form + 6 composed cards) | 14 |
| `settings/preferences` | `getPreferences()` | `PreferencesSettings` (currency/tz/default-space) | 14 |
| `settings/notifications` | `getNotificationPreferences()` | `NotificationSettings` (category×channel matrix) | 26 |
| `settings/data` | `getDataPrivacy()` (discarded) | `DataPrivacySettings` (export + archive link) | 14 |
| `settings/archived-assets` | inline Prisma (no `lib/settings/loaders`) | `ArchivedAssetsClient` (706 LOC, `components/dashboard/`) | 128 |

- **Navigation:** hub-and-spoke. The index `DataCard` link-list is the *only* nav surface; each
  section returns to it via `SettingsPageHeader`'s "‹ Settings" back-link. No sibling nav, no rail.
- **Save fragmentation:** `InlineField` (`onSave → Promise<string|null>`, commit-on-success + 2.5s
  "Saved ✓" flash) is used at **9 call sites in 2 files**; `PreferredSpaceCard`, the password form,
  and the notification matrix each reimplement their **own** save + status pattern (four idioms
  total). `INPUT_BASE`/`inputStyle` tokens have leaked to 6+ files.
- **`archived-assets` is a misfiled outlier:** it reads/writes `FinancialAccount` + `Space`
  archive/trash, lives in `components/dashboard/`, hand-rolls its own loader, skips
  `SettingsPageHeader`, is the only tabbed surface in the tree, and hits `/api/accounts/*` +
  `/api/spaces/*` — **zero** `/api/user/*` calls. It reached Settings only as a cross-link from
  Data & Privacy.

---

## Target workspace model

Both surfaces are **global-nav destinations** (the nav is Spaces · Brief · AI · **Connections** ·
**Settings**), not areas inside a customer Space. They adopt `SpaceShell` for its **frame + rail**,
following the `PlatformSpaceDashboard` blueprint, with **one deliberate divergence** — see Decision D2.

### Registry entries (identity)

New `lib/connections/workspaces.ts` and `lib/settings/workspaces.ts`, mirroring
`lib/platform/workspaces.ts`. Ids namespaced so they never collide in the shared registry.

```ts
// lib/connections/workspaces.ts
export const CONNECTIONS_WORKSPACES: Record<string, WorkspaceDefinition> = {
  "connections-overview": { id: "connections-overview", kind: "standard",
    domain: "connections", label: "Connections", icon: "PlugZap" },
  // ── forward (demand-pulled, Wave 5), not built now: ──
  // "connections-activity":    { …, label: "Activity",    icon: "History" },
  // "connections-diagnostics": { …, label: "Diagnostics", icon: "Stethoscope" },
};

// lib/settings/workspaces.ts
export const SETTINGS_WORKSPACES: Record<string, WorkspaceDefinition> = {
  "settings-account":       { id: "settings-account",       kind: "standard", domain: "settings", label: "Account",        icon: "User" },
  "settings-security":      { id: "settings-security",      kind: "standard", domain: "settings", label: "Security",       icon: "ShieldCheck" },
  "settings-preferences":   { id: "settings-preferences",   kind: "standard", domain: "settings", label: "Preferences",    icon: "SlidersHorizontal" },
  "settings-notifications": { id: "settings-notifications", kind: "standard", domain: "settings", label: "Notifications",  icon: "Bell" },
  "settings-data":          { id: "settings-data",          kind: "standard", domain: "settings", label: "Data & Privacy", icon: "Database" },
};
```

### Composition (order + route), kept separate from identity — exactly like `PLATFORM_AREA_WORKSPACES`

Because Settings stays **URL-driven** (Decision D3), its composition pairs each workspace id with a
route rather than a set of section-widget keys:

```ts
// lib/settings/workspaces.ts
export interface SettingsWorkspaceComposition { workspaceId: string; route: string }
export const SETTINGS_WORKSPACE_ORDER: readonly SettingsWorkspaceComposition[] = [
  { workspaceId: "settings-account",       route: "/dashboard/settings/account" },
  { workspaceId: "settings-security",      route: "/dashboard/settings/security" },
  { workspaceId: "settings-preferences",   route: "/dashboard/settings/preferences" },
  { workspaceId: "settings-notifications", route: "/dashboard/settings/notifications" },
  { workspaceId: "settings-data",          route: "/dashboard/settings/data" },
];
// Connections is single-workspace in Wave 1 → no composition record needed yet.
```

### Registry union + guard

```ts
// lib/perspectives.ts
export const WORKSPACE_REGISTRY = {
  ...STANDARD_WORKSPACES, ...PERSPECTIVE_LIBRARY, ...PLATFORM_WORKSPACES,
  ...CONNECTIONS_WORKSPACES, ...SETTINGS_WORKSPACES,   // ← new, disjoint id sets
};
// domain?: "finance" | "platform" | "connections" | "settings"   ← extend the union (Decision D1)
```
The `lib/platform/workspaces.test.ts` "no finance vocabulary on a non-finance definition" guard
extends to cover the two new domains (they declare only `id/label/icon/kind/domain`).

### Render surfaces (thin `SpaceShell` hosts, one each)

- `components/connections/ConnectionsSpaceDashboard.tsx` — mounts `SpaceShell`; **rail suppressed
  while there is one workspace** (renders the `ConnectionsList` body directly); actions cluster into
  the shell toolbar slot. Poller, cards, and actions move **verbatim**.
- `app/(shell)/dashboard/settings/layout.tsx` — mounts `SpaceShell`; rail options = the five
  `SETTINGS_WORKSPACES`; `activeTab` derived from `usePathname()`; `onSelectTab` → `router.push`
  of the workspace's route. Section pages remain **server components with their own loaders** and
  render into the shell body. This is the least invasive shape: **zero data-loading change**, URLs
  preserved (deep-linkable, bookmarkable, back-button correct).

---

## Migration slices

Ordered by dependency; each is independently shippable and reversible.

| Slice | Scope | Blocked on | Risk |
|---|---|---|---|
| **W1-0 · Registry seam** | Extend `domain` union; add empty `CONNECTIONS_WORKSPACES`/`SETTINGS_WORKSPACES`; union into `WORKSPACE_REGISTRY`; extend guard test | — | Trivial (single-line union, disjoint ids; explicit-pathspec commit) |
| **W1-A · Connections shell** | `ConnectionsSpaceDashboard` wraps existing body in `SpaceShell`; register `connections-overview`; **poller/cards/actions unchanged** | W1-0 | Low — presentation only, no data touch |
| **W1-B · Settings shell/nav** | `settings/layout.tsx` mounts `SpaceShell` rail (5 sections, pathname-driven); retire the index link-list + `SettingsPageHeader` back-links; **forms untouched** | W1-0 | Low-medium — routing/layout only, loaders untouched |
| **W1-C · archived-assets exit** | Move `ArchivedAssetsClient` out of Settings to its own surface (Spaces/accounts domain); keep the Data & Privacy cross-link | — (independent) | Low — a route move + link update |
| **W1-D · Form-field kit** (Wave-0 primitive) | Build `components/atlas/fields/*` + `Toast`/`useToast` + `InlineBanner` + `SettingsSection`; decompose `InlineField` onto the kit | — (independent primitive work) | Medium — new primitives, test-covered |
| **W1-E · Settings forms on the kit** | Migrate the 5 sections + `PreferredSpaceCard`/password/notification-matrix onto one save idiom + Toast; retire the four bespoke patterns | **W1-D** + W1-B | Medium — behavior-preserving refactor, per-section verifiable |

**Parallelism:** W1-A (Connections) and W1-B (Settings shell) run fully in parallel after W1-0 —
disjoint files. W1-C is independent of both. W1-D (primitives) can start immediately alongside
everything. Only W1-E has a hard predecessor (W1-D). So **four tracks run at once**; the single
shared write is the `lib/perspectives.ts` union (land W1-0 first, explicit pathspec).

**What ships the "Workspace migration" itself:** W1-A + W1-B. The form-kit work (W1-D/E) is a
quality convergence that can trail without blocking the architectural outcome.

---

## File ownership plan

**New files**
- `lib/connections/workspaces.ts` — `CONNECTIONS_WORKSPACES` (identity).
- `lib/settings/workspaces.ts` — `SETTINGS_WORKSPACES` + `SETTINGS_WORKSPACE_ORDER` (identity + route composition).
- `components/connections/ConnectionsSpaceDashboard.tsx` — `SpaceShell` host (client).
- `app/(shell)/dashboard/settings/layout.tsx` — `SpaceShell` rail host (client; derives active from pathname).
- `components/atlas/fields/{Field,Label,Input,Select,Toggle,HelpText,FieldError}.tsx` — promoted form kit (W1-D).
- `components/atlas/Toast.tsx` + `useToast` — save-status primitive (W1-D).
- `components/atlas/InlineBanner.tsx`, `components/atlas/EmptyState.tsx`, `components/settings/SettingsSection.tsx` — promoted containers (W1-D).

**Edited files**
- `lib/perspectives.ts` — extend `domain` union; union the two registries; (guard) accessor coverage.
- `lib/platform/workspaces.test.ts` (or a new `workspaces.test.ts`) — extend the no-finance-vocabulary guard to the two domains.
- `app/(shell)/dashboard/connections/page.tsx` — render `ConnectionsSpaceDashboard` (body verbatim).
- `app/(shell)/dashboard/settings/page.tsx` — becomes a default (redirect to `/account` or a thin landing); index link-list retired in favor of the rail.
- `components/settings/{Account,Security,Preferences,Notification,DataPrivacy}Settings.tsx` — (W1-E only) migrate onto the field kit + Toast; drop `SettingsPageHeader` back-links (rail replaces them).
- `components/settings/InlineField.tsx` — (W1-E) re-expressed as `InlineEditField` over the kit; call sites unchanged in shape.

**Moved files**
- `components/dashboard/ArchivedAssetsClient.tsx` + `app/(shell)/dashboard/settings/archived-assets/*` → a home in the Spaces/accounts domain (e.g. `/dashboard/archive` or a Spaces workspace); Settings keeps only the cross-link. (W1-C)

**Untouched (capability-preserving — do not refactor in Wave 1)**
- `lib/connections/space-data.ts`, `lib/sync/status.ts`, `lib/sync/wallet-connections.ts`,
  `app/api/sync/status/route.ts` — the data + sync contracts.
- `components/connections/{ConnectionsList,ConnectionCard,ConnectionsActions}.tsx` and
  `components/connections/import/*` — poller mechanics (4s/`MAX_POLLS`/resume ladder/`LIQUID_CAP`),
  provider semantics, import wizard.
- All `/api/user/*` routes and the `lib/settings/loaders.ts` per-section loaders.

---

## UI redesign proposal

**Connections (W1-A).** Same content, promoted into the Space frame. `SpaceShell` supplies the
identity header ("Connections — Manage the institutions and providers connected to Fourth Meridian");
the **Connect institution / Add wallet** cluster moves into the shell toolbar slot; the body keeps
its two-zone layout (importing cards full-width-stacked, resolved cards in the auto-fit grid). No
rail while single-workspace. **Forward (Wave 5, not now):** an *Activity* workspace (sync-history
timeline) and a *Diagnostics* workspace (per-connection coverage meter, capabilities with honest
"—", reconnect) — the prototype's Connections-as-infrastructure view — appear as rail entries once
the viz/panel primitives land, decomposed on demand exactly as Platform Ops was. **Forward
opportunity:** surface connection health via `TrustIndicator` — the `observed/derived/estimated/
incomplete/unknown` tiers map cleanly onto sync freshness — but Wave 1 preserves the current
per-card state chips.

**Settings (W1-B, then W1-E).** The hub-and-spoke collapses into one framed surface with a
**persistent five-item rail** (Account · Security · Preferences · Notifications · Data & Privacy).
Selecting a section is a real URL navigation (deep-linkable; back-button lands on the previous
section, not a hub). The "‹ Settings" back-links disappear — the rail *is* the wayfinding. After
W1-E, every field renders through the shared kit, and every save reports through **one Toast**
instead of four bespoke "Saved ✓" flashes and inline banners — the concrete end of the
fragmentation this wave exists to close. `archived-assets` leaves the tree (W1-C); Data & Privacy
keeps a single cross-link to its new home.

---

## Decisions to ratify (before W1-A/B start)

- **D1 — `domain` modeling.** Recommend extending the union to
  `"finance" | "platform" | "connections" | "settings"` (two distinct tags → clean guard tests,
  honest names). *Alternative:* one `"account"`/`"utility"` tag covering both — fewer values, but the
  guard can't distinguish the two surfaces. **Recommend: two tags.**
- **D2 — chrome mode (the one divergence from Platform).** Platform calls
  `useSpaceChromePublisher.publishSpace(...)` to take over `ContextualNavbar` into *space mode* (back
  button, `onLeave → /dashboard/spaces`). Connections/Settings are **global-nav peers**, so they
  should **not** enter space mode — they stay highlighted in global nav and use `SpaceShell` only for
  the frame + rail. **Verification item:** confirm `SpaceShell` renders cleanly *without* a published
  Space identity (title/subtitle otherwise appear only in the mobile relocation row); if it assumes
  space mode, add a lightweight `variant="utility"` that renders identity in the shell header.
  **Recommend: global-peer, no space-mode takeover.**
- **D3 — Settings navigation mechanism.** Recommend **URL-driven** (rail options are routes;
  `activeTab` from pathname; section pages stay server components with their own loaders) — zero
  data-loading change, preserves deep links. *Alternative:* client host with local `activeTab` +
  self-fetching sections (closer to Platform, but converts server loaders to endpoints — more churn,
  no user benefit here). **Recommend: URL-driven.**
- **D4 — `archived-assets` destination.** It is not a Settings concern. Recommend re-homing to the
  Spaces/accounts domain (a `/dashboard/archive` surface or a Spaces workspace), keeping the Data &
  Privacy cross-link. **Confirm the target home** before W1-C.

---

## Constraints honored

- **No feature rewrite.** W1-A/B are presentation + registration only; every capability in the
  audit's preservation lists (Connections items 1–10; the four Settings save paths) is retained.
- **No second design system / no duplicate shell.** Both surfaces adopt the *one* `SpaceShell`;
  missing primitives are **promoted into Atlas once** (W1-D), not per surface.
- **No premature abstraction.** New registries copy the Platform pattern (a proven second consumer);
  Connections stays single-workspace until a real second workspace is demand-pulled.
- **Ownership boundary preserved.** Connections remains `userId`-scoped credential/sync; it never
  becomes a money consumer.
