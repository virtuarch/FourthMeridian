"use client";

/**
 * components/space/workspaces/MembersWorkspace.tsx
 *
 * The Members destination, in the Workspace editorial language (converged from the
 * former read-only SpaceMembersWidget wrapper). Members answers one question — "who
 * has access to this Space?" — and owns membership visibility, roles, invites, and
 * access state. It does NOT own authentication, global users, or the admin system.
 *
 * Composition, in the established idiom (hero → read Surfaces in labelled Blocks, drill
 * via edge-docked Panels):
 *   ①  MembersHero        — the editorial lede (count + your role; no money/trust)
 *   ②  People             — the roster ledger → RightPanel member detail (role,
 *                           access caption, change-role / remove actions)
 *   ③  Invite             — the invite Form (shared UserSearchInput + role Select)
 *   ④  Pending invites    — the not-yet-accepted queue, rescindable
 *
 * Presentation + wiring only. All state + mutations live in useSpaceMembers, which
 * self-fetches and calls the SAME member/invite routes the manage modal uses — ZERO
 * new backend, no permission engine (the gates mirror, and the server enforces,
 * lib/spaces/policy.ts). "Manage Space" still routes to the host-owned ManageSpaceModal
 * for the General / Add Accounts / Delete surfaces this destination doesn't own.
 */

import { Loader2 } from "lucide-react";
import { Block } from "@/components/atlas/Surface";
import { useSpaceMembers } from "@/components/space/widgets/members/use-space-members";
import { MembersHero } from "@/components/space/widgets/members/MembersHero";
import { MembersRoster } from "@/components/space/widgets/members/MembersRoster";
import { MembersInvite } from "@/components/space/widgets/members/MembersInvite";
import { PendingInvites } from "@/components/space/widgets/members/PendingInvites";

export function MembersWorkspace({
  spaceId,
  myRole,
  currentUserId,
  onManage,
  onRefresh,
}: {
  spaceId: string;
  /** The caller's role — used for the gate arithmetic until the roster confirms it. */
  myRole: string;
  /** The signed-in user, so the roster can mark "(you)" and gate self-actions. */
  currentUserId: string;
  /** Opens the host-owned ManageSpaceModal (General / Add Accounts / Delete). */
  onManage?: () => void;
  /** The host's own refresh (accounts / totals) — a removal revokes shared accounts. */
  onRefresh?: () => void | Promise<void>;
}) {
  const m = useSpaceMembers({ spaceId, myRole, onRefresh });

  if (m.members === null) {
    return (
      <div className="flex items-center justify-center py-16 text-[var(--text-muted)]">
        <Loader2 size={16} className="mr-2 animate-spin" /> Loading people…
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-8 sm:space-y-10">
      <MembersHero
        count={m.members.length}
        myRole={m.myRole}
        isPersonal={m.isPersonal}
        onManage={onManage}
      />

      <Block id="people" label="People">
        <MembersRoster
          members={m.members}
          currentUserId={currentUserId}
          canInvite={m.canInvite}
          isOwner={m.isOwner}
          changingRoleId={m.changingRoleId}
          removingId={m.removingId}
          onChangeRole={m.changeRole}
          onRemove={m.remove}
        />
      </Block>

      {m.canInvite && (
        <Block id="invite" label="Invite">
          <MembersInvite spaceId={spaceId} onInvite={m.invite} />
        </Block>
      )}

      {m.canInvite && (
        <Block
          id="pending"
          label="Pending invites"
          hint={m.queueLoading ? <Loader2 size={10} className="animate-spin text-[var(--text-muted)]" /> : undefined}
        >
          <PendingInvites
            queue={m.inviteQueue}
            rescindingId={m.rescindingId}
            onRescind={m.rescind}
          />
        </Block>
      )}
    </div>
  );
}
