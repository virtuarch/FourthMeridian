# Fourth Meridian — PO1.0 Platform Access Foundation: Implementation Plan

**Date:** 2026-07-13
**Scope:** PO1.0 only — the platform authorization seam, the four seeded platform Spaces, grant administration, and access-derived visibility. No ops widgets with real data (those are PO1.1+), no telemetry, no schema changes outside the ones specified here.
**Grounding:** `FOURTH_MERIDIAN_PO1_CAPABILITIES_INVESTIGATION_2026-07-13.md` (this plan's companion; all §1 findings cited there), plus the decided 07-07 architecture (`FOURTH_MERIDIAN_PO1_PLATFORM_ACCESS_INVESTIGATION_2026-07-07.md`, `FOURTH_MERIDIAN_SECOPS_ARCHITECTURE_REVIEW_2026-07-07.md`).
**Doctrine:** investigation first · smallest additive slices · behavior-neutral substrate before cutover · every slice independently shippable and revertible · validation gate at the end · no opportunistic refactors.

---

## 1. Repository findings (full citations in the 2026-07-13 investigation)

1. Platform authority is binary: `enum UserRole { USER, SYSTEM_ADMIN }` (`prisma/schema.prisma:243-246`); all 14 `app/api/admin/*` routes gate on `requireSystemAdmin` (`lib/session.ts:200-208`), only the session-revoke route on the fresh variant (`app/api/admin/security/users/[userId]/sessions/route.ts:42`). No capability/grant/entitlement primitive exists anywhere.
2. The pure/impure authz pattern to mirror: pure `can(action, ctx)` over `ACTION_POLICY: Record<SpaceAction, ActionRule>` (`lib/spaces/policy.ts:114-170`) + impure `requireSpaceAction` adapter with a separately-testable `decideSpaceAction` (`lib/spaces/authorize.ts:74-111`).
3. The grant-row pattern to mirror: `SpaceMember` — `@@unique([spaceId, userId])`, status enum instead of deletion, `revokedAt`/`revokedById` provenance (`prisma/schema.prisma:493-518`).
4. `Space.category: SpaceCategory` (`schema.prisma:428`) is user-facing and client-creatable (`app/api/spaces/route.ts:98-101`) with category-exhaustive template tests (`lib/space-templates/registry.test.ts:132-135` et al.) — the platform marker must be a new field.
5. "My Spaces" surfaces: `GET /api/spaces` (`app/api/spaces/route.ts:39-61`, consumed by `components/ui/Sidebar.tsx:106` and AddManualAssetModal — both read only `mine[].{id,name,type,myRole}`), and the Spaces landing page (`app/(shell)/dashboard/spaces/page.tsx:36-38`).
6. Ambient Space context is membership-only: `/api/space/switch` checks `spaceMember.findUnique` (`app/api/space/switch/route.ts:41`), `resolveSpaceContext` likewise with a PERSONAL fallback (`lib/space.ts:168-202`). Platform Spaces must NOT enter this machinery.
7. `proxy.ts` redirects SYSTEM_ADMIN off `/dashboard/*` to `/admin` and non-SYSTEM_ADMIN off `/admin/*` to `/dashboard` (`proxy.ts:48-55`; matcher `proxy.ts:79-82`). Consequence: grant-holders (role USER) consume platform Spaces under `/dashboard/*`; the admin administers grants under `/admin/*`. The two surfaces never mix.
8. Data readiness gradient (investigation §2–3): Security Ops read routes exist today; Platform Ops has data but zero read routes; Growth & Revenue and Customer Success have no purpose-built data. PO1.0 therefore seeds and gates all four Spaces but ships placeholder content only.

---

## 2. Exact implementation design

### 2.1 Schema diff (one additive migration: `20260713TTTTTT_po1_0_platform_access`)

Append to `prisma/schema.prisma` (placement: after `enum UserRole`, and a new model block after `SpaceMember`):

```prisma
/// PO1.0 — a platform-facing area of Fourth Meridian itself, each backed by
/// exactly one system-singleton Space (Space.platformArea). Extensible:
/// adding an area = one enum value + one PLATFORM_AREAS metadata entry +
/// re-running the idempotent seed. NOT user-facing categorization — that is
/// SpaceCategory; do not conflate (see PO1 capabilities investigation §1.5).
enum PlatformArea {
  PLATFORM_OPS
  SECURITY_OPS
  GROWTH_REVENUE
  CUSTOMER_SUCCESS
}

/// Ranked access level within one PlatformArea. WRITE ≥ READ (LEVEL_RANK in
/// lib/platform/policy.ts) — never compared for equality, mirroring how
/// SpaceMemberRole is consumed via ROLE_RANK/ROLE_ORDER.
enum PlatformAccessLevel {
  READ
  WRITE
}

/// Grant lifecycle. Rows are never deleted — revocation is a status flip with
/// provenance, mirroring SpaceMember ("rows are never deleted").
enum PlatformGrantStatus {
  ACTIVE
  REVOKED
}

/// PO1.0 — THE platform-access source of truth: user × area × level.
/// Orthogonal to SpaceMember on purpose: holding a grant makes the area's
/// platform Space visible (access-derived listing union) and gates its data
/// routes via requirePlatformAccess — it never creates a SpaceMember row and
/// never confers any customer-Space authority (and vice versa).
model PlatformGrant {
  id     String              @id @default(cuid())
  userId String
  user   User                @relation("PlatformGrantsHeld", fields: [userId], references: [id], onDelete: Cascade)
  area   PlatformArea
  level  PlatformAccessLevel
  status PlatformGrantStatus @default(ACTIVE)

  grantedById String?
  grantedBy   User?    @relation("PlatformGrantsIssued", fields: [grantedById], references: [id], onDelete: SetNull)
  grantedAt   DateTime @default(now())

  // Populated when status transitions to REVOKED (mirrors SpaceMember.revokedBy*)
  revokedAt   DateTime?
  revokedById String?
  revokedBy   User?     @relation("PlatformGrantsRevoked", fields: [revokedById], references: [id], onDelete: SetNull)

  updatedAt DateTime @updatedAt

  @@unique([userId, area])
  @@index([userId, status])
  @@index([area, status])
}
```

On `model Space` (after `category`, `schema.prisma:428`):

```prisma
  // PO1.0 — non-null marks this row as the system-singleton platform Space
  // for one PlatformArea: bootstrap-seeded (lib/platform/seed.ts), never
  // client-creatable (POST /api/spaces does not read this field), un-deletable
  // in practice (no SpaceMember rows ever exist, so every membership-gated
  // lifecycle route already denies; tripwired in lib/platform-surface.test.ts).
  // @unique doubles as the one-Space-per-area invariant (NULLs are distinct).
  platformArea PlatformArea? @unique
```

On `model User`, three back-relations (house style — every relation is named):

```prisma
  platformGrants        PlatformGrant[] @relation("PlatformGrantsHeld")
  platformGrantsIssued  PlatformGrant[] @relation("PlatformGrantsIssued")
  platformGrantsRevoked PlatformGrant[] @relation("PlatformGrantsRevoked")
```

Migration is purely additive (2 enum types + 1 enum type + 1 table + 1 nullable unique column + FK indexes). No existing row changes, no backfill, no data migration.

**Re-grant semantics:** `@@unique([userId, area])` + never-delete means a revoked grant is *reinstated* (status→ACTIVE, level set, `grantedById`/`grantedAt` refreshed, `revoked*` cleared) rather than re-created. One row per (user, area), forever, fully attributable.

### 2.2 Pure policy — new file `lib/platform/policy.ts`

Mirrors `lib/spaces/policy.ts` one-to-one (pure, no I/O, no session, no DB):

```ts
import type { PlatformArea, PlatformAccessLevel, PlatformGrantStatus } from "@prisma/client";

/** Display + seed metadata per area — the single registry (PlatformSettingKey style). */
export interface PlatformAreaMeta {
  key: PlatformArea;
  label: string;            // "Security Operations"
  spaceName: string;        // "Security Operations" (Space.name at seed)
  spaceDescription: string;
  /** Section rows the seed materializes (key/label/tab/order); placeholders in PO1.0. */
  sections: { key: string; label: string; order: number }[];
}

export const PLATFORM_AREAS: Record<PlatformArea, PlatformAreaMeta> = { /* exhaustive — compiler-enforced */ };

/** Canonical level precedence. WRITE implies READ. Mirrors ROLE_RANK (lib/spaces/policy.ts:90). */
const LEVEL_RANK: Record<PlatformAccessLevel, number> = { READ: 0, WRITE: 1 };

export interface PlatformGrantCtx {
  area: PlatformArea;
  level: PlatformAccessLevel;
  status: PlatformGrantStatus;
}

/**
 * Pure decision: does this grant set allow `needed` on `area`?
 *   1. Only ACTIVE grants count (REVOKED ⇒ denied — no residual access).
 *   2. Area must match exactly (no cross-area inheritance).
 *   3. LEVEL_RANK[grant.level] >= LEVEL_RANK[needed].
 * SYSTEM_ADMIN bypass deliberately does NOT live here — it is the adapter's
 * concern (policy stays a pure statement about grants).
 */
export function hasPlatformAccess(
  area: PlatformArea,
  needed: PlatformAccessLevel,
  grants: readonly PlatformGrantCtx[],
): boolean { /* … */ }

/** Derived 07-07-style capability names, for display/widget self-declaration only. */
export type PlatformCapability = `${PlatformArea}_${"VIEW" | "MANAGE"}`;
```

Section keys seeded per area in PO1.0 (all placeholder widgets; real adapters land in PO1.1/PO1.2):

| Area | Section keys (order) |
|---|---|
| PLATFORM_OPS | `ops_job_health`, `ops_rate_limits`, `ops_env_status` |
| SECURITY_OPS | `sec_audit_feed`, `sec_auth_posture`, `sec_sessions` |
| GROWTH_REVENUE | `growth_signups` (honest label: revenue has no data source until v3.0 billing — D10) |
| CUSTOMER_SUCCESS | `cs_sync_issues` (honest label: no CS primitives exist yet) |

### 2.3 Impure adapter — new file `lib/platform/authorize.ts`

Mirrors `lib/spaces/authorize.ts` (Go-tuple, pure decision factored out for tests):

```ts
export type PlatformAuth = {
  user: SessionUser;
  /** null exactly when access came from the SYSTEM_ADMIN bypass. */
  grant: { area: PlatformArea; level: PlatformAccessLevel } | null;
};

/** Pure branch (unit-testable): SYSTEM_ADMIN ⇒ allow; else hasPlatformAccess(). */
export function decidePlatformAccess(
  role: UserRole, area: PlatformArea, needed: PlatformAccessLevel,
  grants: readonly PlatformGrantCtx[],
): boolean;

/** requireUser() → one platformGrant.findUnique({ userId_area }) → pure decision.
 *  401 no session · 403 no/insufficient/revoked grant. Never 404 (no existence disclosure). */
export async function requirePlatformAccess(
  area: PlatformArea, needed: PlatformAccessLevel,
): Promise<[PlatformAuth, null] | [null, NextResponse]>;

/** Same, but live-revocation re-check à la requireFreshUser (lib/session.ts:165-191).
 *  Required for every future WRITE mutation on a platform area. Unused in PO1.0
 *  (PO1.0 ships no WRITE actions) — defined now so PO1.1+ cannot forget it. */
export async function requireFreshPlatformAccess(/* same signature */);
```

The SYSTEM_ADMIN bypass sits here (adapter), matching the 07-07 break-glass ruling; the `user.role !== UserRole.SYSTEM_ADMIN` comparison reuses the `lib/session.ts:205` idiom.

### 2.4 Bootstrap seed — new files `lib/platform/seed.ts` + `scripts/seed-platform-spaces.ts`

```ts
// lib/platform/seed.ts — idempotent; safe to run any number of times, anywhere.
export async function ensurePlatformSpaces(client: PrismaClient = db): Promise<void> {
  for (const area of Object.values(PlatformArea)) {
    const meta = PLATFORM_AREAS[area];
    await client.space.upsert({
      where:  { platformArea: area },     // the @unique marker IS the identity
      update: {},                          // never mutate an existing platform Space
      create: {
        name: meta.spaceName,
        description: meta.spaceDescription,
        type: "SHARED",
        category: "OTHER",                 // mundane; never rendered for platform Spaces
        isPublic: false,
        platformArea: area,
        dashboardSections: {
          create: meta.sections.map((s) => ({
            key: s.key, label: s.label, tab: "OVERVIEW", enabled: true, order: s.order,
          })),
        },
      },
    });
  }
}
```

- `scripts/seed-platform-spaces.ts`: thin CLI over the helper (house pattern of `scripts/check-job-health.ts`), run once against prod after migrating.
- `prisma/seed.ts`: call `ensurePlatformSpaces(prisma)` after the sysadmin user block (`prisma/seed.ts:309-315`) so dev databases always have the four Spaces.
- **Deliberately absent:** `SpaceMember` rows (visibility is access-derived — 07-07 risk #1), `AiAgent` row (customer Spaces provision one per create-transaction, `app/api/spaces/route.ts:165-171`; platform Spaces never enter `buildContext`/brief paths because those are membership-driven — an AI-Ops agent is a later PO1.x decision), invites, goals, snapshots.

### 2.5 Grant administration — audit actions, API, UI

**`lib/audit-actions.ts`** — four new canon constants (never free strings; this is the SECOPS vocabulary lesson applied from birth):

```ts
  // ── Platform access (PO1.0) ─────────────────────────────────────────────
  PLATFORM_GRANT_CREATED:       "PLATFORM_GRANT_CREATED",
  PLATFORM_GRANT_LEVEL_CHANGED: "PLATFORM_GRANT_LEVEL_CHANGED",
  PLATFORM_GRANT_REVOKED:       "PLATFORM_GRANT_REVOKED",
  PLATFORM_GRANT_REINSTATED:    "PLATFORM_GRANT_REINSTATED",
```

**`app/api/admin/platform-grants/route.ts`** — the extra-guarded path (07-07 risk #6):

- `GET` — list all grants (any status) with holder identity + grantor/revoker identity. Guard: `requireSystemAdmin` (read).
- `POST` `{ userId, area, level }` — create, reinstate, or change level (single upsert-shaped handler; which of the three it was determines the audit action). Guards, in order:
  1. `requireFreshSystemAdmin()` (`lib/session.ts:218-241`) — live revocation check; **deliberately stronger than the cached guard most admin routes use**.
  2. `limitByUser(admin.id, "platform-grant", { limit: 20, windowSec: 60 })` (`lib/rate-limit.ts` usage pattern per its header).
  3. Target validation: user exists, `role === "USER"` (SYSTEM_ADMIN needs no grants — bypass already; granting one would only mislead audits), `area`/`level` are enum members.
  4. Write + `AuditLog` row in **one transaction**: `{ userId: targetId, action: AuditAction.PLATFORM_GRANT_*, performedByAdminId: admin.id, metadata: { area, level, previousLevel?, previousStatus? }, ipAddress }` — reusing `performedByAdminId` (`prisma/schema.prisma:2221`) exactly as designed.

**`app/api/admin/platform-grants/[grantId]/route.ts`**:

- `PATCH` `{ action: "revoke" }` — status→REVOKED + `revokedAt`/`revokedById`, audited as `PLATFORM_GRANT_REVOKED`. Same four-step guard stack as POST.

**Deliberately absent in PO1.0 (recorded decision):** a self-hosted "grant management" platform capability (07-07's PO1.4 `ACCESS_GRANT`). Grant mutation is SYSTEM_ADMIN-only, full stop. This removes the grant-yourself-access escalation class *entirely* in PO1.0 — no capability can mint capabilities. Self-hosting moves to a later PO1.x with its own investigation.

**`app/admin/platform-access/page.tsx`** — admin UI: user picker (reuse the `admin/security/users` search shape), a 4-column area matrix per user with `— / READ / WRITE` state, revoke buttons, and a grant-history panel driven by the new audit actions through the existing `admin/audit` viewer filters. Follows `app/admin/layout.tsx`'s session gate (`app/admin/layout.tsx:21`); nav entry added beside Security.

### 2.6 Access-derived visibility — the "My Spaces" union (exact changes)

**`app/api/spaces/route.ts` GET (`:39-61`)** — additive response key; `mine` byte-identical:

```ts
  // PO1.0 — platform Spaces the caller holds an ACTIVE grant on (access-derived;
  // no SpaceMember rows exist for platform Spaces by design).
  const grants = await db.platformGrant.findMany({
    where: { userId: user.id, status: "ACTIVE" },
    select: { area: true, level: true },
  });
  const platform = grants.length === 0 ? [] : (
    await db.space.findMany({
      where:  { platformArea: { in: grants.map((g) => g.area) } },
      select: { id: true, name: true, platformArea: true },
    })
  ).map((s) => ({ ...s, access: grants.find((g) => g.area === s.platformArea)!.level }));

  return NextResponse.json({ mine: …unchanged…, platform });
```

Both existing consumers read only `data.mine` (route header, `app/api/spaces/route.ts:30-38`), so the new key is invisible to them until opted in. **AddManualAssetModal is deliberately NOT opted in** — platform Spaces are never share targets.

**`components/ui/Sidebar.tsx`** — render a separated "Platform" group under My Spaces from `data.platform`; each entry is a plain link to `/dashboard/platform/[area]`. **No `/api/space/switch` call, no `ACTIVE_SPACE_COOKIE` write** — the ambient Space context never points at a platform Space (finding #6).

**`app/(shell)/dashboard/spaces/page.tsx`** — add one parallel query (grants → platform Spaces, same shape as above) to the existing `Promise.all` (`:30`), pass `platformSpaces` to `SpacesClient`, which renders a "Platform" card group linking to `/dashboard/platform/[area]`. The `publicSpaces` query (`:76`) additionally gains `platformArea: null` as defense-in-depth (already excluded via `isPublic: false`).

### 2.7 The platform-Space host — new page `app/(shell)/dashboard/platform/[area]/page.tsx`

Server component; the *only* render path for platform Spaces:

1. Parse `[area]` against `Object.values(PlatformArea)` — unknown → `redirect("/dashboard/spaces")`.
2. Session via `getServerSession(authOptions)` → no session → `redirect("/login")` (same as `app/(shell)/dashboard/spaces/page.tsx:20-21`).
3. Grant check: one `platformGrant.findUnique({ userId_area })`, require `status === "ACTIVE"` — else `redirect("/dashboard/spaces")` (no existence disclosure; consistent with the adapter's never-404 rule). (`SYSTEM_ADMIN` never reaches this page — `proxy.ts:49-50` redirects them to `/admin`.)
4. Fetch the Space row (`where: { platformArea: area }`) + its enabled `SpaceDashboardSection` rows ordered by `order` — reusing the section model (`prisma/schema.prisma:1160-1177`) exactly as customer dashboards do.
5. Render `PlatformSpaceDashboard` (new client component, `components/platform/PlatformSpaceDashboard.tsx`): header (Space name, holder's access level badge), then one card per section via a local `PLATFORM_SECTION_REGISTRY` adapter map keyed by section key — the widget-registry adapter *pattern* ("add one entry, no switch/case", `lib/widget-registry.ts:9-11`) in a platform-local registry. In PO1.0 every entry renders an honest placeholder card ("Job health — lands in PO1.2 over lib/jobs/health.ts" / "Revenue — no data source until billing (v3.0)"), so the gate/listing/host chain is fully exercisable end-to-end before any data plumbing exists.

**No customer tab rail** (`SPACE_TAB_ORDER` is customer muscle-memory, `lib/space-nav.ts:11-15`), **no entry into `SpaceDashboard.tsx`**, **no `WIDGET_REGISTRY` entries** — the customer registry stays untouched.

Data routes for later slices are namespaced now: `app/api/platform/[area]/…`, each gated `requirePlatformAccess(area, "READ")` — PO1.0 creates the directory convention only (no routes yet).

### 2.8 Guardrail — new file `lib/platform-surface.test.ts`

Source-scan tripwire in the `lib/security-surface.test.ts` house pattern (`lib/security-surface.test.ts:2-20`):

1. `lib/platform/**` and `app/(shell)/dashboard/platform/**` and `app/api/platform/**` contain no `can(`, `requireSpaceRole`, `requireSpaceAction`, or `SpaceMemberRole` (07-07 risk #2: axis confusion).
2. `app/api/admin/platform-grants/**` contains `requireFreshSystemAdmin` and `limitByUser` and `AuditAction.PLATFORM_GRANT` (risk #6 floor cannot silently regress).
3. `app/api/spaces/route.ts` POST does not read `platformArea` from the request body.
4. `lib/platform/seed.ts` upsert has an empty `update: {}` (seed can never mutate a live platform Space).
5. No `spaceMember.create` appears anywhere under `lib/platform/**` or the grant routes (visibility stays access-derived).

---

## 3. Files

**New (10):**

| File | Contents |
|---|---|
| `prisma/migrations/20260713TTTTTT_po1_0_platform_access/migration.sql` | generated; additive only |
| `lib/platform/policy.ts` | `PLATFORM_AREAS`, `LEVEL_RANK`, `hasPlatformAccess`, types |
| `lib/platform/policy.test.ts` | standalone tsx unit tests (house pattern) |
| `lib/platform/authorize.ts` | `decidePlatformAccess`, `requirePlatformAccess`, `requireFreshPlatformAccess` |
| `lib/platform/seed.ts` | `ensurePlatformSpaces()` |
| `scripts/seed-platform-spaces.ts` | CLI over the seed helper |
| `lib/platform-surface.test.ts` | source-scan tripwires (§2.8) |
| `app/api/admin/platform-grants/route.ts` | GET list · POST grant/reinstate/level-change |
| `app/api/admin/platform-grants/[grantId]/route.ts` | PATCH revoke |
| `app/(shell)/dashboard/platform/[area]/page.tsx` + `components/platform/PlatformSpaceDashboard.tsx` | host shell + placeholder section renderer |
| `app/admin/platform-access/page.tsx` | grant matrix UI |

**Modified (6):** `prisma/schema.prisma` (§2.1) · `lib/audit-actions.ts` (4 constants) · `prisma/seed.ts` (call `ensurePlatformSpaces`) · `app/api/spaces/route.ts` (additive `platform` key) · `components/ui/Sidebar.tsx` (Platform group) · `app/(shell)/dashboard/spaces/page.tsx` + `components/dashboard/SpacesClient.tsx` (Platform card group; `platformArea: null` on `publicSpaces`).

**Explicitly untouched:** `lib/spaces/policy.ts`, `lib/spaces/authorize.ts`, `lib/session.ts`, `lib/space.ts` (`resolveSpaceContext`), `app/api/space/switch/route.ts`, `lib/space-nav.ts`, `lib/widget-registry.ts`, `lib/space-templates/**`, `SpaceCategory`, `proxy.ts`, all existing `app/api/admin/*` routes.

---

## 4. Slice plan (each independently shippable and revertible)

- **S1 — Schema.** §2.1 migration + `prisma generate`. Zero readers. Revert = drop migration.
- **S2 — Pure policy.** `lib/platform/policy.ts` + `policy.test.ts`. Zero callers (the SP-2a move, `lib/spaces/policy.ts:11-13`).
- **S3 — Adapter.** `lib/platform/authorize.ts` (pure `decidePlatformAccess` covered in S2's test file). Zero callers.
- **S4 — Seed + tripwires.** `lib/platform/seed.ts`, script, `prisma/seed.ts` wiring, `lib/platform-surface.test.ts`. After this slice the four Spaces exist but are invisible to everyone (no grants, no listing union yet) — deliberately inert.
- **S5 — Grant administration API.** Audit constants + both `platform-grants` routes. First real caller of the schema; still no user-visible surface.
- **S6 — Admin UI.** `app/admin/platform-access/page.tsx` + nav entry.
- **S7 — Visibility + host.** `/api/spaces` union, Sidebar group, Spaces-page group, host page + placeholder dashboard. This is the cutover slice: a granted user now sees and opens platform Spaces.
- **Gate — §8**, then STATUS.md ledger update (PO1.0 entry) in the completion doc.

**PO1.x sequencing decided now (build order confirmed by investigation §3):** PO1.1 Security Operations content (new `app/api/platform/security-ops/*` reads wrapping the same queries as `admin/audit`/`admin/security/*`, gated `requirePlatformAccess("SECURITY_OPS","READ")`; admin routes unchanged). PO1.2 Platform Operations content (thin reads: job health over `checkScheduledJobHealth()`, rate-limit status over `RateLimit`, env report via a `validateEnv()` report-shape refactor — SECOPS prep item #2). PO1.3 Growth & Revenue signups/activation panel (derived from `User.createdAt`/`emailVerifiedAt`/`UserSession.lastActiveAt`). PO1.4 Customer Success sync-issue triage (over `SyncIssue`). Deferred indefinitely: WRITE-level actions, role bundles, self-hosted grant management, platform-Space AiAgent, widget-level capability filtering.

---

## 5. Risks

1. **Privilege escalation via the grant endpoint (07-07 risk #6 — the big one).** Mitigations are structural in PO1.0: mutation is SYSTEM_ADMIN-only (no capability can mint capabilities), `requireFreshSystemAdmin` (no 30s-cache window, unlike most admin routes — deliberate upgrade), rate-limited, transactionally audited with canon actions, and targets restricted to `role === "USER"`. Tripwired (§2.8-2).
2. **Axis confusion** — an HQ surface gating on `SpaceMemberRole`/`can()`. Tripwired (§2.8-1); host page and adapters never import from `lib/spaces/*`.
3. **Platform Spaces leaking into customer surfaces.** Enumerations audited: public listing excluded (`isPublic:false` + explicit `platformArea:null`), `/api/spaces` `mine` untouched (membership-driven; platform Spaces have no members), share-picker unchanged, `resolveSpaceContext` unreachable (membership-driven). `admin/overview` *will* list them (`db.space.findMany` unfiltered, `app/api/admin/overview/route.ts:51`) — acceptable: SYSTEM_ADMIN-only, and arguably desirable; recorded, not changed.
4. **Enum extension friction later.** Postgres `ALTER TYPE … ADD VALUE` cannot run in the same transaction as its first use — adding a fifth `PlatformArea` must be its own migration, then a seed re-run. Recorded so the future slice isn't surprised.
5. **Sidebar/listing contract breakage.** Mitigated by the additive-key design; `mine` is asserted byte-identical in the gate.
6. **SYSTEM_ADMIN cannot view platform Spaces** (`proxy.ts:49-50` redirects them off `/dashboard`). By design in PO1.0 — the admin *administers* from `/admin`; if the operator later wants to *see* HQ content, that is a deliberate future decision (grant themselves nothing; change proxy semantics consciously), not an accident to hack around now.

---

## 6. Overengineering check

- No role bundles, no per-action capabilities, no widget-runtime capability filtering, no ops telemetry tables, no new tab rail, no AiAgent, no notification types — all named, all deferred with reasons (investigation §1.3; §4 above).
- The placeholder dashboard is a static registry of cards, not a framework. Real widgets in PO1.1+ replace card bodies one entry at a time.
- Four seeded Spaces × ~1–3 section rows each is the entire data footprint of PO1.0.

## 7. Testing expectations

- `lib/platform/policy.test.ts` (standalone tsx, house pattern): LEVEL_RANK semantics (READ satisfies READ; WRITE satisfies both; READ never satisfies WRITE), REVOKED denied everything, wrong-area denied, empty grants denied, `PLATFORM_AREAS` exhaustive over the enum, `decidePlatformAccess` SYSTEM_ADMIN bypass + USER-with/without-grant matrix.
- `lib/platform-surface.test.ts`: the five tripwires (§2.8).
- Existing suites untouched and green — in particular the three `SpaceCategory`-exhaustive template suites, which prove `SpaceCategory` was not extended.
- Seed idempotency: `ensurePlatformSpaces()` twice → exactly 4 platform Spaces (the `@unique` marker makes duplication impossible; the test proves the upsert path, not luck).

## 8. Validation gate (all must pass before PO1.0 is called done)

1. `npx prisma migrate dev` clean · `npx prisma generate` · `npx tsc --noEmit` · `npx eslint .` — zero errors.
2. `npx tsx lib/platform/policy.test.ts` · `npx tsx lib/platform-surface.test.ts` · full existing suite green (incl. `lib/security-surface.test.ts`, space-template suites).
3. `npx tsx scripts/seed-platform-spaces.ts` twice on a dev DB → 4 Spaces, second run a no-op.
4. Manual, as the dev sysadmin (`prisma/seed.ts:309-315`) + a seeded USER:
   - Grant READ SECURITY_OPS → Space appears in the user's Sidebar Platform group and Spaces page; host page renders the placeholder dashboard with a READ badge.
   - Revoke → gone from both listings; direct URL redirects to `/dashboard/spaces`.
   - Un-granted user, direct URL → redirect (no existence disclosure).
   - Every grant/revoke produced exactly one `AuditLog` row with the canon action, `performedByAdminId` set, visible in `/admin/audit`.
   - Grant mutation with a just-revoked admin session → 401 (fresh-auth proof).
   - `POST /api/spaces` with `platformArea` in the body → field ignored, normal Space created.
   - `GET /api/spaces` → `mine` byte-identical to pre-PO1.0 for a user with no grants; share-picker in AddManualAssetModal shows no platform Spaces.
   - SYSTEM_ADMIN visiting `/dashboard/platform/SECURITY_OPS` → redirected to `/admin` (proxy behavior intact).

## 9. Stop conditions (halt and re-investigate — do not improvise past any of these)

1. Any point where platform-Space visibility seems to need a `SpaceMember` row → stop. That is the dual-source-of-truth design 07-07 explicitly rejected (risk #1).
2. Any platform gate that wants `can()` / `requireSpaceRole` / `SpaceMemberRole` → stop (risk #2).
3. The host page seems to need `resolveSpaceContext`, `ACTIVE_SPACE_COOKIE`, or `/api/space/switch` changes → stop; the ambient-context machinery is out of scope by design.
4. Any pressure to add a `SpaceCategory` value → stop (investigation §1.5 closed this).
5. The migration turns non-additive (touches existing rows/columns) → stop.
6. The grant routes cannot satisfy fresh-auth + rate-limit + transactional canon audit → stop; that floor is the point of the slice.
7. Any platform data read routes through customer assemblers / `buildContext` / spaceId-scoped adapters → stop (07-07 risk #3: the scoping-invariant escape must be its own audited path — that path is PO1.1+, not PO1.0).
8. Placeholder pressure turns into new data modeling for Growth & Revenue or Customer Success → stop; that is PO1.3+/net-new work with its own investigation.
