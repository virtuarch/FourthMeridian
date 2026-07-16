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
import { AtlasLiquidCta } from "@/components/atlas/AtlasLiquidCta";
import { AtlasLiquidCard } from "@/components/atlas/AtlasLiquidCard";
import { useAtlasLiquid } from "@/components/atlas/useAtlasLiquid";
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
  () => import("@/components/space/manage/ManageSpaceModal").then((m) => m.ManageSpaceModal),
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
  // MC1 QA Q5 — this Space's OWN reporting currency for its card labels
  // (never the active Space's). Defaults to USD upstream.
  currency: string;
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

// PO1.0 — access-derived platform Spaces (one ACTIVE grant each). Rendered as
// a separate card group linking to the platform host; never a switch target.
type PlatformSpaceItem = {
  id:     string;
  name:   string;
  area:   string;
  access: string;
};

interface Props {
  mine: SpaceItem[];
  publicSpaces: SpaceItem[];
  pendingInvites: Invite[];
  currentUserId: string;
  activeSpaceId: string | null;
  preferredSpaceId: string | null;
  platformSpaces?: PlatformSpaceItem[];
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

// ── Space identity tint (Liquid cards) ────────────────────────────────────────
// Per-category IDENTITY colour used to tint the Liquid Space cards (and their
// Glass fallback). These are identity tints ONLY — they signal what kind of
// Space this is, never its health/state. Product-specified palette.
const SPACE_IDENTITY_TINT: Record<string, string> = {
  PERSONAL:       "#C89B3C",
  HOUSEHOLD:      "#4F8DFF",
  FAMILY:         "#4F8DFF",
  BUSINESS:       "#2FBF71",
  INVESTMENT:     "#8B6CFF",
  RETIREMENT:     "#8B6CFF",
  DEBT_PAYOFF:    "#D94A4A",
  GOAL:           "#E3B341",
  EMERGENCY_FUND: "#2AA6A6",
};
// Custom / Unknown / unmapped (PROPERTY, VEHICLE, TRIP, EQUIPMENT, CUSTOM,
// OTHER) fall back to a neutral slate so the identity read stays quiet.
const IDENTITY_TINT_NEUTRAL = "#64748B";
function spaceIdentityTint(category: string): string {
  return SPACE_IDENTITY_TINT[category] ?? IDENTITY_TINT_NEUTRAL;
}

// R4-b: the Liquid card's hue comes from the MATERIAL itself. Convert the
// identity hex into a shader `tintColor` (RGB multiplier), scaled so the
// brightest channel ≈ 1.05 — this preserves luminance while carrying the hue,
// so the tint reads as elegant coloured lighting rather than a flat fill.
function identityTintColor(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b) || 1;
  const scale = 1.05 / max;
  return [r * scale, g * scale, b * scale];
}
// Texture the Liquid material refracts for Space cards. The per-Space identity
// hue still applies on top (see SPACE_CARD_TINT_STRENGTH), so this only changes
// the refracted backdrop — the tint/hues are unchanged.
const SPACE_CARD_TEXTURE = "/atlas-card-nebula-v2.png";
// Raised from the frosted preset's ~0.1 so the identity hue is noticeably more
// apparent, while staying elegant (lighting/tint, not a solid fill).
const SPACE_CARD_TINT_STRENGTH = 0.42;

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
function Sparkline({
  values,
  tone,
  fullWidth = false,
}: {
  values: number[];
  tone: "positive" | "danger" | "neutral";
  fullWidth?: boolean;
}) {
  // `fullWidth` (R4-a): a wide, integrated trend band that stretches to the
  // card's width and lives lower in the card, vs. the compact inline chip.
  const w = fullWidth ? 240 : 80;
  const h = fullWidth ? 40 : 28;
  const pad = 3;

  if (values.length < 2) {
    return fullWidth
      ? <div className="w-full h-10" aria-hidden />
      : <div className="w-20 h-7 shrink-0" aria-hidden />;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y] as const;
  });
  const points = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  // Closed area under the line — a faint fill so the chart feels integrated
  // into the card rather than a floating line (fullWidth only).
  const area = `${pts[0][0].toFixed(1)},${h} ${points} ${pts[pts.length - 1][0].toFixed(1)},${h}`;
  const stroke =
    tone === "positive" ? "var(--emerald-400)" : tone === "danger" ? "var(--coral-400)" : "var(--text-secondary)";

  if (fullWidth) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-10" aria-hidden>
        <polygon points={area} fill={stroke} fillOpacity={0.1} stroke="none" />
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

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

  // Product override (Spaces overview): Space cards render on the sanctioned
  // Atlas **Liquid** material when supported, falling back to the Glass tile
  // below when not (useAtlasLiquid: no WebGL / prefers-reduced-transparency /
  // ?atlasLiquid=0). Liquid is an enhancement, never a dependency — the Glass
  // path stays a complete card. Interactions are identical on both paths.
  const liquid = useAtlasLiquid();
  const tint = spaceIdentityTint(category);

  // Per-category identity tint — a quiet corner wash only (never health/state).
  // R4-a: the coloured identity RING was removed — the card edge stays clean,
  // crisp, and neutral; colour comes from the material + the graphic, not the
  // outline. (Full material-native hue lands in R4-b.)
  const identityOverlay = (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[inherit]"
      style={{ background: `radial-gradient(118% 88% at 0% 0%, ${tint}22, transparent 58%)` }}
    />
  );

  // Card interior (identical on both material paths). Its own p-5/gap-4 padding
  // lives on the wrapping element below (AtlasLiquidCard zeroes content padding).
  const body = (
    <>
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

      {/* R4-a header — the Space NAME is the primary element; the graphic +
          type form a secondary identity row beneath it. */}
      <div className="relative">
        <div className="flex items-start gap-1.5">
          {/* Name: sharper/larger, strong white, tighter tracking (decision 10).
              line-clamp-2 keeps long names readable rather than truncated. */}
          <p
            className="flex-1 min-w-0 font-semibold text-[var(--text-primary)] tracking-[-0.01em] leading-snug line-clamp-2 break-words"
            style={{ fontSize: "clamp(0.9375rem, 0.86rem + 0.35vw, 1.0625rem)" }}
          >
            {displaySpaceName(space.name)}
          </p>
          {space.isPublic
            ? <Globe size={12} className="text-[var(--text-secondary)] shrink-0 mt-1" />
            : !isPersonal && <Lock size={12} className="text-[var(--text-secondary)] shrink-0 mt-1" />}
          {!interactive && (
            <span className="text-[9px] font-medium text-[var(--text-secondary)] shrink-0 mt-1">Not joined</span>
          )}
        </div>

        {/* Secondary identity row — small heavily-tinted glass graphic chip
            (same hue as the card identity, decision 7/8) beside the type. */}
        <div className="flex items-center gap-2 mt-2">
          <div
            className="relative w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 overflow-hidden text-white"
            style={{
              background: `linear-gradient(140deg, ${tint}66, ${tint}22)`,
              boxShadow: `inset 0 1px 0 rgba(255,255,255,.4), inset 0 0 0 1px ${tint}59, 0 2px 6px rgba(0,0,0,.3)`,
            }}
          >
            {/* Specular highlight — sells the "floating tinted glass" read. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-1/2"
              style={{ background: "linear-gradient(180deg, rgba(255,255,255,.28), transparent)" }}
            />
            <CategoryIcon name={CATEGORY_ICONS[category] ?? "LayoutDashboard"} />
          </div>
          <p className="text-xs font-medium text-[var(--text-secondary)] truncate">
            {CATEGORY_LABELS[category] ?? "Space"}
          </p>
        </div>
      </div>

      {/* Primary financial metric — number only; the chart lives lower now. */}
      <div className="relative">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)] mb-1">
          {metricLabelForCategory(category)}
        </p>
        <p className="text-[1.6rem] font-bold text-[var(--text-primary)] tabular-nums leading-none">
          {space.trend.length > 0 ? formatCurrency(space.netWorth, space.currency) : "—"}
        </p>
      </div>

      {/* Trend chart — every card, lower half, centered + widened, with a faint
          area fill so it reads as integrated into the card (decision 5). */}
      <div className="relative mt-auto">
        <Sparkline values={space.trend} tone={tone} fullWidth />
      </div>

      {/* Members + last updated + hover actions — no divider; spacing +
          type weight separate it (decision 6). */}
      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <MemberAvatars members={space.members} />
          <span className="text-[11px] text-[var(--text-secondary)] truncate">
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
    </>
  );

  // ── Liquid material path ──────────────────────────────────────────────────
  // Only when Liquid is supported AND the card is interactive (onOpen present).
  // AtlasLiquidCard owns the click/keyboard affordance (onClick + Enter/Space);
  // nested Manage/Crown buttons keep their e.stopPropagation() so they don't
  // also trigger onOpen. `group` for the hover reflections comes from
  // AtlasLiquidCard's shell.
  if (liquid && interactive && onOpen) {
    return (
      <AtlasLiquidCard
        onClick={onOpen}
        ariaLabel={displaySpaceName(space.name)}
        backgroundImage={SPACE_CARD_TEXTURE}
        tint={identityTintColor(tint)}
        tintStrength={SPACE_CARD_TINT_STRENGTH}
      >
        <div
          className={[
            "relative rounded-[20px] overflow-hidden p-5 flex flex-col gap-4",
            switching ? "opacity-60" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {identityOverlay}
          {body}
        </div>
      </AtlasLiquidCard>
    );
  }

  // ── Glass fallback path (no WebGL / reduced-transparency / ?atlasLiquid=0) ──
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
      {identityOverlay}
      {body}
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
          {space.trend.length > 0 ? formatCurrency(space.netWorth, space.currency) : "—"}
        </p>
        <p className="text-[9px] text-[var(--text-muted)] mt-0.5 truncate">
          {formatActivity(space.lastUpdated, space.createdAt)}
        </p>
      </div>
    </div>
  );
}

// Empty state for "Explore Public Spaces" when none exist. Framed by the SAME
// Atlas Liquid backdrop as the Space cards (same texture + a quiet neutral
// tint) so it belongs to the same family; falls back to a Glass panel when
// Liquid isn't supported (useAtlasLiquid). Static — no click affordance.
function PublicEmptyState() {
  const liquid = useAtlasLiquid();

  const content = (
    <div className="relative mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-12 text-center">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full"
        style={{
          background: "linear-gradient(140deg, rgba(125,168,255,.18), rgba(125,168,255,.05))",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,.3), inset 0 0 0 1px rgba(125,168,255,.26)",
        }}
      >
        <Globe size={20} className="text-[var(--meridian-300)]" />
      </div>
      <div>
        <p className="text-sm font-semibold text-[var(--text-primary)]">
          No public Spaces available yet
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">
          The community marketplace is just getting started. Check back soon to
          discover public Spaces, frameworks, and templates.
        </p>
      </div>
    </div>
  );

  if (liquid) {
    return (
      <AtlasLiquidCard
        ariaLabel="No public Spaces available yet"
        backgroundImage={SPACE_CARD_TEXTURE}
        tint={identityTintColor(IDENTITY_TINT_NEUTRAL)}
        tintStrength={SPACE_CARD_TINT_STRENGTH}
      >
        <div className="relative rounded-[20px] overflow-hidden">{content}</div>
      </AtlasLiquidCard>
    );
  }

  return (
    <GlassPanel depth="thin" elevation="e1" radius="lg">
      {content}
    </GlassPanel>
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
                  {space.trend.length > 0 ? formatCurrency(space.netWorth, space.currency) : "—"}
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

// ─── Platform card group (PO1.0) ──────────────────────────────────────────────
//
// Access-derived (from PlatformGrant); rendered only for grant-holders. Each
// card is a plain link to /dashboard/platform/[area] — NOT a switch target, so
// the ambient Space context never points at a platform Space. Visually quieter
// and distinct from customer Space cards (Shield glyph, access badge) so the two
// families never read as the same thing.

function PlatformSpaceGroup({ spaces }: { spaces: PlatformSpaceItem[] }) {
  const router = useRouter();
  if (spaces.length === 0) return null;

  return (
    <div className="mt-10">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)]">
        <Shield size={14} className="text-[var(--meridian-400)]" />
        Platform
      </h2>
      <p className="text-xs text-[var(--text-secondary)] mt-1 mb-3">
        Operational areas of Fourth Meridian you have been granted access to.
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-3">
        {spaces.map((p) => {
          const href = `/dashboard/platform/${p.area}`;
          return (
            <div
              key={p.id}
              onClick={() => router.push(href)}
              role="button"
              tabIndex={0}
              onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") router.push(href); }}
              className="group relative overflow-hidden rounded-[var(--radius-md)] border p-4 flex flex-col gap-3 cursor-pointer bg-[var(--surface-muted)] hover:bg-[var(--surface-hover)] border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] transition-[background-color,border-color]"
            >
              <div className="flex items-start justify-between gap-2">
                <div
                  className="w-8 h-8 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
                  style={{ background: "rgba(59,130,246,.12)", color: "var(--meridian-400)", border: "1px solid rgba(125,168,255,.24)" }}
                >
                  <Shield size={15} />
                </div>
                <span
                  className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border"
                  style={{ background: "var(--glass-ultrathin)", color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}
                >
                  {p.access}
                </span>
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-[var(--text-primary)] text-sm leading-snug truncate">
                  {displaySpaceName(p.name)}
                </p>
                <p className="text-[10px] text-[var(--text-muted)] mt-0.5">Platform area</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────
//
// Deliberately not a GlassPanel — a large boxed-in hero reads heavy and
// "admin dashboard"; floating the title directly over the Atlas Field is
// the lighter, breathable, visionOS-style treatment this page wants. No
// "current Space" status line under the title anymore — which Space is
// active is already obvious from the card grid below (tinted tile + no
// "Active" badge needed) and from the sidebar.
//
// P1 (overview redesign): the descriptive subtitle was removed — the Daily
// Brief owns greetings/framing, so the overview header stays to the point
// (just the "Spaces" title + the Create Space CTA top-right), letting the
// now-more-apparent Atlas Field carry the atmosphere.

function SpacesHeader({ onCreateSpace }: { onCreateSpace: () => void }) {
  // Phase 1 Liquid pilot — the single Create Space CTA is the one Spaces surface
  // that opts into the Liquid material; everything else stays Atlas Glass. Falls
  // back to the original GlassButton when Liquid isn't supported (useAtlasLiquid:
  // no WebGL / prefers-reduced-transparency / ?atlasLiquid=0). Behavior (opening
  // CreateSpaceModal via onCreateSpace) is identical on both paths.
  const liquid = useAtlasLiquid();
  return (
    <div className="pt-2 pb-8 md:pb-10 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
      <div>
        <h1 className="text-3xl md:text-[2.5rem] font-semibold tracking-tight text-[var(--text-primary)]">
          Spaces
        </h1>
      </div>
      {/* Opens CreateSpaceModal (mounted once from DashboardChrome.tsx) via the
          same "open-create-space" window event the Sidebar's row dispatches. */}
      {liquid ? (
        <AtlasLiquidCta
          onClick={onCreateSpace}
          ariaLabel="Create Space"
          fullWidth={false}
          className="shrink-0 sm:mt-1"
        >
          <Plus size={15} />
          <span>Create Space</span>
        </AtlasLiquidCta>
      ) : (
        <GlassButton onClick={onCreateSpace} tone="meridian" className="shrink-0 sm:mt-1">
          <Plus size={15} />
          Create Space
        </GlassButton>
      )}
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
  platformSpaces = [],
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
        // MC1 nav currency-staleness fix — the display-currency provider lives
        // in the shared /dashboard layout, which App Router does NOT re-run on
        // same-layout navigation. Without invalidating the Router Cache the
        // previous Space's currency would follow into the next Space until a
        // manual refresh. router.refresh() re-runs the layout with the new
        // active-Space cookie (parity with Sidebar.handleSwitch).
        router.refresh();
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
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium bg-emerald-500/10 border-emerald-500/30 text-[var(--accent-positive)]">
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

        {/* R4-a: the outer Glass "canvas" was removed — the Liquid Space cards
            are their own visual grouping and breathe directly in the page
            layout. auto-fit + minmax sizes columns off the content width; once
            two 280px-min cards can't sit side by side it drops to one column.
            min(280px,100%) keeps the floor from ever exceeding the container on
            narrow screens (no horizontal scroll). */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-4 md:gap-5">
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
          <div className="flex justify-center pt-6">
            <GlassButton tone="neutral" size="sm" onClick={() => setShowAllSpaces(true)}>
              Show {hiddenSpaceCount} more Space{hiddenSpaceCount === 1 ? "" : "s"}
              <ChevronDown size={13} />
            </GlassButton>
          </div>
        )}

        {/* PO1.0 — Platform group (access-derived; only shown to grant-holders). */}
        <PlatformSpaceGroup spaces={platformSpaces} />

        {/* Explore Public Spaces — ALWAYS rendered. When public Spaces exist,
            it shows the compact preview grid; when none exist, it shows an
            intentional, premium Atlas empty state (glass-framed) rather than
            hiding the section. Presentation-only — the underlying query/data
            are unchanged. */}
        <div className="mt-10">
          {/* Clickable heading -> /dashboard/spaces/public (the future full
              public directory). Title-case + text-primary matches the
              platform's other sub-section headings. */}
          <button
            type="button"
            onClick={() => router.push("/dashboard/spaces/public")}
            className="group flex items-center gap-1.5 text-sm font-semibold text-[var(--text-primary)] hover:text-[var(--meridian-400)] transition-colors"
          >
            Explore Public Spaces
            <ChevronRight size={14} className="text-[var(--text-muted)] group-hover:text-[var(--meridian-400)] group-hover:translate-x-0.5 transition-[color,transform]" />
          </button>
          <p className="text-xs text-[var(--text-secondary)] mt-1 mb-3">
            Discover ideas, track creators, and follow what matters.
          </p>

          {explorePublic.length > 0 ? (
            /* Roughly half the column width of the "My Spaces" grid above —
               compact, near-square previews. Capped to PUBLIC_CARD_LIMIT so
               this stays a quiet preview row, not a second full grid. */
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(140px,100%),1fr))] gap-3">
              {explorePublic.slice(0, PUBLIC_CARD_LIMIT).map((space) => (
                <PublicSpaceCard key={space.id} space={space} onOpen={() => setViewingPublicSpace(space)} />
              ))}
            </div>
          ) : (
            /* Premium Atlas empty state — framed by the SAME Liquid backdrop as
               the Space cards so it reads as part of the same family, not an
               error or missing data. */
            <PublicEmptyState />
          )}
        </div>

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
