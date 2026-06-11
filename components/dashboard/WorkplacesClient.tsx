"use client";

import { useState, useTransition, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Building2, Globe, Lock, Plus, Users, Crown,
  Shield, Eye, UserMinus, X, Check, ChevronRight,
  Mail, Loader2, Trash2, Search,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Member = {
  id: string;
  role: string;
  joinedAt: string;
  user: { id: string; name: string | null; username: string | null };
};

type Workspace = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  isPublic: boolean;
  createdAt: string;
  members: Member[];
  myRole?: string | null;
};

type Invite = {
  id: string;
  role: string;
  createdAt: string;
  workspace: { id: string; name: string; description: string | null; isPublic: boolean };
  invitedBy: { id: string; name: string | null; username: string | null };
};

type UserResult = {
  id: string;
  name: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
};

type QueuedInvite = {
  id: string;
  role: string;
  createdAt: string;
  invitedUser: { id: string; name: string | null; username: string | null };
  invitedBy:   { id: string; name: string | null; username: string | null };
};

interface Props {
  mine: Workspace[];
  publicWorkspaces: Workspace[];
  pendingInvites: Invite[];
  currentUserId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROLE_ICONS: Record<string, React.ReactNode> = {
  OWNER:  <Crown  size={11} className="text-yellow-400" />,
  ADMIN:  <Shield size={11} className="text-blue-400"   />,
  MEMBER: <Users  size={11} className="text-gray-400"   />,
  VIEWER: <Eye    size={11} className="text-gray-500"   />,
};

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", VIEWER: "Viewer",
};

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="flex items-center gap-1 text-[10px] font-medium text-gray-400">
      {ROLE_ICONS[role] ?? null}
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

function MemberAvatars({ members }: { members: Member[] }) {
  const shown = members.slice(0, 4);
  const extra = members.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((m) => {
        const initial = (m.user.name ?? m.user.username ?? "?")[0].toUpperCase();
        return (
          <div key={m.id} className="w-6 h-6 rounded-full bg-gray-700 border border-gray-800 flex items-center justify-center" title={m.user.name ?? m.user.username ?? ""}>
            <span className="text-[9px] font-semibold text-gray-300">{initial}</span>
          </div>
        );
      })}
      {extra > 0 && (
        <div className="w-6 h-6 rounded-full bg-gray-700 border border-gray-800 flex items-center justify-center">
          <span className="text-[9px] font-semibold text-gray-400">+{extra}</span>
        </div>
      )}
    </div>
  );
}

// ─── User Search Dropdown ─────────────────────────────────────────────────────

function UserSearchInput({
  workspaceId,
  onSelect,
}: {
  workspaceId: string;
  onSelect: (user: UserResult) => void;
}) {
  const [query,   setQuery]   = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open,    setOpen]    = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const search = useCallback(async (q: string) => {
    if (q.length < 1) { setResults([]); setOpen(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}&exclude=${workspaceId}`);
      const data = await res.json();
      setResults(data);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // Debounce
  useEffect(() => {
    const t = setTimeout(() => search(query), 250);
    return () => clearTimeout(t);
  }, [query, search]);

  function handleSelect(user: UserResult) {
    onSelect(user);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  const displayName = (u: UserResult) => {
    if (u.name) return u.name;
    const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
    return full || u.username || "Unknown";
  };

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query.length >= 1 && results.length > 0 && setOpen(true)}
          placeholder="Search by name or @username…"
          className="w-full bg-gray-800 border border-gray-700 rounded-xl pl-8 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
        />
        {loading && <Loader2 size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 animate-spin" />}
      </div>

      {open && results.length > 0 && (
        <div className="absolute z-10 w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl shadow-xl overflow-hidden">
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); handleSelect(u); }}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-700 transition-colors text-left"
            >
              <div className="w-7 h-7 rounded-full bg-gray-600 flex items-center justify-center shrink-0">
                <span className="text-[10px] font-semibold text-gray-200">
                  {displayName(u)[0].toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{displayName(u)}</p>
                {u.username && <p className="text-xs text-gray-500">@{u.username}</p>}
              </div>
            </button>
          ))}
        </div>
      )}

      {open && !loading && query.length >= 1 && results.length === 0 && (
        <div className="absolute z-10 w-full mt-1 bg-gray-800 border border-gray-700 rounded-xl shadow-xl px-3 py-3">
          <p className="text-sm text-gray-500">No users found for &ldquo;{query}&rdquo;</p>
        </div>
      )}
    </div>
  );
}

// ─── Create Workspace Modal ───────────────────────────────────────────────────

function CreateWorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name,        setName]        = useState("");
  const [description, setDescription] = useState("");
  const [isPublic,    setIsPublic]    = useState(false);
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), isPublic }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to create");
      } else {
        onCreated();
        onClose();
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center px-4 pt-4 pb-40 sm:p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl shadow-2xl flex flex-col max-h-[calc(100dvh-180px)] sm:max-h-[85vh]">
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-800 shrink-0">
          <h2 className="text-base font-semibold text-white">New Workspace</h2>
          <button onClick={onClose} className="p-1.5 rounded-xl text-gray-500 hover:text-white hover:bg-gray-800 transition-colors">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-400 mb-1.5 block">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Smith Family, Rental Properties LLC"
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              maxLength={60}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-400 mb-1.5 block">
              Description <span className="text-gray-600">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this workspace for?"
              rows={3}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors resize-none"
              maxLength={200}
            />
          </div>

          <button
            type="button"
            onClick={() => setIsPublic((p) => !p)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl border transition-colors ${
              isPublic ? "border-blue-500/40 bg-blue-600/10" : "border-gray-700 bg-gray-800/50"
            }`}
          >
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${isPublic ? "bg-blue-600/20" : "bg-gray-700"}`}>
              {isPublic ? <Globe size={15} className="text-blue-400" /> : <Lock size={15} className="text-gray-400" />}
            </div>
            <div className="flex-1 text-left">
              <p className="text-sm font-medium text-white">{isPublic ? "Public" : "Private"}</p>
              <p className="text-xs text-gray-500">
                {isPublic ? "Visible to all FinTracker users" : "Only visible to invited members"}
              </p>
            </div>
            <div className={`w-4 h-4 rounded-full border-2 shrink-0 ${isPublic ? "border-blue-500 bg-blue-500" : "border-gray-600"}`} />
          </button>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </form>

        <div className="px-5 pb-6 sm:pb-5 pt-3 border-t border-gray-800 shrink-0 flex gap-2">
          <button type="button" onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-700 text-sm text-gray-400 hover:text-white hover:border-gray-500 transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSubmit as never}
            disabled={busy || !name.trim()}
            className="flex-1 px-4 py-2.5 rounded-xl bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Workspace Detail Panel ───────────────────────────────────────────────────

function WorkspaceDetail({
  ws,
  currentUserId,
  onClose,
  onRefresh,
}: {
  ws: Workspace;
  currentUserId: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [selectedUser,  setSelectedUser]  = useState<UserResult | null>(null);
  const [inviteError,   setInviteError]   = useState("");
  const [inviteBusy,    setInviteBusy]    = useState(false);
  const [inviteOk,      setInviteOk]      = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy,    setDeleteBusy]    = useState(false);
  const [inviteQueue,   setInviteQueue]   = useState<QueuedInvite[]>([]);
  const [queueLoading,  setQueueLoading]  = useState(false);
  const [rescindingId,  setRescindingId]  = useState<string | null>(null);

  const myRole    = ws.myRole ?? "";
  const isOwner   = myRole === "OWNER";
  const canInvite = ["OWNER", "ADMIN"].includes(myRole);

  const fetchQueue = useCallback(async () => {
    if (!canInvite) return;
    setQueueLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/invites`);
      if (res.ok) setInviteQueue(await res.json());
    } finally {
      setQueueLoading(false);
    }
  }, [ws.id, canInvite]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  async function handleInvite() {
    if (!selectedUser) return;
    setInviteBusy(true);
    setInviteError("");
    setInviteOk("");
    try {
      const res = await fetch(`/api/workspaces/${ws.id}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: selectedUser.username ?? selectedUser.id }),
      });
      const d = await res.json();
      if (!res.ok) setInviteError(d.error ?? "Failed to invite");
      else {
        const name = selectedUser.name ?? selectedUser.username ?? "User";
        setInviteOk(`Invite sent to ${name}`);
        setSelectedUser(null);
        fetchQueue();
      }
    } catch { setInviteError("Network error"); }
    finally { setInviteBusy(false); }
  }

  async function handleRescind(inviteId: string) {
    setRescindingId(inviteId);
    try {
      await fetch(`/api/workspaces/${ws.id}/invites/${inviteId}`, { method: "DELETE" });
      await fetchQueue();
    } finally {
      setRescindingId(null);
    }
  }

  async function handleRemoveMember(userId: string) {
    await fetch(`/api/workspaces/${ws.id}/members/${userId}`, { method: "DELETE" });
    onRefresh();
  }

  async function handleDelete() {
    setDeleteBusy(true);
    await fetch(`/api/workspaces/${ws.id}`, { method: "DELETE" });
    onRefresh();
    onClose();
  }

  async function handleLeave() {
    await fetch(`/api/workspaces/${ws.id}/members/${currentUserId}`, { method: "DELETE" });
    onRefresh();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center px-4 pt-4 pb-40 sm:p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl shadow-2xl flex flex-col max-h-[calc(100dvh-180px)] sm:max-h-[85vh]">
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-gray-800 shrink-0">
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 mb-0.5">
              <h2 className="text-base font-semibold text-white truncate">{ws.name}</h2>
              {ws.isPublic
                ? <Globe size={13} className="text-gray-500 shrink-0" />
                : <Lock  size={13} className="text-gray-600 shrink-0" />}
            </div>
            {ws.description && <p className="text-xs text-gray-500">{ws.description}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl text-gray-500 hover:text-white hover:bg-gray-800 transition-colors shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Members */}
          <div>
            <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">
              Members · {ws.members.length}
            </p>
            <div className="space-y-1">
              {ws.members.map((m) => {
                const isSelf  = m.user.id === currentUserId;
                const canKick = canInvite && !isSelf && m.role !== "OWNER";
                return (
                  <div key={m.id} className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-gray-800/50 group transition-colors">
                    <div className="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center shrink-0">
                      <span className="text-[10px] font-semibold text-gray-300">
                        {(m.user.name ?? m.user.username ?? "?")[0].toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">
                        {m.user.name ?? m.user.username ?? "Unknown"}
                        {isSelf && <span className="text-gray-600 ml-1 text-xs">(you)</span>}
                      </p>
                      {m.user.username && <p className="text-xs text-gray-600">@{m.user.username}</p>}
                    </div>
                    <RoleBadge role={m.role} />
                    {canKick && (
                      <button
                        onClick={() => handleRemoveMember(m.user.id)}
                        className="p-1 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                        title="Remove member"
                      >
                        <UserMinus size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pending Invite Queue */}
          {canInvite && (inviteQueue.length > 0 || queueLoading) && (
            <div>
              <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">
                Pending Invites{inviteQueue.length > 0 ? ` · ${inviteQueue.length}` : ""}
              </p>
              {queueLoading ? (
                <div className="flex justify-center py-3">
                  <Loader2 size={16} className="animate-spin text-gray-600" />
                </div>
              ) : (
                <div className="space-y-1">
                  {inviteQueue.map((inv) => (
                    <div key={inv.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-yellow-500/5 border border-yellow-500/10">
                      <div className="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center shrink-0">
                        <span className="text-[10px] font-semibold text-gray-300">
                          {(inv.invitedUser.name ?? inv.invitedUser.username ?? "?")[0].toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">
                          {inv.invitedUser.name ?? inv.invitedUser.username ?? "Unknown"}
                        </p>
                        {inv.invitedUser.username && (
                          <p className="text-xs text-gray-600">@{inv.invitedUser.username}</p>
                        )}
                      </div>
                      <span className="text-[10px] font-medium text-yellow-400 bg-yellow-400/10 px-1.5 py-0.5 rounded-full shrink-0">
                        Pending
                      </span>
                      <button
                        onClick={() => handleRescind(inv.id)}
                        disabled={rescindingId === inv.id}
                        className="p-1 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors shrink-0"
                        title="Rescind invite"
                      >
                        {rescindingId === inv.id
                          ? <Loader2 size={13} className="animate-spin" />
                          : <X size={13} />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Invite by search */}
          {canInvite && (
            <div>
              <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">
                Invite Member
              </p>

              {selectedUser ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-2.5 bg-gray-800 border border-blue-500/40 rounded-xl px-3 py-2">
                    <div className="w-6 h-6 rounded-full bg-gray-600 flex items-center justify-center shrink-0">
                      <span className="text-[9px] font-semibold text-gray-200">
                        {(selectedUser.name ?? selectedUser.username ?? "?")[0].toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">
                        {selectedUser.name ?? selectedUser.username}
                      </p>
                      {selectedUser.username && (
                        <p className="text-xs text-gray-500">@{selectedUser.username}</p>
                      )}
                    </div>
                    <button
                      onClick={() => { setSelectedUser(null); setInviteError(""); setInviteOk(""); }}
                      className="p-0.5 text-gray-500 hover:text-white transition-colors"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <button
                    onClick={handleInvite}
                    disabled={inviteBusy}
                    className="px-4 py-2 rounded-xl bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors flex items-center gap-1.5 shrink-0"
                  >
                    {inviteBusy ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                    Send
                  </button>
                </div>
              ) : (
                <UserSearchInput
                  workspaceId={ws.id}
                  onSelect={(u) => { setSelectedUser(u); setInviteError(""); setInviteOk(""); }}
                />
              )}

              {inviteError && <p className="text-xs text-red-400 mt-1.5">{inviteError}</p>}
              {inviteOk    && <p className="text-xs text-green-400 mt-1.5">{inviteOk}</p>}
            </div>
          )}

          {/* Danger zone */}
          {ws.type !== "PERSONAL" && (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
              <p className="text-xs font-semibold text-red-400 uppercase tracking-widest">Danger Zone</p>
              {!isOwner && (
                <button
                  onClick={handleLeave}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <UserMinus size={14} />
                  Leave workspace
                </button>
              )}
              {isOwner && !confirmDelete && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 size={14} />
                  Delete workspace
                </button>
              )}
              {isOwner && confirmDelete && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-400">
                    Delete <span className="text-white font-medium">{ws.name}</span>? This cannot be undone.
                  </p>
                  <div className="flex gap-2">
                    <button onClick={() => setConfirmDelete(false)}
                      className="flex-1 px-3 py-2 rounded-xl border border-gray-700 text-xs text-gray-400 hover:text-white transition-colors">
                      Cancel
                    </button>
                    <button onClick={handleDelete} disabled={deleteBusy}
                      className="flex-1 px-3 py-2 rounded-xl bg-red-600 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
                      {deleteBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Workspace Card ───────────────────────────────────────────────────────────

function WorkspaceCard({
  ws,
  joined,
  onClick,
}: {
  ws: Workspace;
  joined?: boolean;
  onClick: () => void;
}) {
  const isPersonal = ws.type === "PERSONAL";

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-gray-900 border border-gray-800 rounded-2xl p-4 hover:border-gray-700 hover:bg-gray-800/50 transition-colors group"
    >
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
          isPersonal ? "bg-blue-600/20" : "bg-gray-800"
        }`}>
          <Building2 size={16} className={isPersonal ? "text-blue-400" : "text-gray-400"} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <p className="text-sm font-semibold text-white truncate">{ws.name}</p>
            {ws.isPublic
              ? <Globe size={11} className="text-gray-600 shrink-0" />
              : !isPersonal && <Lock size={11} className="text-gray-700 shrink-0" />}
            {joined && (
              <span className="text-[9px] font-semibold bg-blue-600/20 text-blue-400 px-1.5 py-0.5 rounded-full shrink-0">
                Joined
              </span>
            )}
          </div>
          {ws.description && (
            <p className="text-xs text-gray-500 truncate mb-2">{ws.description}</p>
          )}
          <div className="flex items-center justify-between">
            <MemberAvatars members={ws.members} />
            <div className="flex items-center gap-2">
              {ws.myRole && <RoleBadge role={ws.myRole} />}
              <ChevronRight size={14} className="text-gray-700 group-hover:text-gray-500 transition-colors" />
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}

// ─── Invite Card ─────────────────────────────────────────────────────────────

function InviteCard({ invite, onAction }: { invite: Invite; onAction: () => void }) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [done, setDone] = useState(false);

  async function act(action: "accept" | "decline") {
    setBusy(action);
    try {
      await fetch(`/api/workspaces/${invite.workspace.id}/invites/${invite.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setDone(true);
      onAction();
    } finally {
      setBusy(null);
    }
  }

  if (done) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-xl bg-blue-600/10 border border-blue-500/20 flex items-center justify-center shrink-0">
          <Building2 size={16} className="text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{invite.workspace.name}</p>
          <p className="text-xs text-gray-500">
            Invited by {invite.invitedBy.name ?? `@${invite.invitedBy.username}`} · {ROLE_LABELS[invite.role] ?? invite.role}
          </p>
          {invite.workspace.description && (
            <p className="text-xs text-gray-600 mt-0.5 truncate">{invite.workspace.description}</p>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => act("decline")}
          disabled={!!busy}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-gray-700 text-xs text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-50 transition-colors"
        >
          {busy === "decline" ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
          Decline
        </button>
        <button
          onClick={() => act("accept")}
          disabled={!!busy}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
        >
          {busy === "accept" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          Accept
        </button>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type Tab = "mine" | "public" | "invites";

export function WorkplacesClient({ mine, publicWorkspaces, pendingInvites, currentUserId }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [tab,        setTab]        = useState<Tab>("mine");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedWs, setSelectedWs] = useState<Workspace | null>(null);

  function refresh() {
    startTransition(() => router.refresh());
  }

  const sharedMine = mine.filter((w) => w.type === "SHARED");
  const personal   = mine.find((w)  => w.type === "PERSONAL");

  // For the public tab: all public workspaces + user's own public shared workspaces
  // so a workspace they created as public shows up there too
  const myPublicIds  = new Set(sharedMine.filter((w) => w.isPublic).map((w) => w.id));
  const allPublic    = [
    ...sharedMine.filter((w) => w.isPublic),               // user's own public (with myRole)
    ...publicWorkspaces.filter((w) => !myPublicIds.has(w.id)), // others they haven't joined
  ];

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "mine",    label: "My Workspaces", count: sharedMine.length        },
    { id: "public",  label: "Public",        count: allPublic.length         },
    { id: "invites", label: "Invites",       count: pendingInvites.length    },
  ];

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Workspaces</h1>
          <p className="text-sm text-gray-500 mt-0.5">Collaborate on shared finances</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          <Plus size={15} />
          <span className="hidden sm:inline">New Workspace</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>

      {/* Personal workspace card */}
      {personal && (
        <div className="mb-5">
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2 px-1">Personal</p>
          <WorkspaceCard ws={personal} onClick={() => setSelectedWs(personal)} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-2xl p-1 mb-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
              tab === t.id ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {t.label}
            {typeof t.count === "number" && t.count > 0 && (
              <span className={`text-[10px] rounded-full px-1.5 py-0.5 ${
                tab === t.id ? "bg-gray-600 text-gray-200" : "bg-gray-800 text-gray-500"
              }`}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "mine" && (
        <div className="space-y-2">
          {sharedMine.length === 0 ? (
            <div className="text-center py-12">
              <Building2 size={32} className="text-gray-700 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No shared workspaces yet</p>
              <button
                onClick={() => setShowCreate(true)}
                className="mt-3 text-sm text-blue-400 hover:text-blue-300 transition-colors"
              >
                Create your first one
              </button>
            </div>
          ) : (
            sharedMine.map((ws) => (
              <WorkspaceCard key={ws.id} ws={ws} onClick={() => setSelectedWs(ws)} />
            ))
          )}
        </div>
      )}

      {tab === "public" && (
        <div className="space-y-2">
          {allPublic.length === 0 ? (
            <div className="text-center py-12">
              <Globe size={32} className="text-gray-700 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No public workspaces yet</p>
            </div>
          ) : (
            allPublic.map((ws) => (
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                joined={!!ws.myRole}
                onClick={() => setSelectedWs(ws)}
              />
            ))
          )}
        </div>
      )}

      {tab === "invites" && (
        <div className="space-y-2">
          {pendingInvites.length === 0 ? (
            <div className="text-center py-12">
              <Mail size={32} className="text-gray-700 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No pending invites</p>
            </div>
          ) : (
            pendingInvites.map((inv) => (
              <InviteCard key={inv.id} invite={inv} onAction={refresh} />
            ))
          )}
        </div>
      )}

      {/* Modals */}
      {showCreate && (
        <CreateWorkspaceModal onClose={() => setShowCreate(false)} onCreated={refresh} />
      )}
      {selectedWs && (
        <WorkspaceDetail
          ws={selectedWs}
          currentUserId={currentUserId}
          onClose={() => setSelectedWs(null)}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}
