"use client";

/**
 * SpacesClient
 *
 * Redesigned Spaces landing page — premium, card-driven, Atlas Glass
 * throughout (Fourth Meridian Design Language v1). Replaces the old
 * SpacesClient tab layout with a single card canvas:
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
 * Backend is untouched: same /api/spaces, /api/space/switch,
 * /api/user/profile endpoints, and the same `space-list-changed` /
 * `space-invites-changed` events other components (Sidebar) already
 * listen for. Only the presentation layer and the "Space" → "Space"
 * terminology changed.
 *
 * The deep settings surface (members, goals, shared accounts, danger zone)
 * stays in ManageSpaceModal — reused as-is here rather than duplicated.
 * The old standalone "SpaceDetail" read-only modal has been retired:
 * its members/accounts views are already covered by ManageSpaceModal,
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
  SpaceCategory,
} from "@/lib/space-presets";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { displaySpaceName, formatDate } from "@/lib/format";
import {
  SPACE_LIST_CHANGED_EVENT,
  SPACE_INVITES_CHANGED_EVENT,
  OPEN_CREATE_SPACE_EVENT,
} from "@/lib/space-nav";

// Manage Space (deep settings) is only opened from a card's hover action —
// split out of the initial bundle for this route.
const ManageSpaceModal = dynamic(
  () => import("@/components/dashboard/ManageSpaceModal").then((m) => m.ManageSpaceModal),
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
  space: { id: string; name: string; description: string | null; isPublic: boolean };
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

// Exported so CreateSpaceModal.tsx (mounted from DashboardChrome.tsx, not
// this file) can reuse the exact same icon-name → glyph mapping for its
// Space Type chips instead of duplicating ICON_MAP in two places.
export function CategoryIcon({ name }: { name: string }) {
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

// "Net Worth" is the one real number every space already has (from
// SpaceSnapshot). The label changes per Space type so the same number
// reads correctly in context — no new aggregation, just relabeling.
function metricLabelForCategory(category: string): string {
  if (category === "INVESTMENT" || category === "RETIREMENT") return "Portfolio Value";
  if (category === "PROPERTY" || category === "VEHICLE" || category === "EQUIPMENT") return "Equity";
  if (category === "DEBT_PAYOFF") return "Balance";
  if (category === "TRIP") return "Budget";
  if (category === "CUSTOM" || category === "OTHER") return "Value";
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
  const category = space.category as SpaceCategory;

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
          <div className="flex items-start gap-1.5">
            {/* Name scales down slightly before it wraps to a second line,
                and only ever ellipsizes as a last resort (line-clamp-2's
                native overflow behavior) — long Space names stay readable
                instead of getting cut off after a few characters. */}
            <p
              className="font-semibold text-[var(--text-primary)] leading-snug line-clamp-2 break-words"
              style={{ fontSize: "clamp(0.8125rem, 0.75rem + 0.3vw, 0.875rem)" }}
            >
              {displaySpaceName(space.name)}
            </p>
            {space.isPublic
              ? <Globe size={11} className="text-[var(--text-muted)] shrink-0 mt-1" />
              : !isPersonal && <Lock size={11} className="text-[var(--text-muted)] shrink-0 mt-1" />}
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
            {CATEGORY_LABELS[category] ?? "Space"}
          </p>
        </div>
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

// ─── Public Space card (compact) + detail modal ──────────────────────────────
//
// Public Spaces the user hasn't joined get their own compact preview card —
// visibly smaller than the full SpaceCard above (tighter padding, smaller
// icon tile and type, no sparkline, no member stack, no hover actions): these
// are previews, not active spaces, so the card's job is to communicate
// just enough — name, type, the one financial metric, last activity — to
// decide whether to look closer. Clicking one opens PublicSpaceDetailModal
// for the fuller read-only view rather than switching into the Space.

function PublicSpaceCard({ space, onOpen }: { space: SpaceItem; onOpen: () => void }) {
  const category = space.category as SpaceCategory;

  return (
    <div
      className={[
        "group relative overflow-hidden rounded-[var(--radius-md)] border p-3 flex flex-col gap-2 cursor-pointer",
        "bg-[var(--surface-muted)] hover:bg-[var(--surface-hover)] border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)]",
        "transition-[transform,background-color,border-color,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-standard)]",
        "hover:-translate-y-[2px] hover:shadow-[var(--shadow-e2)]",
      ].join(" ")}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") onOpen(); }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 left-2.5 right-2.5 h-px opacity-30 group-hover:opacity-100 transition-opacity duration-[var(--dur-base)] ease-[var(--ease-standard)]"
        style={{ background: "linear-gradient(90deg, transparent, var(--specular-edge), transparent)" }}
      />

      <div className="flex items-start justify-between gap-2">
        <div
          className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 text-white"
          style={{ background: categoryTile(category), boxShadow: "inset 0 1px 0 rgba(255,255,255,.2), 0 1px 3px rgba(0,0,0,.25)" }}
        >
          <CategoryIcon name={CATEGORY_ICONS[category] ?? "LayoutDashboard"} />
        </div>
        <Globe size={10} className="text-[var(--text-muted)] shrink-0 mt-1" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="font-semibold text-[var(--text-primary)] text-[13px] leading-snug line-clamp-2 break-words">
          {displaySpaceName(space.name)}
        </p>
        <p className="text-[10px] text-[var(--text-muted)] mt-0.5 truncate">
          {CATEGORY_LABELS[category] ?? "Space"}
        </p>
      </div>

      <div className="pt-2" style={{ borderTop: "1px solid var(--border-hairline)" }}>
        <p className="text-[8px] uppercase tracking-wide text-[var(--text-muted)] mb-0.5">
          {metricLabelForCategory(category)}
        </p>
        <p className="text-sm font-bold text-[var(--text-primary)] tabular-nums truncate">
          {space.trend.length > 0 ? formatCurrency(space.netWorth) : "—"}
        </p>
        <p className="text-[9px] text-[var(--text-muted)] mt-0.5 truncate">
          {formatActivity(space.lastUpdated, space.createdAt)}
        </p>
      </div>
    </div>
  );
}

// Read-only detail view for a public Space the viewer hasn't joined. Mirrors
// ManageSpaceModal's shell (fixed backdrop + GlassPanel depth="thick", same
// header/close-button recipe) so it reads as the same family of surface, but
// has no tabs and no mutation — just the fuller picture the compact card can't
// fit. "Join Space" is intentionally inert: public join permissions,
// viewer-only membership, audit logs, invite rules, and abuse controls are a
// dedicated backend pass of their own, so this only previews the action.
function PublicSpaceDetailModal({ space, onClose }: { space: SpaceItem; onClose: () => void }) {
  const category = space.category as SpaceCategory;
  const owner = space.members.find((m) => m.role === "OWNER");
  const tone: "positive" | "danger" | "neutral" =
    space.trend.length >= 2
      ? space.trend[space.trend.length - 1] >= space.trend[0] ? "positive" : "danger"
      : "neutral";

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)" }}
      onClick={handleBackdrop}
    >
      <GlassPanel depth="thick" elevation="e4" radius="xl" className="w-full sm:max-w-md">
        <div className="flex flex-col max-h-[calc(100dvh-2rem)] sm:max-h-[88dvh]">
          {/* Header */}
          <div
            className="flex items-start justify-between gap-3 px-5 pt-5 pb-4"
            style={{ borderBottom: "1px solid var(--border-hairline)" }}
          >
            <div className="flex items-start gap-3 min-w-0">
              <div
                className="w-11 h-11 rounded-[var(--radius-md)] flex items-center justify-center shrink-0 text-white"
                style={{ background: categoryTile(category), boxShadow: "inset 0 1px 0 rgba(255,255,255,.2), 0 1px 3px rgba(0,0,0,.25)" }}
              >
                <CategoryIcon name={CATEGORY_ICONS[category] ?? "LayoutDashboard"} />
              </div>
              <div className="min-w-0">
                <p className="text-base font-semibold text-[var(--text-primary)] truncate">{displaySpaceName(space.name)}</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-1">
                  {CATEGORY_LABELS[category] ?? "Space"} · <Globe size={10} className="shrink-0" /> Public
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] transition-colors shrink-0"
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5 min-h-0">
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

            {space.description && (
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{space.description}</p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[var(--radius-md)] p-3" style={{ background: "var(--surface-muted)" }}>
                <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Created</p>
                <p className="text-sm text-[var(--text-primary)]">{formatDate(space.createdAt)}</p>
              </div>
              <div className="rounded-[var(--radius-md)] p-3" style={{ background: "var(--surface-muted)" }}>
                <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Updated</p>
                <p className="text-sm text-[var(--text-primary)]">
                  {space.lastUpdated ? formatDate(space.lastUpdated) : "—"}
                </p>
              </div>
              {owner && (
                <div className="rounded-[var(--radius-md)] p-3" style={{ background: "var(--surface-muted)" }}>
                  <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Owner</p>
                  <p className="text-sm text-[var(--text-primary)] truncate">
                    {owner.user.name ?? `@${owner.user.username}`}
                  </p>
                </div>
              )}
              <div className="rounded-[var(--radius-md)] p-3" style={{ background: "var(--surface-muted)" }}>
                <p className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Members</p>
                <p className="text-sm text-[var(--text-primary)] flex items-center gap-1.5">
                  <Users size={12} className="text-[var(--text-muted)]" /> {space.members.length}
                </p>
              </div>
            </div>
          </div>

          {/* Footer — "Join Space" is intentionally disabled. See file-level
              comment: public join backend (permissions, viewer-only
              membership, audit logs, invite rules, abuse controls) is a
              dedicated future pass, not part of this presentation redesign. */}
          <div className="px-5 py-4 shrink-0" style={{ borderTop: "1px solid var(--border-hairline)" }}>
            <GlassButton tone="meridian" fullWidth disabled title="Public Space joining is coming soon">
              <Users size={13} />
              Join Space
            </GlassButton>
            <p className="text-[11px] text-[var(--text-muted)] text-center mt-2">
              Public joining is coming soon.
            </p>
          </div>
        </div>
      </GlassPanel>
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
      const res = await fetch(`/api/spaces/${invite.space.id}/invites/${invite.id}`, {
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
        <p className="text-sm text-[var(--text-primary)] truncate">{displaySpaceName(invite.space.name)}</p>
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

  // Mirrors the old SpacesClient delay: surfaced immediately, marked
  // seen 1.5s later so the Sidebar badge has time to register before it clears.
  useEffect(() => {
    if (!hasUnseen || seenFired.current) return;
    const t = setTimeout(() => {
      seenFired.current = true;
      fetch("/api/spaces/invites/seen", { method: "POST" })
        .then(() => window.dispatchEvent(new CustomEvent(SPACE_INVITES_CHANGED_EVENT)))
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

// ─── Header ───────────────────────────────────────────────────────────────────
//
// Deliberately not a GlassPanel — a large boxed-in hero reads heavy and
// "admin dashboard"; floating the title directly over the Atlas Field is
// the lighter, breathable, visionOS-style treatment this page wants. No
// "current Space" status line under the title anymore — which Space is
// active is already obvious from the card grid below (tinted tile + no
// "Active" badge needed) and from the sidebar, so the hero just goes
// straight from headline to subtitle.

function SpacesHeader({ onCreateSpace }: { onCreateSpace: () => void }) {
  return (
    <div className="pt-2 pb-8 md:pb-10 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
      <div>
        <h1 className="text-3xl md:text-[2.5rem] font-semibold tracking-tight text-[var(--text-primary)] mb-2">
          Spaces
        </h1>
        <p className="text-sm md:text-base text-[var(--text-muted)] max-w-xl leading-relaxed">
          Everything you build, manage, and share lives here.
        </p>
      </div>
      {/* Replaces the old permanently-visible inline Create Space panel —
          the form now lives in CreateSpaceModal (mounted once from
          DashboardChrome.tsx), opened via the same "open-create-space"
          window event the Sidebar's own Create Space row also dispatches. */}
      <GlassButton onClick={onCreateSpace} tone="meridian" className="shrink-0 sm:mt-1">
        <Plus size={15} />
        Create Space
      </GlassButton>
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
  const [viewingPublicSpace, setViewingPublicSpace] = useState<SpaceItem | null>(null);
  const [leftSpaceToast, setLeftSpaceToast]    = useState<string | null>(null);

  // Picks up the "?left=<name>" hint a Leave Space action (ManageSpaceModal
  // or SpaceDashboard's header Leave button) appends when it redirects here,
  // shows a one-shot success toast, then strips the param so a refresh or
  // back-navigation doesn't re-show it. Plain history API instead of
  // useSearchParams() — avoids opting this whole client component into a
  // Suspense boundary for a single one-time read.
  useEffect(() => {
    const left = new URLSearchParams(window.location.search).get("left");
    if (!left) return;
    // setTimeout(..., 0) defers the setState out of the effect body itself —
    // same pattern as the managingSpace sync effect above, avoids the
    // react-hooks/set-state-in-effect cascading-render lint rule.
    let dismissTimer: ReturnType<typeof setTimeout> | undefined;
    const showTimer = setTimeout(() => {
      setLeftSpaceToast(left);
      window.history.replaceState({}, "", window.location.pathname);
      dismissTimer = setTimeout(() => setLeftSpaceToast(null), 3500);
    }, 0);
    return () => {
      clearTimeout(showTimer);
      if (dismissTimer) clearTimeout(dismissTimer);
    };
  }, []);

  // Keep managingSpace in sync with the latest server-rendered `mine` list
  // after router.refresh() — same pattern as the old SpacesClient.
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

  const handleSwitch = useCallback(async (spaceId: string) => {
    setSwitchingId(spaceId);
    try {
      const res = await fetch("/api/space/switch", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ spaceId }),
      });
      if (res.ok) {
        setActiveId(spaceId);
        window.dispatchEvent(new CustomEvent(SPACE_LIST_CHANGED_EVENT));
        router.push("/dashboard");
      }
    } finally {
      setSwitchingId(null);
    }
  }, [router]);

  async function handleSetDefault(spaceId: string) {
    const newVal = preferredId === spaceId ? "" : spaceId;
    setSettingDefaultId(spaceId);
    try {
      const res = await fetch("/api/user/profile", {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ preferredSpaceId: newVal || null }),
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

  // This preview row is intentionally capped, full stop (no "show more" —
  // that belongs to the future /dashboard/spaces/public page the heading
  // above links to, not this compact strip on the main Spaces page).
  const PUBLIC_CARD_LIMIT = 4;

  const resolvedActiveId = (activeId && mine.some((w) => w.id === activeId)) ? activeId : personal?.id ?? null;

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
      {leftSpaceToast && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium bg-emerald-500/10 border-emerald-500/30 text-emerald-400">
          <Check size={14} />
          You left {leftSpaceToast}
        </div>
      )}

      {/* Atlas Field now renders from DashboardChrome.tsx so it can paint
          behind the header strip too, not just this page's own content
          (Phase G #2) — nothing to render here anymore. */}
      <div className="max-w-[1400px] mx-auto pb-16">
        <SpacesHeader onCreateSpace={() => window.dispatchEvent(new CustomEvent(OPEN_CREATE_SPACE_EVENT))} />

        {pendingInvites.length > 0 && <InviteBanner invites={pendingInvites} onAction={refresh} />}

        {/* One unified Atlas Glass canvas holding every Space card — not
            a row of separately-boxed panels. No more right-column Create
            Space panel: that form now lives in a modal (see
            CreateSpaceModal.tsx), so the page content is just the card
            grid. */}
        <GlassPanel depth="thin" elevation="e2" radius="xl" className="p-4 md:p-6">
          {/* auto-fit + minmax sizes columns off the actual width of this
              GlassPanel, not the viewport — so once the content column
              (viewport minus sidebar) can't fit two 280px-min cards side by
              side, it drops to one column instead of squeezing both.
              min(280px,100%) keeps the floor from ever exceeding the
              container on very narrow screens, which would otherwise force
              horizontal scroll. */}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-4">
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
            {/* Clickable heading -> /dashboard/spaces/public. That route
                doesn't exist yet (see TODO below) — this is the main
                Spaces page's compact preview row, not the full public
                directory, so the heading itself is the entry point into a
                future dedicated browsing page. Title-case + text-primary
                matches the platform's other sub-section headings (see
                "Add existing accounts" / "Invite Users" in
                CreateSpaceModal.tsx) rather than the old all-caps muted
                label style. */}
            <button
              type="button"
              onClick={() => router.push("/dashboard/spaces/public")}
              className="group flex items-center gap-1.5 mb-3 text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--meridian-400)] transition-colors"
            >
              Explore Public Spaces
              <ChevronRight size={14} className="text-[var(--text-muted)] group-hover:text-[var(--meridian-400)] group-hover:translate-x-0.5 transition-[color,transform]" />
            </button>
            {/* TODO(backend/future pass): /dashboard/spaces/public doesn't
                exist yet — this click currently 404s. Build a dedicated
                public-Spaces browsing page there (full directory, search,
                filters) rather than cramming it into this compact preview
                row. Capped at PUBLIC_CARD_LIMIT here intentionally; that
                future page is where "see all public Spaces" belongs. */}

            {/* Roughly half the column width of the "My Spaces" grid above
                (150px floor vs. 280px) — compact, near-square previews
                rather than full-width panels. Capped to PUBLIC_CARD_LIMIT so
                this stays a quiet preview row, not a second full grid. */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(140px,100%),1fr))] gap-3">
              {explorePublic.slice(0, PUBLIC_CARD_LIMIT).map((space) => (
                <PublicSpaceCard key={space.id} space={space} onOpen={() => setViewingPublicSpace(space)} />
              ))}
            </div>
          </div>
        )}

        {managingSpace && (
          <ManageSpaceModal
            spaceId={managingSpace.id}
            spaceName={displaySpaceName(managingSpace.name)}
            myRole={managingSpace.myRole ?? "MEMBER"}
            currentUserId={currentUserId}
            onClose={() => setManagingSpace(null)}
            onRefresh={refresh}
            onDeleted={() => setManagingSpace(null)}
          />
        )}

        {viewingPublicSpace && (
          <PublicSpaceDetailModal
            space={viewingPublicSpace}
            onClose={() => setViewingPublicSpace(null)}
          />
        )}
      </div>
    </div>
  );
}
