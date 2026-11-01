/**
 * lib/platform/directory.server.ts  (UX-P2 — Platform Spaces directory)
 *
 * THE read site for "which Platform Spaces does this viewer's grants reach" and
 * for the one-bit fact the GlobalHeader needs ("does this viewer hold ANY active
 * grant"). Both run AS THE TENANT through `withTenantDb`, and both are keyed on
 * the session's own user id — a grant is a fact about the viewer.
 *
 * Extracted from app/(shell)/dashboard/spaces/page.tsx's `loadPlatformSpaces`
 * (RLS-T3) when the HQ card group moved off the launcher and into the directory
 * page (UX-P2 decision N1): one loader, one row shape (lib/platform/directory.ts),
 * one place lib/rls-server-component-authority.test.ts pins.
 *
 * ── WHY THE TENANT ROLE IS THE RIGHT ONE HERE (unchanged from RLS-T3) ────────
 *   · `PlatformGrant.fm_app_sel` is `"userId" = current_fm_user_id()` (§9), and
 *     the question asked is "my grants".
 *   · `Space.fm_app_sel` carries the platform arm (§11) — `platformArea IS NOT
 *     NULL AND EXISTS (an ACTIVE PlatformGrant for me on that area)` — so the
 *     Space rows come back too, and an area the viewer holds no grant on is
 *     refused by the database as well as by the `in` filter.
 *   · The arm STOPS at `Space`; it does NOT extend to `SpaceDashboardSection`,
 *     which is why app/(shell)/dashboard/platform/[area]/page.tsx stays on `db`.
 *     This module never reads sections, so it has no such problem.
 *
 * ONE transaction for the two directory reads, on purpose: the second is a
 * function of the first, neither calls out of the process, and the answer must
 * not straddle a grant being revoked mid-page.
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────────
 * `hasActivePlatformGrants` swallows every failure to `false`: the header
 * control it feeds is DISPLAY, and a broken tenant channel must read as "no
 * Platform door", never as a thrown dashboard layout. The directory loader does
 * NOT swallow — a page that cannot answer should error, not render empty.
 */

import "server-only";

import { withTenantDb } from "@/lib/db/tenant-context";
import { platformDirectoryRows, type PlatformDirectoryRow } from "@/lib/platform/directory";

/** Does the viewer hold at least one ACTIVE PlatformGrant? One indexed count.
 *  Any failure ⇒ false (the Platform door stays hidden). */
export async function hasActivePlatformGrants(userId: string): Promise<boolean> {
  try {
    const n = await withTenantDb(userId, (tx) =>
      tx.platformGrant.count({ where: { userId, status: "ACTIVE" } }),
    );
    return n > 0;
  } catch {
    return false;
  }
}

/** The Platform Spaces the viewer's ACTIVE grants reach, in registry order. */
/**
 * SEC-PLAT-1 — the caller's own second-factor state (their own row; read as the
 * user). The directory lists only the caller's own areas, but with operator MFA
 * enforced an un-enrolled operator is sent to enrolment from here too, rather
 * than to a page whose every card the shared guard would refuse.
 */
export async function operatorHasTotp(userId: string): Promise<boolean> {
  const row = await withTenantDb(userId, (tx) =>
    tx.user.findUnique({ where: { id: userId }, select: { totpEnabled: true } }),
  );
  return row?.totpEnabled === true;
}

export async function loadPlatformDirectory(userId: string): Promise<PlatformDirectoryRow[]> {
  return withTenantDb(userId, async (tx) => {
    const grants = await tx.platformGrant.findMany({
      where:  { userId, status: "ACTIVE" },
      select: { area: true, level: true },
    });
    if (grants.length === 0) return [];

    const spaces = await tx.space.findMany({
      where:  { platformArea: { in: grants.map((g) => g.area) } },
      select: { id: true, name: true, platformArea: true },
    });

    return platformDirectoryRows(spaces, grants);
  });
}
