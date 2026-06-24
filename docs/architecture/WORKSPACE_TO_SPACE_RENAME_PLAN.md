# Workspace → Space Rename — Phase 1 Impact Map & Implementation Plan

**Status: planning only. No code, schema, or branch changes have been made in producing this document. Nothing here has been implemented.**

Branch: `fourth-meridian`, HEAD `0796bf0` ("Build the unified Spaces dashboard architecture"). Tags: v2.0, v2.0.1, v2.0.2, v2.1.0, v2.2.0.

This revision supersedes the previous draft of this file. It was produced by re-auditing the live repository file-by-file (grep + direct reads of every flagged file, not inference) rather than trusting the prior draft's numbers. Section 11 lists exactly what changed and why, so the correction trail is visible rather than silently overwritten.

---

## 0. What Phase 1 is and isn't

Per the controlled-implementation plan this is a **naming migration only**. In scope: `Workspace` → `Space` across Prisma models, relation names, generated types, server helpers, API routes, frontend props/types, component names, live documentation, seed data. Explicitly **not** in scope: `ProviderCatalog`, the `Connection` abstraction, Provider Adapters, Marketplace tables, `SpaceAccountLink`, or any lifecycle/archive rule changes. Those are Phases 2–4 and must not land on this branch.

**Explicit exclusion carried over unchanged:** `WorkspaceAccountShare` does not become `SpaceAccountLink` here. It has its own retirement path (Phase 3) with different semantics (one row per account↔Space pair vs. today's share model). Renaming it now would create a table that needs a second migration weeks later. It — and everything that exists solely to point at it — is carved out of this rename. See §2 and §5.

---

## 1. Why this is a mixed-state rename

A prior pass already renamed `Workspace` → `Space` in **UI copy only**. `fourth-meridian-product-language.md` §3/§8 still states the guardrail in force at the time: *"No database, Prisma schema, or model renames. `Workspace`, `WorkspaceMember`, `WorkspaceSnapshot`, and `PlaidItem` stay exactly as they are in code."* Confirmed still present in the file, verbatim, today.

That guardrail held for the database layer but the **presentation layer has since moved past it**, independently of any plan:

- `app/(shell)/dashboard/spaces/page.tsx` (174 lines) is the live Spaces landing page. Its own header comment says it's "the redesigned, premium successor to the old `/dashboard/workspaces` page... intentionally leaves [the backend] untouched; only the user-facing presentation layer is renamed." It calls `db.workspaceMember.findMany`, `db.workspace.findMany`, imports `ACTIVE_WORKSPACE_COOKIE` from `lib/workspace.ts`, and serializes everything from `Workspace`-shaped Prisma results into Space-labeled props.
- `app/(shell)/dashboard/workspaces/page.tsx` is now an 11-line permanent redirect to `/dashboard/spaces`, with a comment explicitly noting the underlying API/schema/folder name are untouched for compatibility.
- `app/admin/workspaces/page.tsx` (296 lines) already renders `"Space"` in its own UI strings (`` `${workspaces.length} Space${...}` ``) while every variable, state field, and the `/api/admin/workspaces` fetch call stays `workspace`-named. `components/admin/AdminNav.tsx` likewise labels the nav entry `"Spaces"` while linking to `/admin/workspaces`.
- `components/dashboard/SpacesClient.tsx`, `CreateSpaceModal.tsx`, `widgets/SpaceMembersWidget.tsx`, `widgets/SpaceTimelineWidget.tsx`, and `lib/space-nav.ts` are all already Space-named files that import `Workspace`-typed helpers and call `/api/workspaces/*`.
- A second, older generation — `components/dashboard/WorkspaceDashboard.tsx`, `ManageWorkspaceModal.tsx`, and the whole `components/workspace/` directory (7 files) — is still fully `Workspace`-named end to end. **Neither generation is dead code**: I confirmed both are still imported live (`WorkspaceDashboard` from `app/(shell)/dashboard/page.tsx` and `DashboardClient.tsx`; `ManageWorkspaceModal` from `SpacesClient.tsx`, `CreateSpaceModal.tsx`, and `WorkspaceDashboard.tsx` itself). They coexist; nothing here resolves which is canonical.

This plan renames the identifier layer underneath both generations as one coherent migration. It does **not** try to also resolve which component generation survives — that's a separate, product-level cleanup, flagged as an open decision in §10.

---

## 2. Models, enums, and the explicit exclusion

| # | Model | Role | Disposition |
|---|---|---|---|
| 1 | `Workspace` | The Space itself — type, category, archive/trash lifecycle, `isPublic` | Rename → `Space` |
| 2 | `WorkspaceMember` | User↔Workspace membership + role + status | Rename → `SpaceMember` |
| 3 | `WorkspaceInvite` | Pending invite token | Rename → `SpaceInvite` |
| 4 | `WorkspaceGoal` | Savings/payoff goal, scoped to a workspace | Rename → `SpaceGoal` |
| 5 | `WorkspaceDashboardSection` | Widget layout + data bindings | Rename → `SpaceDashboardSection` |
| 6 | `WorkspaceSnapshot` | Net worth rollup, point-in-time, derived/regenerable | Rename → `SpaceSnapshot` |
| 7 | `WorkspaceAccountShare` | Account↔Workspace visibility join table | **Excluded.** Has its own Phase 3 replacement (`SpaceAccountLink`) with different semantics. Do not rename to `SpaceAccountShare` or anything else here. |

Enums:

| Enum | Used by | Disposition |
|---|---|---|
| `WorkspaceType` | `Workspace.type` | Rename → `SpaceType` |
| `WorkspaceCategory` | `Workspace.category` | Rename → `SpaceCategory` |
| `WorkspaceDashboardTab` | `WorkspaceDashboardSection.tab` | Rename → `SpaceDashboardTab` |
| `WorkspaceMemberRole` | `WorkspaceMember.role`, `WorkspaceInvite.role` | Rename → `SpaceMemberRole` |
| `WorkspaceMemberStatus` | `WorkspaceMember.status` | Rename → `SpaceMemberStatus` |

One enum **value**, not a model: `AccountOwnerType.WORKSPACE` on `FinancialAccount.ownerType` (`prisma/schema.prisma:148`). Reads the same as the model name in code and copy — in scope for the same pass (→ `SPACE`, with a data migration for existing rows, see §6).

Out of scope, confirmed by direct inspection — not because they weren't checked, but because there's nothing to rename:

- `AiAgent`, `AiAdvice` — both have a `workspaceId` FK (see §3) but neither model name contains "Workspace." Field-level rename only.
- The Phase 3/4 tables (`Connection`, `*ConnectionDetail`, `ProviderCatalog`, `SpaceTemplate`, `SpaceAccountLink`) — not yet built.

---

## 3. Fields, relations, and the one carve-out the prior draft missed

Foreign keys named `workspaceId`, verified directly in `prisma/schema.prisma`, found on: `WorkspaceMember`, `WorkspaceInvite`, `WorkspaceGoal`, `WorkspaceDashboardSection`, `WorkspaceSnapshot`, `AiAgent`, `AiAdvice`, `AuditLog` (nullable, `SetNull` on delete), `Account` (legacy), and — excluded per §2 — `WorkspaceAccountShare`.

**`AiAdvice.workspaceId` is added here; the prior draft's FK list omitted it** (it was mentioned only in prose, not the field list). Confirmed at `schema.prisma:889`: required, `onDelete: Cascade`.

Two fields carry "Workspace" in the name but have **no FK constraint** — lower migration risk, but still need an app-level rename:

- `User.preferredWorkspaceId` — soft ref, the workspace the user lands on after login.
- `DuplicateAccountCandidate.workspaceId` — confirmed unconstrained at `schema.prisma:638` (no `@relation`).

Named Prisma relation label (a schema identifier, not just a field name):

- `"WorkspaceOwnedFinancialAccounts"` (`FinancialAccount.ownerWorkspaceId` ↔ `Workspace.ownedFinancialAccounts`) → rename the label string itself, e.g. `"SpaceOwnedFinancialAccounts"`.

Relation field names that read as "workspace" even though their type becomes `Space`:

- `User.workspaces` (→ `WorkspaceMember[]`)
- `FinancialAccount.ownerWorkspaceId` / `.ownerWorkspace`
- `Workspace.members` / `.invites` / `.snapshots` / `.goals` / `.dashboardSections`

**New carve-out, found by tracing every field that points at the excluded `WorkspaceAccountShare` model** (the prior draft didn't check this): `FinancialAccount.workspaceShares` (`schema.prisma:522`) is a field *named* `workspaceShares` whose type is `WorkspaceAccountShare[]`. It contains the literal string "workspace" but exists solely to reference the table being excluded from this rename — it should stay `workspaceShares`, not become `spaceShares`, until Phase 3 replaces it alongside the table it points to. Renaming the field while leaving the model untouched would just be inconsistent in the other direction. `Workspace.accountShares` and `User.addedShares`/`.revokedShares` (also pointing at `WorkspaceAccountShare`) don't contain "workspace" in their own names, so they're not at risk of being touched by an automated pass — only `workspaceShares` is.

Index/constraint count, recounted directly rather than estimated: **22** `@@index`/`@@unique` declarations reference a workspace-related FK — 21 on `workspaceId` plus one on `FinancialAccount.ownerWorkspaceId` (`schema.prisma:530`, easy to miss since it doesn't match a literal `workspaceId` grep) (the prior draft said "12+"). Every one is a name change in the generated migration, not just a column rename.

---

## 4. Complete file inventory

Verified by `grep -rli "workspace"` across `app/`, `components/`, `lib/`, `jobs/`, `prisma/`, `docs/`, `types/`, and root-level `.md` files, excluding `node_modules`, `.next`, `.git`, and `prisma/migrations/` (handled separately in §6). **116 files, ~2,345 case-insensitive occurrences of "workspace" total.** This is the actual complete impact map — the heaviest-touch files below are a subset of it, not the full scope.

### 4.1 Schema and seed (2 files)

`prisma/schema.prisma`; `prisma/seed.ts` — **23** `.workspace*.` call sites (recounted directly by call site, not estimated; prior draft said 21), spanning every model in §2: 8 `workspace.create`, 6 deleteMany cleanup calls, 1 `workspaceMember.createMany`, 4 `workspaceSnapshot.createMany`, plus the dashboard-section create/createMany/updateMany/deleteMany group. The only place that exercises all seven core models end to end outside the running app — needs a clean re-run against a fresh database post-rename, not just a code update.

### 4.2 API routes — path rename required (20 files)

Everything under the `/api/workspace*` URL surface. A path rename is a breaking change for every caller, but every caller located in this audit is first-party (components in this repo) — no public/external API consumer was found.

```
app/api/workspaces/route.ts                                    GET, POST
app/api/workspaces/[id]/route.ts                                GET, PATCH, DELETE
app/api/workspaces/[id]/restore/route.ts                        POST
app/api/workspaces/[id]/permanent/route.ts                      DELETE
app/api/workspaces/[id]/invite/route.ts                         POST
app/api/workspaces/[id]/invites/route.ts                        GET
app/api/workspaces/[id]/invites/[inviteId]/route.ts             DELETE
app/api/workspaces/[id]/members/[userId]/route.ts               PATCH, DELETE
app/api/workspaces/[id]/accounts/route.ts                       GET
app/api/workspaces/[id]/accounts/share/route.ts                 POST
app/api/workspaces/[id]/activity/route.ts                       GET
app/api/workspaces/[id]/goals/route.ts                          GET, POST
app/api/workspaces/[id]/goals/[goalId]/route.ts                 PATCH, DELETE
app/api/workspaces/[id]/goals/[goalId]/check-in/route.ts        POST
app/api/workspaces/[id]/sections/route.ts                       GET, POST
app/api/workspaces/[id]/sections/[sectionId]/route.ts           PATCH, DELETE
app/api/workspaces/invites/pending/route.ts                     GET
app/api/workspaces/invites/seen/route.ts                        POST
app/api/workspace/switch/route.ts                                POST  (sets the active-Space cookie)
app/api/admin/workspaces/route.ts                                GET  (admin overview)
```

(Prior draft said "21 route files" in prose but its own list — and the live filesystem — both show 20.)

### 4.3 API routes — internal updates only, no path change (22 files)

These don't live under `/api/workspace*` but call `getWorkspaceContext()`, query `db.workspace*`, or reference `workspaceId` internally. Missing these is the most likely way an automated rename leaves the app half-migrated while looking complete (the URLs are unaffected, so nothing 404s — it just silently keeps using old identifiers internally):

```
app/api/accounts/route.ts                          app/api/accounts/[id]/route.ts
app/api/accounts/[id]/restore/route.ts             app/api/accounts/[id]/transactions/route.ts
app/api/accounts/debug-duplicates/route.ts          app/api/accounts/manual/route.ts
app/api/accounts/manual/[id]/route.ts               app/api/accounts/manual/[id]/restore/route.ts
app/api/accounts/manual/[id]/permanent/route.ts     app/api/accounts/manual/archived/route.ts
app/api/accounts/wallet/route.ts                    app/api/admin/audit/route.ts
app/api/admin/overview/route.ts                     app/api/admin/users/route.ts
app/api/auth/register/route.ts                      app/api/brief/route.ts
app/api/credit/update-fico/route.ts                 app/api/plaid/create-link-token/route.ts
app/api/plaid/exchange-token/route.ts               app/api/plaid/refresh/route.ts
app/api/user/profile/route.ts                       app/api/users/search/route.ts
```

### 4.4 Page routes (9 files)

```
app/(shell)/dashboard/page.tsx                       app/(shell)/dashboard/spaces/page.tsx        (mixed-state, see §1)
app/(shell)/dashboard/workspaces/page.tsx            app/(shell)/dashboard/settings/page.tsx
app/(shell)/dashboard/settings/archived-assets/page.tsx
app/admin/page.tsx                                   app/admin/users/page.tsx
app/admin/audit/page.tsx                             app/admin/workspaces/page.tsx  (296 lines, mixed-state, see §1)
```

`app/admin/workspaces/page.tsx` is a real, heavy admin page, not a stub — it needs the same depth of pass as the API routes, not a quick rename.

### 4.5 Components (27 files)

Heaviest-touch, by direct grep count on the current files (recounted — these differ somewhat from the prior draft's numbers, most likely because that pass counted whole-word matches and this one counted raw substring occurrences; the ranking is unchanged):

| Occurrences | File |
|---|---|
| 148 | `components/dashboard/WorkspaceDashboard.tsx` — full workspace dashboard; ~20 `fetch("/api/workspaces/...")` call sites |
| 137 | `components/dashboard/ManageWorkspaceModal.tsx` — workspace management modal, comparable breadth |
| 52 | `components/dashboard/ArchivedAssetsClient.tsx` — archive/restore/permanent-delete flows |
| 43 | `components/dashboard/SpacesClient.tsx` — already Space-named, still calls `/api/workspaces/*` |
| 32 | `components/dashboard/CreateSpaceModal.tsx` — already Space-named, still calls `/api/workspaces` + `/api/workspace/switch` |
| 27 | `components/dashboard/DashboardClient.tsx` — top-level dashboard shell |
| 19 | `components/dashboard/AddManualAssetModal.tsx` |
| 18 | `components/dashboard/SettingsClient.tsx` |
| 17 | `components/ui/Sidebar.tsx` — Space switcher UI; hardcodes its own cookie-name string, see §5 |

Lighter touch (mostly prop names, type imports, or comments): `components/admin/AdminNav.tsx`, `components/charts/{CashChart,ChartFirstDayPlaceholder,PortfolioHistoryChart}.tsx`, `components/dashboard/{DebtClient,RemoveAccountButton}.tsx`, `components/dashboard/widgets/{PerspectivesWidget,SpaceMembersWidget,SpaceTimelineWidget,TimelineModal}.tsx`, `components/ui/DashboardChrome.tsx`.

The entire `components/workspace/` directory (7 files: `sections/DebtPayoffSection.tsx`, `widgets/{AssetValueWidget,BreakdownWidget,ProgressWidget,SummaryWidget,TimelineWidget,debt-adapters}.tsx`) is itself workspace-named and would move to `components/space/` — confirmed still live (imported from `WorkspaceDashboard.tsx`, `DebtClient.tsx`, `widgets/SpaceTimelineWidget.tsx`, `lib/widget-registry.ts`), not dead code to delete instead of rename.

### 4.6 `lib/` — the chokepoint (23 files)

`lib/workspace.ts` is the single highest-risk file. Read directly, not summarized: it exports `getWorkspaceContext()` (wrapped in React's `cache()` for per-request memoization) and `resolveWorkspaceContext()`, owns `ACTIVE_WORKSPACE_COOKIE = "fintracker_workspace"`, and its own comment says it's called by "every Server Component / API route that needs the active workspace." It also currently carries temporary diagnostic `console.log` instrumentation (a `[wsctx ...]` call-counter, added per its own comment for a perf audit) — not a rename concern, but worth knowing it's there before touching the file so the diff isn't confused with the logging cleanup.

`resolveWorkspaceContext()` has four distinct branches worth knowing before the rename, because they're what the validation pass in §9 needs to exercise: requested-Space-found-and-valid, requested-Space-invalid/not-a-member (falls through), no-cookie (falls through to preferred-Space lookup, wrapped in try/catch for pre-migration safety), and last-resort any-membership.

Second-highest occurrence count: `lib/workspace-presets.ts` (category-based default dashboard presets) — not called out by file name in the prior draft's heaviest-touch table at all, despite being the second-largest file in scope.

Remaining 21 lib files, lighter touch (mostly `workspaceId` params, `Workspace`-typed arguments, or comments/docstrings referencing `/api/workspaces`): `lib/space-nav.ts` (already Space-named, consumes Workspace-typed data), `lib/widget-registry.ts`, `lib/timeline-types.ts`, `lib/timeline-placeholder.ts`, `lib/perspectives.ts`, `lib/account-privacy.ts`, `lib/account-classifier.ts`, `lib/audit-actions.ts`, `lib/session.ts`, `lib/session-cache.ts`, `lib/api.ts`, `lib/auth.ts`, `lib/format.ts`, `lib/currency.ts`, `lib/data/{accounts,advice,snapshots,transactions}.ts`, `lib/accounts/reconcile.ts`, `lib/snapshots/regenerate.ts`, `lib/plaid/refresh.ts`. A handful of these (`lib/auth.ts`, `lib/format.ts`, `lib/currency.ts`, `lib/session-cache.ts`, `lib/timeline-placeholder.ts`, and the two chart components in §4.5) only have comment/docstring mentions — zero functional risk, update opportunistically in the same pass rather than tracking separately.

### 4.7 Jobs (1 file)

`jobs/purge-trash.ts` — calls `(db as any).workspaceGoal.deleteMany(...)` directly against the archive/trash lifecycle.

### 4.8 Documentation — in scope now (5 files)

Live docs that describe the product as it exists today and would be actively wrong if left unrenamed once Phase 1 ships:

- `fourth-meridian-product-language.md` §3/§8 — contains the literal "no schema renames" guardrail quoted in §1. This is the one piece of documentation the prior draft already flagged; confirmed still accurate.
- `README.md` — "Multi-Workspace Architecture" section header and surrounding prose (lines 9–45, 156–170), including the version-history table that lists "Workspace Platform" as the v2.0 codename.
- `ROADMAP.md` — "Workspaces" section header, milestone descriptions, checklist items (lines 20, 38–70).
- `docs/operations/PROJECT_STATE.md` — the most detailed of the four; documents current schema state, migration history, and explicitly states *"Workspace-to-Space code rename deferred. Per project constraints, `Workspace` stays the model/code name through this release"* (line 106) — that line becomes false the moment this rename ships and must be updated in the same change, not left contradicting the code the way the product-language doc's guardrail already does today.
- `docs/operations/DEPLOYMENT.md` — one line, a QA checklist item ("Workspace switching works").

### 4.9 Documentation — excluded (historical record, do not edit)

`docs/archive/WORKSPACE_STATUS.md`, `docs/archive/WORKSPACE_TYPE_SPEC.md`, `docs/archive/QA_PASS_2_REPORT.md`, `docs/archive/WIDGET_META_ANALYSIS.md`, `docs/releases/v2.0.1.md` — these are dated, point-in-time records of decisions already made (the same principle as "never edit historical migration files," applied to docs). Rewriting them to say "Space" would misrepresent what was actually decided and shipped at that date.

### 4.10 Documentation — update after Phase 1 ships, not before

`docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` and its three SVGs (`docs/images/architecture/*.svg`) intentionally describe the **current** schema using `Workspace` names — that's correct today. Renaming them now, before any code changes, would have the architecture docs describe a future state that doesn't exist yet, which is exactly the kind of doc/code drift this whole audit process is trying to avoid. Update these in the change that completes Phase 1, not in this planning pass and not speculatively ahead of it.

### 4.11 Tests

No test files exist anywhere in the repository (no `*.test.ts(x)`, `*.spec.ts`, or `__tests__` directories found). "Update tests" from the rename-targets list is **N/A** for this codebase as it stands — noted so it isn't mistaken for an oversight during review.

### 4.12 `types/`

`types/index.ts` and `types/next-auth.d.ts` — checked directly, zero `Workspace` references in either. Not in scope.

---

## 5. Two raw-string duplication risks — exact strings to grep for after the rename

Both are the same failure mode as each other: a name that's exported as a constant from one place but **also hardcoded as a literal string somewhere else**, so a rename of the constant's value silently leaves the duplicate behind.

1. **The cookie name.** `lib/workspace.ts` exports `ACTIVE_WORKSPACE_COOKIE = "fintracker_workspace"`. `components/ui/Sidebar.tsx` does not import it — it redeclares `const COOKIE_NAME = "fintracker_workspace"` at line 68 and reads `document.cookie` directly with it. A rename driven by find-and-replace on the exported constant's *name* will not touch this literal unless the literal string `"fintracker_workspace"` is also grepped for directly.

2. **Two `CustomEvent` names — found in this audit, not flagged in the prior draft.** `"workspace-list-changed"` and `"workspace-invites-changed"` are dispatched and listened for as raw string literals, with no shared constant anywhere:
   - Dispatched from `components/dashboard/CreateSpaceModal.tsx` (3 call sites) and `components/dashboard/SpacesClient.tsx` (2) and `components/dashboard/ManageWorkspaceModal.tsx` (2).
   - Listened for in `components/ui/Sidebar.tsx` (both events, lines 137–141).
   - Referenced only in comments (not call sites) in `components/dashboard/SpacesClient.tsx` and `components/ui/DashboardChrome.tsx`, describing the pattern for future event names.
   - **11 occurrences total across 4 files**, all of them the literal string, not a shared import. If the rename changes these to `"space-list-changed"`/`"space-invites-changed"` (recommended, for consistency with the cookie and route renames), every one of the four files needs the literal updated — there's no single source of truth to change once and propagate.

Recommend the validation checklist (§9) include an explicit post-rename grep for both `"fintracker_workspace"` and `"workspace-list-changed"`/`"workspace-invites-changed"` as literal strings, separate from the general `/api/workspace` grep, since none of these three are caught by a rename that only follows imports and type references.

---

## 6. Migration risk

- **Schema migration is additive-rename, not destructive**, done correctly: Prisma's `@@map`/`@map` can rename Postgres-facing table/column names independently of the Prisma model/field names, or a generated migration can run real `ALTER TABLE ... RENAME` statements. Either way no data is dropped — every row, FK, and index carries forward. The risk is in *sequencing and coverage*, not data loss.
- **Historical migration files must not be edited.** Recounted directly: **22** total migration folders exist. **6** have "workspace" in the folder name itself (`20260610210000_add_workspace_invite`, `20260611000002_workspace_dashboard_enums`, `20260611000003_workspace_dashboard_section`, `20260611152921_workspace_dashboard_sections`, `20260612000005_goal_lifecycle_preferred_workspace`, `20260617120000_add_workspace_archive_trash`). But **14** of the 22 migration.sql files reference "workspace" in their actual SQL content — including `20260609234422_init`, which creates the `Workspace` table itself under a folder name that doesn't mention "workspace" at all. (The prior draft's "15+" figure conflated folder-name matches with content matches; 14 by content is the number that actually matters for "what history exists to not edit.") The rename ships as one or more **new** migrations on top of all 22, never an edit to any of them.
- **`lib/workspace.ts` is the single point of failure.** Confirmed by direct read (§4.6): because nearly every route and Server Component calls `getWorkspaceContext()`, a broken rename in this one file fails the entire app, not one feature. Change and test this file first, in isolation, before touching anything downstream.
- **The `fintracker_workspace` cookie is a live, browser-side value for every currently-logged-in user.** Renaming the cookie key (recommended for consistency, not required) means existing sessions stop finding their previously-selected active Space on the next request. Not a data-loss risk — `resolveWorkspaceContext()` already falls back gracefully to the user's Personal Space when the cookie is missing/invalid (confirmed by reading the function, §4.6) — but it is a one-time, silent "your Space selector reset to Personal" moment for every active user at cutover. Decide deliberately (read both old and new cookie names for a transition window, vs. accept the one-time reset) rather than let it happen as a side effect.
- **`AccountOwnerType.WORKSPACE` → `SPACE` is an enum-value rename on a column with live data**, not just a code-level rename — every `FinancialAccount` row with `ownerType = WORKSPACE` needs the new enum value to exist before the column can reference it, and a data migration (not just a schema migration) to flip existing rows. This needs its own explicit step in implementation; it's easy to treat as "just another rename" and miss that it's the one enum-value change in this list that touches existing data rather than just an identifier.
- **`WorkspaceAccountShare`-adjacent files need surgical editing, not blanket find-and-replace.** Confirmed 23 files call `db.workspaceAccountShare.*` or reference the model type directly (`lib/account-privacy.ts`, `lib/accounts/reconcile.ts`, `lib/snapshots/regenerate.ts`, `lib/plaid/refresh.ts`, `lib/data/{accounts,transactions}.ts`, `components/dashboard/RemoveAccountButton.tsx`, `prisma/seed.ts`, `prisma/schema.prisma`, and 14 API route files). Every one of these files is **in scope** for its other `workspace` references but the literal identifiers `WorkspaceAccountShare` (type) and `workspaceAccountShare` (Prisma client accessor, camelCase of the model name) must be left untouched inside them. A naive global find-and-replace of `Workspace`→`Space` and `workspace`→`space` would catch both of these and silently break Prisma client calls against a model that hasn't been renamed. This is the single highest-risk mechanical step in the whole migration — recommend a dedicated pre-flight grep for `WorkspaceAccountShare|workspaceAccountShare` immediately after any automated pass, before running `prisma generate`, to confirm zero unintended hits.
- **Two component generations exist for the same screens** (§1). A mechanical rename touches both, including whichever is on its way out. Not wrong, but the diff will be larger than "just the live code path" — worth knowing going in.
- **No public/external API consumers found** for `/api/workspaces/*` (§4.2) — every call site is first-party. Lowers the blast radius of the route rename relative to a public API.

---

## 7. Sequencing recommendation

1. Add `Space`-named Prisma models/enums/fields **alongside** the existing `Workspace`-named ones via `@@map`/`@map` — database-facing table/column names can move independently of any application code change — or generate the rename migration directly if a clean cutover is preferred over a transition period. Either way, schema-only, no application code touched yet.
2. Update `lib/workspace.ts` (file, exports, cookie constant) in isolation, with its own test pass — everything downstream depends on it (§6).
3. Run the `AccountOwnerType.WORKSPACE` → `SPACE` data migration (§6) as its own step, separate from the identifier renames, since it touches existing rows.
4. Update API routes: move `app/api/workspaces/*` → `app/api/spaces/*`, `app/api/workspace/switch` → `app/api/space/switch`; update the 22 internal-only routes in §4.3 in place. Keep old routes as thin redirects for one release if any bookmarking/caching risk is identified.
5. Update components and lib call sites, starting with `WorkspaceDashboard.tsx` and `ManageWorkspaceModal.tsx` (largest blast radius if something is missed), then the rest of §4.5/§4.6.
6. Run the dedicated `WorkspaceAccountShare|workspaceAccountShare` pre-flight grep from §6 before `prisma generate`.
7. Update `prisma/seed.ts` and re-seed a local/staging database end to end.
8. Update the five in-scope docs (§4.8) in the same change — not left stale the way the product-language doc's guardrail already is today.
9. Decide, before step 4, whether the component-generation duplication (§1) gets resolved as part of this work or tracked separately (§10) — doing it silently inside the rename diff makes the PR much harder to review.

---

## 8. Rollback plan

- The recommended approach (§7.1) separates the database-level rename from the application-code rename, so the database step is reversible by reverting the Prisma schema change and regenerating the client — no data moved or dropped, only names.
- If a direct `ALTER TABLE/COLUMN RENAME` migration is used instead of `@@map`, rollback is a second migration renaming back, not a restore-from-backup — still no data loss, an extra deploy.
- Application-code rollback is a standard PR revert; no destructive schema operations are involved anywhere in this plan, so no scenario here requires a database restore.
- The `AccountOwnerType.WORKSPACE`→`SPACE` data migration (§6) is the one step that isn't purely reversible by reverting code — rows already flipped to `SPACE` need an explicit reverse data migration if rolled back after the fact, not just a schema revert. Call this out specifically in the implementation PR.
- The cookie-name change (§6) is the one other non-mechanical part of rollback: if cutover and rollback happen far enough apart, some users will have re-selected their active Space under the new cookie name, and rolling back the code while leaving the new cookie in their browser silently drops back to Personal. Minor, self-healing (same fallback as a fresh login), but worth noting as the one user-visible edge of an otherwise clean rollback.

---

## 9. Validation checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `eslint` clean
- [ ] `prisma validate` and `prisma migrate diff` reviewed line by line against §2–§3's model/field/index list before the migration is applied anywhere
- [ ] Every route in §4.2 has a corresponding renamed route, and every old path either 404s intentionally or redirects — no silently-dead endpoint
- [ ] Every `fetch("/api/workspace...")` call site across §4.5/§4.6 updated — grep for the literal string `/api/workspace` returns zero matches in `app/` and `components/` when done
- [ ] `lib/workspace.ts` rename verified by exercising all four branches of `resolveWorkspaceContext()` identified in §4.6: requested-Space valid, requested-Space invalid/not-a-member, no-cookie-falls-back-to-preferred, last-resort any-membership
- [ ] `prisma/seed.ts` runs clean against a fresh database post-rename
- [ ] Literal-string grep for `"fintracker_workspace"` (§5.1) returns zero matches outside the single renamed constant's definition
- [ ] Literal-string grep for `"workspace-list-changed"` and `"workspace-invites-changed"` (§5.2) returns zero matches across all 4 files identified
- [ ] Literal-string grep for `WorkspaceAccountShare` and `workspaceAccountShare` (§6) returns matches **only** in the 23 files identified, and only as the unchanged model/accessor name — confirms the exclusion held under whatever rename method was used
- [ ] `AccountOwnerType.WORKSPACE` → `SPACE` data migration confirmed to have updated every existing `FinancialAccount` row, with a row-count check before/after
- [ ] Historical files under `prisma/migrations/` confirmed untouched (all 22, not just the 6 workspace-named ones) — only new migration files added
- [ ] All 5 in-scope docs from §4.8 updated; all 5 excluded docs from §4.9 confirmed untouched; §4.10's architecture docs updated in this same change (not before, not skipped)
- [ ] Manual smoke test: create a Space, invite a member, switch active Space, archive/restore a Space, create/check-in/delete a goal, share an account into a Space (confirms the `WorkspaceAccountShare` exclusion didn't break the one flow that touches it most)

---

## 10. Open decisions for review before implementation starts

1. **Cookie transition window** (§6): accept the one-time "resets to Personal Space" moment at cutover, or support reading both cookie names for a release.
2. **Component-generation duplication** (§1, §7.9): resolve `WorkspaceDashboard.tsx`/`ManageWorkspaceModal.tsx` vs. `SpacesClient.tsx`/`CreateSpaceModal.tsx` as part of this rename, or rename both generations as-is and track the consolidation as separate, later work. Doing it silently inside this diff is not recommended either way — it should be a deliberate choice either direction.
3. **Event-name rename** (§5.2): confirmed no shared constant exists for `workspace-list-changed`/`workspace-invites-changed` today. Worth introducing one (e.g. exported from `lib/space-nav.ts`) as part of this rename rather than recreating four hardcoded literal pairs under new names.

---

## 11. Corrections made in this revision vs. the previous draft

For transparency, since this document replaces an existing draft rather than starting from nothing: route count corrected 21→20 (prose matched the list after recount); seed.ts call-site count corrected 21→23 (counted by exact call site, including the dashboard-section group the prior pass likely missed); `AiAdvice.workspaceId` added to the FK list (was mentioned only in prose); index/unique count corrected "12+"→22 (21 on `workspaceId` + 1 on `ownerWorkspaceId`); migration folder count corrected to 22 total, clarified 6 by-folder-name vs. 14 by-content (was stated as a single "15+" figure); `FinancialAccount.workspaceShares` field carve-out added (§3) — not previously identified; the two `CustomEvent` name literals added (§5.2) — not previously identified; `AccountOwnerType.WORKSPACE`→`SPACE` flagged as a data migration, not just an identifier rename (§6); documentation scope expanded from one file to a 5 in-scope / 5 excluded / 1 update-after-shipping split (§4.8–§4.10, the last being `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` plus its 3 SVGs, which sit outside the 116-file text grep) — previously only `fourth-meridian-product-language.md` was named; the 22 internal-only API routes (§4.3, 42 total API route files together with the 20 in §4.2) and full lib/component file lists (§4.5–§4.6) added as an explicit inventory rather than "heaviest touch plus an et cetera." All counts in this revision were re-verified directly against the live repository (exact `grep`/`find` counts, not estimates) immediately before finalizing; this pass also caught and corrected two further miscounts from the immediately-preceding draft of this same document (the `@@index`/`@@unique` total and the seed.ts call-site total) before presenting it for review. The 116-file total reconciles exactly against the category breakdown in §4: 2 (schema/seed) + 20 + 22 (API) + 9 (pages) + 27 (components) + 23 (lib) + 1 (jobs) + 12 (docs, including this plan document itself, which inevitably matches its own "workspace" grep).

---

No schema changes. No code changes. No branch created. This document is the deliverable for this phase; implementation begins only after it is reviewed and approved.
