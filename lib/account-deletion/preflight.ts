/**
 * lib/account-deletion/preflight.ts  (OPS-2 S7b)
 *
 * Read-only gate the account-deletion REQUEST route runs before scheduling a
 * pending deletion. S7b implements the ONE hard block from the S7 investigation
 * §3.0a — the sole-OWNER block — plus the shared grace-period constant. Nothing
 * here deletes, purges, or mutates; the S7c purge pipeline re-asserts the same
 * gate at purge time (one source of truth).
 *
 * Sole-OWNER block: mirrors the established "Cannot remove the Space owner —
 * transfer ownership first" residual (app/api/spaces/[id]/members/[userId]).
 * A user may not delete their account while they are the ONLY active OWNER of a
 * SHARED Space that still has other active members — doing so would leave that
 * Space administratively orphaned. They must transfer ownership (when that flow
 * exists) or delete the Space via the normal trash → permanent path first.
 *
 * This is membership/role counting over SpaceMember — the same shape the
 * members route already uses — not a new permission system.
 */

import "server-only";
import { db } from "@/lib/db";

/** Approved grace window (decision D1). deletionScheduledAt = requestedAt + this. */
export const GRACE_DAYS = 7;

/** Milliseconds in the grace window — convenience for scheduling math. */
export const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

/** A Space that blocks account deletion, surfaced to the client for resolution. */
export interface BlockingSpace {
  id:   string;
  name: string;
}

export interface DeletionPreflightResult {
  blocked:        boolean;
  blockingSpaces: BlockingSpace[];
}

/**
 * PURE predicate — does deleting `userId` orphan this Space? True only when the
 * Space is SHARED, the user is an active OWNER, there is NO other active OWNER,
 * and at least one OTHER active member remains. PERSONAL Spaces and
 * sole-member Spaces never block (they are the user's own property, deleted
 * with them by the S7c pipeline).
 *
 * Roles/status are plain strings so this stays unit-testable without importing
 * the Prisma runtime (see lib/account-deletion/preflight.test.ts).
 */
export function isSoleOwnerBlock(params: {
  userId:        string;
  spaceType:     string; // "PERSONAL" | "SHARED"
  activeMembers: { userId: string; role: string }[];
}): boolean {
  const { userId, spaceType, activeMembers } = params;
  if (spaceType === "PERSONAL") return false;

  const userIsOwner = activeMembers.some((m) => m.userId === userId && m.role === "OWNER");
  if (!userIsOwner) return false;

  const otherActiveOwners  = activeMembers.filter((m) => m.userId !== userId && m.role === "OWNER").length;
  const otherActiveMembers = activeMembers.filter((m) => m.userId !== userId).length;

  return otherActiveOwners === 0 && otherActiveMembers > 0;
}

/**
 * Run the deletion preflight for a user. Loads the SHARED Spaces where they are
 * an active OWNER and applies isSoleOwnerBlock() per Space. Read-only.
 */
export async function deletionPreflight(userId: string): Promise<DeletionPreflightResult> {
  // SHARED, non-trashed Spaces where the user is an ACTIVE OWNER — the only
  // Spaces that can possibly block. PERSONAL Spaces are excluded by type.
  const ownerMemberships = await db.spaceMember.findMany({
    where: {
      userId,
      status: "ACTIVE",
      role:   "OWNER",
      space:  { type: { not: "PERSONAL" }, deletedAt: null },
    },
    select: { spaceId: true, space: { select: { name: true } } },
  });

  const blockingSpaces: BlockingSpace[] = [];

  for (const m of ownerMemberships) {
    const activeMembers = await db.spaceMember.findMany({
      where:  { spaceId: m.spaceId, status: "ACTIVE" },
      select: { userId: true, role: true },
    });

    if (isSoleOwnerBlock({ userId, spaceType: "SHARED", activeMembers })) {
      blockingSpaces.push({ id: m.spaceId, name: m.space.name });
    }
  }

  return { blocked: blockingSpaces.length > 0, blockingSpaces };
}
