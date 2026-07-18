"use client";

/**
 * components/space/widgets/members/use-space-members.ts
 *
 * The Members workspace's single source of truth for the roster + its mutations —
 * the client-side authority the editorial Members destination composes over. It is
 * NOT a new backend: it self-fetches the SAME routes ManageSpaceModal / MembersPanel
 * already use (the roster is the GET /api/spaces/[id] side-payload; the pending queue
 * is GET …/invites) and calls the SAME five mutation endpoints (invite / rescind /
 * role / remove). No policy engine, no new capability — the gate booleans below
 * mirror (but, like MembersPanel, do not import) the server's canonical member:*
 * rules in lib/spaces/policy.ts, and the residuals (don't-touch-OWNER, no-self-role,
 * self stays removable only via the Danger tab) are route residuals kept local.
 *
 * The workspace threads the returned data + actions to the editorial surfaces
 * (MembersRoster / MemberDetail / MembersInvite / PendingInvites); each surface owns
 * only its own UI state (selection, the invite composer's draft), never the fetches.
 */

import { useCallback, useEffect, useState } from "react";
import {
  SPACE_LIST_CHANGED_EVENT,
  SPACE_ACCOUNTS_CHANGED_EVENT,
} from "@/lib/space-nav";
import type { Member } from "@/components/space/manage/manage-shared";

/** One PENDING invite, as returned by GET /api/spaces/[id]/invites. */
export interface QueuedInvite {
  id: string;
  role: string;
  createdAt: string;
  invitedUser: { id: string; name: string | null; username: string | null };
  invitedBy: { id: string; name: string | null; username: string | null };
}

/** The roster side-payload shape this workspace reads off GET /api/spaces/[id]. */
interface SpaceRosterPayload {
  type: string;
  members: Member[];
  myRole: string | null;
}

export interface UseSpaceMembers {
  /** null while the first roster load is in flight. */
  members: Member[] | null;
  /** The caller's role in this Space (from the roster payload), or the passed hint. */
  myRole: string;
  /** true for a strictly single-user PERSONAL Space (no one to invite or manage). */
  isPersonal: boolean;
  /** OWNER/ADMIN on a shared Space — may invite + manage members. */
  canInvite: boolean;
  /** OWNER — may change roles. */
  isOwner: boolean;

  /** Pending invites (empty until loaded / when canInvite is false). */
  inviteQueue: QueuedInvite[];
  queueLoading: boolean;

  /** Mutations — each resolves to an error string, or null on success. */
  invite: (username: string, role: string) => Promise<string | null>;
  rescind: (inviteId: string) => Promise<void>;
  changeRole: (userId: string, role: string) => Promise<void>;
  remove: (userId: string) => Promise<string | null>;

  /** In-flight markers so each surface can disable the row it is mutating. */
  rescindingId: string | null;
  changingRoleId: string | null;
  removingId: string | null;

  /** Re-pull the roster (e.g. after a mutation performed elsewhere). */
  reload: () => Promise<void>;
}

export function useSpaceMembers({
  spaceId,
  myRole: myRoleHint,
  onRefresh,
}: {
  spaceId: string;
  /** The host already knows the caller's role — used until the roster payload
   *  confirms it, so gates never flash the wrong affordances at first paint. */
  myRole: string;
  /** The host's own refresh (accounts / sections / totals), called after a
   *  removal revokes the departing member's shared accounts server-side. */
  onRefresh?: () => void | Promise<void>;
}): UseSpaceMembers {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [payloadRole, setPayloadRole] = useState<string | null>(null);
  const [isPersonal, setIsPersonal] = useState(false);

  const [inviteQueue, setInviteQueue] = useState<QueuedInvite[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);

  const [rescindingId, setRescindingId] = useState<string | null>(null);
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const myRole = payloadRole ?? myRoleHint;
  const canInvite = !isPersonal && ["OWNER", "ADMIN"].includes(myRole);
  const isOwner = myRole === "OWNER";

  const reload = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}`);
    if (!res.ok) {
      setMembers((prev) => prev ?? []);
      return;
    }
    const data: SpaceRosterPayload = await res.json();
    setMembers(data.members ?? []);
    setPayloadRole(data.myRole ?? null);
    setIsPersonal(data.type === "PERSONAL");
  }, [spaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { reload(); }, [reload]);

  const fetchQueue = useCallback(async () => {
    if (!canInvite) { setInviteQueue([]); return; }
    setQueueLoading(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/invites`);
      if (res.ok) setInviteQueue(await res.json());
    } finally {
      setQueueLoading(false);
    }
  }, [spaceId, canInvite]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  const invite = useCallback(async (username: string, role: string): Promise<string | null> => {
    try {
      const res = await fetch(`/api/spaces/${spaceId}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, role }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return d.error ?? "Failed to invite";
      await fetchQueue();
      return null;
    } catch {
      return "Network error";
    }
  }, [spaceId, fetchQueue]);

  const rescind = useCallback(async (inviteId: string) => {
    setRescindingId(inviteId);
    try {
      await fetch(`/api/spaces/${spaceId}/invites/${inviteId}`, { method: "DELETE" });
      await fetchQueue();
    } finally {
      setRescindingId(null);
    }
  }, [spaceId, fetchQueue]);

  const changeRole = useCallback(async (userId: string, role: string) => {
    setChangingRoleId(userId);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (res.ok) {
        await reload();
        await onRefresh?.();
      }
    } finally {
      setChangingRoleId(null);
    }
  }, [spaceId, reload, onRefresh]);

  const remove = useCallback(async (userId: string): Promise<string | null> => {
    setRemovingId(userId);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/members/${userId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        return d.error ?? "Failed to remove member";
      }
      // Removal revokes the member's shared accounts server-side — signal the
      // sidebar (member count) and SpaceDashboard's account listener so
      // accounts / widgets / totals refresh without a manual reload.
      window.dispatchEvent(new CustomEvent(SPACE_LIST_CHANGED_EVENT));
      window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
      await reload();
      await onRefresh?.();
      return null;
    } finally {
      setRemovingId(null);
    }
  }, [spaceId, reload, onRefresh]);

  return {
    members,
    myRole,
    isPersonal,
    canInvite,
    isOwner,
    inviteQueue,
    queueLoading,
    invite,
    rescind,
    changeRole,
    remove,
    rescindingId,
    changingRoleId,
    removingId,
    reload,
  };
}
