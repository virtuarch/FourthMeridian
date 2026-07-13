/**
 * lib/platform/authorize.ts
 *
 * PO1.0 — session-aware platform-access authorization adapter.
 *
 * `requirePlatformAccess(area, needed)` is the route/page-facing entry point
 * that ties the live session + one platform-grant lookup to the pure policy
 * decision in `lib/platform/policy.ts` (`hasPlatformAccess`). Mirrors
 * `lib/spaces/authorize.ts`: the RULE stays pure and unit-tested; this file
 * contributes only I/O (session + one grant query) plus the SYSTEM_ADMIN
 * break-glass bypass.
 *
 * DESIGN
 * ------
 *   - The pure branch is factored into `decidePlatformAccess` so it is
 *     unit-testable without DB/session (covered in lib/platform/policy.test.ts).
 *   - Session access reuses `requireUser()` / `requireFreshUser()` from
 *     lib/session.ts (same getServerSession path + revocation check every route
 *     already runs).
 *   - The SYSTEM_ADMIN bypass sits HERE, not in the pure policy — matching the
 *     07-07 break-glass ruling and reusing the `user.role !== SYSTEM_ADMIN`
 *     idiom from lib/session.ts:205.
 *
 * BEHAVIOUR
 * ---------
 *   401 — no session                     (requireUser → unauthorized())
 *   403 — no / insufficient / revoked grant   (forbidden())
 * The adapter NEVER emits 404: a missing grant ⇒ 403 (no existence disclosure),
 * mirroring the never-404 rule of the Space adapter it is modelled on.
 *
 * Go-style tuple return:
 *   const [auth, err] = await requirePlatformAccess("SECURITY_OPS", "READ");
 *   if (err) return err;
 *   const { user, grant } = auth;   // grant === null iff SYSTEM_ADMIN bypass
 */

import "server-only";

import { NextResponse }             from "next/server";
import { UserRole }                 from "@prisma/client";
import type { PlatformArea, PlatformAccessLevel } from "@prisma/client";
import { db }                       from "@/lib/db";
import { requireUser, requireFreshUser, forbidden } from "@/lib/session";
import type { SessionUser }         from "@/lib/session";
import { hasPlatformAccess }        from "./policy";
import type { PlatformGrantCtx }    from "./policy";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PlatformAuth = {
  user: SessionUser;
  /** null exactly when access came from the SYSTEM_ADMIN break-glass bypass. */
  grant: { area: PlatformArea; level: PlatformAccessLevel } | null;
};

// ── Pure decision (unit-testable without DB/session) ──────────────────────────

/**
 * The branch `requirePlatformAccess` applies after the session + DB fetch,
 * factored out so it can be tested in isolation.
 *
 *   - SYSTEM_ADMIN ⇒ allowed unconditionally (break-glass; grant set ignored).
 *   - Otherwise ⇒ hasPlatformAccess(area, needed, grants) decides.
 *
 * Returns true iff the caller is allowed.
 */
export function decidePlatformAccess(
  role:   UserRole,
  area:   PlatformArea,
  needed: PlatformAccessLevel,
  grants: readonly PlatformGrantCtx[],
): boolean {
  if (role === UserRole.SYSTEM_ADMIN) return true;
  return hasPlatformAccess(area, needed, grants);
}

// ── Adapters ──────────────────────────────────────────────────────────────────

/**
 * Resolve one user's platform access for (area, needed): the SYSTEM_ADMIN
 * short-circuit (no DB query needed — bypass), else the single-grant lookup
 * keyed on the @@unique([userId, area]) composite. Shared by both the cached
 * and fresh entry points below.
 */
async function resolvePlatformAccess(
  user:   SessionUser,
  area:   PlatformArea,
  needed: PlatformAccessLevel,
): Promise<[PlatformAuth, null] | [null, NextResponse]> {
  // Break-glass — the bypass lives in the adapter (07-07 ruling), not the pure
  // policy. SYSTEM_ADMIN never needs (and is never issued) a grant row.
  if (user.role === UserRole.SYSTEM_ADMIN) {
    return [{ user, grant: null }, null];
  }

  const row = await db.platformGrant.findUnique({
    where:  { userId_area: { userId: user.id, area } },
    select: { area: true, level: true, status: true },
  });

  const grants: PlatformGrantCtx[] = row ? [row] : [];

  if (!decidePlatformAccess(user.role, area, needed, grants)) {
    return [null, forbidden()]; // 403 — no / insufficient / revoked grant
  }

  // Non-null asserted: a non-admin only passes when an ACTIVE matching grant
  // was found, so `row` is set here.
  return [{ user, grant: { area: row!.area, level: row!.level } }, null];
}

/**
 * requireUser() → one platformGrant.findUnique({ userId_area }) → pure decision.
 * 401 no session · 403 no/insufficient/revoked grant. Never 404.
 */
export async function requirePlatformAccess(
  area:   PlatformArea,
  needed: PlatformAccessLevel,
): Promise<[PlatformAuth, null] | [null, NextResponse]> {
  const [user, err] = await requireUser();
  if (err) return [null, err]; // 401 — no session
  return resolvePlatformAccess(user, area, needed);
}

/**
 * Same, but with the live-revocation re-check of requireFreshUser
 * (lib/session.ts:165-191) — required for every future WRITE mutation on a
 * platform area. Unused in PO1.0 (which ships no WRITE actions); defined now so
 * PO1.1+ cannot forget it.
 */
export async function requireFreshPlatformAccess(
  area:   PlatformArea,
  needed: PlatformAccessLevel,
): Promise<[PlatformAuth, null] | [null, NextResponse]> {
  const [user, err] = await requireFreshUser();
  if (err) return [null, err]; // 401 — no session / revoked
  return resolvePlatformAccess(user, area, needed);
}
