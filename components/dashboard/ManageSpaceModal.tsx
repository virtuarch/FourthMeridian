"use client";

/**
 * ManageSpaceModal
 *
 * Full space management panel. Rendered through the shared Atlas Glass modal
 * primitive (FormModal → OverlaySurface) per the Modal Doctrine Phase 3
 * (migration 3.3, retires recipe R3): the tab bar lives in the primitive's
 * toolbar slot and the tab content is its scrolling body; portal, focus-trap,
 * body-scroll-lock, panel height cap, and named z-scale come from the
 * primitive. Backdrop/Escape close (unchanged, always allowed here).
 * Tabs: General · Members · Goals · Finances · Overview · Delete/Leave Space
 *
 * The last tab is the single entry point for owner-initiated archive/trash
 * actions, or member-initiated leave (see DangerZoneTab below) —
 * SpacesClient's separate SpaceDetail modal no longer duplicates a
 * delete control. Labeled "Delete Space" for owners and "Leave Space" for
 * everyone else — deliberately plain account-management language, not
 * security-warning language (the internal tab id/type stays "danger" since
 * that's just an identifier, not anything user-facing).
 *
 * Permission gating mirrors the server:
 *   OWNER  — all tabs + actions
 *   ADMIN  — Members (invite/remove non-owners), Goals, Finances, Overview
 *   MEMBER — Finances (share own accounts only), no management tabs
 *   VIEWER — read only, no management tabs
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";
import {
  X, Settings, Users, Target, Landmark, LayoutDashboard,
  AlertTriangle, Loader2, Crown, Shield, Eye, EyeOff,
  UserMinus, Trash2, Mail, Plus, Check, Globe, Lock,
  Share2, Search, ChevronRight, AlertCircle, Calendar,
  CheckCircle2, Circle, Pencil, Save, Archive, LogOut,
} from "lucide-react";
import {
  CATEGORY_LABELS, CATEGORY_ICONS,
  PRIMARY_CATEGORIES, SECONDARY_CATEGORIES,
  SpaceCategory,
} from "@/lib/space-presets";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { formatDate as formatDateUTC, displaySpaceName } from "@/lib/format";
import {
  SPACE_LIST_CHANGED_EVENT,
  SPACE_ACCOUNTS_CHANGED_EVENT,
} from "@/lib/space-nav";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { GlassButton } from "@/components/atlas/GlassButton";
import { FormModal } from "@/components/atlas/FormModal";

// ─── Types ─────────────────────────────────────────────────────────────────────

type Member = {
  id: string;
  role: string;
  joinedAt: string;
  user: { id: string; name: string | null; username: string | null; email: string | null };
};

type SpaceDetail = {
  id:          string;
  name:        string;
  description: string | null;
  type:        string;
  category:    string;
  isPublic:    boolean;
  /** MC1 Phase 4 Slice 2 — authoritative reporting currency (present on the GET include). */
  reportingCurrency?: string;
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

// Exported (along with userDisplayName and UserSearchInput below) so the
// Create Space onboarding flow's Invite step (CreateSpaceModal.tsx) can
// reuse the exact same search-and-select UI and types instead of
// duplicating them — same component, two mount points.
export type UserResult = {
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
  spaceId:   string;
  spaceName: string;
  myRole:        string;
  currentUserId: string;
  onClose:       () => void;
  onRefresh:     () => void;
  onDeleted?:    () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ROLE_ICONS: Record<string, React.ReactNode> = {
  OWNER:  <Crown  size={11} className="text-[var(--brass-400)]" />,
  ADMIN:  <Shield size={11} className="text-[var(--meridian-400)]"   />,
  MEMBER: <Users  size={11} className="text-[var(--text-secondary)]"   />,
  VIEWER: <Eye    size={11} className="text-[var(--text-muted)]"   />,
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

export function userDisplayName(u: UserResult) {
  if (u.name) return u.name;
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return full || u.username || "Unknown";
}

// ─── User Search ───────────────────────────────────────────────────────────────

export function UserSearchInput({
  spaceId,
  onSelect,
}: {
  spaceId: string;
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
      const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}&exclude=${spaceId}`);
      const data = await res.json();
      setResults(data);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

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
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => query.length >= 1 && results.length > 0 && setOpen(true)}
          placeholder="Search by name or @username…"
          className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl pl-8 pr-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--meridian-400)] transition-colors"
        />
        {loading && <Loader2 size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] animate-spin" />}
      </div>
      {/* Results popup: deliberately rendered as opaque/"thick" glass rather
          than the --surface-muted token the search field itself uses —
          --surface-muted is only a ~5% tint (by design, so inputs read as a
          subtle recess in the panel behind them), which made this dropdown
          nearly see-through against the modal's own backdrop. A floating
          menu needs to read as solid above everything behind it, so this
          uses GlassPanel's "thick" depth (the same opaque recipe the modal
          sheets themselves use) plus a stronger hairline and elevated
          shadow, lifted to z-30 to clear any sibling content in this
          modal's stacking context. */}
      {open && results.length > 0 && (
        <GlassPanel
          depth="thick"
          elevation="e3"
          radius="md"
          className="absolute z-30 w-full mt-1.5 overflow-hidden"
          style={{ border: "1px solid var(--border-hairline-strong)" }}
        >
          {results.map((u) => (
            <button
              key={u.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); handleSelect(u); }}
              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-[var(--surface-hover-strong)] transition-colors text-left"
            >
              <div className="w-7 h-7 rounded-full bg-[var(--surface-hover-strong)] flex items-center justify-center shrink-0">
                <span className="text-[10px] font-semibold text-[var(--text-primary)]">{userDisplayName(u)[0].toUpperCase()}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--text-primary)] truncate">{userDisplayName(u)}</p>
                {u.username && <p className="text-xs text-[var(--text-muted)]">@{u.username}</p>}
              </div>
            </button>
          ))}
        </GlassPanel>
      )}
      {open && !loading && query.length >= 1 && results.length === 0 && (
        <GlassPanel
          depth="thick"
          elevation="e3"
          radius="md"
          className="absolute z-30 w-full mt-1.5 px-3 py-3"
          style={{ border: "1px solid var(--border-hairline-strong)" }}
        >
          <p className="text-sm text-[var(--text-muted)]">No users found for &ldquo;{query}&rdquo;</p>
        </GlassPanel>
      )}
    </div>
  );
}

// ─── Tab: General ──────────────────────────────────────────────────────────────

function GeneralTab({
  space,
  onSaved,
}: {
  space: SpaceDetail;
  onSaved: (updated: Partial<SpaceDetail>) => void;
}) {
  const [name,        setName]        = useState(space.name);
  const [description, setDescription] = useState(space.description ?? "");
  const [isPublic,    setIsPublic]    = useState(space.isPublic);
  const [category,    setCategory]    = useState(space.category);
  // MC1 Phase 4 Slice 2 (plan D-2) — Space reporting-currency selector.
  const [reportingCurrency, setReportingCurrency] = useState(space.reportingCurrency ?? "USD");
  const settingsRouter = useRouter();
  const currencyChanged = reportingCurrency !== (space.reportingCurrency ?? "USD");
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
      const res = await fetch(`/api/spaces/${space.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          name:        name.trim(),
          description: description.trim() || null,
          isPublic,
          category,
          // MC1 P4 Slice 2 — only sent when changed (audit stays quiet otherwise)
          ...(currencyChanged ? { reportingCurrency } : {}),
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to save");
      } else {
        onSaved({ name: name.trim(), description: description.trim() || null, isPublic, category, reportingCurrency });
        // MC1 P4 Slice 2 — a currency change re-denominates every aggregate
        // at read time; refresh the current view so converted totals and the
        // display-currency provider pick it up immediately.
        if (currencyChanged) settingsRouter.refresh();
        // Sidebar caches its Space list client-side and only refetches on this
        // event — without it, a rename here (e.g. fixing legacy "X's Dashboard"
        // grammar) would update the page but leave the sidebar showing the old
        // stale name until a full reload.
        window.dispatchEvent(new CustomEvent(SPACE_LIST_CHANGED_EVENT));
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { setError("Network error"); }
    finally { setBusy(false); }
  }

  const isDirty =
    name.trim()       !== space.name ||
    (description.trim() || null) !== space.description ||
    isPublic          !== space.isPublic ||
    category          !== space.category ||
    currencyChanged;

  return (
    <div className="space-y-5">
      {/* Name */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">Space name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--meridian-400)] transition-colors"
        />
      </div>

      {/* Description */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">
          Description <span className="text-[var(--text-muted)]">(optional)</span>
        </label>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this Space for?"
          className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--meridian-400)] transition-colors resize-none"
        />
      </div>

      {/* Visibility */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">Visibility</label>
        <div className="grid grid-cols-2 gap-2">
          {([false, true] as const).map((pub) => (
            <button
              key={String(pub)}
              type="button"
              onClick={() => setIsPublic(pub)}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                isPublic === pub
                  ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]"
                  : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)]"
              }`}
            >
              <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-colors ${
                isPublic === pub ? "border-[var(--meridian-400)] bg-[var(--meridian-400)]" : "border-[var(--border-hairline-strong)]"
              }`} />
              <div>
                <p className="text-xs font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                  {pub ? <Globe size={11} /> : <Lock size={11} />}
                  {pub ? "Public" : "Private"}
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">
                  {pub ? "Anyone can view" : "Invite only"}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Category */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">Category</label>
        <button
          type="button"
          onClick={() => setShowCatPicker((p) => !p)}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] text-left transition-colors"
        >
          <span className="text-[var(--text-muted)]">{ICON_MAP[CATEGORY_ICONS[category as SpaceCategory]] ?? <Settings size={16} />}</span>
          <span className="text-sm text-[var(--text-primary)] flex-1">{CATEGORY_LABELS[category as SpaceCategory] ?? category}</span>
          <ChevronRight size={13} className={`text-[var(--text-muted)] transition-transform ${showCatPicker ? "rotate-90" : ""}`} />
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
                    ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]"
                    : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] bg-[var(--surface-muted)]"
                }`}
              >
                <span className="text-[var(--text-muted)] shrink-0">{ICON_MAP[CATEGORY_ICONS[cat]] ?? <Settings size={14} />}</span>
                <span className="text-xs text-[var(--text-primary)] truncate">{CATEGORY_LABELS[cat]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Reporting currency — MC1 Phase 4 Slice 2 (plan D-2) */}
      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1.5">Reporting currency</label>
        <select
          value={reportingCurrency}
          onChange={(e) => setReportingCurrency(e.target.value)}
          className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--meridian-400)] transition-colors"
        >
          {[FX_BASE, ...SUPPORTED_QUOTES].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
          Totals, charts, and AI summaries for this Space are shown in this currency.
        </p>
        {currencyChanged && (
          <div className="mt-2 px-3 py-2.5 rounded-xl border border-[rgba(255,196,87,.35)] bg-[rgba(255,196,87,.08)]">
            <p className="text-xs text-[var(--text-primary)]">
              Totals, charts, and AI summaries will show {reportingCurrency} from now on.
              Past history keeps the currency it was recorded in — nothing is converted or rewritten.
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}

      <GlassButton
        onClick={handleSave}
        disabled={busy || !isDirty}
        tone="meridian"
        fullWidth
      >
        {busy
          ? <Loader2 size={14} className="animate-spin" />
          : saved
            ? <Check size={14} />
            : <Save size={14} />}
        {saved ? "Saved!" : "Save changes"}
      </GlassButton>
    </div>
  );
}

// ─── Tab: Members ─────────────────────────────────────────────────────────────

function MembersTab({
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
  // matching GeneralTab/DangerZoneTab's convention elsewhere in this file).
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

  const canInvite = ["OWNER", "ADMIN"].includes(myRole);
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

// ─── Tab: Goals ───────────────────────────────────────────────────────────────

function GoalsTab({
  spaceId,
  canManage,
}: {
  spaceId: string;
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
    const res = await fetch(`/api/spaces/${spaceId}/goals`);
    if (res.ok) setGoals(await res.json());
    setLoading(false);
  }, [spaceId]);

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
        ? `/api/spaces/${spaceId}/goals/${editingGoal.id}`
        : `/api/spaces/${spaceId}/goals`;
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
      await fetch(`/api/spaces/${spaceId}/goals/${goalId}`, { method: "DELETE" });
      loadGoals();
    } finally {
      setDeletingId(null);
    }
  }

  async function markComplete(g: Goal) {
    await fetch(`/api/spaces/${spaceId}/goals/${g.id}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ status: g.status === "COMPLETED" ? "ACTIVE" : "COMPLETED" }),
    });
    loadGoals();
  }

  if (loading) {
    return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-muted)]" /></div>;
  }

  if (showForm) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <button onClick={() => setShowForm(false)} className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors">
            <X size={15} />
          </button>
          <p className="text-sm font-semibold text-[var(--text-primary)]">{editingGoal ? "Edit goal" : "New goal"}</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Name</label>
            <input value={fName} onChange={(e) => setFName(e.target.value)}
              placeholder="Emergency fund" className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--meridian-400)]" />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Category</label>
            <select value={fCategory} onChange={(e) => setFCategory(e.target.value)}
              className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--meridian-400)]">
              {Object.entries(GOAL_CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Target amount</label>
            <input type="number" min="1" step="1" value={fAmount} onChange={(e) => setFAmount(e.target.value)}
              placeholder="10000" className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--meridian-400)]" />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Target date <span className="text-[var(--text-muted)]">(optional)</span></label>
            <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)}
              className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--meridian-400)]" />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] block mb-1">Description <span className="text-[var(--text-muted)]">(optional)</span></label>
            <textarea rows={2} value={fDescription} onChange={(e) => setFDescription(e.target.value)}
              className="w-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--meridian-400)] resize-none" />
          </div>
          {fError && <p className="text-xs text-[var(--coral-400)]">{fError}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowForm(false)}
              className="flex-1 px-4 py-2.5 rounded-xl border border-[var(--border-hairline)] text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
              Cancel
            </button>
            <GlassButton type="submit" disabled={fBusy} tone="meridian" fullWidth>
              {fBusy ? <Loader2 size={14} className="animate-spin" /> : null}
              {editingGoal ? "Save" : "Create goal"}
            </GlassButton>
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
          <Target size={28} className="text-[var(--text-muted)] mx-auto mb-2" />
          <p className="text-sm text-[var(--text-muted)]">No goals yet</p>
          {canManage && <p className="text-xs text-[var(--text-muted)] mt-1">Add a financial goal to start tracking progress.</p>}
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <div className="space-y-2">
              {active.map((g) => {
                const pct      = Math.min(100, g.targetAmount > 0 ? (g.currentAmount / g.targetAmount) * 100 : 0);
                const isOverdue = g.targetDate && new Date(g.targetDate) < new Date();
                return (
                  <div key={g.id} className="bg-[var(--surface-muted)] rounded-xl px-3 py-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <button onClick={() => markComplete(g)} title="Mark complete" className="shrink-0">
                          <Circle size={14} className="text-[var(--meridian-400)]" />
                        </button>
                        <p className="text-sm font-medium text-[var(--text-primary)] truncate">{g.name}</p>
                        {isOverdue && <AlertCircle size={12} className="text-[var(--coral-400)] shrink-0" />}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {canManage && (
                          <>
                            <button onClick={() => openEdit(g)}
                              className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover-strong)] transition-colors">
                              <Pencil size={12} />
                            </button>
                            <button onClick={() => handleDelete(g.id)} disabled={deletingId === g.id}
                              className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--coral-400)] hover:bg-[rgba(237,82,71,.10)] disabled:opacity-50 transition-colors">
                              {deletingId === g.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="h-1.5 bg-[var(--surface-hover-strong)] rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${pct >= 100 ? "bg-[var(--emerald-500)]" : isOverdue ? "bg-[var(--coral-500)]" : "bg-[var(--meridian-400)]"}`}
                        style={{ width: `${pct}%` }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] text-[var(--text-muted)]">{formatBalance(g.currentAmount)} of {formatBalance(g.targetAmount)}</p>
                      <div className="flex items-center gap-2">
                        {g.targetDate && (
                          <p className={`text-[10px] flex items-center gap-1 ${isOverdue ? "text-[var(--coral-400)]" : "text-[var(--text-muted)]"}`}>
                            <Calendar size={9} />{formatDate(g.targetDate)}
                          </p>
                        )}
                        <p className="text-[10px] text-[var(--text-muted)]">{pct.toFixed(0)}%</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {completed.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">Completed</p>
              <div className="space-y-1">
                {completed.map((g) => (
                  <div key={g.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[var(--surface-muted)]">
                    <button onClick={() => markComplete(g)} title="Mark active" className="shrink-0">
                      <CheckCircle2 size={14} className="text-[var(--emerald-500)]" />
                    </button>
                    <p className="text-sm text-[var(--text-secondary)] flex-1 truncate">{g.name}</p>
                    <p className="text-xs text-[var(--emerald-400)] shrink-0">{formatBalance(g.targetAmount)}</p>
                    {canManage && (
                      <button onClick={() => handleDelete(g.id)} disabled={deletingId === g.id}
                        className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--coral-400)] hover:bg-[rgba(237,82,71,.10)] disabled:opacity-50 transition-colors">
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
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-[var(--border-hairline)] text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-hairline-strong)] transition-colors">
          <Plus size={14} /> Add a goal
        </button>
      )}
    </div>
  );
}

// ─── Tab: Finances (account sharing) ─────────────────────────────────────────

/**
 * ShareExistingAccountsPanel
 *
 * Lets a member move/share an account they already own (from their global
 * `/api/accounts` list) into a given Space. This is the single source of
 * truth for "add an existing account to this Space" — it backs both the
 * Finances tab's "Share an account" panel below AND the Create Space
 * onboarding flow's "Add existing accounts" step (CreateSpaceModal.tsx).
 * Fetches its own "already shared" exclusion list so it's drop-in reusable
 * with nothing but a spaceId — no duplicated account-sharing logic.
 */
export function ShareExistingAccountsPanel({
  spaceId,
  onShared,
}: {
  spaceId: string;
  onShared?: (accountId: string) => void;
}) {
  const [myAccounts, setMyAccounts] = useState<UserAccount[]>([]);
  const [sharedIds,  setSharedIds]  = useState<Set<string>>(new Set());
  const [loading,    setLoading]    = useState(true);
  const [sharingId,  setSharingId]  = useState<string | null>(null);
  const [shareVis,   setShareVis]   = useState<"FULL" | "BALANCE_ONLY">("FULL");
  const [shareBusy,  setShareBusy]  = useState(false);
  const [shareError, setShareError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mineRes, sharedRes] = await Promise.all([
        fetch("/api/accounts"),
        fetch(`/api/spaces/${spaceId}/accounts`),
      ]);
      if (mineRes.ok) setMyAccounts(await mineRes.json());
      if (sharedRes.ok) {
        const shared: SharedAccount[] = await sharedRes.json();
        setSharedIds(new Set(shared.map((a) => a.id)));
      }
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  async function handleShare(accountId: string) {
    setShareBusy(true);
    try {
      const res = await fetch(`/api/spaces/${spaceId}/accounts/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financialAccountId: accountId, visibilityLevel: shareVis }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setShareError(d.error ?? "Failed"); }
      else {
        setSharingId(null);
        setShareVis("FULL");
        setShareError("");
        setSharedIds((prev) => new Set(prev).add(accountId));
        // Notify SpaceDashboard (and any other listeners) to refresh its account list
        window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
        onShared?.(accountId);
      }
    } catch { setShareError("Network error"); }
    finally { setShareBusy(false); }
  }

  const available = myAccounts.filter((a) => !sharedIds.has(a.id));

  if (loading) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-muted)]" /></div>;

  if (available.length === 0) {
    return (
      <div className="text-center py-8">
        <Landmark size={26} className="text-[var(--text-muted)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No accounts available to add</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {available.map((a) => {
        const isSelected = sharingId === a.id;
        return (
          <div key={a.id} className={`rounded-xl border transition-colors ${isSelected ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.05)]" : "border-[var(--border-hairline)] bg-[var(--surface-muted)]"}`}>
            <button type="button" onClick={() => setSharingId(isSelected ? null : a.id)}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[var(--text-primary)] truncate">{a.name}</p>
                <p className="text-xs text-[var(--text-muted)] truncate">{a.institution}{a.mask ? ` ···${a.mask}` : ""}</p>
              </div>
              <p className="text-sm font-medium text-[var(--text-primary)] shrink-0 mr-1">{formatBalance(a.balance, a.currency)}</p>
              <ChevronRight size={13} className={`text-[var(--text-muted)] shrink-0 transition-transform ${isSelected ? "rotate-90" : ""}`} />
            </button>
            {isSelected && (
              <div className="px-3 pb-3 space-y-2.5 border-t border-[var(--border-hairline)]">
                <p className="text-xs text-[var(--text-muted)] pt-2">Visibility for Space members:</p>
                {(["FULL", "BALANCE_ONLY"] as const).map((vis) => (
                  <button key={vis} type="button" onClick={() => setShareVis(vis)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-colors ${shareVis === vis ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]" : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)]"}`}>
                    <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${shareVis === vis ? "border-[var(--meridian-400)] bg-[var(--meridian-400)]" : "border-[var(--border-hairline-strong)]"}`} />
                    <div>
                      <p className="text-xs font-medium text-[var(--text-primary)]">{vis === "FULL" ? "Full access" : "Balance only"}</p>
                      <p className="text-[10px] text-[var(--text-muted)]">{vis === "FULL" ? "Name, institution, and balance" : "Balance total only"}</p>
                    </div>
                  </button>
                ))}
                {shareError && <p className="text-xs text-[var(--coral-400)]">{shareError}</p>}
                <GlassButton onClick={() => handleShare(a.id)} disabled={shareBusy} tone="meridian" size="sm" fullWidth>
                  {shareBusy ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
                  Share into Space
                </GlassButton>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FinancesTab({
  spaceId,
  myRole,
  onRefresh,
}: {
  spaceId: string;
  myRole:      string;
  // The real top-level ManageSpaceModal.onRefresh — previously never
  // threaded into this tab at all, which is why sharing/revoking an asset
  // from /dashboard/spaces never updated the Space card/totals there.
  onRefresh:   () => void | Promise<void>;
}) {
  const [accounts,       setAccounts]       = useState<SharedAccount[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [showPanel,      setShowPanel]      = useState(false);
  const [revokingId,     setRevokingId]     = useState<string | null>(null);

  const canShare = ["OWNER", "ADMIN", "MEMBER"].includes(myRole);

  const loadAccounts = useCallback(() => {
    setLoading(true);
    fetch(`/api/spaces/${spaceId}/accounts`)
      .then((r) => r.ok ? r.json() : [])
      .then((data: SharedAccount[]) => { setAccounts(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [spaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  async function handleRevoke(accountId: string) {
    setRevokingId(accountId);
    try {
      await fetch(`/api/spaces/${spaceId}/accounts/share`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financialAccountId: accountId }),
      });
      loadAccounts();
      window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
      // Notify the hosting page directly — same gap as MembersTab had:
      // the event above only reaches SpaceDashboard's listener.
      await onRefresh();
    } finally {
      setRevokingId(null);
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-muted)]" /></div>;

  if (showPanel) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button onClick={() => setShowPanel(false)} className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-muted)] transition-colors">
            <X size={15} />
          </button>
          <p className="text-sm font-semibold text-[var(--text-primary)]">Share an account</p>
        </div>
        <ShareExistingAccountsPanel
          spaceId={spaceId}
          onShared={() => { loadAccounts(); onRefresh(); }}
        />
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
          <Landmark size={28} className="text-[var(--text-muted)] mx-auto mb-2" />
          <p className="text-sm text-[var(--text-muted)]">No accounts shared</p>
          {canShare && <p className="text-xs text-[var(--text-muted)] mt-1">Share an account to include it in this Space.</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type}>
              <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-1.5">
                {ACCOUNT_TYPE_LABELS[type] ?? type}
              </p>
              <div className="space-y-1">
                {items.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-[var(--surface-muted)] group">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[var(--text-primary)] truncate">{a.name}</p>
                      <p className="text-xs text-[var(--text-muted)] truncate">{a.institution}</p>
                    </div>
                    <p className="text-sm font-medium text-[var(--text-primary)] shrink-0">{formatBalance(a.balance, a.currency)}</p>
                    {canShare && (
                      <button onClick={() => handleRevoke(a.id)} disabled={revokingId === a.id}
                        className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--coral-400)] hover:bg-[rgba(237,82,71,.10)] opacity-0 group-hover:opacity-100 disabled:opacity-50 transition-all"
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
        <button onClick={() => setShowPanel(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-[var(--border-hairline)] text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-hairline-strong)] transition-colors">
          <Share2 size={14} /> Share an account
        </button>
      )}
    </div>
  );
}

// ─── Tab: Dashboard (sections) ────────────────────────────────────────────────

function DashboardTab({
  spaceId,
}: {
  spaceId: string;
}) {
  const [sections,   setSections]   = useState<DashboardSection[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const loadSections = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}/sections`);
    if (res.ok) setSections(await res.json());
    setLoading(false);
  }, [spaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadSections(); }, [loadSections]);

  async function toggle(s: DashboardSection) {
    setTogglingId(s.id);
    try {
      await fetch(`/api/spaces/${spaceId}/sections/${s.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ enabled: !s.enabled }),
      });
      loadSections();
    } finally {
      setTogglingId(null);
    }
  }

  if (loading) return <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-[var(--text-muted)]" /></div>;

  if (sections.length === 0) {
    return (
      <div className="text-center py-8">
        <LayoutDashboard size={28} className="text-[var(--text-muted)] mx-auto mb-2" />
        <p className="text-sm text-[var(--text-muted)]">No dashboard sections</p>
        <p className="text-xs text-[var(--text-muted)] mt-1">This Space was created without a template.</p>
      </div>
    );
  }

  const byTab = sections.reduce<Record<string, DashboardSection[]>>((acc, s) => {
    (acc[s.tab] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <p className="text-xs text-[var(--text-muted)]">Toggle sections to show or hide them. Changes apply to all members.</p>
      {Object.entries(byTab).map(([tab, items]) => (
        <div key={tab}>
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest mb-2">
            {TAB_LABELS_SECTION[tab] ?? tab}
          </p>
          <div className="space-y-1">
            {items.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[var(--surface-muted)]">
                <div className="flex-1 min-w-0">
                  <p className={`text-sm truncate ${s.enabled ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}>{s.label}</p>
                </div>
                <button onClick={() => toggle(s)} disabled={togglingId === s.id}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    s.enabled
                      ? "bg-[rgba(59,130,246,.20)] text-[var(--meridian-400)] hover:bg-[rgba(59,130,246,.30)]"
                      : "bg-[var(--surface-hover-strong)] text-[var(--text-muted)] hover:bg-[var(--surface-hover-strong)]"
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
// (db.space.delete) only exists at app/api/spaces/[id]/permanent —
// and that route only accepts spaces that are already trashed, so it is
// intentionally not reachable from this modal. It's only ever offered from
// the Archive & Trash page (/dashboard/settings/archive), once a space
// is already sitting in trash. This is also the single entry point for
// owner-initiated destructive actions — the old per-card "Delete space"
// shortcut in SpacesClient's SpaceDetail modal has been removed so
// there's exactly one place owners go for this.
function DangerZoneTab({
  space,
  myRole,
  currentUserId,
  onClose,
  onRefresh,
  onDeleted,
}: {
  space:     SpaceDetail;
  myRole:        string;
  currentUserId: string;
  onClose:       () => void;
  onRefresh:     () => void;
  onDeleted?:    () => void;
}) {
  const router = useRouter();
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [archiveBusy,  setArchiveBusy]  = useState(false);
  const [trashBusy,    setTrashBusy]    = useState(false);
  const [leaveBusy,    setLeaveBusy]    = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  const isOwner = myRole === "OWNER";

  async function handleLeave() {
    setLeaveBusy(true);
    try {
      const res = await fetch(`/api/spaces/${space.id}/members/${currentUserId}`, { method: "DELETE" });
      if (res.ok) {
        onRefresh();
        onClose();
        router.push(`/dashboard/spaces?left=${encodeURIComponent(displaySpaceName(space.name))}`);
      }
    } finally {
      setLeaveBusy(false);
    }
  }

  async function handleArchive() {
    setArchiveBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/spaces/${space.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ archivedAt: new Date().toISOString() }),
      });
      if (res.ok) {
        onDeleted?.(); // it leaves the active list the same way a trashed space does
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
      const res = await fetch(`/api/spaces/${space.id}`, { method: "DELETE" });
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
        <GlassPanel depth="thin" elevation="e1" radius="lg" glow="coral" className="block">
          <div className="p-4 space-y-3">
            <p className="text-xs font-semibold text-[var(--coral-400)] uppercase tracking-widest">Leave Space</p>
            <div className="space-y-1.5">
              <p className="text-xs text-[var(--text-secondary)]">
                You will be removed from <span className="text-[var(--text-primary)] font-medium">{displaySpaceName(space.name)}</span> and lose access immediately.
              </p>
              <ul className="space-y-1">
                {[
                  "You won't see this Space in your sidebar.",
                  "Any accounts you shared into this Space will be removed from the Space when you leave.",
                  "You can only rejoin if an owner sends you a new invite.",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]">
                    <span className="mt-0.5 shrink-0 w-1 h-1 rounded-full bg-[var(--surface-hover-strong)] translate-y-1" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <GlassButton onClick={handleLeave} disabled={leaveBusy} tone="danger" size="sm">
              {leaveBusy ? <Loader2 size={14} className="animate-spin" /> : <UserMinus size={14} />}
              Leave Space
            </GlassButton>
          </div>
        </GlassPanel>
      )}

      {isOwner && (
        <>
          <GlassPanel depth="thin" elevation="e1" radius="lg" className="block">
            <div className="p-4 space-y-3">
              <p className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-widest">Archive Space</p>
              <p className="text-xs text-[var(--text-secondary)]">
                Hide <span className="text-[var(--text-primary)] font-medium">{displaySpaceName(space.name)}</span> from your active Space list. Members, shared accounts, and history all stay intact — unarchive it any time from the Archive &amp; Trash page.
              </p>
              <GlassButton onClick={handleArchive} disabled={archiveBusy} tone="neutral" size="sm">
                {archiveBusy ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
                Archive Space
              </GlassButton>
            </div>
          </GlassPanel>

          <GlassPanel depth="thin" elevation="e1" radius="lg" glow="coral" className="block">
            <div className="p-4 space-y-3">
              <p className="text-xs font-semibold text-[var(--coral-400)] uppercase tracking-widest">Delete Space</p>
              <p className="text-xs text-[var(--text-secondary)]">
                Move <span className="text-[var(--text-primary)] font-medium">{displaySpaceName(space.name)}</span> to trash. It&apos;s hidden from active use but can still be restored from the Archive &amp; Trash page until it&apos;s permanently deleted there.
              </p>
              {!confirmTrash ? (
                <GlassButton onClick={() => setConfirmTrash(true)} tone="danger" size="sm">
                  <Trash2 size={14} /> Move to trash
                </GlassButton>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-[var(--text-secondary)]">Move this Space to trash?</p>
                  <div className="flex gap-2">
                    <GlassButton onClick={() => setConfirmTrash(false)} tone="neutral" size="sm" fullWidth>
                      Cancel
                    </GlassButton>
                    <GlassButton onClick={handleTrash} disabled={trashBusy} tone="danger" size="sm" fullWidth>
                      {trashBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                      Move to trash
                    </GlassButton>
                  </div>
                </div>
              )}
            </div>
          </GlassPanel>

          <p className="text-[11px] text-[var(--text-muted)] px-1">
            Permanent deletion is only available from the Archive &amp; Trash page, and only once this Space is already in trash.
          </p>
        </>
      )}

      {error && (
        <p className="text-xs text-[var(--coral-400)] flex items-center gap-1.5 px-1">
          <AlertTriangle size={11} /> {error}
        </p>
      )}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

type ManageTab = "general" | "members" | "goals" | "finances" | "dashboard" | "danger";

export function ManageSpaceModal({
  spaceId,
  spaceName,
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
  const [space, setSpace] = useState<SpaceDetail | null>(null);
  const [loading,   setLoading]   = useState(true);

  const loadSpace = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}`);
    if (res.ok) {
      const data = await res.json();
      setSpace(data);
    }
    setLoading(false);
  }, [spaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadSpace(); }, [loadSpace]);

  const allTabs: { id: ManageTab; label: string; icon: React.ReactNode; show: boolean }[] = [
    { id: "general",   label: "General",     icon: <Settings    size={14} />, show: canEdit },
    { id: "members",   label: "Members",     icon: <Users       size={14} />, show: true },
    { id: "goals",     label: "Goals",       icon: <Target      size={14} />, show: false },
    { id: "finances",  label: "Add Accounts", icon: <Landmark    size={14} />, show: true },
    { id: "dashboard", label: "Overview",    icon: <LayoutDashboard size={14} />, show: canManage },
    { id: "danger",    label: isOwner ? "Delete Space" : "Leave Space", icon: isOwner ? <Trash2 size={14} /> : <LogOut size={14} />, show: true },
  ];
  const tabs = allTabs.filter((t) => t.show);

  return (
    <FormModal
      open
      onClose={onClose}
      title={displaySpaceName(spaceName)}
      subtitle={`${ROLE_LABELS[myRole] ?? myRole} · Manage Space`}
      size="md"
      toolbar={
        <div className="flex gap-0.5 overflow-x-auto scrollbar-hide">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium whitespace-nowrap transition-colors shrink-0 ${
                activeTab === t.id
                  ? t.id === "danger"
                    ? "bg-[rgba(237,82,71,.16)] text-[var(--coral-400)]"
                    : "bg-[var(--surface-hover-strong)] text-[var(--text-primary)]"
                  : t.id === "danger"
                    ? "text-[rgba(237,82,71,.6)] hover:text-[var(--coral-400)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 size={22} className="animate-spin text-[var(--text-muted)]" />
        </div>
      ) : !space ? (
        <div className="text-center py-12">
          <p className="text-sm text-[var(--text-muted)]">Could not load Space</p>
        </div>
      ) : (
        <>
          {activeTab === "general"   && canEdit   && (
            <GeneralTab
              space={space}
              onSaved={(updated) => {
                setSpace((prev) => prev ? { ...prev, ...updated } : prev);
                onRefresh();
              }}
            />
          )}
          {activeTab === "members"              && (
            <MembersTab
              space={space}
              myRole={myRole}
              currentUserId={currentUserId}
              reloadSpace={loadSpace}
              onRefresh={onRefresh}
            />
          )}
          {activeTab === "goals"    && canManage && (
            <GoalsTab spaceId={spaceId} canManage={canManage} />
          )}
          {activeTab === "finances"             && (
            <FinancesTab spaceId={spaceId} myRole={myRole} onRefresh={onRefresh} />
          )}
          {activeTab === "dashboard" && canManage && (
            <DashboardTab spaceId={spaceId} />
          )}
          {activeTab === "danger"               && (
            <DangerZoneTab
              space={space}
              myRole={myRole}
              currentUserId={currentUserId}
              onClose={onClose}
              onRefresh={onRefresh}
              onDeleted={onDeleted}
            />
          )}
        </>
      )}
    </FormModal>
  );
}
