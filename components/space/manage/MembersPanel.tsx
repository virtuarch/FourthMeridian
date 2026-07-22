"use client";

/**
 * components/space/manage/MembersPanel.tsx  (MSM decomposition)
 *
 * The "Members" tab of Manage Space, extracted verbatim from the former single-
 * file ManageSpaceModal (MembersTab). Owns the member roster, role changes,
 * invites, pending-invite queue, and member removal, hitting the canonical
 * member/invite routes. Behavior-preserving: identical permission gates
 * (isPersonal / canInvite / canRemove / canRole), state, and event dispatches.
 *
 * NOTE (for SEC): the invite/remove/role gates below are still hand-rolled from
 * `myRole` strings and mirror — but do not import — the server's canonical
 * member:* rules in lib/spaces/policy.ts. No client permission authority exists
 * to consume yet, and the modal's residuals (self-leave, don't-touch-OWNER) are
 * route residuals policy.ts's can() deliberately excludes, so this stays local.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Crown, Shield, Users, Eye, Loader2, UserMinus, Mail, X,
} from "lucide-react";
import { formatDate } from "@/lib/format";
import {
  SPACE_LIST_CHANGED_EVENT,
  SPACE_ACCOUNTS_CHANGED_EVENT,
} from "@/lib/space-nav";
import { GlassButton } from "@/components/atlas/GlassButton";
import { UserSearchInput, userDisplayName, type UserResult } from "./UserSearchInput";
import { ROLE_LABELS, type SpaceDetail } from "./manage-shared";

type QueuedInvite = {
  id: string;
  role: string;
  createdAt: string;
  invitedUser: { id: string; name: string | null; username: string | null };
  invitedBy:   { id: string; name: string | null; username: string | null };
};

const ROLE_ICONS: Record<string, React.ReactNode> = {
  OWNER:  <Crown  size={11} className="text-[var(--brass-400)]" />,
  ADMIN:  <Shield size={11} className="text-[var(--meridian-400)]"   />,
  MEMBER: <Users  size={11} className="text-[var(--text-secondary)]"   />,
  VIEWER: <Eye    size={11} className="text-[var(--text-muted)]"   />,
};

function memberDisplayName(m: { user: { name: string | null; username: string | null } }) {
  return m.user.name ?? (m.user.username ? `@${m.user.username}` : "Unknown");
}

export function MembersPanel({
  space,
  myRole,
  currentUserId,
  reloadSpace,
  onRefresh,
}: {
  space:     SpaceDetail;
  myRole:        string;
  currentUserId: string;
  // Refreshes this modal's own member list (was previously — confusingly —
  // bound to the prop named `onRefresh`; renamed so `onRefresh` below can
  // unambiguously mean "the real top-level ManageSpaceModal.onRefresh",
  // matching GeneralSettingsPanel/DangerZonePanel's convention elsewhere).
  reloadSpace:   () => void | Promise<void>;
  // The real top-level callback the hosting page (SpaceDashboard /
  // SpacesClient / DashboardClient) relies on to refresh its own
  // accounts/sections/cards. Previously never called from this tab.
  onRefresh:     () => void | Promise<void>;
}) {
  const [inviteQueue,   setInviteQueue]   = useState<QueuedInvite[]>([]);
  const [queueLoading,  setQueueLoading]  = useState(false);
  const [selectedUser,  setSelectedUser]  = useState<UserResult | null>(null);
  const [inviteBusy,    setInviteBusy]    = useState(false);
  const [inviteError,   setInviteError]   = useState("");
  const [inviteOk,      setInviteOk]      = useState("");
  const [inviteRole,    setInviteRole]    = useState("MEMBER");
  const [removingId,    setRemovingId]    = useState<string | null>(null);
  const [rescindingId,  setRescindingId]  = useState<string | null>(null);
  const [changingRoleId, setChangingRoleId] = useState<string | null>(null);

  // Personal Spaces are strictly single-user (enforced server-side in the
  // invite / accept / role-change routes). Hide the invite affordance, pending-
  // invite list, role selectors, and remove buttons entirely — there is no one
  // to invite or manage but the owner. SHARED spaces are unchanged.
  const isPersonal = space.type === "PERSONAL";
  const canInvite = !isPersonal && ["OWNER", "ADMIN"].includes(myRole);
  const isOwner   = myRole === "OWNER";

  const fetchQueue = useCallback(async () => {
    if (!canInvite) return;
    setQueueLoading(true);
    try {
      const res = await fetch(`/api/spaces/${space.id}/invites`);
      if (res.ok) setInviteQueue(await res.json());
    } finally {
      setQueueLoading(false);
    }
  }, [space.id, canInvite]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  async function handleInvite() {
    if (!selectedUser) return;
    setInviteBusy(true);
    setInviteError("");
    setInviteOk("");
    try {
      const res = await fetch(`/api/spaces/${space.id}/invite`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username: selectedUser.username ?? selectedUser.id, role: inviteRole }),
      });
      const d = await res.json();
      if (!res.ok) {
        setInviteError(d.error ?? "Failed to invite");
      } else {
        setInviteOk(`Invite sent to ${userDisplayName(selectedUser)}`);
        setSelectedUser(null);
        fetchQueue();
      }
    } catch { setInviteError("Network error"); }
    finally { setInviteBusy(false); }
  }

  async function handleRemove(userId: string) {
    setRemovingId(userId);
    try {
      const res = await fetch(`/api/spaces/${space.id}/members/${userId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setInviteError(d.error ?? "Failed to remove member");
        return;
      }
      // Refresh member list in-place; sidebar will pick up the change
      window.dispatchEvent(new CustomEvent(SPACE_LIST_CHANGED_EVENT));
      // Removal revokes the member's shared accounts server-side (see DELETE
      // /api/spaces/[id]/members/[userId]) — signal SpaceDashboard's account
      // listener so accounts/widgets/totals refresh without a manual reload.
      window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
      // Refresh this modal's own member list...
      await reloadSpace();
      // ...and notify the hosting page directly. The event dispatches above
      // only reach SpaceDashboard's listener; this is the one mechanism
      // every host page (SpaceDashboard / SpacesClient / DashboardClient)
      // already implements correctly — it just was never being called.
      await onRefresh();
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRescind(inviteId: string) {
    setRescindingId(inviteId);
    try {
      await fetch(`/api/spaces/${space.id}/invites/${inviteId}`, { method: "DELETE" });
      await fetchQueue();
    } finally {
      setRescindingId(null);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    setChangingRoleId(userId);
    try {
      const res = await fetch(`/api/spaces/${space.id}/members/${userId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ role: newRole }),
      });
      if (res.ok) {
        await onRefresh();
      }
    } finally {
      setChangingRoleId(null);
    }
  }

  const activeMembers = space.members;

  return (
    <div className="space-y-5">
      {/* Member list */}
      <div>
        <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">
          Members · {activeMembers.length}
        </p>
        <div className="space-y-1">
          {activeMembers.map((m) => {
            const isSelf    = m.user.id === currentUserId;
            const isTarget  = m.role === "OWNER";
            const canRemove = !isSelf && !isTarget && canInvite;
            const canRole   = isOwner && !isTarget && !isSelf;

            return (
              <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[var(--surface-muted)]">
                <div className="w-7 h-7 rounded-full bg-[var(--surface-hover-strong)] flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-semibold text-[var(--text-secondary)]">
                    {memberDisplayName(m)[0].toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--text-primary)] truncate">
                    {memberDisplayName(m)}
                    {isSelf && <span className="text-[10px] text-[var(--text-muted)] ml-1">(you)</span>}
                  </p>
                  {m.user.username && (
                    <p className="text-[10px] text-[var(--text-muted)]">@{m.user.username}</p>
                  )}
                </div>

                {/* Role selector for OWNER */}
                {canRole ? (
                  <select
                    value={m.role}
                    disabled={changingRoleId === m.user.id}
                    onChange={(e) => handleRoleChange(m.user.id, e.target.value)}
                    className="bg-[var(--surface-hover-strong)] border-0 rounded-lg text-xs text-[var(--text-secondary)] px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[var(--meridian-400)] disabled:opacity-50"
                  >
                    <option value="ADMIN">Admin</option>
                    <option value="MEMBER">Member</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                ) : (
                  <span className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] shrink-0">
                    {ROLE_ICONS[m.role] ?? null}
                    {ROLE_LABELS[m.role] ?? m.role}
                  </span>
                )}

                {canRemove && (
                  <button
                    onClick={() => handleRemove(m.user.id)}
                    disabled={removingId === m.user.id}
                    className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--coral-400)] hover:bg-[rgba(237,82,71,.10)] disabled:opacity-50 transition-colors"
                    title="Remove member"
                  >
                    {removingId === m.user.id
                      ? <Loader2 size={12} className="animate-spin" />
                      : <UserMinus size={12} />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Invite */}
      {canInvite && (
        <div>
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">Invite</p>
          <div className="space-y-2">
            {selectedUser ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--surface-muted)] border border-[rgba(125,168,255,.3)]">
                  <div className="w-6 h-6 rounded-full bg-[rgba(59,130,246,.20)] flex items-center justify-center shrink-0">
                    <span className="text-[10px] font-semibold text-[var(--meridian-400)]">
                      {userDisplayName(selectedUser)[0].toUpperCase()}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--text-primary)] flex-1 truncate">{userDisplayName(selectedUser)}</p>
                  <button onClick={() => { setSelectedUser(null); setInviteError(""); setInviteOk(""); }}
                    className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                    <X size={13} />
                  </button>
                </div>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl text-xs text-[var(--text-secondary)] px-2 py-2.5 focus:outline-none"
                >
                  <option value="ADMIN">Admin</option>
                  <option value="MEMBER">Member</option>
                  <option value="VIEWER">Viewer</option>
                </select>
                <GlassButton
                  onClick={handleInvite}
                  disabled={inviteBusy}
                  tone="meridian"
                  size="sm"
                >
                  {inviteBusy ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
                  Send
                </GlassButton>
              </div>
            ) : (
              <UserSearchInput
                spaceId={space.id}
                onSelect={(u) => { setSelectedUser(u); setInviteError(""); setInviteOk(""); }}
              />
            )}
            {inviteError && <p className="text-xs text-[var(--coral-400)]">{inviteError}</p>}
            {inviteOk    && <p className="text-xs text-[var(--emerald-400)]">{inviteOk}</p>}
          </div>
        </div>
      )}

      {/* Pending invites */}
      {canInvite && (
        <div>
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">
            Pending invites {queueLoading && <Loader2 size={9} className="inline animate-spin ml-1" />}
          </p>
          {inviteQueue.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] px-1">No pending invites</p>
          ) : (
            <div className="space-y-1">
              {inviteQueue.map((inv) => (
                <div key={inv.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[var(--surface-muted)]">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[var(--text-primary)] truncate">{userDisplayName(inv.invitedUser as UserResult)}</p>
                    <p className="text-[10px] text-[var(--text-muted)]">{ROLE_LABELS[inv.role] ?? inv.role} · sent {formatDate(inv.createdAt)}</p>
                  </div>
                  <button
                    onClick={() => handleRescind(inv.id)}
                    disabled={rescindingId === inv.id}
                    className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--coral-400)] hover:bg-[rgba(237,82,71,.10)] disabled:opacity-50 transition-colors"
                    title="Rescind invite"
                  >
                    {rescindingId === inv.id ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
