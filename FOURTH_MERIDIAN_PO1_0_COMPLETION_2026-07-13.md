# Fourth Meridian — PO1.0 Platform Access Foundation: Completion Summary

**Date:** 2026-07-13
**Plan:** `FOURTH_MERIDIAN_PO1_0_IMPLEMENTATION_PLAN_2026-07-13.md`
**Grounding:** `FOURTH_MERIDIAN_PO1_CAPABILITIES_INVESTIGATION_2026-07-13.md`
**Outcome:** All seven slices shipped exactly as specified — one commit per slice, the §8 validation gate green after each, and the full §8 part-4 manual checklist executed against a running dev server with every item passing. No stop condition (§9) was hit.

---

## What shipped, per slice

| Slice | Commit | What landed |
|---|---|---|
| **S1 — Schema** | `30b7f5b` | Additive migration `20260713150000_po1_0_platform_access`: `PlatformArea` / `PlatformAccessLevel` / `PlatformGrantStatus` enums; the `PlatformGrant` grant-row model (user × area × level; never-deleted, revocation-provenance lifecycle mirroring `SpaceMember`); a nullable `Space.platformArea @unique` marker (the area link **and** the one-Space-per-area invariant in one field); three named `User` back-relations. Purely additive — no existing row/column changes, no backfill. |
| **S2 — Pure policy** | `caa92f4` | `lib/platform/policy.ts`: `PLATFORM_AREAS` (exhaustive `Record<PlatformArea, meta>` — display + honest seed metadata + placeholder section rows), `LEVEL_RANK` (WRITE ≥ READ), pure `hasPlatformAccess(area, needed, grants)` (only-ACTIVE, exact-area, level-rank). Knows nothing about the customer axis. `lib/platform/policy.test.ts`: a 128-combination single-grant matrix vs an independent oracle + named invariants + registry/rank exhaustiveness. |
| **S3 — Adapter** | `f072b7f` | `lib/platform/authorize.ts`: `requirePlatformAccess` / `requireFreshPlatformAccess` (Go-tuple; `requireUser`→one `platformGrant.findUnique` on the `userId_area` composite→pure decision; 401/403, **never 404**). The SYSTEM_ADMIN break-glass bypass lives here (adapter), not in the pure policy. Pure `decidePlatformAccess` branch covered in `policy.test.ts` via oracle + source-scan (the adapter can't be imported into a `tsx` script — `server-only`/Prisma/next). |
| **S4 — Seed + tripwires** | `90ee966` | `lib/platform/seed.ts` `ensurePlatformSpaces()` (idempotent upsert on the `@unique` marker; `update: {}` never mutates a live platform Space; **no SpaceMember rows, no AiAgent**); `scripts/seed-platform-spaces.ts` CLI; `prisma/seed.ts` wiring. `lib/platform-surface.test.ts`: the five load-bearing §2.8 tripwires. After this slice the four Spaces exist but are invisible (no grants, no listing union) — deliberately inert. |
| **S5 — Grant admin API** | `e2f3b84` | Four canon audit constants + a "Platform Access" filter group. `app/api/admin/platform-grants/route.ts` (GET list; POST single upsert-shaped create/reinstate/level-change — existing-row state selects the canon action; ACTIVE-at-same-level is an idempotent no-op). `[grantId]/route.ts` (PATCH revoke — status flip + provenance, never a deletion). Every mutation carries the **four-step guard stack**: `requireFreshSystemAdmin` + `limitByUser` + target validation (role === USER) + grant-write + `AuditLog` row in one transaction. |
| **S6 — Admin UI** | `636b4e4` | `app/admin/platform-access/page.tsx`: the (user × area) grant matrix — R/W cells POST, × revokes, state re-reads after each mutation; USER-role accounts only; search + a "Grant history" link to `/admin/audit`. AdminNav entry beside Security. |
| **S7 — Visibility + host (cutover)** | `088b189` | `/api/spaces` GET additive `platform` key (`mine` byte-identical; membership + grant queries in parallel). Sidebar "Platform" group + Spaces-page "Platform" card group (`platformArea: null` defense-in-depth on `publicSpaces`). Host page `app/(shell)/dashboard/platform/[area]/page.tsx` — the only render path — gate order area→session→ACTIVE-grant, every failure a redirect (never 404). `components/platform/PlatformSpaceDashboard.tsx` renders one honest placeholder card per section via a platform-local registry. `app/api/platform/` established as the PO1.1+ data-route directory convention (README only). |
| **Ledger + docs** | `acbd9cd` | STATUS.md PO1.0 row in §3 (OPS-x track) + correction of the two stale "PO1 … zero code" Current-focus claims. This completion summary. |

---

## Validation gate (§8) results

**Parts 1–3 — automated, re-run at completion against the final tree:**

- `prisma migrate status` → **up to date** (65 migrations); `prisma generate` clean.
- `npx tsc --noEmit` → **0 errors**.
- `npx eslint .` → **1 error, unchanged from the pre-PO1.0 baseline** (`components/dashboard/SpaceDashboard.tsx:2542`, a pre-existing `react-hooks/set-state-in-effect` in a file untouched by this work and unmodified vs `HEAD`). PO1.0 added **zero** eslint errors; every new file lints clean.
- `npx tsx lib/platform/policy.test.ts` → **314 checks pass**. `npx tsx lib/platform-surface.test.ts` → **all five tripwires pass**.
- Full suite (`npm test`) → **205/205 files pass** (203 pre-existing + `policy.test.ts` + `platform-surface.test.ts`); the three `SpaceCategory`-exhaustive template suites stay green, proving `SpaceCategory` was **not** extended.
- Seed idempotency (`scripts/seed-platform-spaces.ts` twice) → **4 platform Spaces, 0 SpaceMember rows on them, 8 section rows**; the second run is a no-op.

**Note on `migrate dev`:** the environment is non-interactive, so the migration was authored via `prisma migrate diff` and applied with `prisma migrate deploy` / `migrate reset` (the CI-safe path). The migration SQL was hand-scoped to PO1.0 only — the pre-existing `MerchantMergeDecision` / `PositionObservation` schema drift that `migrate diff` also surfaces was deliberately excluded, matching the house convention already set by `20260710101154_add_transfer_evidence`.

---

## Manual checklist (§8 part 4) — executed against a running dev server, all passing

| Check | Result |
|---|---|
| Grant READ SECURITY_OPS → Space appears in the user's `/api/spaces` `platform` key, Sidebar Platform group, and Spaces-page Platform group; host page renders the placeholder dashboard with a **READ** badge | ✅ (host SSR contained "Security Operations", the READ badge, all three PO1.1 placeholder notes, and the section labels) |
| Revoke → gone from both listings; direct URL redirects to `/dashboard/spaces` | ✅ (`platform: []`; host → `307 /dashboard/spaces`) |
| Un-granted user, direct URL → redirect (no existence disclosure) | ✅ (`307 /dashboard/spaces`); unknown area → `307 /dashboard/spaces` (no 404); unauthenticated → `307 /login?callbackUrl=…` |
| Every grant/revoke → exactly one `AuditLog` row, canon action, `performedByAdminId` set | ✅ (`PLATFORM_GRANT_CREATED`, `_REVOKED`, `_REINSTATED` all confirmed with correct metadata incl. `previousLevel`/`previousStatus`) |
| Grant mutation with a just-revoked admin session → 401 (fresh-auth proof) | ✅ (both POST **and** PATCH returned **401** after the admin's `UserSession` was revoked in the DB) |
| `POST /api/spaces` with `platformArea` in the body → field ignored, normal Space created | ✅ (created Space had `platformArea = NULL`, type SHARED, category OTHER) |
| `GET /api/spaces` → `mine` byte-identical for a user with no grants; share picker shows no platform Spaces | ✅ (`mine` JSON byte-identical pre/post-grant; `AddManualAssetModal` reads only `data.mine`, and platform Spaces have zero members) |
| SYSTEM_ADMIN visiting `/dashboard/platform/SECURITY_OPS` → redirected to `/admin` (proxy intact) | ✅ (`307 /admin`) |
| **Bonus:** re-grant of a revoked grant **reinstates** the same row (not a duplicate) | ✅ (`PLATFORM_GRANT_REINSTATED`, `previousStatus: REVOKED`, still exactly 1 grant row for the user) |

The one synthetic artifact created during testing (an "Injection Test Space") was deleted afterward; the dev DB is back to 4 platform Spaces intact.

---

## Stop conditions (§9) — none hit

No point in the build required a `SpaceMember` row for platform visibility, `can()`/`requireSpaceRole`/`SpaceMemberRole` in platform code, `resolveSpaceContext`/`ACTIVE_SPACE_COOKIE`/`/api/space/switch` involvement, a new `SpaceCategory` value, a non-additive migration, a grant route missing fresh-auth/rate-limit/audit, platform data through `buildContext`/customer assemblers, or new Growth & Revenue / Customer Success data modeling. The five source tripwires in `lib/platform-surface.test.ts` now guard the first three of those permanently.

---

## What PO1.0 deliberately did **not** ship (deferred, per plan §4/§6)

Real ops widgets with live data (PO1.1 Security Ops → PO1.2 Platform Ops → PO1.3 Growth & Revenue shell → PO1.4 Customer Success shell), WRITE-level actions, role bundles, self-hosted grant management, a platform-Space `AiAgent`, telemetry/event-grammar tables, and widget-level capability filtering. The placeholder dashboard is a static registry of cards, not a framework — real widgets replace card bodies one entry at a time.
