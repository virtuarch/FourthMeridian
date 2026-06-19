"use client";

/**
 * ManageWorkspaceModal
 *
 * Full workspace management panel. Opens as a modal overlay.
 * Tabs: General · Members · Goals · Finances · Dashboard · Danger Zone
 *
 * Danger Zone is the single entry point for owner-initiated archive/trash
 * actions (see DangerZoneTab below) — WorkspacesClient's separate
 * WorkspaceDetail modal no longer duplicates a delete control.
 *
 * Permission gating mirrors the server:
 *   OWNER  — all tabs + actions
 *   ADMIN  — Members (invite/remove non-owners), Goals, Finances, Dashboard
 *   MEMBER — Finances (share own accounts only), no management tabs
 *   VIEWER — read only, no management tabs
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X, Settings, Users, Target, Landmark, LayoutDashboard,
  AlertTriangle, Loader2, Crown, Shield, Eye, EyeOff,
  UserMinus, Trash2, Mail, Plus, Check, Globe, Lock,
  Share2, Search, ChevronRight, AlertCircle, Calendar,
  CheckCircle2, Circle, Pencil, Save, Archive,
} from "lucide-react";
import {
  CATEGORY_LABELS, CATEGORY_ICONS,
  PRIMARY_CATEGORIES, SECONDARY_CATEGORIES,
  WorkspaceCategory,
} from "@/lib/workspace-presets";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatDate as formatDateUTC } from "@/lib/format";

// ─── Types ─────────────────────────────────────────────────────────────────────

type Member = {
  id: string;
  role: string;
  joinedAt: string;
  user: { id: string; name: string | null; username: string | null; email: string | null };
};

type WorkspaceDetail = {
  id:          string;
  name:        string;
  description: string | null;
  type:        string;
  category:    string;
  isPublic:    boolean;
  createdAt:   string;
  members:     Member[];
  myRole:      string | null;
};

type Goal = {
  id:            string;
  name:          string;
  description:   string | null;
  category:      string;
  status:        string;
  targetAmount:  number;
  currentAmount: number;
  targetDate:    string | null;
  completedAt:   string | null;
};

type SharedAccount = {
  id:          string;
  name:        string;
  type:        string;
  institution: string;
  balance:     number;
  currency:    string;
  lastUpdated: string;
};

type UserAccount = SharedAccount & { mask?: string | null };

type DashboardSection = {
  id:      string;
  key:     string;
  label:   string;
  tab:     string;
  enabled: boolean;
  order:   number;
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
  workspaceId:   string;
  workspaceName: string;
  myRole:        string;
  currentUserId: string;
  onClose:       () => void;
  onRefresh:     () => void;
  onDeleted?:    () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ROLE_ICONS: Record<string, React.ReactNode> = {
  OWNER:  <Crown  size={11} className="text-yellow-400" />,
  ADMIN:  <Shield size={11} className="text-blue-400"   />,
  MEMBER: <Users  size={11} className="text-gray-400"   />,
  VIEWER: <Eye    size={11} className="text-gray-500"   />,
};

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", VIEWER: "Viewer",
};

const GOAL_CATEGORY_LABELS: Record<string, string> = {
  SAVINGS: "Savings", DEBT_PAYOFF: "Debt Payoff", INVESTMENT: "Investment",
  HOME: "Home", VEHICLE: "Vehicle", EDUCATION: "Education", TRAVEL: "Travel",
  EMERGENCY: "Emergency Fund", RETIREMENT: "Retirement", EQUIPMENT: "Equipment",
  GENERAL: "General",
};

const TAB_LABELS_SECTION: Record<string, string> = {
  OVERVIEW: "Overview", GOALS: "Goals", ACCOUNTS: "Accounts",
  DEBT: "Debt", INVESTMENTS: "Investments", RETIREMENT: "Retirement",
  ACTIVITY: "Activity", SETTINGS: "Settings",
};

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: "Checking", savings: "Savings", investment: "Investment",
  crypto: "Crypto", debt: "Debt", other: "Other",
};

const ICON_MAP: Record<string, React.ReactNode> = {
  User: <Users size={16} />, Home: <Landmark size={16} />, Users: <Users size={16} />,
  Briefcase: <Settings size={16} />, Building2: <LayoutDashboard size={16} />,
  Car: <Settings size={16} />, Plane: <Target size={16} />, TrendingUp: <Target size={16} />,
  Wrench: <Settings size={16} />, Sunset: <Target size={16} />, CreditCard: <AlertTriangle size={16} />,
  Shield: <Shield size={16} />, Target: <Target size={16} />,
  LayoutDashboard: <LayoutDashboard size={16} />, MoreHorizontal: <Settings size={16} />,
};

function formatBalance(amount: number, currency = DEFAULT_DISPLAY_CURRENCY) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, maximumFractionDigits: 0,
  }).format(amount);
}

const formatDate = formatDateUTC;

function memberDisplayName(m: { user: { name: string | null; username: string | null } }) {
  return m.user.name ?? (m.user.username ? `@${m.user.username}` : "Unknown");
}

function userDisplayName(u: UserResult) {
  if (u.name) return u.name;
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return full || u.username || "Unknown";
}

// ─── User Search ───────────────────────────────────────────────────────────────

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
                <span className="text-[10px] font-semibold text-gray-200">{userDisplayName(u)[0].toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{userDisplayName(u)}</p>
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

// ─── Tab: General ──────────────────────────────────────────────────────────────

function GeneralTab({
  workspace,
  onSaved,
}: {
  workspace: WorkspaceDetail;
  onSaved: (updated: Partial<WorkspaceDetail>) => void;
}) {
  const [name,        setName]        = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [isPublic,    setIsPublic]    = useState(workspace.isPublic);
  const [category,    setCategory]    = useState(workspace.category);
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState("");
  const [saved,       setSaved]       = useState(false);
  const [showCatPicker, setShowCatPicker] = useState(false);

  const allCategories = [...PRIMARY_CATEGORIES, ...SECONDARY_CATEGORIES];

  async function handleSave() {
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          name:        name.trim(),
          description: description.trim() || null,
          isPublic,
          category,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save");
      } else {
        onSaved({ name: name.trim(), description: description.trim() || null, isPublic, category });
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { setError("Network error"); }
    finally { setBusy(false); }
  }

  const isDirty =
    name.trim()       !== workspace.name ||
    (description.trim() || null) !== workspace.description ||
    isPublic          !== workspace.isPublic ||
    category          !== workspace.category;

  return (
    <div className="space-y-5">
      {/* Name */}
      <div>
        <label className="text-xs font-medium text-gray-400 block mb-1.5">Space name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
        />
      </div>

      {/* Description */}
      <div>
        <label className="text-xs font-medium text-gray-400 block mb-1.5">
          Description <span className="text-gray-600">(optional)</span>
        </label>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this Space for?"
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors resize-none"
        />
      </div>

      {/* Visibility */}
      <div>
        <label className="text-xs font-medium text-gray-400 block mb-1.5">Visibility</label>
        <div className="grid grid-cols-2 gap-2">
          {([false, true] as const).map((pub) => (
            <button
              key={String(pub)}
              type="button"
              onClick={() => setIsPublic(pub)}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                isPublic === pub
                  ? "border-blue-500/40 bg-blue-600/10"
                  : "border-gray-700 hover:border-gray-600"
              }`}
            >
              <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-colors ${
                isPublic === pub ? "border-blue-500 bg-blue-500" : "border-gray-600"
              }`} />
              <div>
                <p className="text-xs font-medium text-white flex items-center gap-1.5">
                  {pub ? <Globe size={11} /> : <Lock size={11} />}
                  {pub ? "Public" : "Private"}
                </p>
                <p className="text-[10px] text-gray-500">
                  {pub ? "Anyone can view" : "Invite only"}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Category */}
      <div>
        <label className="text-xs font-medium text-gray-400 block mb-1.5">Category</label>
        <button
          type="button"
          onClick={() => setShowCatPicker((p) => !p)}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-gray-700 hover:border-gray-600 bg-gray-800 text-left transition-colors"
        >
          <span className="text-gray-500">{ICON_MAP[CATEGORY_ICONS[category as WorkspaceCategory]] ?? <Settings size={16} />}</span>
          <span className="text-sm text-white flex-1">{CATEGORY_LABELS[category as WorkspaceCategory] ?? category}</span>
          <ChevronRight size={13} className={`text-gray-600 transition-transform ${showCatPicker ? "rotate-90" : ""}`} />
        </button>

        {showCatPicker && (
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {allCategories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => { setCategory(cat); setShowCatPicker(false); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition-colors ${
                  category === cat
                    ? "border-blue-500/40 bg-blue-600/10"
                    : "border-gray-700 hover:border-gray-600 bg-gray-800/40"
                }`}
              >
                <span className="text-gray-500 shrink-0">{ICON_MAP[CATEGORY_ICONS[cat]] ?? <Settings size={14} />}</span>
                <span className="text-xs text-white truncate">{CATEGORY_LABELS[cat]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={handleSave}
        disabled={busy || !isDirty}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {busy
          ? <Loader2 size={14} className="animate-spin" />
          : saved
            ? <Check size={14} />
            : <Save size={14} />}
        {saved ? "Saved!" : "Save changes"}
      </button>
    </div>
  );
}

// ─── Tab: Members ─────────────────────────────────────────────────────────────

function MembersTab({
  workspace,
  myRole,
  currentUserId,
  onRefresh,
}: {
  workspace:     WorkspaceDetail;
  myRole:        string;
  currentUserId: string;
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

  const canInvite = ["OWNER", "ADMIN"].includes(myRole);
  const isOwner   = myRole === "OWNER";

  const fetchQueue = useCallback(async () => {
    if (!canInvite) return;
    setQueueLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/invites`);
      if (res.ok) setInviteQueue(await res.json());
    } finally {
      setQueueLoading(false);
    }
  }, [workspace.id, canInvite]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  async function handleInvite() {
    if (!selectedUser) return;
    setInviteBusy(true);
    setInviteError("");
    setInviteOk("");
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/invite`, {
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
      const res = await fetch(`/api/workspaces/${workspace.id}/members/${userId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setInviteError(d.error ?? "Failed to remove member");
        return;
      }
      // Refresh member list in-place; sidebar will pick up the change
      window.dispatchEvent(new CustomEvent("workspace-list-changed"));
      await onRefresh();
    } finally {
      setRemovingId(null);
    }
  }

  async function handleRescind(inviteId: string) {
    setRescindingId(inviteId);
    try {
      await fetch(`/api/workspaces/${workspace.id}/invites/${inviteId}`, { method: "DELETE" });
      await fetchQueue();
    } finally {
      setRescindingId(null);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    setChangingRoleId(userId);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/members/${userId}`, {
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

  const activeMembers = workspace.members;

  return (
    <div className="space-y-5">
      {/* Member list */}
      <div>
        <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">
          Members · {activeMembers.length}
        </p>
        <div className="space-y-1">
          {activeMembers.map((m) => {
            const isSelf    = m.user.id === currentUserId;
            const isTarget  = m.role === "OWNER";
            const canRemove = !isSelf && !isTarget && canInvite;
            const canRole   = isOwner && !isTarget && !isSelf;

            return (
              <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gray-800/40">
                <div className="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-semibold text-gray-300">
                    {memberDisplayName(m)[0].toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">
                    {memberDisplayName(m)}
                    {isSelf && <span className="text-[10px] text-gray-500 ml-1">(you)</span>}
                  </p>
                  {m.user.username && (
                    <p className="text-[10px] text-gray-500">@{m.user.username}</p>
                  )}
                </div>

                {/* Role selector for OWNER */}
                {canRole ? (
                  <select
                    value={m.role}
                    disabled={changingRoleId === m.user.id}
                    onChange={(e) => handleRoleChange(m.user.id, e.target.value)}
                    className="bg-gray-700 border-0 rounded-lg text-xs text-gray-300 px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                  >
                    <option value="ADMIN">Admin</option>
                    <option value="MEMBER">Member</option>
                    <option value="VIEWER">Viewer</option>
                  </select>
                ) : (
                  <span className="flex items-center gap-1 text-[10px] text-gray-400 shrink-0">
                    {ROLE_ICONS[m.role] ?? null}
                    {ROLE_LABELS[m.role] ?? m.role}
                  </span>
                )}

                {canRemove && (
                  <button
                    onClick={() => handleRemove(m.user.id)}
                    disabled={removingId === m.user.id}
                    className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
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
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">Invite</p>
          <div className="space-y-2">
            {selectedUser ? (
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 border border-blue-500/30">
                  <div className="w-6 h-6 rounded-full bg-blue-600/20 flex items-center justify-center shrink-0">
                    <span className="text-[10px] font-semibold text-blue-400">
                      {userDisplayName(selectedUser)[0].toUpperCase()}
                    </span>
                  </div>
                  <p className="text-sm text-white flex-1 truncate">{userDisplayName(selectedUser)}</p>
                  <button onClick={() => { setSelectedUser(null); setInviteError(""); setInviteOk(""); }}
                    className="p-0.5 text-gray-500 hover:text-white">
                    <X size={13} />
                  </button>
                </div>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-xl text-xs text-gray-300 px-2 py-2.5 focus:outline-none"
                >
                  <option value="ADMIN">Admin</option>
                  <option value="MEMBER">Member</option>
                  <option value="VIEWER">Viewer</option>
                </select>
                <button
                  onClick={handleInvite}
                  disabled={inviteBusy}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                >
                  {inviteBusy ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
                  Send
                </button>
              </div>
            ) : (
              <UserSearchInput
                workspaceId={workspace.id}
                onSelect={(u) => { setSelectedUser(u); setInviteError(""); setInviteOk(""); }}
              />
            )}
            {inviteError && <p className="text-xs text-red-400">{inviteError}</p>}
            {inviteOk    && <p className="text-xs text-green-400">{inviteOk}</p>}
          </div>
        </div>
      )}

      {/* Pending invites */}
      {canInvite && (
        <div>
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">
            Pending invites {queueLoading && <Loader2 size={9} className="inline animate-spin ml-1" />}
          </p>
          {inviteQueue.length === 0 ? (
            <p className="text-xs text-gray-600 px-1">No pending invites</p>
          ) : (
            <div className="space-y-1">
              {inviteQueue.map((inv) => (
                <div key={inv.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-gray-800/40">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{userDisplayName(inv.invitedUser as UserResult)}</p>
                    <p className="text-[10px] text-gray-500">{ROLE_LABELS[inv.role] ?? inv.role} · sent {formatDate(inv.createdAt)}</p>
                  </div>
                  <button
                    onClick={() => handleRescind(inv.id)}
                    disabled={rescindingId === inv.id}
                    className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
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

// ─── Tab: Goals ───────────────────────────────────────────────────────────────

function GoalsTab({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage:   boolean;
}) {
  const [goals,        setGoals]        = useState<Goal[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [showForm,     setShowForm]     = useState(false);
  const [editingGoal,  setEditingGoal]  = useState<Goal | null>(null);
  const [deletingId,   setDeletingId]   = useState<string | null>(null);

  // Form state
  const [fName,         setFName]         = useState("");
  const [fAmount,       setFAmount]       = useState("");
  const [fDate,         setFDate]         = useState("");
  const [fCategory,     setFCategory]     = useState("GENERAL");
  const [fDescription,  setFDescription]  = useState("");
  const [fBusy,         setFBusy]         = useState(false);
  const [fError,        setFError]        = useState("");

  const loadGoals = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/goals`);
    if (res.ok) setGoals(await res.json());
    setLoading(false);
  }, [workspaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadGoals(); }, [loadGoals]);

  function openCreate() {
    setEditingGoal(null);
    setFName(""); setFAmount(""); setFDate(""); setFCategory("GENERAL"); setFDescription(""); setFError("");
    setShowForm(true);
  }

  function openEdit(g: Goal) {
    setEditingGoal(g);
    setFName(g.name);
    setFAmount(String(g.targetAmount));
    setFDate(g.targetDate ? g.targetDate.split("T")[0] : "");
    setFCategory(g.category);
    setFDescription(g.description ?? "");
    setFError("");
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!fName.trim() || !fAmount) { setFError("Name and target are required."); return; }
    setFBusy(true);
    setFError("");
    try {
      const url    = editingGoal
        ? `/api/workspaces/${workspaceId}/goals/${editingGoal.id}`
        : `/api/workspaces/${workspaceId}/goals`;
      const method = editingGoal ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:         fName.trim(),
          description:  fDescription.trim() || null,
          category:     fCategory,
          targetAmount: parseFloat(fAmount),
          targetDate:   fDate || null,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setFError(d.error ?? "Failed to save");
      } else {
        setShowForm(false);
        loadGoals();
      }
    } catch { setFError("Network error"); }
    finally { setFBusy(false); }
  }

  async function handleDelete(goalId: string) {
    setDeletingId(goalId);
    try {
      await fetch(`/api/workspaces/${workspaceId}/goals/${goalId}`, { method: "DELETE" });
      loadGoals();
    } finally {
      setDeletingId(null);
    }
  }

  async function markComplete(g: Goal) {
    await fetch(`/api/workspaces/${workspaceId}/goals/${g.id}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ status: g.status === "COMPLETED" ? "ACTIVE" : "COMPLETED" }),
    });
    loadGoals();
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-gray-600" /></div>;
  }

  if (showForm) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <button onClick={() => setShowForm(false)} className="p-1 rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors">
            <X size={15} />
          </button>
          <p className="text-sm font-semibold text-white">{editingGoal ? "Edit goal" : "New goal"}</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1">Name</label>
            <input value={fName} onChange={(e) => setFName(e.target.value)}
              placeholder="Emergency fund" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1">Category</label>
            <select value={fCategory} onChange={(e) => setFCategory(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500">
              {Object.entries(GOAL_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1">Target amount</label>
            <input type="number" min="1" step="1" value={fAmount} onChange={(e) => setFAmount(e.target.value)}
              placeholder="10000" className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1">Target date <span className="text-gray-600">(optional)</span></label>
            <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1">Description <span className="text-gray-600">(optional)</span></label>
            <textarea rows={2} value={fDescription} onChange={(e) => setFDescription(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none" />
          </div>
          {fError && <p className="text-xs text-red-400">{fError}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowForm(false)}
              className="flex-1 px-4 py-2.5 rounded-xl border border-gray-700 text-sm text-gray-400 hover:text-white transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={fBusy}
              className="flex-1 px-4 py-2.5 rounded-xl bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
              {fBusy ? <Loader2 size={14} className="animate-spin" /> : null}
              {editingGoal ? "Save" : "Create goal"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  const active    = goals.filter((g) => g.status === "ACTIVE" || g.status === "PAUSED");
  const completed = goals.filter((g) => g.status === "COMPLETED");

  return (
    <div className="space-y-4">
      {goals.length === 0 ? (
        <div className="text-center py-8">
          <Target size={28} className="text-gray-700 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No goals yet</p>
          {canManage && <p className="text-xs text-gray-600 mt-1">Add a financial goal to start tracking progress.</p>}
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <div className="space-y-2">
              {active.map((g) => {
                const pct      = Math.min(100, g.targetAmount > 0 ? (g.currentAmount / g.targetAmount) * 100 : 0);
                const isOverdue = g.targetDate && new Date(g.targetDate) < new Date();
                return (
                  <div key={g.id} className="bg-gray-800/40 rounded-xl px-3 py-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <button onClick={() => markComplete(g)} title="Mark complete" className="shrink-0">
                          <Circle size={14} className="text-blue-400" />
                        </button>
                        <p className="text-sm font-medium text-white truncate">{g.name}</p>
                        {isOverdue && <AlertCircle size={12} className="text-red-400 shrink-0" />}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {canManage && (
                          <>
                            <button onClick={() => openEdit(g)}
                              className="p-1 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-gray-700 transition-colors">
                              <Pencil size={12} />
                            </button>
                            <button onClick={() => handleDelete(g.id)} disabled={deletingId === g.id}
                              className="p-1 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors">
                              {deletingId === g.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${pct >= 100 ? "bg-green-500" : isOverdue ? "bg-red-500" : "bg-blue-500"}`}
                        style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-gray-500">{formatBalance(g.currentAmount)} of {formatBalance(g.targetAmount)}</p>
                      <div className="flex items-center gap-2">
                        {g.targetDate && (
                          <p className={`text-[10px] flex items-center gap-1 ${isOverdue ? "text-red-400" : "text-gray-500"}`}>
                            <Calendar size={9} />{formatDate(g.targetDate)}
                          </p>
                        )}
                        <p className="text-[10px] text-gray-600">{pct.toFixed(0)}%</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {completed.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">Completed</p>
              <div className="space-y-1">
                {completed.map((g) => (
                  <div key={g.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-gray-800/30">
                    <button onClick={() => markComplete(g)} title="Mark active" className="shrink-0">
                      <CheckCircle2 size={14} className="text-green-500" />
                    </button>
                    <p className="text-sm text-gray-400 flex-1 truncate">{g.name}</p>
                    <p className="text-xs text-green-400 shrink-0">{formatBalance(g.targetAmount)}</p>
                    {canManage && (
                      <button onClick={() => handleDelete(g.id)} disabled={deletingId === g.id}
                        className="p-1 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors">
                        {deletingId === g.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {canManage && (
        <button onClick={openCreate}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-gray-700 text-sm text-gray-500 hover:text-white hover:border-gray-500 transition-colors">
          <Plus size={14} /> Add a goal
        </button>
      )}
    </div>
  );
}

// ─── Tab: Finances (account sharing) ─────────────────────────────────────────

function FinancesTab({
  workspaceId,
  myRole,
}: {
  workspaceId: string;
  myRole:      string;
}) {
  const [accounts,       setAccounts]       = useState<SharedAccount[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [showPanel,      setShowPanel]      = useState(false);
  const [myAccounts,     setMyAccounts]     = useState<UserAccount[]>([]);
  const [myAccLoading,   setMyAccLoading]   = useState(false);
  const [sharingId,      setSharingId]      = useState<string | null>(null);
  const [shareVis,       setShareVis]       = useState<"FULL" | "BALANCE_ONLY">("FULL");
  const [shareBusy,      setShareBusy]      = useState(false);
  const [shareError,     setShareError]     = useState("");
  const [revokingId,     setRevokingId]     = useState<string | null>(null);

  const canShare = ["OWNER", "ADMIN", "MEMBER"].includes(myRole);

  const loadAccounts = useCallback(() => {
    setLoading(true);
    fetch(`/api/workspaces/${workspaceId}/accounts`)
      .then((r) => r.ok ? r.json() : [])
      .then((data: SharedAccount[]) => { setAccounts(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [workspaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  async function openSharePanel() {
    setShowPanel(true);
    setSharingId(null);
    setShareError("");
    setMyAccLoading(true);
    try {
      const res = await fetch("/api/accounts");
      if (res.ok) setMyAccounts(await res.json());
    } finally {
      setMyAccLoading(false);
    }
  }

  async function handleShare(accountId: string) {
    setShareBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/accounts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financialAccountId: accountId, visibilityLevel: shareVis }),
      });
      if (!res.ok) { const d = await res.json(); setShareError(d.error ?? "Failed"); }
      else {
        // Stay on the share panel — reset to a fresh state so the next account starts clean
        setSharingId(null);
        setShareVis("FULL");
        setShareError("");
        loadAccounts();
        // Notify WorkspaceDashboard to refresh its account list
        window.dispatchEvent(new CustomEvent("workspace-accounts-changed"));
      }
    } catch { setShareError("Network error"); }
    finally { setShareBusy(false); }
  }

  async function handleRevoke(accountId: string) {
    setRevokingId(accountId);
    try {
      await fetch(`/api/workspaces/${workspaceId}/accounts/share`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financialAccountId: accountId }),
      });
      loadAccounts();
      window.dispatchEvent(new CustomEvent("workspace-accounts-changed"));
    } finally {
      setRevokingId(null);
    }
  }

  const sharedIds = new Set(accounts.map((a) => a.id));

  if (loading) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-gray-600" /></div>;

  if (showPanel) {
    const available = myAccounts.filter((a) => !sharedIds.has(a.id));
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button onClick={() => setShowPanel(false)} className="p-1 rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors">
            <X size={15} />
          </button>
          <p className="text-sm font-semibold text-white">Share an account</p>
        </div>
        {myAccLoading ? (
          <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-gray-600" /></div>
        ) : available.length === 0 ? (
          <div className="text-center py-8">
            <Landmark size={26} className="text-gray-700 mx-auto mb-2" />
            <p className="text-sm text-gray-500">No accounts available to share</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {available.map((a) => {
              const isSelected = sharingId === a.id;
              return (
                <div key={a.id} className={`rounded-xl border transition-colors ${isSelected ? "border-blue-500/40 bg-blue-600/5" : "border-gray-700 bg-gray-800/40"}`}>
                  <button type="button" onClick={() => setSharingId(isSelected ? null : a.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{a.name}</p>
                      <p className="text-xs text-gray-500 truncate">{a.institution}{(a as UserAccount).mask ? ` ···${(a as UserAccount).mask}` : ""}</p>
                    </div>
                    <p className="text-sm font-medium text-white shrink-0 mr-1">{formatBalance(a.balance, a.currency)}</p>
                    <ChevronRight size={13} className={`text-gray-600 shrink-0 transition-transform ${isSelected ? "rotate-90" : ""}`} />
                  </button>
                  {isSelected && (
                    <div className="px-3 pb-3 space-y-2.5 border-t border-gray-700/50">
                      <p className="text-xs text-gray-500 pt-2">Visibility for Space members:</p>
                      {(["FULL", "BALANCE_ONLY"] as const).map((vis) => (
                        <button key={vis} type="button" onClick={() => setShareVis(vis)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-colors ${shareVis === vis ? "border-blue-500/40 bg-blue-600/10" : "border-gray-700 hover:border-gray-600"}`}>
                          <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${shareVis === vis ? "border-blue-500 bg-blue-500" : "border-gray-600"}`} />
                          <div>
                            <p className="text-xs font-medium text-white">{vis === "FULL" ? "Full access" : "Balance only"}</p>
                            <p className="text-[10px] text-gray-500">{vis === "FULL" ? "Name, institution, and balance" : "Balance total only"}</p>
                          </div>
                        </button>
                      ))}
                      {shareError && <p className="text-xs text-red-400">{shareError}</p>}
                      <button onClick={() => handleShare(a.id)} disabled={shareBusy}
                        className="w-full px-3 py-2 rounded-xl bg-blue-600 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
                        {shareBusy ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
                        Share into Space
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const grouped = accounts.reduce<Record<string, SharedAccount[]>>((acc, a) => {
    (acc[a.type] ??= []).push(a);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {accounts.length === 0 ? (
        <div className="text-center py-6">
          <Landmark size={28} className="text-gray-700 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No accounts shared</p>
          {canShare && <p className="text-xs text-gray-600 mt-1">Share an account to include it in this Space.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type}>
              <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1.5">
                {ACCOUNT_TYPE_LABELS[type] ?? type}
              </p>
              <div className="space-y-1">
                {items.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-gray-800/40 group">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{a.name}</p>
                      <p className="text-xs text-gray-500 truncate">{a.institution}</p>
                    </div>
                    <p className="text-sm font-medium text-white shrink-0">{formatBalance(a.balance, a.currency)}</p>
                    {canShare && (
                      <button onClick={() => handleRevoke(a.id)} disabled={revokingId === a.id}
                        className="p-1 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 disabled:opacity-50 transition-all"
                        title="Remove from Space">
                        {revokingId === a.id ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {canShare && (
        <button onClick={openSharePanel}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-gray-700 text-sm text-gray-500 hover:text-white hover:border-gray-500 transition-colors">
          <Share2 size={14} /> Share an account
        </button>
      )}
    </div>
  );
}

// ─── Tab: Dashboard (sections) ────────────────────────────────────────────────

function DashboardTab({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const [sections,   setSections]   = useState<DashboardSection[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const loadSections = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/sections`);
    if (res.ok) setSections(await res.json());
    setLoading(false);
  }, [workspaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadSections(); }, [loadSections]);

  async function toggle(s: DashboardSection) {
    setTogglingId(s.id);
    try {
      await fetch(`/api/workspaces/${workspaceId}/sections/${s.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ enabled: !s.enabled }),
      });
      loadSections();
    } finally {
      setTogglingId(null);
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-gray-600" /></div>;

  if (sections.length === 0) {
    return (
      <div className="text-center py-8">
        <LayoutDashboard size={28} className="text-gray-700 mx-auto mb-2" />
        <p className="text-sm text-gray-500">No dashboard sections</p>
        <p className="text-xs text-gray-600 mt-1">This Space was created without a template.</p>
      </div>
    );
  }

  const byTab = sections.reduce<Record<string, DashboardSection[]>>((acc, s) => {
    (acc[s.tab] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-500">Toggle sections to show or hide them. Changes apply to all members.</p>
      {Object.entries(byTab).map(([tab, items]) => (
        <div key={tab}>
          <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-2">
            {TAB_LABELS_SECTION[tab] ?? tab}
          </p>
          <div className="space-y-1">
            {items.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gray-800/40">
                <div className="flex-1 min-w-0">
                  <p className={`text-sm truncate ${s.enabled ? "text-white" : "text-gray-500"}`}>{s.label}</p>
                </div>
                <button onClick={() => toggle(s)} disabled={togglingId === s.id}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    s.enabled
                      ? "bg-blue-600/20 text-blue-400 hover:bg-blue-600/30"
                      : "bg-gray-700 text-gray-500 hover:bg-gray-600"
                  }`}>
                  {togglingId === s.id
                    ? <Loader2 size={11} className="animate-spin" />
                    : s.enabled ? <><Eye size={11} /> Shown</> : <><EyeOff size={11} /> Hidden</>}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Tab: Danger Zone ─────────────────────────────────────────────────────────
//
// Archive and Move to trash are the only destructive-ish actions surfaced
// here, and both are reversible. A real, irreversible delete
// (db.workspace.delete) only exists at app/api/workspaces/[id]/permanent —
// and that route only accepts workspaces that are already trashed, so it is
// intentionally not reachable from this modal. It's only ever offered from
// the Archive & Trash page (/dashboard/settings/archive), once a workspace
// is already sitting in trash. This is also the single entry point for
// owner-initiated destructive actions — the old per-card "Delete workspace"
// shortcut in WorkspacesClient's WorkspaceDetail modal has been removed so
// there's exactly one place owners go for this.
function DangerZoneTab({
  workspace,
  myRole,
  currentUserId,
  onClose,
  onRefresh,
  onDeleted,
}: {
  workspace:     WorkspaceDetail;
  myRole:        string;
  currentUserId: string;
  onClose:       () => void;
  onRefresh:     () => void;
  onDeleted?:    () => void;
}) {
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [archiveBusy,  setArchiveBusy]  = useState(false);
  const [trashBusy,    setTrashBusy]    = useState(false);
  const [leaveBusy,    setLeaveBusy]    = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  const isOwner = myRole === "OWNER";

  async function handleLeave() {
    setLeaveBusy(true);
    await fetch(`/api/workspaces/${workspace.id}/members/${currentUserId}`, { method: "DELETE" });
    onRefresh();
    onClose();
  }

  async function handleArchive() {
    setArchiveBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ archivedAt: new Date().toISOString() }),
      });
      if (res.ok) {
        onDeleted?.(); // it leaves the active list the same way a trashed workspace does
        onRefresh();
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to archive Space.");
      }
    } finally {
      setArchiveBusy(false);
    }
  }

  async function handleTrash() {
    setTrashBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}`, { method: "DELETE" });
      if (res.ok) {
        onDeleted?.();
        onRefresh();
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to move Space to trash.");
        setConfirmTrash(false);
      }
    } finally {
      setTrashBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {!isOwner && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
          <p className="text-xs font-semibold text-red-400 uppercase tracking-widest">Leave Space</p>
          <div className="space-y-1.5">
            <p className="text-xs text-gray-400">
              You will be removed from <span className="text-white font-medium">{workspace.name}</span> and lose access immediately.
            </p>
            <ul className="space-y-1">
              {[
                "You won't see this Space in your sidebar.",
                "Any accounts you shared here remain — the Space owner still has access to them.",
                "You can only rejoin if an owner sends you a new invite.",
              ].map((line) => (
                <li key={line} className="flex items-start gap-1.5 text-xs text-gray-500">
                  <span className="mt-0.5 shrink-0 w-1 h-1 rounded-full bg-gray-600 translate-y-1" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <button onClick={handleLeave} disabled={leaveBusy}
            className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50">
            {leaveBusy ? <Loader2 size={14} className="animate-spin" /> : <UserMinus size={14} />}
            Leave Space
          </button>
        </div>
      )}

      {isOwner && (
        <>
          <div className="rounded-2xl border border-gray-700 bg-gray-800/40 p-4 space-y-3">
            <p className="text-xs font-semibold text-gray-300 uppercase tracking-widest">Archive Space</p>
            <p className="text-xs text-gray-400">
              Hide <span className="text-white font-medium">{workspace.name}</span> from your active Space list. Members, shared accounts, and history all stay intact — unarchive it any time from the Archive &amp; Trash page.
            </p>
            <button onClick={handleArchive} disabled={archiveBusy}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-gray-300 hover:bg-gray-700/60 transition-colors disabled:opacity-50">
              {archiveBusy ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
              Archive Space
            </button>
          </div>

          <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
            <p className="text-xs font-semibold text-red-400 uppercase tracking-widest">Move to trash</p>
            <p className="text-xs text-gray-400">
              Move <span className="text-white font-medium">{workspace.name}</span> to trash. It&apos;s hidden from active use but can still be restored from the Archive &amp; Trash page until it&apos;s permanently deleted there.
            </p>
            {!confirmTrash ? (
              <button onClick={() => setConfirmTrash(true)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-red-400 hover:bg-red-500/10 transition-colors">
                <Trash2 size={14} /> Move to trash
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-gray-300">Move this Space to trash?</p>
                <div className="flex gap-2">
                  <button onClick={() => setConfirmTrash(false)}
                    className="flex-1 px-3 py-2 rounded-xl border border-gray-700 text-xs text-gray-400 hover:text-white transition-colors">
                    Cancel
                  </button>
                  <button onClick={handleTrash} disabled={trashBusy}
                    className="flex-1 px-3 py-2 rounded-xl bg-red-600 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
                    {trashBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    Move to trash
                  </button>
                </div>
              </div>
            )}
          </div>

          <p className="text-[11px] text-gray-600 px-1">
            Permanent deletion is only available from the Archive &amp; Trash page, and only once this Space is already in trash.
          </p>
        </>
      )}

      {error && (
        <p className="text-xs text-red-400 flex items-center gap-1.5 px-1">
          <AlertTriangle size={11} /> {error}
        </p>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

type ManageTab = "general" | "members" | "goals" | "finances" | "dashboard" | "danger";

export function ManageWorkspaceModal({
  workspaceId,
  workspaceName,
  myRole,
  currentUserId,
  onClose,
  onRefresh,
  onDeleted,
}: Props) {
  const isOwner   = myRole === "OWNER";
  const canManage = ["OWNER", "ADMIN"].includes(myRole);
  const canEdit   = isOwner;

  // "general" is only visible to OWNERs — default to "members" for everyone else
  const [activeTab, setActiveTab] = useState<ManageTab>(canEdit ? "general" : "members");
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [loading,   setLoading]   = useState(true);

  const loadWorkspace = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}`);
    if (res.ok) {
      const data = await res.json();
      setWorkspace(data);
    }
    setLoading(false);
  }, [workspaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadWorkspace(); }, [loadWorkspace]);

  // Close on backdrop click
  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  const allTabs: { id: ManageTab; label: string; icon: React.ReactNode; show: boolean }[] = [
    { id: "general",   label: "General",     icon: <Settings    size={14} />, show: canEdit },
    { id: "members",   label: "Members",     icon: <Users       size={14} />, show: true },
    { id: "goals",     label: "Goals",       icon: <Target      size={14} />, show: false },
    { id: "finances",  label: "Add Accounts", icon: <Landmark    size={14} />, show: true },
    { id: "dashboard", label: "Dashboard",   icon: <LayoutDashboard size={14} />, show: canManage },
    { id: "danger",    label: isOwner ? "Danger Zone" : "Leave", icon: <AlertTriangle size={14} />, show: true },
  ];
  const tabs = allTabs.filter((t) => t.show);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center px-4 bg-black/60 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="w-full sm:max-w-lg bg-gray-900 border border-gray-700 rounded-3xl shadow-2xl flex flex-col max-h-[88dvh]">
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-800 shrink-0">
          <div>
            <p className="text-base font-semibold text-white truncate">{workspaceName}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {ROLE_LABELS[myRole] ?? myRole} · Manage Space
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-gray-500 hover:text-white hover:bg-gray-800 transition-colors shrink-0"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-0.5 px-4 py-2 border-b border-gray-800 overflow-x-auto scrollbar-hide shrink-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-colors shrink-0 ${
                activeTab === t.id
                  ? t.id === "danger"
                    ? "bg-red-600/20 text-red-400"
                    : "bg-gray-700 text-white"
                  : t.id === "danger"
                    ? "text-red-500/60 hover:text-red-400"
                    : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 size={22} className="animate-spin text-gray-600" />
            </div>
          ) : !workspace ? (
            <div className="text-center py-12">
              <p className="text-sm text-gray-500">Could not load Space</p>
            </div>
          ) : (
            <>
              {activeTab === "general"   && canEdit   && (
                <GeneralTab
                  workspace={workspace}
                  onSaved={(updated) => {
                    setWorkspace((prev) => prev ? { ...prev, ...updated } : prev);
                    onRefresh();
                  }}
                />
              )}
              {activeTab === "members"              && (
                <MembersTab
                  workspace={workspace}
                  myRole={myRole}
                  currentUserId={currentUserId}
                  onRefresh={loadWorkspace}
                />
              )}
              {activeTab === "goals"    && canManage && (
                <GoalsTab workspaceId={workspaceId} canManage={canManage} />
              )}
              {activeTab === "finances"             && (
                <FinancesTab workspaceId={workspaceId} myRole={myRole} />
              )}
              {activeTab === "dashboard" && canManage && (
                <DashboardTab workspaceId={workspaceId} />
              )}
              {activeTab === "danger"               && (
                <DangerZoneTab
                  workspace={workspace}
                  myRole={myRole}
                  currentUserId={currentUserId}
                  onClose={onClose}
                  onRefresh={onRefresh}
                  onDeleted={onDeleted}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
