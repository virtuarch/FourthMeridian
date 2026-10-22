/**
 * components/space/manage/destructive-confirm.ts  (UI-003)
 *
 * The confirmation COPY for every destructive customer action in a Space. Each
 * action is reachable only through `ConfirmDialog` (components/atlas), and the
 * dialog must say what the click actually does — not "Are you sure?". Kept pure
 * (no React, no fetch) so the consequence sentences are pinned by a plain test.
 *
 * The consequences are the SERVER's, read from the routes these actions call:
 *   - DELETE /api/spaces/[id]/members/[userId] revokes the membership AND every
 *     account link that member added to the Space, in one transaction.
 *   - PATCH  /api/spaces/[id]/members/[userId] changes the role immediately.
 *   - PATCH  /api/spaces/[id] {archivedAt} hides the Space (reversible).
 *   - DELETE /api/spaces/[id]/accounts/share revokes ONE account link (reversible
 *     by sharing again).
 *
 * The client has no per-member count of shared accounts (the roster payload does
 * not carry one), so the member-removal copy states the rule for "every account
 * they shared" rather than inventing a number.
 */

import { ROLE_LABELS } from "./manage-shared";

export interface ConfirmCopy {
  title:        string;
  message:      string;
  confirmLabel: string;
}

const roleLabel = (r: string) => ROLE_LABELS[r] ?? r;

export function removeMemberConfirm(memberName: string): ConfirmCopy {
  return {
    title: `Remove ${memberName}?`,
    message:
      `${memberName} loses access to this Space immediately. Every account they shared into ` +
      `this Space is un-shared at the same time, so its balances and transactions leave this ` +
      `Space for everyone. They can only rejoin with a new invite.`,
    confirmLabel: "Remove member",
  };
}

export function changeRoleConfirm(
  memberName: string,
  fromRole: string,
  toRole: string,
  toRoleAccess?: string,
): ConfirmCopy {
  const access = toRoleAccess ? ` ${toRoleAccess}.` : "";
  return {
    title: `Make ${memberName} ${/^[AEIOU]/i.test(roleLabel(toRole)) ? "an" : "a"} ${roleLabel(toRole)}?`,
    message:
      `${memberName} changes from ${roleLabel(fromRole)} to ${roleLabel(toRole)} as soon as you ` +
      `confirm.${access}`,
    confirmLabel: `Change to ${roleLabel(toRole)}`,
  };
}

export function archiveSpaceConfirm(spaceName: string): ConfirmCopy {
  return {
    title: `Archive ${spaceName}?`,
    message:
      `${spaceName} is hidden from the active Space list. Members, shared accounts, and history ` +
      `stay intact, and you can unarchive it from the Archive & Trash page.`,
    confirmLabel: "Archive Space",
  };
}

export function leaveSpaceConfirm(spaceName: string): ConfirmCopy {
  return {
    title: `Leave ${spaceName}?`,
    message:
      `You lose access to ${spaceName} immediately, and every account you shared into it is ` +
      `removed from the Space. You can only rejoin if an owner sends you a new invite.`,
    confirmLabel: "Leave Space",
  };
}

export function revokeAccountConfirm(accountName: string): ConfirmCopy {
  return {
    title: `Remove ${accountName} from this Space?`,
    message:
      `${accountName} stops counting in this Space's totals, and its balances and transactions ` +
      `are no longer visible to the Space's members. The account itself is not deleted, and ` +
      `you can share it again later.`,
    confirmLabel: "Remove from Space",
  };
}
