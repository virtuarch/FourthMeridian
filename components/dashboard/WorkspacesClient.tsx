"use client";

import { useState, useTransition, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  Building2, Globe, Lock, Plus, Users, Crown,
  Shield, Eye, UserMinus, X, Check, ChevronRight,
  Mail, Loader2, Trash2, Search, Layers, ArrowRightLeft,
  Landmark, Home, Briefcase, Car, Plane, TrendingUp,
  Wrench, CreditCard, Target, LayoutDashboard,
  MoreHorizontal, Sunset, ArrowLeft, ArrowRight,
  Share2, Pencil,
} from "lucide-react";
import {
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_ICONS,
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  getPresetsForCategory,
  WorkspaceCategory,
} from "@/lib/workspace-presets";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// Only opened from the "Manage" action inside an already-open workspace card —
// not needed for the initial render, so split it out of the main client
// bundle for this route instead of bundling it for every visitor.
const ManageWorkspaceModal = dynamic(
  () => import("@/components/dashboard/ManageWorkspaceModal").then((m) => m.ManageWorkspaceModal),
  { ssr: false }
);

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
  category?: string;
  isPublic: boolean;
  createdAt: string;
  members: Member[];
  myRole?: string | null;
  accountCount?: number;
};

type Invite = {
  id: string;
  role: string;
  createdAt: string;
  seenAt:    string | null;
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

type WorkspaceAccount = {
  id: string;
  name: string;
  type: string;
  institution: string;
  balance: number;
  currency: string;
  lastUpdated: string;
};

interface Props {
  mine: Workspace[];
  publicWorkspaces: Workspace[];
  pendingInvites: Invite[];
  currentUserId: string;
  activeWorkspaceId: string | null;
  preferredWorkspaceId: string | null;
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

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking:   "Checking",
  savings:    "Savings",
  investment: "Investment",
  crypto:     "Crypto",
  debt:       "Debt",
  other:      "Other",
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
  const shown = members.slice(0, 3);
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

function formatBalance(balance: number, currency = DEFAULT_DISPLAY_CURRENCY) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(balance);
}

// ─── Category icon resolver ───────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ReactNode> = {
  User:             <Users      size={18} />,
  Home:             <Home       size={18} />,
  Users:            <Users      size={18} />,
  Briefcase:        <Briefcase  size={18} />,
  Building2:        <Building2  size={18} />,
  Car:              <Car        size={18} />,
  Plane:            <Plane      size={18} />,
  TrendingUp:       <TrendingUp size={18} />,
  Wrench:           <Wrench     size={18} />,
  Sunset:           <Sunset     size={18} />,
  CreditCard:       <CreditCard size={18} />,
  Shield:           <Shield     size={18} />,
  Target:           <Target     size={18} />,
  LayoutDashboard:  <LayoutDashboard size={18} />,
  MoreHorizontal:   <MoreHorizontal size={18} />,
};

function CategoryIcon({ name, size = 18 }: { name: string; size?: number }) {
  const el = ICON_MAP[name];
  if (!el) return <LayoutDashboard size={size} />;
  return <>{el}</>;
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

// ─── Create Workspace Modal (multi-step) ─────────────────────────────────────

type CreateStep = "name" | "visibility" | "template";

function CreateWorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step,        setStep]        = useState<CreateStep>("name");
  const [name,        setName]        = useState("");
  const [description, setDescription] = useState("");
  const [isPublic,    setIsPublic]    = useState(false);
  const [category,    setCategory]    = useState<WorkspaceCategory | null>(null);
  const [showAll,     setShowAll]     = useState(false);
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState("");

  const STEP_ORDER: CreateStep[] = ["name", "visibility", "template"];
  const stepIdx = STEP_ORDER.indexOf(step);

  function goNext() {
    if (step === "name")       { if (!name.trim()) { setError("Name is required"); return; } setError(""); setStep("visibility"); }
    if (step === "visibility") { setError(""); setStep("template"); }
  }
  function goBack() {
    if (step === "visibility") setStep("name");
    if (step === "template")   setStep("visibility");
  }

  const allTemplates = [...PRIMARY_CATEGORIES, ...SECONDARY_CATEGORIES];
  const visibleCategories = showAll ? allTemplates : PRIMARY_CATEGORIES;

  const previewSections = category ? getPresetsForCategory(category) : [];

  async function handleCreate() {
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/workspaces", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          name:        name.trim(),
          description: description.trim() || undefined,
          isPublic,
          category:    category ?? WorkspaceCategory.OTHER,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to create");
      } else {
        window.dispatchEvent(new CustomEvent("workspace-list-changed"));
        onCreated();
        onClose();
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  const STEP_LABELS = ["Details", "Visibility", "Template"];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl shadow-2xl flex flex-col max-h-[88dvh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-white">New Workspace</h2>
            {/* Step dots */}
            <div className="flex items-center gap-2 mt-1.5">
              {STEP_LABELS.map((label, i) => (
                <div key={label} className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full transition-colors ${
                    i === stepIdx ? "bg-blue-400" : i < stepIdx ? "bg-gray-500" : "bg-gray-700"
                  }`} />
                  <span className={`text-[10px] transition-colors ${
                    i === stepIdx ? "text-blue-400" : i < stepIdx ? "text-gray-500" : "text-gray-700"
                  }`}>{label}</span>
                </div>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl text-gray-500 hover:text-white hover:bg-gray-800 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">

          {/* ── Step 1: Name + Description ─────────────────────────────── */}
          {step === "name" && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-gray-400 mb-1.5 block">Workspace name</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => { setName(e.target.value); setError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && goNext()}
                  placeholder="e.g. Smith Family, Atlanta Duplex, Retirement"
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
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          )}

          {/* ── Step 2: Visibility ─────────────────────────────────────── */}
          {step === "visibility" && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500 mb-4">Who can see this workspace?</p>
              {[false, true].map((pub) => (
                <button
                  key={String(pub)}
                  type="button"
                  onClick={() => setIsPublic(pub)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl border transition-colors ${
                    isPublic === pub
                      ? "border-blue-500/50 bg-blue-600/10"
                      : "border-gray-700 bg-gray-800/50 hover:border-gray-600"
                  }`}
                >
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                    isPublic === pub ? "bg-blue-600/20" : "bg-gray-700"
                  }`}>
                    {pub
                      ? <Globe size={16} className={isPublic === pub ? "text-blue-400" : "text-gray-400"} />
                      : <Lock  size={16} className={isPublic === pub ? "text-blue-400" : "text-gray-400"} />}
                  </div>
                  <div className="flex-1 text-left">
                    <p className={`text-sm font-medium ${isPublic === pub ? "text-white" : "text-gray-300"}`}>
                      {pub ? "Public" : "Private"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {pub
                        ? "Listed publicly — anyone on FinTracker can see it"
                        : "Only visible to members you invite"}
                    </p>
                  </div>
                  <div className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                    isPublic === pub ? "border-blue-500 bg-blue-500" : "border-gray-600"
                  }`} />
                </button>
              ))}
            </div>
          )}

          {/* ── Step 3: Template ───────────────────────────────────────── */}
          {step === "template" && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500">
                Choose a template to get default dashboard sections. You can customize them after.
              </p>

              {/* Category grid */}
              <div className="grid grid-cols-2 gap-2">
                {visibleCategories.map((cat) => {
                  const iconName = CATEGORY_ICONS[cat];
                  const selected = category === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setCategory(selected ? null : cat)}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                        selected
                          ? "border-blue-500/50 bg-blue-600/10"
                          : "border-gray-700 bg-gray-800/50 hover:border-gray-600 hover:bg-gray-800"
                      }`}
                    >
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                        selected ? "bg-blue-600/20 text-blue-400" : "bg-gray-700 text-gray-400"
                      }`}>
                        <CategoryIcon name={iconName} size={14} />
                      </div>
                      <div className="min-w-0">
                        <p className={`text-xs font-medium truncate ${selected ? "text-white" : "text-gray-300"}`}>
                          {CATEGORY_LABELS[cat]}
                        </p>
                      </div>
                      {selected && <Check size={12} className="text-blue-400 shrink-0 ml-auto" />}
                    </button>
                  );
                })}
              </div>

              {/* Show more / less */}
              <button
                type="button"
                onClick={() => setShowAll((p) => !p)}
                className="w-full text-xs text-gray-500 hover:text-gray-300 py-1 transition-colors"
              >
                {showAll ? "Show fewer options" : "Show more templates →"}
              </button>

              {/* Section preview */}
              {category && (
                <div className="rounded-2xl border border-gray-700 bg-gray-800/30 p-3">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-2">
                    {CATEGORY_LABELS[category]} · {previewSections.length} default sections
                  </p>
                  <p className="text-xs text-gray-600 mb-2">{CATEGORY_DESCRIPTIONS[category]}</p>
                  <div className="space-y-1">
                    {previewSections.slice(0, 8).map((s) => (
                      <div key={s.key} className="flex items-center gap-2 text-xs">
                        <div className="w-1.5 h-1.5 rounded-full bg-gray-600 shrink-0" />
                        <span className="text-gray-400">{s.label}</span>
                        <span className="text-gray-700 ml-auto text-[10px]">{s.tab.replace("_", " ")}</span>
                      </div>
                    ))}
                    {previewSections.length > 8 && (
                      <p className="text-[10px] text-gray-600 pl-3">
                        +{previewSections.length - 8} more
                      </p>
                    )}
                  </div>
                </div>
              )}

              {!category && (
                <p className="text-xs text-gray-600 text-center py-2">
                  Skip selection to start with a blank workspace, or pick a template above.
                </p>
              )}

              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div className="px-5 pb-6 sm:pb-5 pt-3 border-t border-gray-800 shrink-0 flex gap-2">
          {step !== "name" ? (
            <button
              type="button"
              onClick={goBack}
              className="px-4 py-2.5 rounded-xl border border-gray-700 text-sm text-gray-400 hover:text-white hover:border-gray-500 transition-colors flex items-center gap-1.5"
            >
              <ArrowLeft size={14} />
              Back
            </button>
          ) : (
            <button type="button" onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-gray-700 text-sm text-gray-400 hover:text-white hover:border-gray-500 transition-colors">
              Cancel
            </button>
          )}

          {step !== "template" ? (
            <button
              type="button"
              onClick={goNext}
              disabled={step === "name" && !name.trim()}
              className="flex-1 px-4 py-2.5 rounded-xl bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              Next
              <ArrowRight size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy}
              className="flex-1 px-4 py-2.5 rounded-xl bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create Workspace
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Accounts Tab Content ─────────────────────────────────────────────────────

type UserAccount = WorkspaceAccount & { mask?: string | null };

function WorkspaceAccountsTab({
  workspaceId,
  myRole,
}: {
  workspaceId: string;
  myRole: string;
}) {
  const [accounts,       setAccounts]       = useState<WorkspaceAccount[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [error,          setError]          = useState("");
  const [showSharePanel, setShowSharePanel] = useState(false);
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
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load");
        return r.json();
      })
      .then((data: WorkspaceAccount[]) => { setAccounts(data); setLoading(false); })
      .catch(() => { setError("Could not load accounts"); setLoading(false); });
  }, [workspaceId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  async function openSharePanel() {
    setShowSharePanel(true);
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
    setShareError("");
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/accounts/share`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ financialAccountId: accountId, visibilityLevel: shareVis }),
      });
      if (!res.ok) {
        const d = await res.json();
        setShareError(d.error ?? "Failed to share");
      } else {
        setSharingId(null);
        setShowSharePanel(false);
        loadAccounts();
      }
    } catch { setShareError("Network error"); }
    finally { setShareBusy(false); }
  }

  async function handleRevoke(accountId: string) {
    setRevokingId(accountId);
    try {
      await fetch(`/api/workspaces/${workspaceId}/accounts/share`, {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ financialAccountId: accountId }),
      });
      loadAccounts();
    } finally {
      setRevokingId(null);
    }
  }

  // Already-shared account IDs (to avoid showing in share panel)
  const sharedIds = new Set(accounts.map((a) => a.id));

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 size={18} className="animate-spin text-gray-600" />
      </div>
    );
  }

  if (error) return <p className="text-sm text-red-400 py-4 text-center">{error}</p>;

  // Group shared accounts by type
  const grouped = accounts.reduce<Record<string, WorkspaceAccount[]>>((acc, a) => {
    (acc[a.type] ??= []).push(a);
    return acc;
  }, {});

  // ── Share panel overlay ────────────────────────────────────────────────────
  if (showSharePanel) {
    const available = myAccounts.filter((a) => !sharedIds.has(a.id));
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowSharePanel(false); setSharingId(null); }}
            className="p-1 rounded-lg text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <ArrowLeft size={15} />
          </button>
          <p className="text-sm font-semibold text-white">Share an Account</p>
        </div>

        {myAccLoading && (
          <div className="flex justify-center py-6">
            <Loader2 size={16} className="animate-spin text-gray-600" />
          </div>
        )}

        {!myAccLoading && available.length === 0 && (
          <div className="text-center py-8">
            <Landmark size={26} className="text-gray-700 mx-auto mb-2" />
            <p className="text-sm text-gray-500">No accounts available to share</p>
            <p className="text-xs text-gray-600 mt-1">All your accounts are already in this workspace.</p>
          </div>
        )}

        {!myAccLoading && available.length > 0 && (
          <div className="space-y-1.5">
            {available.map((a) => {
              const isSelected = sharingId === a.id;
              return (
                <div key={a.id} className={`rounded-xl border transition-colors ${
                  isSelected ? "border-blue-500/40 bg-blue-600/5" : "border-gray-700 bg-gray-800/40"
                }`}>
                  <button
                    type="button"
                    onClick={() => setSharingId(isSelected ? null : a.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{a.name}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {a.institution}{a.mask ? ` ···${a.mask}` : ""}
                      </p>
                    </div>
                    <p className="text-sm font-medium text-white shrink-0 mr-1">
                      {formatBalance(a.balance, a.currency)}
                    </p>
                    <ChevronRight size={13} className={`text-gray-600 shrink-0 transition-transform ${isSelected ? "rotate-90" : ""}`} />
                  </button>

                  {isSelected && (
                    <div className="px-3 pb-3 pt-0 space-y-2.5 border-t border-gray-700/50 mt-0">
                      <p className="text-xs text-gray-500 pt-2">Visibility for workspace members:</p>

                      {(["FULL", "BALANCE_ONLY"] as const).map((vis) => (
                        <button
                          key={vis}
                          type="button"
                          onClick={() => setShareVis(vis)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-colors ${
                            shareVis === vis
                              ? "border-blue-500/40 bg-blue-600/10"
                              : "border-gray-700 hover:border-gray-600"
                          }`}
                        >
                          <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
                            shareVis === vis ? "border-blue-500 bg-blue-500" : "border-gray-600"
                          }`} />
                          <div>
                            <p className="text-xs font-medium text-white">
                              {vis === "FULL" ? "Full access" : "Balance only"}
                            </p>
                            <p className="text-[10px] text-gray-500">
                              {vis === "FULL"
                                ? "Name, institution, and balance visible"
                                : "Only the balance total is shown"}
                            </p>
                          </div>
                        </button>
                      ))}

                      {shareError && <p className="text-xs text-red-400">{shareError}</p>}

                      <button
                        onClick={() => handleShare(a.id)}
                        disabled={shareBusy}
                        className="w-full px-3 py-2 rounded-xl bg-blue-600 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
                      >
                        {shareBusy
                          ? <Loader2 size={12} className="animate-spin" />
                          : <Share2 size={12} />}
                        Share into workspace
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

  // ── Main accounts view ─────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {accounts.length === 0 ? (
        <div className="text-center py-6">
          <Landmark size={28} className="text-gray-700 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No accounts in this workspace</p>
          {canShare && (
            <p className="text-xs text-gray-600 mt-1">Share one of your accounts to get started.</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type}>
              <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1.5 px-1">
                {ACCOUNT_TYPE_LABELS[type] ?? type}
              </p>
              <div className="space-y-1">
                {items.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-gray-800/40 group">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{a.name}</p>
                      <p className="text-xs text-gray-500 truncate">{a.institution}</p>
                    </div>
                    <p className="text-sm font-medium text-white shrink-0">
                      {formatBalance(a.balance, a.currency)}
                    </p>
                    {canShare && (
                      <button
                        onClick={() => handleRevoke(a.id)}
                        disabled={revokingId === a.id}
                        className="p-1 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 disabled:opacity-50 transition-all"
                        title="Remove from workspace"
                      >
                        {revokingId === a.id
                          ? <Loader2 size={12} className="animate-spin" />
                          : <X size={12} />}
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
        <button
          onClick={openSharePanel}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-dashed border-gray-700 text-sm text-gray-500 hover:text-white hover:border-gray-500 transition-colors"
        >
          <Share2 size={14} />
          Share an account
        </button>
      )}
    </div>
  );
}

// ─── Workspace Detail Panel ───────────────────────────────────────────────────

type DetailTab = "members" | "accounts";

function WorkspaceDetail({
  ws,
  currentUserId,
  isActive,
  onClose,
  onRefresh,
  onSwitch,
}: {
  ws: Workspace;
  currentUserId: string;
  isActive: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSwitch: (id: string) => void;
}) {
  const [tab,           setTab]           = useState<DetailTab>("members");
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
  useEffect(() => { if (tab === "members") fetchQueue(); }, [fetchQueue, tab]);

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
    const res = await fetch(`/api/workspaces/${ws.id}/members/${userId}`, { method: "DELETE" });
    if (res.ok) onRefresh();
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

  const detailTabs: { id: DetailTab; label: string }[] = [
    { id: "members",  label: `Members · ${ws.members.length}` },
    { id: "accounts", label: ws.accountCount !== undefined ? `Accounts · ${ws.accountCount}` : "Accounts" },
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-3xl shadow-2xl flex flex-col max-h-[88dvh]">
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-gray-800 shrink-0">
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 mb-0.5">
              <h2 className="text-base font-semibold text-white truncate">{ws.name}</h2>
              {ws.isPublic
                ? <Globe size={13} className="text-gray-500 shrink-0" />
                : <Lock  size={13} className="text-gray-600 shrink-0" />}
              {isActive && (
                <span className="text-[9px] font-semibold bg-blue-600/20 text-blue-400 px-1.5 py-0.5 rounded-full shrink-0">
                  Current
                </span>
              )}
            </div>
            {ws.description && <p className="text-xs text-gray-500">{ws.description}</p>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl text-gray-500 hover:text-white hover:bg-gray-800 transition-colors shrink-0">
            <X size={16} />
          </button>
        </div>

        {/* Switch button (only shows when user belongs to workspace and it's not already active) */}
        {ws.myRole && !isActive && (
          <div className="px-5 pt-3 pb-0 shrink-0">
            <button
              onClick={() => { onSwitch(ws.id); onClose(); }}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
            >
              <ArrowRightLeft size={14} />
              Switch to this workspace
            </button>
          </div>
        )}

        {/* Inner tabs */}
        <div className="flex gap-1 mx-5 mt-3 bg-gray-800/50 border border-gray-800 rounded-xl p-0.5 shrink-0">
          {detailTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                tab === t.id ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* ── Members tab ─────────────────────────────────────────────── */}
          {tab === "members" && (
            <>
              <div>
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
            </>
          )}

          {/* ── Accounts tab ────────────────────────────────────────────── */}
          {tab === "accounts" && (
            <WorkspaceAccountsTab workspaceId={ws.id} myRole={myRole} />
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
  isActive,
  isDefault,
  onClick,
  onSwitch,
  onManage,
  onSetDefault,
  settingDefault,
}: {
  ws: Workspace;
  joined?: boolean;
  isActive?: boolean;
  isDefault?: boolean;
  onClick: () => void;
  onSwitch?: (id: string) => void;
  onManage?: (id: string) => void;
  onSetDefault?: (id: string) => void;
  settingDefault?: boolean;
}) {
  const isPersonal   = ws.type === "PERSONAL";
  const canManage    = onManage && ["OWNER", "ADMIN"].includes(ws.myRole ?? "") && !isPersonal;
  const showActions  = !!ws.myRole && (!!onSetDefault || (!isActive && !!onSwitch));

  return (
    <div className={`bg-gray-900 border rounded-2xl p-4 transition-colors ${
      isActive ? "border-blue-500/40 bg-blue-600/5" : "border-gray-800 hover:border-gray-700 hover:bg-gray-800/30"
    }`}>
      {/* ── Row 1: icon + title + chevron ─────────────────────────────────── */}
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
          isPersonal ? "bg-blue-600/20" : "bg-gray-800"
        }`}>
          <Building2 size={16} className={isPersonal ? "text-blue-400" : "text-gray-400"} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-sm font-semibold text-white truncate">{ws.name}</p>
            {ws.isPublic
              ? <Globe size={11} className="text-gray-600 shrink-0" />
              : !isPersonal && <Lock size={11} className="text-gray-700 shrink-0" />}
            {isActive && (
              <span className="text-[9px] font-semibold bg-blue-600/20 text-blue-400 px-1.5 py-0.5 rounded-full shrink-0">
                Current
              </span>
            )}
            {isDefault && (
              <span className="text-[9px] font-semibold bg-emerald-600/20 text-emerald-400 px-1.5 py-0.5 rounded-full shrink-0">
                Default
              </span>
            )}
            {joined && !isActive && !isDefault && (
              <span className="text-[9px] font-semibold bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded-full shrink-0">
                Joined
              </span>
            )}
          </div>

          {/* ── Row 2: description ─────────────────────────────────────────── */}
          {ws.description && (
            <p className="text-xs text-gray-500 truncate mt-0.5">{ws.description}</p>
          )}
        </div>

        {/* Chevron always in top-right corner, inside card bounds */}
        <button
          onClick={onClick}
          className="p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-gray-700 transition-colors shrink-0 self-start"
          title="Open details"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* ── Row 3: avatars + account count + role (+ pencil for managers) ─── */}
      <div className="flex items-center gap-3 mt-2.5 ml-12">
        <MemberAvatars members={ws.members} />
        {typeof ws.accountCount === "number" && (
          <span className="flex items-center gap-1 text-[10px] text-gray-600">
            <Layers size={10} />
            {ws.accountCount} {ws.accountCount === 1 ? "account" : "accounts"}
          </span>
        )}
        {ws.myRole && <RoleBadge role={ws.myRole} />}
        {/* Pencil for owners/admins — right-aligned in meta row */}
        {canManage && (
          <button
            onClick={(e) => { e.stopPropagation(); onManage!(ws.id); }}
            className="ml-auto p-1 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-gray-700 transition-colors shrink-0"
            title="Manage workspace"
          >
            <Pencil size={13} />
          </button>
        )}
      </div>

      {/* ── Row 4: Set default + Switch ───────────────────────────────────── */}
      {showActions && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-gray-800/60">
          {onSetDefault && (
            <button
              onClick={(e) => { e.stopPropagation(); onSetDefault(ws.id); }}
              disabled={settingDefault}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-colors ${
                isDefault
                  ? "bg-emerald-600/15 text-emerald-400 hover:bg-emerald-600/25"
                  : "bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700"
              }`}
              title={isDefault ? "Remove as default" : "Set as default landing workspace"}
            >
              {settingDefault
                ? <Loader2 size={11} className="animate-spin" />
                : <Crown size={11} />}
              {isDefault ? "Default" : "Set default"}
            </button>
          )}
          {!isActive && onSwitch && (
            <button
              onClick={(e) => { e.stopPropagation(); onSwitch(ws.id); }}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-blue-400 bg-blue-600/10 hover:bg-blue-600/20 transition-colors"
              title="Switch to this workspace"
            >
              <ArrowRightLeft size={11} />
              Switch
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Invite Card ─────────────────────────────────────────────────────────────

function InviteCard({ invite, onAction }: { invite: Invite; onAction: () => void }) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [done, setDone] = useState(false);
  const isNew = invite.seenAt === null;

  async function act(action: "accept" | "decline") {
    setBusy(action);
    try {
      const res = await fetch(`/api/workspaces/${invite.workspace.id}/invites/${invite.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        setDone(true);
        onAction();
      }
    } finally {
      setBusy(null);
    }
  }

  if (done) return null;

  return (
    <div className={`rounded-2xl p-4 border transition-colors ${
      isNew
        ? "bg-blue-500/5 border-blue-500/30"
        : "bg-gray-900 border-gray-800"
    }`}>
      <div className="flex items-start gap-3 mb-3">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
          isNew ? "bg-blue-600/15 border-blue-500/30" : "bg-blue-600/10 border-blue-500/20"
        }`}>
          <Building2 size={16} className="text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-white truncate">{invite.workspace.name}</p>
            {isNew && (
              <span className="text-[10px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30 px-1.5 py-0.5 rounded-full shrink-0">
                New
              </span>
            )}
          </div>
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

export function WorkspacesClient({
  mine,
  publicWorkspaces,
  pendingInvites,
  currentUserId,
  activeWorkspaceId: initialActiveId,
  preferredWorkspaceId: initialPreferredId,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const hasUnseen = pendingInvites.some((i) => i.seenAt === null);
  const [tab,          setTab]          = useState<Tab>(hasUnseen ? "invites" : "mine");
  const [showCreate,   setShowCreate]   = useState(false);
  const [selectedWs,   setSelectedWs]   = useState<Workspace | null>(null);
  const [managingWs,   setManagingWs]   = useState<Workspace | null>(null);
  const [activeId,     setActiveId]     = useState<string | null>(initialActiveId);
  const [switchingId,  setSwitchingId]  = useState<string | null>(null);
  const [preferredId,  setPreferredId]  = useState<string | null>(initialPreferredId);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

  // Mark all unseen invites as seen when the Invites tab is opened.
  // Delayed 1.5s on auto-open so the sidebar badge is visible before it clears.
  // Immediate when the user manually clicks the tab.
  const seenFiredRef = useRef(false);
  useEffect(() => {
    if (tab !== "invites") return;
    // Count current unseen from the props snapshot (server-rendered)
    const unseen = pendingInvites.filter((i) => i.seenAt === null).length;
    if (unseen === 0) return;
    if (seenFiredRef.current) return;
    const delay = hasUnseen ? 1500 : 0; // longer delay on auto-tab, instant on manual click
    const timer = setTimeout(() => {
      seenFiredRef.current = true;
      fetch("/api/workspaces/invites/seen", { method: "POST" })
        .then(() => window.dispatchEvent(new CustomEvent("workspace-invites-changed")))
        .catch(() => {});
    }, delay);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Keep selectedWs / managingWs in sync with the latest server-rendered mine list.
  // router.refresh() updates `mine` props but doesn't auto-update these state vars.
  useEffect(() => {
    const t = setTimeout(() => {
      if (selectedWs) {
        const updated = mine.find((w) => w.id === selectedWs.id);
        if (updated) setSelectedWs(updated);
      }
      if (managingWs) {
        const updated = mine.find((w) => w.id === managingWs.id);
        if (updated) setManagingWs(updated);
      }
    }, 0);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine]);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function handleSwitch(workspaceId: string) {
    setSwitchingId(workspaceId);
    try {
      const res = await fetch("/api/workspace/switch", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ workspaceId }),
      });
      if (res.ok) {
        setActiveId(workspaceId);
        // Tell Sidebar to refetch so its dropdown updates immediately
        window.dispatchEvent(new CustomEvent("workspace-list-changed"));
        // Redirect to dashboard with the new workspace context
        router.push("/dashboard");
      }
    } finally {
      setSwitchingId(null);
    }
  }

  async function handleSetDefault(workspaceId: string) {
    // Personal workspace is default when no preference is stored — always clear to null
    const isPersonalWs = personal?.id === workspaceId;
    const newVal = (isPersonalWs || preferredId === workspaceId) ? "" : workspaceId;
    setSettingDefaultId(workspaceId);
    try {
      const res = await fetch("/api/user/profile", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ preferredWorkspaceId: newVal || null }),
      });
      if (res.ok) setPreferredId(newVal || null);
    } finally {
      setSettingDefaultId(null);
    }
  }

  // The user's own personal workspace = PERSONAL type where they're the OWNER.
  // Any other workspace (including someone else's PERSONAL workspace they were invited to)
  // appears in the shared list so it's not silently dropped.
  const personal   = mine.find((w) => w.type === "PERSONAL" && w.myRole === "OWNER");
  const sharedMine = mine.filter((w) => w.id !== personal?.id);

  // Determine true active workspace:
  // if no activeId, or the workspace doesn't exist in our list, default to personal
  const resolvedActiveId = (activeId && mine.some((w) => w.id === activeId))
    ? activeId
    : personal?.id ?? null;

  const myPublicIds  = new Set(sharedMine.filter((w) => w.isPublic).map((w) => w.id));
  const allPublic    = [
    ...sharedMine.filter((w) => w.isPublic),
    ...publicWorkspaces.filter((w) => !myPublicIds.has(w.id)),
  ];

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "mine",    label: "My Workspaces", count: sharedMine.length     },
    { id: "public",  label: "Public",        count: allPublic.length      },
    { id: "invites", label: "Invites",       count: pendingInvites.length },
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
          <WorkspaceCard
            ws={personal}
            isActive={resolvedActiveId === personal.id}
            isDefault={!preferredId || preferredId === personal.id}
            onClick={() => setSelectedWs(personal)}
            onSwitch={switchingId ? undefined : handleSwitch}
            onSetDefault={handleSetDefault}
            settingDefault={settingDefaultId === personal.id}
          />
          {/* personal workspace has no Manage button — managed via personal dashboard settings */}
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
              <WorkspaceCard
                key={ws.id}
                ws={ws}
                isActive={resolvedActiveId === ws.id}
                isDefault={preferredId === ws.id}
                onClick={() => setSelectedWs(ws)}
                onSwitch={switchingId ? undefined : handleSwitch}
                onManage={setManagingWs.bind(null, ws)}
                onSetDefault={handleSetDefault}
                settingDefault={settingDefaultId === ws.id}
              />
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
                isActive={resolvedActiveId === ws.id}
                isDefault={preferredId === ws.id}
                onClick={() => setSelectedWs(ws)}
                onSwitch={ws.myRole ? handleSwitch : undefined}
                onManage={setManagingWs.bind(null, ws)}
                onSetDefault={ws.myRole ? handleSetDefault : undefined}
                settingDefault={settingDefaultId === ws.id}
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
          isActive={resolvedActiveId === selectedWs.id}
          onClose={() => setSelectedWs(null)}
          onRefresh={refresh}
          onSwitch={handleSwitch}
        />
      )}
      {managingWs && (
        <ManageWorkspaceModal
          workspaceId={managingWs.id}
          workspaceName={managingWs.name}
          myRole={managingWs.myRole ?? "MEMBER"}
          currentUserId={currentUserId}
          onClose={() => setManagingWs(null)}
          onRefresh={refresh}
          onDeleted={() => setManagingWs(null)}
        />
      )}
    </div>
  );
}
