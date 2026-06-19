"use client";

/**
 * SpacesClient
 *
 * Redesigned Spaces landing page — premium, card-driven, Atlas Glass
 * throughout (Fourth Meridian Design Language v1). Replaces the old
 * WorkspacesClient tab layout with a single card canvas:
 *
 *   Atlas Field ambient background (renders from DashboardChrome.tsx so it
 *   can extend behind the header strip too — see AtlasField.tsx)
 *   Floating header ("Spaces") — no hero card, visionOS-style
 *   Pending invites banner (only if any)
 *   My Spaces — one unified glass canvas containing the card grid
 *   Explore public Spaces — quiet secondary row (only if any exist)
 *   Create Space — persistent right-side panel (scrolls with the page,
 *   per Phase G — no longer sticky)
 *
 * Backend is untouched: same /api/workspaces, /api/workspace/switch,
 * /api/user/profile endpoints, and the same `workspace-list-changed` /
 * `workspace-invites-changed` events other components (Sidebar) already
 * listen for. Only the presentation layer and the "Workspace" → "Space"
 * terminology changed.
 *
 * The deep settings surface (members, goals, shared accounts, danger zone)
 * stays in ManageWorkspaceModal — reused as-is here rather than duplicated.
 * The old standalone "WorkspaceDetail" read-only modal has been retired:
 * its members/accounts views are already covered by ManageWorkspaceModal,
 * so clicking a card now does the one thing users actually want (switch
 * into that Space), and the Manage (pencil) action opens full settings
 * directly — one fewer click, one fewer modal to maintain.
 *
 * Visual tightening pass (iOS/visionOS "liquid glass" direction): cards are
 * plain tinted tiles living inside one shared GlassPanel canvas rather than
 * each being its own nested glass panel — nesting `backdrop-filter: blur()`
 * panels inside one another doubles the blur cost for no visual gain and
 * reads as "boxed off" rather than one continuous surface. Hover states use
 * background-tint + border-brighten + a fading specular edge instead of any
 * glow/bloom, so liquid-glass raises feel tactile rather than neon.
 */

import { useState, useTransition, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  Plus, Globe, Lock, Users, Crown, Mail, Loader2, Check, X,
  Pencil, ChevronRight, ChevronDown, Home, Briefcase, Car, Plane, TrendingUp,
  Wrench, CreditCard, Target, LayoutDashboard, MoreHorizontal,
  Sunset, Building2, Shield,
} from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { GlassButton } from "@/components/atlas/GlassButton";
import {
  CATEGORY_LABELS,
  CATEGORY_ICONS,
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  WorkspaceCategory,
} from "@/lib/workspace-presets";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// Manage Space (deep settings) is only opened from a card's hover action —
// split out of the initial bundle for this route.
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

type SpaceItem = {
  id: string;
  name: string;
  description: string | null;
  type: string;
  category: string;
  isPublic: boolean;
  createdAt: string;
  members: Member[];
  myRole?: string | null;
  accountCount?: number;
  netWorth: number;
  trend: number[];
  lastUpdated: string | null;
};

type Invite = {
  id: string;
  role: string;
  createdAt: string;
  seenAt: string | null;
  workspace: { id: string; name: string; description: string | null; isPublic: boolean };
  invitedBy: { id: string; name: string | null; username: string | null };
};

interface Props {
  mine: SpaceItem[];
  publicSpaces: SpaceItem[];
  pendingInvites: Invite[];
  currentUserId: string;
  activeSpaceId: string | null;
  preferredSpaceId: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", VIEWER: "Viewer",
};

const ICON_MAP: Record<string, React.ReactNode> = {
  User:            <Users      size={18} />,
  Home:            <Home       size={18} />,
  Users:           <Users      size={18} />,
  Briefcase:       <Briefcase  size={18} />,
  Building2:       <Building2  size={18} />,
  Car:             <Car        size={18} />,
  Plane:           <Plane      size={18} />,
  TrendingUp:      <TrendingUp size={18} />,
  Wrench:          <Wrench     size={18} />,
  Sunset:          <Sunset     size={18} />,
  CreditCard:      <CreditCard size={18} />,
  Target:          <Target     size={18} />,
  LayoutDashboard: <LayoutDashboard size={18} />,
  MoreHorizontal:  <MoreHorizontal size={18} />,
  Shield:          <Shield     size={18} />,
};

function CategoryIcon({ name }: { name: string }) {
  return <>{ICON_MAP[name] ?? <LayoutDashboard size={18} />}</>;
}

// Per-category tinted icon tile — drawn only from existing design tokens
// (meridian/brass/violet/emerald/coral/ink), no new colors invented. Gives
// each Space card a distinct, branded swatch instead of one neutral tile
// repeated for every category.
const CATEGORY_TILE: Record<string, string> = {
  PERSONAL:       "linear-gradient(135deg, var(--meridian-400), var(--meridian-700))",
  HOUSEHOLD:      "linear-gradient(135deg, var(--ink-400), var(--ink-700))",
  FAMILY:         "linear-gradient(135deg, var(--ink-400), var(--ink-700))",
  BUSINESS:       "linear-gradient(135deg, var(--emerald-400), var(--emerald-700))",
  PROPERTY:       "linear-gradient(135deg, var(--ink-400), var(--ink-700))",
  VEHICLE:        "linear-gradient(135deg, var(--ink-400), var(--ink-700))",
  TRIP:           "linear-gradient(135deg, var(--brass-300), var(--brass-600))",
  INVESTMENT:     "linear-gradient(135deg, var(--violet-400), var(--violet-700))",
  EQUIPMENT:      "linear-gradient(135deg, var(--ink-400), var(--ink-700))",
  GOAL:           "linear-gradient(135deg, var(--meridian-400), var(--meridian-700))",
  RETIREMENT:     "linear-gradient(135deg, var(--violet-400), var(--violet-700))",
  DEBT_PAYOFF:    "linear-gradient(135deg, var(--coral-400), var(--coral-700))",
  EMERGENCY_FUND: "linear-gradient(135deg, var(--emerald-400), var(--emerald-700))",
  CUSTOM:         "linear-gradient(135deg, var(--ink-400), var(--ink-700))",
  OTHER:          "linear-gradient(135deg, var(--ink-400), var(--ink-700))",
};

function categoryTile(category: string): string {
  return CATEGORY_TILE[category] ?? CATEGORY_TILE.OTHER;
}

// Shared selected/unselected tint for the Create Space panel's option-chip
// grids (Space Type + Privacy) — both grids used this identical two-state
// class recipe inline; extracted once so they can't drift out of sync.
// Pure class-string return, no markup change — output is byte-identical to
// the previous inline ternaries.
function chipTone(selected: boolean): string {
  return selected
    ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]"
    : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] hover:bg-[var(--surface-hover)]";
}

// "Net Worth" is the one real number every workspace already has (from
// WorkspaceSnapshot). The label changes per Space type so the same number
// reads correctly in context — no new aggregation, just relabeling.
function metricLabelForCategory(category: string): string {
  if (category === "INVESTMENT" || category === "RETIREMENT") return "Portfolio Value";
  if (category === "PROPERTY" || category === "VEHICLE" || category === "EQUIPMENT") return "Equity";
  if (category === "DEBT_PAYOFF") return "Balance";
  if (category === "TRIP") return "Budget";
  return "Net Worth";
}

function formatCurrency(value: number, currency = DEFAULT_DISPLAY_CURRENCY) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

function formatActivity(lastUpdated: string | null, createdAt: string): string {
  const iso = lastUpdated ?? createdAt;
  const verb = lastUpdated ? "Updated" : "Created";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return `${verb} today`;
  if (days === 1) return `${verb} yesterday`;
  if (days < 7) return `${verb} ${days}d ago`;
  if (days < 30) return `${verb} ${Math.floor(days / 7)}w ago`;
  return `${verb} ${new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

// Deterministic per-member fill so an avatar stack reads as solid, tactile
// chips (Linear/Slack-style) instead of a single repeated tint. Drawn only
// from existing category/tone tokens — no new colors invented.
const AVATAR_PALETTE = [
  "var(--meridian-600)",
  "var(--brass-600)",
  "var(--violet-600)",
  "var(--emerald-600)",
  "var(--coral-600)",
];

function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function MemberAvatars({ members }: { members: Member[] }) {
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div className="flex items-center -space-x-2">
      {shown.map((m) => {
        const initial = (m.user.name ?? m.user.username ?? "?")[0].toUpperCase();
        return (
          <div
            key={m.id}
            title={m.user.name ?? m.user.username ?? ""}
            className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
            style={{ background: avatarColor(m.id), border: "1.5px solid var(--bg-base)" }}
          >
            <span className="text-[9px] font-semibold text-white">{initial}</span>
          </div>
        );
      })}
      {extra > 0 && (
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
          style={{ background: "var(--ink-600)", border: "1.5px solid var(--bg-base)" }}
        >
          <span className="text-[9px] font-semibold text-white">+{extra}</span>
        </div>
      )}
    </div>
  );
}

// Tiny inline trend visualization — intentionally hand-rolled SVG rather
// than recharts; a card grid of 20+ Spaces rendering 20+ chart instances is
// exactly the case a 12-line polyline beats a charting library for.
function Sparkline({ values, tone }: { values: number[]; tone: "positive" | "danger" | "neutral" }) {
  if (values.length < 2) {
    return <div className="w-20 h-7 shrink-0" aria-hidden />;
  }
  const w = 80, h = 28, pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke =
    tone === "positive" ? "var(--emerald-400)" : tone === "danger" ? "var(--coral-400)" : "var(--text-muted)";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="shrink-0" aria-hidden>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Space Card ───────────────────────────────────────────────────────────────
//
// Renders as a plain tinted tile (not a nested GlassPanel) so a grid of
// these can live inside one shared Atlas Glass canvas without stacking
// blur-on-blur. Background/border are Tailwind utility classes rather than
// inline `style` specifically so the `hover:` variants can take effect —
// see GlassButton.tsx for the same note.

function SpaceCard({
  space,
  isActive,
  isDefault,
  isPersonal,
  interactive = true,
  onOpen,
  onManage,
  onSetDefault,
  switching,
  settingDefault,
}: {
  space: SpaceItem;
  isActive?: boolean;
  isDefault?: boolean;
  isPersonal?: boolean;
  interactive?: boolean;
  onOpen?: () => void;
  onManage?: () => void;
  onSetDefault?: () => void;
  switching?: boolean;
  settingDefault?: boolean;
}) {
  const canManage = interactive && !!onManage && ["OWNER", "ADMIN"].includes(space.myRole ?? "") && !isPersonal;
  const tone: "positive" | "danger" | "neutral" =
    space.trend.length >= 2
      ? space.trend[space.trend.length - 1] >= space.trend[0] ? "positive" : "danger"
      : "neutral";
  const category = space.category as WorkspaceCategory;

  const tile = isActive
    ? "bg-[rgba(59,130,246,.08)] hover:bg-[rgba(59,130,246,.13)] border-[rgba(125,168,255,.32)] hover:border-[rgba(125,168,255,.5)]"
    : "bg-[var(--surface-muted)] hover:bg-[var(--surface-hover)] border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)]";

  return (
    <div
      className={[
        "group relative overflow-hidden rounded-[var(--radius-lg)] border p-5 flex flex-col gap-4",
        "transition-[transform,background-color,border-color,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-standard)]",
        tile,
        interactive
          ? "cursor-pointer hover:-translate-y-[3px] hover:scale-[1.014] hover:shadow-[var(--shadow-e3)]"
          : "",
        switching ? "opacity-60" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={interactive ? onOpen : undefined}
      role={interactive && onOpen ? "button" : undefined}
      tabIndex={interactive && onOpen ? 0 : undefined}
      onKeyDown={
        interactive && onOpen
          ? (e: React.KeyboardEvent) => { if (e.key === "Enter") onOpen(); }
          : undefined
      }
    >
      {/* Specular top-edge highlight — faint at rest, brightens on hover so
          the "liquid glass raise" reads as physical rather than a flat tint
          swap. */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 left-4 right-4 h-px opacity-30 group-hover:opacity-100 transition-opacity duration-[var(--dur-base)] ease-[var(--ease-standard)]"
        style={{ background: "linear-gradient(90deg, transparent, var(--specular-edge), transparent)" }}
      />

      {/* Soft diagonal glass reflection — a faint sheen band that only
          appears on hover, clipped to the card's rounded corners by the
          parent's overflow-hidden. Intentionally subtle: no bloom, no
          neon, just a hint of light passing across glass. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-x-6 -top-1/2 h-[180%] opacity-0 group-hover:opacity-100 transition-opacity duration-[var(--dur-base)] ease-[var(--ease-standard)]"
        style={{
          background:
            "linear-gradient(115deg, transparent 38%, rgba(255,255,255,.045) 48%, rgba(255,255,255,.085) 50%, rgba(255,255,255,.045) 52%, transparent 62%)",
        }}
      />

      {/* Icon + name + type */}
      <div className="flex items-start gap-3">
        <div
          className="w-11 h-11 rounded-[var(--radius-md)] flex items-center justify-center shrink-0 text-white"
          style={{ background: categoryTile(category), boxShadow: "inset 0 1px 0 rgba(255,255,255,.2), 0 1px 3px rgba(0,0,0,.25)" }}
        >
          <CategoryIcon name={CATEGORY_ICONS[category] ?? "LayoutDashboard"} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{space.name}</p>
            {space.isPublic
              ? <Globe size={11} className="text-[var(--text-muted)] shrink-0" />
              : !isPersonal && <Lock size={11} className="text-[var(--text-muted)] shrink-0" />}
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
            {CATEGORY_LABELS[category] ?? "Space"}
          </p>
        </div>
        {isActive && (
          <span className="flex items-center gap-1.5 shrink-0" title="Active Space">
            <span
              className="presence-dot w-[6px] h-[6px] rounded-full shrink-0"
              style={{ background: "var(--emerald-400)" }}
              aria-hidden
            />
            <span className="text-[10px] font-medium text-[var(--text-muted)]">Active</span>
          </span>
        )}
        {!interactive && (
          <span className="text-[9px] font-medium text-[var(--text-muted)] shrink-0">Not joined</span>
        )}
      </div>

      {/* Primary financial metric + sparkline */}
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
            {metricLabelForCategory(category)}
          </p>
          <p className="text-2xl font-bold text-[var(--text-primary)] tabular-nums">
            {space.trend.length > 0 ? formatCurrency(space.netWorth) : "—"}
          </p>
        </div>
        <Sparkline values={space.trend} tone={tone} />
      </div>

      {/* Members + last updated + hover actions */}
      <div className="flex items-center justify-between gap-3 pt-3" style={{ borderTop: "1px solid var(--border-hairline)" }}>
        <div className="flex items-center gap-2.5 min-w-0">
          <MemberAvatars members={space.members} />
          <span className="text-[11px] text-[var(--text-muted)] truncate">
            {formatActivity(space.lastUpdated, space.createdAt)}
          </span>
        </div>
        {interactive && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
            {isDefault ? (
              <span title="Default landing Space" className="p-1.5">
                <Crown size={13} className="text-[var(--brass-400)]" />
              </span>
            ) : onSetDefault && (
              <button
                onClick={(e) => { e.stopPropagation(); onSetDefault(); }}
                title="Set as default Space"
                className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors"
              >
                {settingDefault ? <Loader2 size={13} className="animate-spin" /> : <Crown size={13} />}
              </button>
            )}
            {canManage && (
              <button
                onClick={(e) => { e.stopPropagation(); onManage!(); }}
                title="Manage Space"
                className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors"
              >
                <Pencil size={13} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Pending invite row + banner ──────────────────────────────────────────────

function InviteRow({ invite, onAction }: { invite: Invite; onAction: () => void }) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [done, setDone] = useState(false);

  async function act(action: "accept" | "decline") {
    setBusy(action);
    try {
      const res = await fetch(`/api/workspaces/${invite.workspace.id}/invites/${invite.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) { setDone(true); onAction(); }
    } finally {
      setBusy(null);
    }
  }

  if (done) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)]" style={{ background: "var(--surface-muted)" }}>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text-primary)] truncate">{invite.workspace.name}</p>
        <p className="text-xs text-[var(--text-muted)] truncate">
          Invited by {invite.invitedBy.name ?? `@${invite.invitedBy.username}`} · {ROLE_LABELS[invite.role] ?? invite.role}
        </p>
      </div>
      <button
        onClick={() => act("decline")}
        disabled={!!busy}
        className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] disabled:opacity-50 transition-colors shrink-0"
        title="Decline"
      >
        {busy === "decline" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
      </button>
      <GlassButton
        onClick={() => act("accept")}
        disabled={!!busy}
        tone="meridian"
        size="sm"
        className="shrink-0"
      >
        {busy === "accept" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
        Accept
      </GlassButton>
    </div>
  );
}

function InviteBanner({ invites, onAction }: { invites: Invite[]; onAction: () => void }) {
  const hasUnseen = invites.some((i) => i.seenAt === null);
  const [expanded, setExpanded] = useState(hasUnseen);
  const seenFired = useRef(false);

  // Mirrors the old WorkspacesClient delay: surfaced immediately, marked
  // seen 1.5s later so the Sidebar badge has time to register before it clears.
  useEffect(() => {
    if (!hasUnseen || seenFired.current) return;
    const t = setTimeout(() => {
      seenFired.current = true;
      fetch("/api/workspaces/invites/seen", { method: "POST" })
        .then(() => window.dispatchEvent(new CustomEvent("workspace-invites-changed")))
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [hasUnseen]);

  return (
    <GlassPanel depth="thin" elevation="e1" radius="lg" glow="meridian" className="p-4 mb-8">
      <button onClick={() => setExpanded((p) => !p)} className="w-full flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
          <Mail size={15} className="text-[var(--meridian-400)]" />
          {invites.length} pending Space invite{invites.length === 1 ? "" : "s"}
        </span>
        <ChevronRight size={14} className={`text-[var(--text-muted)] transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && (
        <div className="mt-3 space-y-1.5">
          {invites.map((inv) => <InviteRow key={inv.id} invite={inv} onAction={onAction} />)}
        </div>
      )}
    </GlassPanel>
  );
}

// ─── Create Space panel ───────────────────────────────────────────────────────

function CreateSpacePanel({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [category, setCategory] = useState<WorkspaceCategory | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const visibleCategories = showAll ? [...PRIMARY_CATEGORIES, ...SECONDARY_CATEGORIES] : PRIMARY_CATEGORIES;

  async function handleCreate() {
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
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
        setName(""); setDescription(""); setIsPublic(false); setCategory(null);
        onCreated();
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-6 flex flex-col gap-5">
      <div>
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Create Space</h2>
        <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
          A new Space for a family, business, property, or anything else you want to track separately.
        </p>
      </div>

      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] mb-2 block">Space Type</label>
        <div className="grid grid-cols-2 gap-2">
          {visibleCategories.map((cat) => {
            const selected = category === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(selected ? null : cat)}
                className={[
                  "flex items-center gap-2 px-3 py-2.5 rounded-[var(--radius-sm)] border text-left transition-[transform,background-color,border-color] active:scale-[0.97]",
                  chipTone(selected),
                ].join(" ")}
              >
                <span className={selected ? "text-[var(--meridian-400)]" : "text-[var(--text-muted)]"}>
                  <CategoryIcon name={CATEGORY_ICONS[cat]} />
                </span>
                <span className={`text-xs truncate ${selected ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]"}`}>
                  {CATEGORY_LABELS[cat]}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setShowAll((p) => !p)}
          className="w-full text-left text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] py-1.5 transition-colors"
        >
          {showAll ? "Show fewer types" : "Show more types →"}
        </button>
      </div>

      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Space Name</label>
        <input
          value={name}
          onChange={(e) => { setName(e.target.value); setError(""); }}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          placeholder="e.g. Smith Family, Atlanta Duplex"
          maxLength={60}
          className="w-full rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-colors"
          style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
        />
      </div>

      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">
          Description <span className="text-[var(--text-muted)]">(optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this Space for?"
          rows={2}
          maxLength={200}
          className="w-full rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-colors resize-none"
          style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
        />
      </div>

      {/* Bottom decision zone — deliberately more generous spacing (gap-7)
          than the form fields above (gap-5): this is where the user commits,
          so it should feel relaxed and premium, not crowded against the
          fields right above it. */}
      <div className="flex flex-col gap-7">
        <div>
          <label className="text-xs font-medium text-[var(--text-secondary)] mb-2 block">Privacy</label>
          <div className="grid grid-cols-2 gap-2">
            {[false, true].map((pub) => {
              const selected = isPublic === pub;
              return (
                <button
                  key={String(pub)}
                  type="button"
                  onClick={() => setIsPublic(pub)}
                  className={[
                    "flex items-center justify-center gap-2 px-3 py-2.5 rounded-[var(--radius-sm)] border transition-[transform,background-color,border-color] active:scale-[0.97]",
                    chipTone(selected),
                  ].join(" ")}
                >
                  {pub ? <Globe size={13} /> : <Lock size={13} />}
                  <span className="text-xs text-[var(--text-secondary)]">{pub ? "Public" : "Private"}</span>
                </button>
              );
            })}
          </div>
        </div>

        {error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}

        <GlassButton
          onClick={handleCreate}
          disabled={busy || !name.trim()}
          tone="meridian"
          fullWidth
          className="py-3 text-sm"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Create Space
        </GlassButton>
      </div>
    </GlassPanel>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────
//
// Deliberately not a GlassPanel — a large boxed-in hero reads heavy and
// "admin dashboard"; floating the title directly over the Atlas Field is
// the lighter, breathable, visionOS-style treatment this page wants. The
// "current Space" indicator is no longer a glass pill — just a softly
// pulsing presence dot and a line of text. Presence over status: nothing to
// read as chrome, nothing to read as a badge.

function SpacesHeader({ currentName }: { currentName: string | null }) {
  return (
    <div className="pt-2 pb-8 md:pb-10">
      <h1 className="text-3xl md:text-[2.5rem] font-semibold tracking-tight text-[var(--text-primary)] mb-2">
        Spaces
      </h1>
      {/* Active-Space presence line — sits directly under the title, reading
          as a status line rather than a detached badge floating above it. */}
      {currentName && (
        <div className="flex items-center gap-1.5 mb-2">
          <span
            className="presence-dot w-[6px] h-[6px] rounded-full shrink-0"
            style={{ background: "var(--emerald-400)" }}
            aria-hidden
          />
          <span className="text-xs font-medium text-[var(--text-muted)]">
            Active in <span className="text-[var(--text-secondary)]">{currentName}</span>
          </span>
        </div>
      )}
      <p className="text-sm md:text-base text-[var(--text-muted)] max-w-xl leading-relaxed">
        Everything you build, manage, and share lives here.
      </p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SpacesClient({
  mine,
  publicSpaces,
  pendingInvites,
  currentUserId,
  activeSpaceId: initialActiveId,
  preferredSpaceId: initialPreferredId,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [activeId, setActiveId]               = useState<string | null>(initialActiveId);
  const [preferredId, setPreferredId]          = useState<string | null>(initialPreferredId);
  const [switchingId, setSwitchingId]          = useState<string | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [managingSpace, setManagingSpace]      = useState<SpaceItem | null>(null);
  const [showAllSpaces, setShowAllSpaces]      = useState(false);

  // Keep managingSpace in sync with the latest server-rendered `mine` list
  // after router.refresh() — same pattern as the old WorkspacesClient.
  useEffect(() => {
    if (!managingSpace) return;
    const t = setTimeout(() => {
      const updated = mine.find((w) => w.id === managingSpace.id);
      if (updated) setManagingSpace(updated);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine]);

  function refresh() {
    startTransition(() => router.refresh());
  }

  const handleSwitch = useCallback(async (workspaceId: string) => {
    setSwitchingId(workspaceId);
    try {
      const res = await fetch("/api/workspace/switch", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ workspaceId }),
      });
      if (res.ok) {
        setActiveId(workspaceId);
        window.dispatchEvent(new CustomEvent("workspace-list-changed"));
        router.push("/dashboard");
      }
    } finally {
      setSwitchingId(null);
    }
  }, [router]);

  async function handleSetDefault(workspaceId: string) {
    const newVal = preferredId === workspaceId ? "" : workspaceId;
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

  const personal = mine.find((w) => w.type === "PERSONAL" && w.myRole === "OWNER");
  const others   = mine.filter((w) => w.id !== personal?.id);
  const ordered  = personal ? [personal, ...others] : others;

  // Caps the initial grid so the canvas reads the same whether someone has
  // 1 Space or 50+ — the rest are one click away via "Show N more" instead
  // of an ever-growing scroll.
  const CARD_LIMIT = 6;
  const visibleSpaces = showAllSpaces ? ordered : ordered.slice(0, CARD_LIMIT);
  const hiddenSpaceCount = ordered.length - visibleSpaces.length;

  const resolvedActiveId = (activeId && mine.some((w) => w.id === activeId)) ? activeId : personal?.id ?? null;
  const activeSpace = mine.find((w) => w.id === resolvedActiveId) ?? personal ?? null;

  const myIds = new Set(mine.map((w) => w.id));
  const explorePublic = publicSpaces.filter((w) => !myIds.has(w.id));

  function handleOpen(space: SpaceItem) {
    if (resolvedActiveId === space.id) {
      router.push("/dashboard");
    } else {
      handleSwitch(space.id);
    }
  }

  return (
    <div className="min-h-[70vh]">
      {/* Atlas Field now renders from DashboardChrome.tsx so it can paint
          behind the header strip too, not just this page's own content
          (Phase G #2) — nothing to render here anymore. */}
      <div className="max-w-[1400px] mx-auto pb-16">
        <SpacesHeader currentName={activeSpace?.name ?? null} />

        {pendingInvites.length > 0 && <InviteBanner invites={pendingInvites} onAction={refresh} />}

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 lg:gap-8 items-start">
          <div>
            {/* One unified Atlas Glass canvas holding every Space card — not
                a row of separately-boxed panels. */}
            <GlassPanel depth="thin" elevation="e2" radius="xl" className="p-4 md:p-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {visibleSpaces.map((space) => (
                  <SpaceCard
                    key={space.id}
                    space={space}
                    isActive={resolvedActiveId === space.id}
                    isDefault={preferredId ? preferredId === space.id : space.id === personal?.id}
                    isPersonal={space.id === personal?.id}
                    onOpen={() => handleOpen(space)}
                    onManage={() => setManagingSpace(space)}
                    onSetDefault={space.id === personal?.id ? undefined : () => handleSetDefault(space.id)}
                    switching={switchingId === space.id}
                    settingDefault={settingDefaultId === space.id}
                  />
                ))}
              </div>

              {hiddenSpaceCount > 0 && (
                <div className="flex justify-center pt-5">
                  <GlassButton tone="neutral" size="sm" onClick={() => setShowAllSpaces(true)}>
                    Show {hiddenSpaceCount} more Space{hiddenSpaceCount === 1 ? "" : "s"}
                    <ChevronDown size={13} />
                  </GlassButton>
                </div>
              )}
            </GlassPanel>

            {explorePublic.length > 0 && (
              <div className="mt-10">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
                  Explore public Spaces
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
                  {explorePublic.map((space) => (
                    <SpaceCard key={space.id} space={space} interactive={false} />
                  ))}
                </div>
              </div>
            )}
          </div>

          <CreateSpacePanel onCreated={refresh} />
        </div>

        {managingSpace && (
          <ManageWorkspaceModal
            workspaceId={managingSpace.id}
            workspaceName={managingSpace.name}
            myRole={managingSpace.myRole ?? "MEMBER"}
            currentUserId={currentUserId}
            onClose={() => setManagingSpace(null)}
            onRefresh={refresh}
            onDeleted={() => setManagingSpace(null)}
          />
        )}
      </div>
    </div>
  );
}
