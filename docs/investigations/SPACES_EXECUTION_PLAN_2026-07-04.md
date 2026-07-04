> **INVESTIGATION ONLY — no code, schema, migration, or UI changes were made to produce this document.** For current project state see `STATUS.md` at the repository root. This thread runs in parallel with the FlowType P5 lane; nothing here touches FlowType, transactions, Plaid, imports, the AI assembler, the Daily Brief, Atlas Liquid internals, package files, or the Prisma schema.

# Spaces Execution Plan — Next Parallel Initiative

**Date:** 2026-07-04
**Branch context:** `feature/v2.5-spaces-completion` (baseline `v2.4.5-82-g0b100c2`)
**Question:** What is the best next Spaces initiative to run in parallel with FlowType P5, and what is the first slice?

**Bottom line:** Do **SP-2 (centralized Space policy module)** before SP-1. It is a security-relevant, additive, FlowType-disjoint refactor that closes a proven, recurring leak class. SP-1 (SpaceTemplate foundation) is worth doing but is schema-bearing and currently *Parked* (D9), so it needs an un-park approval and should not be the first slice. This aligns with the repo's own lateral audit (`docs/investigations/V2.5_LATERAL_ARCHITECTURE_AUDIT_2026-07-03.md`, §3), which reached the same SP-2-first ordering independently.

---

## 1. Current Spaces architecture (grounded)

### Models (`prisma/schema.prisma`)

The Space domain is mature and mostly renamed-from-Workspace via `@@map` (DB type/table names preserved). Core models:

- **`Space`** (`:367`, `@@map("Workspace")`) — `type` (`SpaceType`: PERSONAL | SHARED), `category` (`SpaceCategory`, 15 values), `isPublic`, lifecycle `archivedAt` / `deletedAt`. Relations to members, invites, accountLinks, goals, `dashboardSections`, snapshots, `aiAgent`, `auditLogs`, `importMappingProfiles`.
- **`SpaceMember`** (`:425`, `@@map("WorkspaceMember")`) — `role` (`SpaceMemberRole`: OWNER | ADMIN | MEMBER | VIEWER), `status` (`SpaceMemberStatus`: ACTIVE | REMOVED | LEFT). Rows are never deleted (audit history). `@@unique([spaceId, userId])`.
- **`SpaceInvite`** (`:453`) — grant-only, OWNER/ADMIN-issued.
- **`SpaceAccountLink`** (`:869`, D3) — sole account-link path since `WorkspaceAccountShare` was retired (v2.5-A Phase 4c). `kind` (HOME | SHARED), `visibilityLevel` (`VisibilityLevel`), `status` (`ShareStatus`). Partial-unique index enforces one HOME per account.
- **`SpaceDashboardSection`** (`:1051`, `@@map("WorkspaceDashboardSection")`) — per-Space section rows: `key`, `label`, `tab` (`SpaceDashboardTab`), `enabled`, `order`, `config Json?`. `@@unique([spaceId, key])`.
- **`SpaceGoal`** (`:952`), **`SpaceSnapshot`** (`:1383`), plus `AiAgent` (one per Space, `@@unique`).
- **No `SpaceTemplate` model exists.** The only "template" references in the schema (`:485–489`) are forward-looking comments reserving a *future* `SpaceTemplate.contextDomains`.

### API routes (23 route files under `app/api/space[s]`)

`switch`, list/create (`spaces/route.ts`), and per-Space `[id]/` handlers for `route.ts` (PATCH/archive/trash/delete), `accounts`, `accounts/share`, `activity`, `goals` (+ `[goalId]`, `check-in`), `invite`, `invites`, `members/[userId]`, `permanent`, `restore`, `perspectives`, `sections` (+ `[sectionId]`), `snapshots`, `transactions`, plus `spaces/invites/pending|seen` and `admin/spaces`.

### Permission checks — **two parallel systems**

1. **Centralized:** `requireSpaceRole(spaceId, minRole)` in `lib/session.ts` — Go-style tuple return, `ROLE_ORDER`-based `meetsMinRole`, enforces ACTIVE status. Used by **12** route files (goals, snapshots, invite, transactions, accounts, members, main `[id]` route, …).
2. **Inline:** raw `db.spaceMember.findUnique(...)` + hand-rolled `status !== "ACTIVE"` and `["OWNER","ADMIN"].includes(role)` checks, re-implemented in **13** route files (sections, `sections/[sectionId]`, activity, perspectives, `goals/check-in`, accounts/share, parts of members, …).

A **third** role→capability encoding lives in `lib/space.ts` as `derivePermissions(role)` → `{ canInvite, canManage, canWrite, canRead, isOwner }`, entirely separate from `ROLE_ORDER` in `session.ts`. And the **PERSONAL-Space-cannot-be-archived/deleted** rule is a bare inline `existing.type === "PERSONAL"` string check duplicated across `[id]/route.ts` (`:88`, `:139`) and `[id]/permanent/route.ts` (`:52`).

### Membership gate & context

`lib/space.ts` — `getSpaceContext()` (React `cache()`-wrapped, session + `fintracker_space` cookie) and `resolveSpaceContext(userId, activeSpaceId?)` are the canonical membership resolver with PERSONAL-Space fallback and archived/trashed exclusion.

### Preset / template system (`lib/space-presets.ts`, 492 lines)

Category → default `SpaceDashboardSection` records, **hardcoded TypeScript, not data**. `PRESET_MAP: Record<SpaceCategory, SectionPreset[]>` + three universal sections (Goals/Accounts/Activity) merged by `getPresetsForCategory()`. Seeded at Space creation inside the `spaces` POST transaction. Local enum mirrors (`SpaceCategory`, `SpaceDashboardTab`) exist so the file compiles pre-`prisma generate`. Also exports `CATEGORY_LABELS/DESCRIPTIONS/ICONS` and `PRIMARY/SECONDARY_CATEGORIES` for the template picker.

### Section registry (`lib/widget-registry.ts`, ~815 lines) — **the mature part**

"Central source of truth for every section key," with `DataRequirement`, config schema, and implementation status. The runtime compositor (`components/dashboard/SpaceDashboard.tsx`) looks entries up here; adding a section = one entry. This subsystem is healthy and not a target.

### UI surfaces

`app/(shell)/dashboard/spaces/page.tsx` (+ `SpacesClient.tsx`), `CreateSpaceModal.tsx`, `ManageSpaceModal.tsx`, `SpaceDashboard.tsx` (compositor), and widgets under `components/dashboard/widgets/*` and `components/space/widgets/*`.

### Member roles

`SpaceMemberRole` = OWNER | ADMIN | MEMBER | VIEWER, with `SpaceMemberStatus` = ACTIVE | REMOVED | LEFT. Capability mapping is currently expressed **three** different ways (see above).

---

## 2. Where authorization is duplicated or risky

The core finding: **role, lifecycle, and visibility rules are re-derived per route with three different encodings and inconsistent styles.** This is the same failure class the changelog records four times (KD-1 / KD-15 / KD-19 + class: "a read surface disagreeing with the canonical rule").

Concrete duplication / risk points, all grounded:

- **~13 route files re-implement the membership+role check inline** instead of calling `requireSpaceRole`, using divergent idioms — `SpaceMemberStatus.ACTIVE` enum vs. the string `"ACTIVE"`; `["OWNER","ADMIN"].includes(role)` vs. `requireSpaceRole(ADMIN)`'s `ROLE_ORDER` precedence. Two ways to say the same thing drift over time.
- **Three separate role→capability sources of truth:** `derivePermissions` (`lib/space.ts`), `meetsMinRole`/`ROLE_ORDER` (`lib/session.ts`), and ad-hoc `.includes()` arrays in routes. No single place answers "can this member do X."
- **The PERSONAL-Space lifecycle invariant is a stringly-typed inline check** duplicated in `[id]/route.ts` and `[id]/permanent/route.ts`. Any new lifecycle route must remember to re-add it; nothing structurally enforces it. The schema comment itself says this is "enforced in the API layer, not the schema."
- **Visibility logic is a fourth axis** living in `lib/ai/visibility.ts` (`grantsTransactionDetail`, `grantsAccountDetail` over `VisibilityLevel`), not composed with the role checks — so "can this viewer see this account's detail" and "is this user an ADMIN" are answered in different modules with no shared entry point.
- **No existence-disclosure discipline is centrally guaranteed.** Several routes correctly return 403-not-404 for non-members ("no space existence disclosure"), but that's a per-author convention, not an enforced contract.

None of these is an active exploit today, but each new Space-scoped route widens the surface. This is real, security-relevant, structural debt.

---

## 3. Should we do SP-2 before SP-1? — **Yes.**

**Why SP-2 first:**

- **Security-relevant and recurring.** SP-2 attacks a leak class that has already produced four logged defects; SP-1 attacks a *convenience/extensibility* gap (config-as-code) with no correctness incidents behind it.
- **Additive and low-drama to land.** The policy module is a new file with no callers on day one; routes migrate opportunistically. SP-1 needs a new Prisma model + migration.
- **Not blocked by governance.** D9 (SpaceTemplate) is explicitly **Parked** in `STATUS.md` (§3 line 54, §8 line 212: unpark condition = "real users requesting templates post-launch"). Making SP-1 the first slice would require an un-park decision *before* any parallel work can start. SP-2 requires no such gate.
- **FlowType-disjoint.** FlowType P5's footprint is `lib/transactions/*`, `lib/plaid/syncTransactions.ts`, `app/api/accounts/[id]/import/route.ts`, `app/api/ai/chat/route.ts`, and the `Transaction` schema block. It touches **zero** Space models, Space routes, or Space libs (verified: no Space route imports any flow/classifier lib). SP-2 lives entirely in `lib/` + `app/api/spaces/*` — no overlap.
- **SP-2 does not block SP-1; the reverse partly holds.** A template-driven Space eventually needs consistent authorization to gate template edit/publish. Getting the policy home in place first means SP-1 (and the parked PublishedAccountView / Frameworks) plug into one auth surface instead of a fourth.

**Why not SP-1 first:** it is the higher-ceiling initiative (turns Space config from code into data, unlocks inheritance/versioning/marketplace), but it is schema-bearing, Parked, and carries migration + seed risk. Its *investigation and checklist* are lateral and can be drafted in parallel — but its *code* should wait behind an un-park approval and ideally behind SP-2.

---

## 4. What a centralized Space policy module would look like

**File location:** `lib/spaces/policy.ts` (new `lib/spaces/` home; a `policy.test.ts` sits beside it). Pure, `server-only`, no route or React imports — so it is unit-testable in isolation and importable by both routes and Server Components.

**Exported functions (shape, not final):**

- `type SpaceAction` — a closed union: `"space:read" | "space:edit" | "space:archive" | "space:delete" | "member:invite" | "member:manage" | "section:edit" | "goal:edit" | "account:share" | "account:revoke"`.
- `can(action: SpaceAction, ctx: { role: SpaceMemberRole; status: SpaceMemberStatus; spaceType: SpaceType }): boolean` — the single role/lifecycle predicate. Absorbs `derivePermissions`, `meetsMinRole`, the `.includes()` arrays, **and** the PERSONAL-Space lifecycle guard (e.g. `space:archive`/`space:delete` return false when `spaceType === "PERSONAL"`).
- `canSeeAccountDetail(level: VisibilityLevel)` / `canSeeTransactionDetail(level: VisibilityLevel)` — thin re-exports composing the existing `lib/ai/visibility.ts` predicates, so visibility joins role under one roof without moving that logic.
- `requireSpaceAction(spaceId, action)` — a thin wrapper over the existing `requireSpaceRole` resolver that fetches membership once and evaluates `can()`, returning the same Go-style `[auth, err]` tuple routes already use. This is the route-facing entry point.

**Route usage (migration pattern):** replace each inline `db.spaceMember.findUnique(...) + status/role checks` with `const [auth, err] = await requireSpaceAction(spaceId, "section:edit"); if (err) return err;`. `requireSpaceRole` stays as the lower-level primitive `requireSpaceAction` is built on — no route churn is forced; migration is per-route and reviewable in isolation.

**Rollback plan:** the module is additive and starts with zero importers. Rollback = stop importing it and delete the file; every route still has its original (or `requireSpaceRole`-based) check. Migrate routes one PR at a time so any single revert is one file. No schema, no data, nothing to un-migrate.

**Tests:** `lib/spaces/policy.test.ts` — an exhaustive truth table over {role × status × spaceType × action} asserting `can()` output, plus explicit cases pinning the four historical leaks (PERSONAL-Space delete/archive denied; REMOVED/LEFT member denied all; VIEWER denied writes; existence-non-disclosure = 403 not 404). Pure function ⇒ deterministic, fast, no DB. Add one integration test per migrated route confirming the 403 boundary is unchanged.

---

## 5. What a SpaceTemplate foundation would look like

**Schema needs (additive only, gated on D9 un-park):** a new `SpaceTemplate` model — `id`, `key` (stable slug), `name`, `description`, `category SpaceCategory`, `sections Json` (the `SectionPreset[]` currently hardcoded), `contextDomains Json` (backing the reserved `getDomainManifest` hook), `isPublic`/`isSystem`, `version`, timestamps. `Space` gains an **optional** `templateId String?` + relation. Optionality is the whole safety story: existing Spaces keep resolving via category default; nothing is backfilled.

**Seed / template data:** a `prisma/seed`-style script materializes today's `PRESET_MAP` into `SpaceTemplate` rows (one system template per category). This is a *lift-and-shift of existing constants into rows*, so the seed output is verifiable against `getPresetsForCategory()` byte-for-byte before any read cutover.

**Relation to existing `space-presets.ts`:** `space-presets.ts` becomes the *fallback / seed source*, not the runtime authority. `getPresetsForCategory()` keeps working; a new resolver prefers a `SpaceTemplate` row when `templateId` is set and falls back to the category preset otherwise. The file's own header already anticipates this ("optionally import from @prisma/client instead"). The D4 manifest seam is ready: `getDomainManifest(category, templateId)` in `lib/ai/domain-manifest.ts` already *accepts and ignores* `templateId` (`:152–163`) — SP-1 is the data that fills a seam already drawn.

**Migration risk:** **low but non-zero** because it is schema-bearing. Risks: (a) the seed must exactly reproduce current section output or new Spaces change shape — mitigated by the byte-for-byte equivalence check; (b) `templateId` must stay nullable and unread until the resolver is deliberately cut over (additive-before-subtractive); (c) it collides with any concurrent `Space`-model edit, so it must not run in the same window as FlowType's `Transaction` schema work (different model, but same `schema.prisma` file — merge-conflict adjacency).

**Future marketplace / Frameworks compatibility:** `SpaceTemplate` is the substrate the parked Marketplace (D9), PublishedAccountView (PAV), and "Frameworks" all require — `isPublic`/`isSystem`/`version` are the forward hooks for user-authored and shareable templates. Building the model additively now means those parked ideas unpark into an existing table instead of a migration each. This is exactly why SP-1's *investigation* is worth drafting in parallel even while its *code* waits.

---

## 6. Which Spaces work can proceed **safely in parallel** with FlowType P5

FlowType P5 owns `lib/transactions/*`, `lib/plaid/syncTransactions.ts`, `app/api/accounts/[id]/import/route.ts`, `app/api/ai/chat/route.ts`, and the `Transaction` block of `schema.prisma`. Anything disjoint from that set is parallel-safe:

- **SP-2 policy module (Slice 1) — fully safe.** `lib/spaces/*` + `app/api/spaces/*` only; no shared files.
- **SP-2 route migration (Slice 2) — safe.** Touches `app/api/spaces/*` route handlers only.
- **SP-1 *investigation + checklist* (Slice 3, docs only) — safe.** Zero code.
- **Section-registry / preset cleanup that is pure code-move within `lib/space-presets.ts` + `lib/widget-registry.ts`** — safe, but low priority and excluded from the top-3 (no correctness driver; risks churn near the composition layer).

## 7. Which Spaces work should **wait** until FlowType P5 finishes

- **Any `schema.prisma` edit — including SP-1's `SpaceTemplate` model.** Even though `SpaceTemplate` is a different model, it edits the same `schema.prisma` file and generates a migration; running it concurrently with FlowType's `Transaction` migration invites merge-conflict and migration-ordering pain. Wait for the FlowType schema step to land (or land in a serialized window), **and** obtain the D9 un-park approval first.
- **Space Dashboard composition UX, Create-Space flow UX, template-discovery UI** — deferred on their own merits (UI-1 Atlas Glass is the live design lane; opening a second UI front competes for the same surface) and because template-driven UX depends on SP-1 data.
- **Public Spaces / Frameworks / PublishedAccountView** — Parked; depend on SP-1 substrate.

---

## 8. Recommended next 3 Spaces slices (ranked)

### Slice 1 — SP-2a: Introduce the Space policy module (additive, zero callers) ⭐ FIRST

- **Objective:** Land `lib/spaces/policy.ts` as the single tested home for role + lifecycle + visibility decisions, with no route yet importing it. Establish the truth-table tests.
- **Files touched:** `lib/spaces/policy.ts` (new), `lib/spaces/policy.test.ts` (new). Read-only *reference* to `lib/ai/visibility.ts` and `@prisma/client` enums. No route edits.
- **Merge-conflict risk:** **Very low** — all-new files; disjoint from FlowType and from UI-1.
- **Touches UI:** **No.**
- **Validation checklist:** `npx prisma generate` (no schema change, sanity only) · `npx tsc --noEmit` · `npm run lint` · `npm test lib/spaces/policy.test.ts` (truth table green, four historical-leak cases pinned).
- **Rollback plan:** delete the two new files; nothing imports them. Zero-impact revert.

### Slice 2 — SP-2b: Migrate inline-check routes to `requireSpaceAction`

- **Objective:** Replace the ~13 hand-rolled `spaceMember.findUnique` + role/status checks with `requireSpaceAction(...)`, preserving every current 403/404 boundary exactly. Migrate in small batches (start with `sections`, `sections/[sectionId]`, `accounts/share` — the clearest OWNER/ADMIN duplication).
- **Files touched:** `app/api/spaces/[id]/sections/route.ts`, `.../sections/[sectionId]/route.ts`, `.../accounts/share/route.ts`, then `.../activity`, `.../perspectives`, `.../goals/[goalId]/check-in`, `.../members/[userId]` in later batches. One PR per batch.
- **Merge-conflict risk:** **Medium** — touches multiple route files; sequence away from any concurrent Space-route edits. Still fully FlowType-disjoint.
- **Touches UI:** **No** (response shapes/status codes unchanged).
- **Validation checklist:** per batch — `npx tsc --noEmit` · `npm run lint` · targeted route tests asserting 401/403/404/200 boundaries are byte-identical pre/post · manual smoke on section toggle + account share.
- **Rollback plan:** revert the batch PR; `requireSpaceRole` and the original inline checks remain intact underneath, so partial migration is a valid resting state.

### Slice 3 — SP-1a: SpaceTemplate foundation *investigation + additive-schema checklist* (docs only)

- **Objective:** Produce the D9 un-park request, impact map, additive-schema design (model + nullable `Space.templateId`), seed-equivalence proof plan, and validation checklist — **no code, no migration.** Ready SP-1 so its implementation is a gated flip once FlowType's schema step clears and D9 is un-parked.
- **Files touched:** `docs/initiatives/d9/*` (new investigation + checklist). No source, no schema.
- **Merge-conflict risk:** **None** (docs only).
- **Touches UI:** **No.**
- **Validation checklist:** internal review that the proposed seed reproduces `getPresetsForCategory()` output for all 15 categories; confirm `getDomainManifest`'s `templateId` seam is the sole integration point; confirm additive-before-subtractive (existing Spaces untouched).
- **Rollback plan:** N/A (documentation).

---

## 9. Recommendation

**Start Slice 1 (SP-2a — the Space policy module).** It is the highest-leverage, lowest-risk, fully FlowType-parallel move: it closes a four-time-recurring security-relevant leak class, lands additively with zero callers (trivial rollback), needs no schema and no governance gate, and gives SP-1 and every parked shared-Space feature a single authorization surface to build against. Run Slice 3 (SP-1 investigation) opportunistically alongside it as pure documentation, and hold Slice 1's route migration (Slice 2) and all SP-1 *code* behind their respective sequencing gates.

Per project working style, each slice still gets its own impact map, rollback plan, and validation checklist before any code — this report is the investigation that precedes the first checklist, not the checklist itself.
