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
 *   (v2.7 P2: the Explore public Spaces row was removed — infrastructure kept)
 *   Create Space — persistent right-side panel (scrolls with the page,
 *   per Phase G — no longer sticky)
 *
 * Backend is untouched: same /api/spaces and /api/space/switch
 * endpoints, and the same `space-list-changed` /
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
  Sunset, Building2, Shield, ArrowUpRight, AlertTriangle,
} from "lucide-react";
import { Surface, Figure } from "@/components/atlas/Surface";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { GlassButton } from "@/components/atlas/GlassButton";
import {
  CATEGORY_LABELS,
  CATEGORY_ICONS,
  SpaceCategory,
} from "@/lib/space-presets";
import { DEFAULT_DISPLAY_CURRENCY, compactCurrencyOptions } from "@/lib/currency";
import { displaySpaceName } from "@/lib/format";
import { effectiveDefaultSpaceId } from "@/lib/spaces/default-space";
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
  /** REVIEW-3 B-4 — true when the figure shown is a reconstruction/estimate
   *  (row isEstimated, or display-converted off its stamp). Renders the ≈
   *  marker so a reconstructed value never poses as an observation. */
  estimated?: boolean;
  lastUpdated: string | null;
  /** v2.6-L4F — the canonical 1M change, from the SAME authority the inside-Space
   *  view uses. Null when the Space's history does not reach back a month. */
  change?: {
    fromDate: string; toDate: string; fromValue: number; toValue: number;
    // v2.6-WINDOW-1 — widened with the authority (canonicalWindowChange is no
    // longer month-only). Still PAST_MONTH for this card; the card renders the
    // window it is GIVEN rather than assuming which one arrived.
    pct: number | null; abs: number; preset: string;
  } | null;
  /** v2.6-L4F — ACCOUNT freshness (Slice 1). Null when the Space has no accounts. */
  freshness?: {
    label: string; anchorObservedAt: string | null; qualifier: string | null;
    claim: string; accountCount: number; staleAccountCount: number;
  } | null;
};

type Invite = {
  id: string;
  role: string;
  createdAt: string;
  seenAt: string | null;
  space: { id: string; name: string; description: string | null; isPublic: boolean };
  invitedBy: { id: string; name: string | null; username: string | null };
};

// UX-P2 (decision N1) — the access-derived Platform Spaces no longer render
// here. Their one home is the Platform Spaces directory
// (app/(shell)/dashboard/platform, components/platform/PlatformSpaceDirectory),
// reached through the GlobalHeader's context switch. This launcher is the
// PERSONAL directory only.

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

// ── Space identity tint (Liquid cards) ────────────────────────────────────────
// Per-category IDENTITY colour used to tint the Liquid Space cards (and their
// Glass fallback). These are identity tints ONLY — they signal what kind of
// Space this is, never its health/state. Product-specified palette.
const SPACE_IDENTITY_TINT: Record<string, string> = {
  PERSONAL:       "#C89B3C",
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

/**
 * v2.6-L4F — the card's freshness line, from the Slice 1 ACCOUNT-freshness
 * authority. It used to read `formatActivity(space.lastUpdated, …)` where
 * `lastUpdated` was the latest SNAPSHOT date — i.e. when we last computed, not
 * when any balance was observed. Falls back to the creation date only when the
 * Space has no accounts at all, which is an honest "nothing to observe yet".
 */
function formatFreshness(space: SpaceItem): string {
  const f = space.freshness;
  if (!f) return `Created ${formatRelative(space.createdAt)}`;
  if (f.anchorObservedAt === null) return f.label;
  return `${f.label} ${formatRelative(f.anchorObservedAt)}`;
}

/** Relative wording only — the VERB is supplied by the caller's authority, so a
 *  card can never say "Updated" about a clock that did not update anything. */
function formatRelative(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
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

// ─── Space Row (editorial) ────────────────────────────────────────────────────
//
// The launcher is a LIST of rooms you already own, not a grid of products to
// browse (prototype Launcher.tsx). Each Space is one editorial row on a solid
// Atlas Surface — "solid surfaces carry information" — carrying identity on the
// left, its own trend + one real figure on the right, and an enter affordance.
// No Liquid/Glass material here: reading a number wants a still surface, and a
// launcher's whole job is to be a quiet threshold.
//
// Nothing about the DATA changed — same SpaceItem, same handlers, same
// cookie-switch on click. Only the presentation moved from tile to row.

// Compact money for the row figure so long balances (S$1,284,320) read as
// S$1.3M and never wrap the right column. Same currency, same source number.
// The Intl options are lib/currency's pinned compact contract — this stays the
// launcher's own formatter (never the cents one), with no runtime defaults.
function formatCurrencyCompact(value: number, currency = DEFAULT_DISPLAY_CURRENCY) {
  return new Intl.NumberFormat("en-US", compactCurrencyOptions(currency, 1)).format(value);
}

// v2.6-L4F — `trendDeltaPct(trend)` was REMOVED. It ran over the last 14 SNAPSHOT
// ROWS, which is neither a month nor 30 days nor any window the product defines,
// and it therefore disagreed with the inside-Space view for the same Space on the
// same day (25.0% outside vs 49.2% inside on the live corpus). The percentage now
// comes from `space.change`, resolved server-side through the canonical
// PAST_MONTH authority — the same one the inside hero consumes. The sparkline
// keeps using `trend`, because a sparkline is a shape, not a claim.

function SpaceCard({
  space,
  isActive,
  isDefault,
  isPersonal,
  interactive = true,
  onOpen,
  onManage,
  switching,
}: {
  space: SpaceItem;
  isActive?: boolean;
  isDefault?: boolean;
  isPersonal?: boolean;
  interactive?: boolean;
  onOpen?: () => void;
  onManage?: () => void;
  switching?: boolean;
}) {
  const canManage = interactive && !!onManage && ["OWNER", "ADMIN"].includes(space.myRole ?? "") && !isPersonal;
  const tone: "positive" | "danger" | "neutral" =
    space.trend.length >= 2
      ? space.trend[space.trend.length - 1] >= space.trend[0] ? "positive" : "danger"
      : "neutral";
  const category = space.category as SpaceCategory;
  const tint = spaceIdentityTint(category);
  const hasFigure = space.trend.length > 0;
  // v2.6-L4F — the canonical 1M change, resolved server-side. Never re-derived
  // here: a percentage computed in React is a second authority by construction.
  const delta = space.change?.pct ?? null;
  const isShared = space.type === "SHARED";

  // The whole left/centre/figure region is one enter affordance (onOpen →
  // cookie switch). Crown/Manage are SIBLINGS of that button, never nested
  // inside it (no button-in-button), so they keep their own click targets.
  const openable = interactive && !!onOpen;

  return (
    <Surface
      as="li"
      className={[
        "group relative flex items-stretch overflow-hidden transition-colors duration-[var(--dur-base)] ease-[var(--ease-standard)]",
        isActive ? "border-[rgba(125,168,255,.4)]" : "hover:border-[var(--border-hairline-strong)]",
        switching ? "opacity-60" : "",
      ].filter(Boolean).join(" ")}
    >
      {/* Active accent — a quiet left rail, not a fill; identity stays neutral. */}
      {isActive && (
        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: "var(--meridian-400)" }} />
      )}

      <button
        type="button"
        onClick={openable ? onOpen : undefined}
        disabled={!openable}
        aria-label={openable ? `Enter ${displaySpaceName(space.name)}` : displaySpaceName(space.name)}
        className="flex min-w-0 flex-1 items-center gap-4 p-4 text-left sm:gap-5 sm:p-5 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] focus-visible:ring-inset"
      >
        {/* Identity chip — the one place category colour appears (identity only,
            never state), a small tinted glass swatch echoing the prototype. */}
        <div
          className="relative hidden size-9 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] text-white sm:flex"
          style={{
            background: `linear-gradient(140deg, ${tint}66, ${tint}22)`,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,.4), inset 0 0 0 1px ${tint}59`,
          }}
        >
          <CategoryIcon name={CATEGORY_ICONS[category] ?? "LayoutDashboard"} />
        </div>

        {/* Name + one meta line — the reading axis. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-semibold text-[var(--text-primary)] tracking-[-0.01em]">
              {displaySpaceName(space.name)}
            </h2>
            {isActive && <RowChip tone="accent">Active</RowChip>}
            {isShared && <RowChip>Shared</RowChip>}
            {space.isPublic
              ? <Globe size={12} className="shrink-0 text-[var(--text-muted)]" />
              : !isPersonal && <Lock size={12} className="shrink-0 text-[var(--text-muted)]" />}
            {!interactive && (
              <span className="shrink-0 text-[10px] font-medium text-[var(--text-muted)]">Not joined</span>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
            {CATEGORY_LABELS[category] ?? "Space"}
            {" · "}{space.members.length} member{space.members.length === 1 ? "" : "s"}
            {" · "}{formatFreshness(space)}
          </p>
        </div>

        {/* Trend — hidden on mobile where the row is already tight. */}
        <div className="hidden w-24 shrink-0 md:block">
          <Sparkline values={space.trend} tone={tone} fullWidth />
        </div>

        {/* One real figure + its derived change. Money is neutral (a number is
            not a claim); only the delta carries gain/loss colour. */}
        <div className="shrink-0 text-right">
          {/* REVIEW-3 B-4 — ≈ marks a reconstructed/estimated figure (the same
              provenance the inside-Space history badges disclose). */}
          <Figure value={hasFigure ? `${space.estimated ? "≈" : ""}${formatCurrencyCompact(space.netWorth, space.currency)}` : "—"} size="lede" />
          {delta !== null && (
            <p className={["tabular-nums mt-0.5 text-[11px]", delta >= 0 ? "text-[var(--accent-positive)]" : "text-[var(--accent-negative)]"].join(" ")}>
              {delta >= 0 ? "+" : ""}{delta.toFixed(1)}%
            </p>
          )}
        </div>

        <ArrowUpRight
          size={15}
          aria-hidden
          className="shrink-0 text-[var(--text-muted)] transition-[transform,color] duration-[var(--dur-base)] ease-[var(--ease-standard)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-[var(--text-secondary)]"
        />
      </button>

      {/* Row actions — siblings of the enter button, revealed on hover/focus.
          The crown is an INDICATOR only. Choosing the default Space lives in
          ONE place — Settings → Preferences → Default Space — so this row no
          longer carries a second "Set as default Space" control. */}
      {interactive && (isDefault || canManage) && (
        <div className="flex items-center gap-0.5 pr-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {isDefault && (
            <span title="Default landing Space" className="p-1.5">
              <Crown size={13} className="text-[var(--brass-400)]" />
            </span>
          )}
          {canManage && (
            <button
              onClick={onManage}
              title="Manage Space"
              className="rounded-[var(--radius-xs)] p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover-strong)] hover:text-[var(--text-primary)]"
            >
              <Pencil size={13} />
            </button>
          )}
        </div>
      )}
    </Surface>
  );
}

// A quiet inline badge — the prototype's `Chip` for "Shared"/"Active" identity
// marks. Not the Atlas radiogroup Chips (that's a switcher); this is a label.
function RowChip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "accent" }) {
  return (
    <span
      className={[
        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        tone === "accent"
          ? "border-[rgba(125,168,255,.34)] text-[var(--meridian-300)]"
          : "border-[var(--border-hairline)] text-[var(--text-muted)]",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

// ─── (v2.7 P2) Public Space discovery UI removed ─────────────────────────────
// The Explore Public Spaces row, its cards, empty state and detail modal are
// gone from My Spaces. Public-Space schema, data, `publicSpaces` loading and
// server authorization are unchanged (infrastructure kept).

// ─── Pending invite row + banner ──────────────────────────────────────────────

function InviteRow({ invite, onAction }: { invite: Invite; onAction: () => void }) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [done, setDone] = useState(false);
  // UI-006 — a refused accept/decline used to leave the row unchanged in silence.
  const [error, setError] = useState<string | null>(null);

  async function act(action: "accept" | "decline") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/spaces/${invite.space.id}/invites/${invite.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) { setDone(true); onAction(); }
      else {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? `Couldn't ${action} this invite. Try again.`);
      }
    } catch {
      setError(`Couldn't reach Fourth Meridian — the invite was not ${action === "accept" ? "accepted" : "declined"}.`);
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
        {error && <p role="alert" className="mt-0.5 text-xs text-[var(--coral-400)]">{error}</p>}
      </div>
      <button
        onClick={() => act("decline")}
        disabled={!!busy}
        className="p-1.5 rounded-[var(--radius-xs)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover-strong)] disabled:opacity-50 transition-colors shrink-0"
        title="Decline"
        aria-label={`Decline invite to ${displaySpaceName(invite.space.name)}`}
      >
        {busy === "decline" ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <X size={14} aria-hidden />}
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
// "Active" badge needed) and from the sidebar.
//
// P1 (overview redesign): the descriptive subtitle was removed — the Daily
// Brief owns greetings/framing, so the overview header stays to the point
// (just the "Spaces" title + the Create Space CTA top-right), letting the
// now-more-apparent Atlas Field carry the atmosphere.

function SpacesHeader({ onCreateSpace }: { onCreateSpace: () => void }) {
  // v2.7 P2 — the Create Space CTA uses the site's canonical button (Atlas
  // GlassButton, meridian = primary), not the Liquid WebGL pilot material.
  // Behavior (opening CreateSpaceModal via onCreateSpace) is unchanged.
  return (
    <div className="pt-2 pb-8 md:pb-10 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-5">
      <div className="min-w-0">
        <h1 className="text-3xl md:text-[2.5rem] font-semibold tracking-tight text-[var(--text-primary)]">
          Spaces
        </h1>
        {/* Manifesto — the launcher's one line of framing (prototype
            Launcher.tsx). Each Space is a walled financial world. */}
        <p className="mt-1.5 text-sm text-[var(--text-secondary)] max-w-md">
          Each Space is a separate financial world. Nothing leaks between them.
        </p>
      </div>
      {/* Opens CreateSpaceModal (mounted once from DashboardChrome.tsx) via the
          same "open-create-space" window event the Sidebar's row dispatches. */}
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
  pendingInvites,
  currentUserId,
  activeSpaceId: initialActiveId,
  preferredSpaceId: initialPreferredId,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [activeId, setActiveId]               = useState<string | null>(initialActiveId);
  const [switchingId, setSwitchingId]          = useState<string | null>(null);
  // UI-006 — a refused Space switch used to do nothing visible.
  const [switchError, setSwitchError]          = useState<string | null>(null);
  const [managingSpace, setManagingSpace]      = useState<SpaceItem | null>(null);
  const [showAllSpaces, setShowAllSpaces]      = useState(false);
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
    setSwitchError(null);
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
      } else {
        const d = await res.json().catch(() => ({}));
        setSwitchError(d.error ?? "Couldn't open that Space. Try again.");
      }
    } catch {
      setSwitchError("Couldn't reach Fourth Meridian — the Space was not opened.");
    } finally {
      setSwitchingId(null);
    }
  }, [router]);

  const personal = mine.find((w) => w.type === "PERSONAL" && w.myRole === "OWNER");
  const others   = mine.filter((w) => w.id !== personal?.id);
  const ordered  = personal ? [personal, ...others] : others;
  // Display only — the Space resolveSpaceContext would land on with no cookie:
  // the preference while it names a Space still in `mine`, else personal.
  const defaultId = effectiveDefaultSpaceId(initialPreferredId, mine.map((w) => w.id), personal?.id ?? null);

  // Caps the initial grid so the canvas reads the same whether someone has
  // 1 Space or 50+ — the rest are one click away via "Show N more" instead
  // of an ever-growing scroll.
  const CARD_LIMIT = 6;
  const visibleSpaces = showAllSpaces ? ordered : ordered.slice(0, CARD_LIMIT);
  const hiddenSpaceCount = ordered.length - visibleSpaces.length;

  const resolvedActiveId = (activeId && mine.some((w) => w.id === activeId)) ? activeId : personal?.id ?? null;

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

        {switchError && (
          <p role="alert" className="mb-3 flex items-center gap-1.5 text-xs text-[var(--coral-400)]">
            <AlertTriangle size={12} aria-hidden /> {switchError}
          </p>
        )}

        {/* A LIST, not a grid — rooms you already own, on one reading axis
            (prototype Launcher.tsx). Each row is a solid Atlas Surface; the
            personal Space is pinned first upstream (`ordered`). */}
        <ul className="space-y-2.5">
          {visibleSpaces.map((space) => (
            <SpaceCard
              key={space.id}
              space={space}
              isActive={resolvedActiveId === space.id}
              isDefault={defaultId === space.id}
              isPersonal={space.id === personal?.id}
              onOpen={() => handleOpen(space)}
              onManage={() => setManagingSpace(space)}
              switching={switchingId === space.id}
            />
          ))}
        </ul>

        {hiddenSpaceCount > 0 && (
          <div className="flex justify-center pt-6">
            <GlassButton tone="neutral" size="sm" onClick={() => setShowAllSpaces(true)}>
              Show {hiddenSpaceCount} more Space{hiddenSpaceCount === 1 ? "" : "s"}
              <ChevronDown size={13} />
            </GlassButton>
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

      </div>
    </div>
  );
}
