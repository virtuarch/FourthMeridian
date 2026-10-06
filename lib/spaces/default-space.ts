/**
 * lib/spaces/default-space.ts
 *
 * THE DEFAULT SPACE IS A PREFERENCE, NOT AN AUTHORITY.
 *
 * `User.preferredSpaceId` names the Space `getSpaceContext()` lands on when no
 * active-Space cookie is set (cookie → preferred → personal, lib/space.ts). It
 * grants nothing: every request re-validates membership in resolveSpaceContext,
 * which falls back to the caller's own PERSONAL Space when the preference names
 * a Space they are no longer an ACTIVE member of, or one that is archived or
 * trashed. So a stale value can never strand a user, and can never widen what
 * they see — it simply stops being honoured.
 *
 * Setting it is therefore only ever a write to the caller's OWN User row. This
 * module is the one place that decides what that write may contain, so the
 * Settings → Preferences control (the only control that sets it) and any future
 * caller cannot disagree about it.
 *
 * ⚠️ THE OWNER'S PREVIEW INCIDENT (2026-10-06). The Preferences picker has
 * always represented "Personal Space (default)" — and "Reset to default" — as
 * the empty string, and this route treated only `null` as a clear. `""` was
 * looked up as a Space id, found no membership, and answered 403 "Not a member
 * of that Space": the user was told they did not belong to the Space they were
 * trying to return to, with no membership having changed. Empty and null now
 * mean the same thing — clear the preference, i.e. land on the personal Space.
 */

import type { Prisma } from "@prisma/client";

export type DefaultSpaceInput =
  | { ok: true; spaceId: string | null }
  | { ok: false; error: string };

/**
 * What a PATCH body's `preferredSpaceId` asks for. `null` and `""` both CLEAR
 * the preference (the resolver then lands on the personal Space); a non-empty
 * string names a Space that must still pass {@link isEligibleDefaultSpace};
 * anything else is malformed.
 */
export function parseDefaultSpaceInput(raw: unknown): DefaultSpaceInput {
  if (raw === null || raw === "") return { ok: true, spaceId: null };
  if (typeof raw === "string" && raw.trim() !== "") return { ok: true, spaceId: raw.trim() };
  return { ok: false, error: "preferredSpaceId must be a Space id, or null to clear it." };
}

/**
 * May `userId` make `spaceId` their default? Exactly the predicate the resolver
 * honours: an ACTIVE membership of their own in a Space that is neither archived
 * nor trashed. Anything the resolver would refuse to land on is refused here,
 * so the setting cannot store a value that is stale from the moment it is
 * written.
 *
 * Runs on the caller's TENANT transaction (fm_app under RLS): the membership is
 * the caller's own row, and a Space they are not an active member of is not
 * visible to them at all — the database answers "no" for another tenant's Space
 * before this predicate does.
 */
export async function isEligibleDefaultSpace(
  tx:      Prisma.TransactionClient,
  userId:  string,
  spaceId: string,
): Promise<boolean> {
  const membership = await tx.spaceMember.findFirst({
    where:  { spaceId, userId, status: "ACTIVE", space: { archivedAt: null, deletedAt: null } },
    select: { spaceId: true },
  });
  return membership !== null;
}

/**
 * The Space the resolver will actually treat as the default, given the stored
 * preference and the Spaces the user can currently land on (ACTIVE, not
 * archived/trashed). A preference outside that set is stale and is NOT the
 * default — the personal Space is. Display only: it mirrors resolveSpaceContext
 * and decides nothing on its own.
 */
export function effectiveDefaultSpaceId(
  preferredId:      string | null,
  eligibleSpaceIds: readonly string[],
  personalId:       string | null,
): string | null {
  return preferredId && eligibleSpaceIds.includes(preferredId) ? preferredId : personalId;
}
