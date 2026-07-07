/**
 * lib/events/handlers/space-member-notifications.ts  (OPS-3 S5 Wave 2)
 *
 * EV-1 dispatch handlers: the Spaces membership producers.
 *
 *   MemberJoined      → SPACE_INVITE_ACCEPTED  (pings the INVITER)
 *   MemberRemoved     → MEMBER_REMOVED         (pings the REMOVED user)
 *   MemberRoleChanged → MEMBER_ROLE_CHANGED    (pings the TARGET user)
 *
 * Registered in lib/events/emit.ts HANDLERS — the producing routes are
 * untouched, and all three events are emitted no-tx (post-commit) so dispatch
 * ordering is already correct. Best-effort by the dispatch contract; the
 * chokepoint is runtime-non-throwing.
 *
 * NOT here, by Wave 2 ruling (OPS3_S5_PRODUCER_WAVES_INVESTIGATION.md §1):
 *   - MemberLeft — evaluated at wave entry as documented: recipient would be
 *     the owner, value is Low (self-explanatory timeline event), and no
 *     registry type exists for it. Not implemented; revisit only if owner
 *     demand appears (a new registry entry + handler then).
 *   - SPACE_OWNERSHIP_TRANSFERRED — the feature does not exist (OPS-2
 *     deferral; the role route 400s "Transfer ownership first").
 *
 * auditLogId: EV-1-derived producers omit it — emitDomainEvent doesn't return
 * the created row id (open decision D1, same as the S1 invite handler).
 *
 * Pure/impure split (house test pattern): build*Input functions are pure and
 * unit-tested; the notify* wrappers fetch context and call the chokepoint.
 */

import { db } from "@/lib/db";
import type { DomainEvent } from "@/lib/events/types";
import { createNotification } from "@/lib/notifications/create";
import type { NotificationInput } from "@/lib/notifications/types";
import type { NotificationTypeId } from "@/lib/notifications/registry";

type Wave2Input = NotificationInput<NotificationTypeId> | null;

// ── MemberJoined → SPACE_INVITE_ACCEPTED ─────────────────────────────────────

/** The invite fields this producer needs (matches the query select below). */
export interface AcceptedInviteRow {
  id: string;
  status: string;
  invitedById: string;
  space: { name: string } | null;
  invitedUser: { name: string | null; username: string | null } | null;
}

/**
 * Pure mapping. Null when the guard declines: invite missing, not ACCEPTED
 * (raced re-invite), or a degenerate self-invite.
 */
export function buildInviteAcceptedInput(
  spaceId: string,
  joinedUserId: string,
  invite: AcceptedInviteRow | null,
): Wave2Input {
  if (!invite || invite.status !== "ACCEPTED") return null;
  if (invite.invitedById === joinedUserId) return null;

  // Display-handle convention mirrors the invite email + S1 handler:
  // @username, else name, else generic.
  const memberName = invite.invitedUser?.username
    ? `@${invite.invitedUser.username}`
    : (invite.invitedUser?.name ?? "Your invitee");

  return {
    type: "SPACE_INVITE_ACCEPTED",
    userId: invite.invitedById,
    spaceId,
    data: {
      inviteId: invite.id,
      spaceName: invite.space?.name ?? "",
      memberName,
    },
  };
}

export async function notifySpaceInviteAccepted(event: DomainEvent): Promise<void> {
  if (event.type !== "MemberJoined") return;
  const spaceId = event.spaceId;
  if (!spaceId) return;

  const invite = (await db.spaceInvite.findUnique({
    where: {
      spaceId_invitedUserId: { spaceId, invitedUserId: event.payload.userId },
    },
    select: {
      id: true,
      status: true,
      invitedById: true,
      space: { select: { name: true } },
      invitedUser: { select: { name: true, username: true } },
    },
  })) as AcceptedInviteRow | null;

  const input = buildInviteAcceptedInput(spaceId, event.payload.userId, invite);
  if (input) await createNotification(input);
}

// ── MemberRemoved → MEMBER_REMOVED ───────────────────────────────────────────

/**
 * Pure mapping. Null when the guard declines: self-removal is the MemberLeft
 * event by route construction, but the actor check stays as defense in depth.
 */
export function buildMemberRemovedInput(
  spaceId: string,
  removedUserId: string,
  actorUserId: string | null | undefined,
  spaceName: string | null,
): Wave2Input {
  if (actorUserId && actorUserId === removedUserId) return null;
  return {
    type: "MEMBER_REMOVED",
    userId: removedUserId,
    spaceId,
    data: { spaceName: spaceName ?? "" },
  };
}

export async function notifyMemberRemoved(event: DomainEvent): Promise<void> {
  if (event.type !== "MemberRemoved") return;
  const spaceId = event.spaceId;
  if (!spaceId) return;

  const space = await db.space.findUnique({
    where: { id: spaceId },
    select: { name: true },
  });

  const input = buildMemberRemovedInput(
    spaceId,
    event.payload.removedUserId,
    event.actorUserId,
    space?.name ?? null,
  );
  if (input) await createNotification(input);
}

// ── MemberRoleChanged → MEMBER_ROLE_CHANGED ──────────────────────────────────

/** Pure mapping. Null for a self-directed change (no self-ping). */
export function buildRoleChangedInput(
  spaceId: string,
  payload: { targetUserId: string; oldRole: string; newRole: string },
  actorUserId: string | null | undefined,
  spaceName: string | null,
): Wave2Input {
  if (actorUserId && actorUserId === payload.targetUserId) return null;
  return {
    type: "MEMBER_ROLE_CHANGED",
    userId: payload.targetUserId,
    spaceId,
    data: {
      spaceName: spaceName ?? "",
      oldRole: payload.oldRole,
      newRole: payload.newRole,
    },
  };
}

export async function notifyMemberRoleChanged(event: DomainEvent): Promise<void> {
  if (event.type !== "MemberRoleChanged") return;
  const spaceId = event.spaceId;
  if (!spaceId) return;

  const space = await db.space.findUnique({
    where: { id: spaceId },
    select: { name: true },
  });

  const input = buildRoleChangedInput(
    spaceId,
    event.payload,
    event.actorUserId,
    space?.name ?? null,
  );
  if (input) await createNotification(input);
}
