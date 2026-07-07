/**
 * lib/events/handlers/space-invite-notification.ts  (OPS-3 S1)
 *
 * EV-1 dispatch handler: MemberInvited → SPACE_INVITE_RECEIVED notification
 * for the invited user. The FIRST notification producer (frozen plan S1) —
 * wired as a HANDLERS registration in lib/events/emit.ts, so the invite route
 * is untouched and the notification rides the existing best-effort dispatch
 * isolation (a failure here never fails invite creation).
 *
 * The MemberInvited payload deliberately carries no invite row (it predates
 * notifications), so this handler performs ONE read — the SpaceInvite by its
 * (spaceId, invitedUserId) unique, with Space name + inviter identity — and
 * hands a registry-contract-shaped input to the chokepoint:
 *   metadata: { inviteId, spaceName, inviterName }   (pointer contract)
 *   expiresAt: mirrors SpaceInvite.expiresAt          (frozen plan S1)
 *
 * Split pure/impure for the house test pattern: buildSpaceInviteNotification-
 * Input is pure (unit-tested with no DB); notifySpaceInviteReceived is the
 * thin fetch-then-call wrapper dispatch invokes.
 */

import { db } from "@/lib/db";
import type { DomainEvent } from "@/lib/events/types";
import { createNotification } from "@/lib/notifications/create";
import type { NotificationInput } from "@/lib/notifications/types";
import type { NotificationTypeId } from "@/lib/notifications/registry";

/** The invite fields this producer needs (matches the query select below). */
export interface SpaceInviteRowForNotification {
  id: string;
  status: string;
  expiresAt: Date | null;
  space: { name: string } | null;
  invitedBy: { name: string | null; username: string | null } | null;
}

/**
 * Pure mapping: (event context, invite row) → chokepoint input.
 * Inviter display identity mirrors the invite email's convention
 * (app/api/spaces/[id]/invite/route.ts): @username, else name, else generic.
 */
export function buildSpaceInviteNotificationInput(
  spaceId: string,
  invitedUserId: string,
  invite: SpaceInviteRowForNotification,
): NotificationInput<NotificationTypeId> {
  const inviterName = invite.invitedBy?.username
    ? `@${invite.invitedBy.username}`
    : (invite.invitedBy?.name ?? "A Fourth Meridian member");

  return {
    type: "SPACE_INVITE_RECEIVED",
    userId: invitedUserId,
    spaceId,
    data: {
      inviteId: invite.id,
      spaceName: invite.space?.name ?? "",
      inviterName,
    },
    expiresAt: invite.expiresAt ?? null,
  };
}

/**
 * Dispatch handler for MemberInvited. Best-effort by contract: dispatch wraps
 * every handler in try/catch, and createNotification is runtime-non-throwing.
 */
export async function notifySpaceInviteReceived(event: DomainEvent): Promise<void> {
  if (event.type !== "MemberInvited") return;
  const spaceId = event.spaceId;
  if (!spaceId) return;

  const invite = (await db.spaceInvite.findUnique({
    where: {
      spaceId_invitedUserId: {
        spaceId,
        invitedUserId: event.payload.invitedUserId,
      },
    },
    select: {
      id: true,
      status: true,
      expiresAt: true,
      space: { select: { name: true } },
      invitedBy: { select: { name: true, username: true } },
    },
  })) as SpaceInviteRowForNotification | null;

  // Only a live, pending invite pings; anything else (raced accept/rescind,
  // missing row) is a silent no-op — awareness, not ceremony.
  if (!invite || invite.status !== "PENDING") return;

  await createNotification(
    buildSpaceInviteNotificationInput(spaceId, event.payload.invitedUserId, invite),
  );
}
