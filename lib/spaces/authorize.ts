/**
 * lib/spaces/authorize.ts
 *
 * SP-2b — session-aware Space authorization adapter.
 *
 * `requireSpaceAction(spaceId, action)` is the route-facing entry point that
 * ties the live session + membership lookup to the pure policy decision in
 * `lib/spaces/policy.ts` (`can`). It exists so route handlers stop
 * re-implementing the `spaceMember.findUnique` + status/role checks by hand.
 *
 * DESIGN
 * ------
 *   - The RULE stays in the pure, unit-tested `can(action, ctx)`; this file
 *     contributes only I/O (session + one membership query).
 *   - Session access reuses `requireUser()` from lib/session.ts (same
 *     getServerSession path + revocation check every route already runs).
 *   - Membership lookup mirrors the inline checks it replaces, plus a
 *     `space.type` join so lifecycle actions (sharedOnly) are decidable
 *     generally — even though this batch's four actions don't use it.
 *
 * BEHAVIOUR PRESERVED
 * -------------------
 *   401 — no session               (requireUser → unauthorized())
 *   403 — non-member / inactive /   (forbidden())
 *         role-too-low
 * The adapter never emits 404: resource 404s (section/account/share) stay
 * route-local. Non-existent space ⇒ null membership ⇒ 403 (no existence
 * disclosure), matching the routes it replaces.
 *
 * Go-style tuple return, mirroring requireSpaceRole:
 *   const [auth, err] = await requireSpaceAction(spaceId, "section:edit");
 *   if (err) return err;
 *   const { user, membership } = auth;
 *
 * ── RLS SLICE B — THE AUTHORIZATION READ RUNS AS THE CALLER TOO ──────────────
 * This is the twin of requireSpaceRole (lib/session.ts), which already enters
 * withTenantDb; leaving one of the two Space doors on the migration principal
 * would have split a single concern across two authorities. The caller is
 * established before this read, and fm_app's `SpaceMember` SELECT policy carries
 * a `userId = current_fm_user_id()` arm — "am I a member" needs no elevated
 * authority to ask.
 *
 * ⚠️ AND THE `space` JOIN HAD TO BECOME A SECOND READ, FOR THE SAME REASON IT
 * DID IN /api/space/switch. `SpaceMember.space` is a REQUIRED relation, but
 * `Space.fm_app_sel` needs an ACTIVE membership — so for a LEFT or REMOVED
 * member the row is visible and the Space is not, and Prisma raises
 * "Inconsistent query result: Field space is required" rather than returning
 * null. A departed member's clean 403 would have become a 500.
 *
 * Reading the Space separately in the SAME transaction preserves every outcome
 * exactly. A LEFT member now yields a null membership (the Space read returns
 * nothing) instead of a membership that `can()` refuses at step 1 — both reach
 * `decideSpaceAction(action, null)` and both emit the same 403. The DECISION
 * still belongs entirely to the pure function below; nothing about the policy
 * moved into the adapter.
 */

import "server-only";

import { NextResponse }                     from "next/server";
import type {
  SpaceMemberRole,
  SpaceMemberStatus,
  SpaceType,
} from "@prisma/client";
import { withTenantDb }                     from "@/lib/db/tenant-context";
import { requireUser, forbidden }           from "@/lib/session";
import type { SessionUser }                 from "@/lib/session";
import { can }                              from "./policy";
import type { SpaceAction, SpacePolicyContext } from "./policy";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Membership shape resolved by the adapter and handed back to routes. */
export type SpaceActionMembership = {
  role:      SpaceMemberRole;
  status:    SpaceMemberStatus;
  spaceType: SpaceType;
};

export type SpaceActionAuth = {
  user:       SessionUser;
  membership: SpaceActionMembership;
};

// ── Pure decision (unit-testable without DB/session) ──────────────────────────

/**
 * The branch logic `requireSpaceAction` applies after the DB fetch, factored
 * out so it can be tested in isolation (the adapter's I/O is not unit-testable
 * without mocks the repo doesn't have).
 *
 * Returns true iff the caller is allowed. A null membership (not a member, or
 * the space does not exist) is always denied.
 */
export function decideSpaceAction(
  action:     SpaceAction,
  membership: SpaceActionMembership | null,
): boolean {
  if (!membership) return false;
  const ctx: SpacePolicyContext = {
    role:      membership.role,
    status:    membership.status,
    spaceType: membership.spaceType,
  };
  return can(action, ctx);
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export async function requireSpaceAction(
  spaceId: string,
  action:  SpaceAction,
): Promise<[SpaceActionAuth, null] | [null, NextResponse]> {
  const [user, err] = await requireUser();
  if (err) return [null, err]; // 401 — no session

  const { row, space } = await withTenantDb(user.id, async (tx) => ({
    row: await tx.spaceMember.findUnique({
      where:  { spaceId_userId: { spaceId, userId: user.id } },
      select: { role: true, status: true },
    }),
    // See the header: a separate read, not an include, because the relation is
    // REQUIRED and the policy behind it is not satisfied for every member row.
    space: await tx.space.findUnique({
      where:  { id: spaceId },
      select: { type: true },
    }),
  }));

  const membership: SpaceActionMembership | null = row && space
    ? { role: row.role, status: row.status, spaceType: space.type }
    : null;

  if (!decideSpaceAction(action, membership)) {
    return [null, forbidden()]; // 403 — non-member / inactive / role-too-low
  }

  // Non-null asserted: decideSpaceAction only returns true when membership is set.
  return [{ user, membership: membership! }, null];
}
