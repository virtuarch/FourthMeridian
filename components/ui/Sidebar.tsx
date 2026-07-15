"use client";

/**
 * Sidebar
 *
 * Spaces-first navigation, restyled with Atlas Glass (Fourth Meridian
 * Design Language v1). Replaces the old flat Dashboard/Spaces/Analyze
 * list with the platform-shaped tree from the redesign brief:
 *
 *   Daily Brief
 *   ───────────
 *   Spaces
 *     • Personal
 *     • Chris & Rawan
 *     • Fourth Meridian LLC
 *     ...
 *     + Create Space
 *   ───────────
 *   AI
 *   Messages        (Soon)
 *   Market Intel    (Soon)
 *   Marketplace     (Soon)
 *   ───────────
 *   Settings
 *
 * There is no standalone "Dashboard" entry — a Space's dashboard is reached
 * by selecting that Space below, not via a separate nav item. There is also
 * no standalone "Spaces" entry — Spaces are inline here, with
 * /dashboard/spaces (SpacesClient) as the full landing page for managing,
 * creating, and exploring them.
 *
 * Backend note: this component still reads the existing `fintracker_space`
 * cookie and calls the existing /api/spaces, /api/space/switch and
 * /api/spaces/invites/pending routes verbatim — no API or schema changes.
 * The lightweight GET /api/spaces used here only selects {id,name,type},
 * so per-category icons (used on the Spaces cards) aren't available at this
 * call site; rows use a Personal/Shared icon distinction instead. Future
 * enhancement: add `category` to that route's select if per-Space icons in
 * the sidebar are wanted.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useEffect, useState, useCallback } from "react";
import {
  Sparkles,
  Home,
  Building2,
  Brain,
  Link2,
  MessageSquare,
  LineChart,
  Store,
  Settings as SettingsIcon,
  RefreshCw,
  LogOut,
  Pencil,
  Plus,
  Check,
  Loader2,
  AlertTriangle,
  Clock,
  LayoutGrid,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { useManualRefresh } from "@/components/plaid/useManualRefresh";
import { AppLogo } from "@/components/ui/AppLogo";
import { displaySpaceName } from "@/lib/format";
import {
  SPACE_LIST_CHANGED_EVENT,
  SPACE_INVITES_CHANGED_EVENT,
  OPEN_CREATE_SPACE_EVENT,
} from "@/lib/space-nav";

const COOKIE_NAME = "fintracker_space";
const INLINE_SPACE_LIMIT = 6;

function readSpaceCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

type SpaceItem = {
  id:      string;
  name:    string;
  type:    string;
  myRole?: string | null;
};

// PO1.0 — access-derived platform Spaces (one ACTIVE grant each). Plain links
// to /dashboard/platform/[area] — never a /api/space/switch target (the ambient
// Space context never points at a platform Space).
type PlatformItem = {
  id:           string;
  name:         string;
  platformArea: string;
  access:       string;
};

// ── Spaces nav section ──────────────────────────────────────────────────────
// Inline, always-expanded list (not a dropdown) — Spaces are a first-class
// nav concept now, not a page you have to go manage elsewhere. Caps at
// INLINE_SPACE_LIMIT rows so this scales from 1 Space to 50+ without the
// sidebar growing unbounded; the rest are one click away on /dashboard/spaces.

function SpacesNavSection({ pathname }: { pathname: string }) {
  const router = useRouter();
  const [spaces,         setSpaces]         = useState<SpaceItem[]>([]);
  const [platform,       setPlatform]       = useState<PlatformItem[]>([]);
  const [activeId,       setActiveId]       = useState<string | null>(null);
  const [switching,      setSwitching]      = useState<string | null>(null);
  const [pendingInvites, setPendingInvites] = useState(0);
  const [loaded,         setLoaded]         = useState(false);

  const loadSpaces = useCallback(async () => {
    try {
      const res = await fetch("/api/spaces");
      if (res.ok) {
        const data = await res.json();
        const mine: SpaceItem[] = (data.mine ?? []).map((w: SpaceItem) => ({
          id: w.id, name: w.name, type: w.type, myRole: w.myRole,
        }));
        setSpaces(mine);
        // PO1.0 — access-derived platform group (additive key; empty for users
        // with no grants, so this is a no-op for everyone else).
        setPlatform((data.platform ?? []).map((p: PlatformItem) => ({
          id: p.id, name: p.name, platformArea: p.platformArea, access: p.access,
        })));
        const cookieId = readSpaceCookie();
        if (cookieId && mine.some((w) => w.id === cookieId)) {
          setActiveId(cookieId);
        } else {
          // myRole === "OWNER" — defense in depth: PERSONAL Spaces are
          // single-owner by construction now, so this never highlights a
          // personal-type Space this user is merely a member of.
          setActiveId(mine.find((w) => w.type === "PERSONAL" && w.myRole === "OWNER")?.id ?? null);
        }
      }
    } catch {
      // non-fatal — section just renders empty
    }
    setLoaded(true);
  }, []);

  const loadInvites = useCallback(async () => {
    try {
      const res = await fetch("/api/spaces/invites/pending");
      if (res.ok) {
        const data = await res.json();
        setPendingInvites(data.count ?? 0);
      }
    } catch {
      // non-fatal
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadSpaces(); loadInvites(); }, [loadSpaces, loadInvites]);

  useEffect(() => {
    function handle() { loadSpaces(); loadInvites(); }
    window.addEventListener(SPACE_LIST_CHANGED_EVENT, handle);
    window.addEventListener(SPACE_INVITES_CHANGED_EVENT, handle);
    return () => {
      window.removeEventListener(SPACE_LIST_CHANGED_EVENT, handle);
      window.removeEventListener(SPACE_INVITES_CHANGED_EVENT, handle);
    };
  }, [loadSpaces, loadInvites]);

  async function handleSwitch(id: string) {
    if (id === activeId) { router.push("/dashboard"); return; }
    setSwitching(id);
    try {
      const res = await fetch("/api/space/switch", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ spaceId: id }),
      });
      if (res.ok) {
        setActiveId(id);
        window.dispatchEvent(new CustomEvent(SPACE_LIST_CHANGED_EVENT));
        router.refresh();
        router.push("/dashboard");
      }
    } finally {
      setSwitching(null);
    }
  }

  // myRole === "OWNER" — same defense-in-depth reasoning as above.
  const personal  = spaces.find((s) => s.type === "PERSONAL" && s.myRole === "OWNER");
  const others    = spaces.filter((s) => s.id !== personal?.id);
  const ordered   = personal ? [personal, ...others] : others;
  const inline    = ordered.slice(0, INLINE_SPACE_LIMIT);
  const overflow  = ordered.length - inline.length;
  const onSpaces  = pathname.startsWith("/dashboard/spaces");

  return (
    <div className="px-3">
      {/* Unlike Daily Brief/AI/Settings below, this top-level row never gets
          the filled pill/border treatment — only its text+icon color flips
          when active. The individual Space row beneath it already carries
          its own selected pill (bg-[rgba(59,130,246,.06)] + border), so
          giving this row the same pill made two "selected" pills stack on
          top of each other and compete for attention. Color-only keeps it a
          clickable nav row without out-competing the actual selected Space. */}
      <Link
        href="/dashboard/spaces"
        className={[
          "flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium transition-colors",
          onSpaces
            ? "text-[var(--meridian-400)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
        ].join(" ")}
      >
        <LayoutGrid size={17} strokeWidth={onSpaces ? 2.5 : 1.75} className="shrink-0" />
        <span className="flex-1">Spaces</span>
        {pendingInvites > 0 && (
          <span
            className="min-w-[16px] h-[16px] px-1 rounded-full text-white text-[9px] font-bold flex items-center justify-center"
            style={{ background: "var(--coral-500)" }}
          >
            {pendingInvites > 9 ? "9+" : pendingInvites}
          </span>
        )}
      </Link>

      <div className="mt-0.5 space-y-0.5">
        {!loaded ? (
          <div className="h-8 mx-2 rounded-lg animate-pulse" style={{ background: "var(--surface-muted)" }} />
        ) : (
          inline.map((space) => {
            const isActive   = space.id === activeId;
            const isBusy     = switching === space.id;
            const isPersonal = space.id === personal?.id;
            return (
              <button
                key={space.id}
                onClick={() => handleSwitch(space.id)}
                disabled={!!switching}
                className={[
                  "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left text-[13px] border transition-[background-color,border-color,color] disabled:opacity-60",
                  isActive
                    ? "text-[var(--text-primary)] bg-[rgba(59,130,246,.06)] border-[rgba(125,168,255,.16)]"
                    : "text-[var(--text-secondary)] border-transparent hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
                ].join(" ")}
              >
                <span className="shrink-0" style={{ color: isActive ? "var(--meridian-400)" : "var(--text-muted)" }}>
                  {isBusy
                    ? <Loader2 size={13} className="animate-spin" />
                    : isPersonal ? <Home size={13} /> : <Building2 size={13} />
                  }
                </span>
                {/* Name + presence dot grouped together so the dot reads as
                    a marker beside the Space's name, not an unrelated status
                    light pinned to the row's far edge. */}
                <span className="flex-1 min-w-0 flex items-center gap-1.5">
                  <span className="truncate">{displaySpaceName(space.name)}</span>
                  {isActive && (
                    <span
                      className="presence-dot w-[6px] h-[6px] rounded-full shrink-0"
                      style={{ background: "var(--emerald-400)" }}
                      aria-hidden
                    />
                  )}
                </span>
              </button>
            );
          })
        )}

        {overflow > 0 && (
          <Link
            href="/dashboard/spaces"
            className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-[13px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-colors"
          >
            <span className="w-[13px] shrink-0" />
            +{overflow} more Space{overflow === 1 ? "" : "s"}
          </Link>
        )}

        {/* Opens the shared CreateSpaceModal (mounted once from
            DashboardChrome.tsx) instead of navigating to /dashboard/spaces
            — Create Space is now a modal action reachable from anywhere,
            not just from the Spaces page. */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_CREATE_SPACE_EVENT))}
          className="w-full mt-1 flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--glass-ultrathin)] hover:bg-[var(--surface-hover-strong)] border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] hover:-translate-y-[1px] active:scale-[0.97] transition-[transform,background-color,border-color,color] duration-[var(--dur-base)] ease-[var(--ease-standard)]"
        >
          <Plus size={13} className="shrink-0" />
          Create Space
        </button>
      </div>

      {/* PO1.0 — Platform group. Access-derived (from data.platform); rendered
          only for grant-holders. Each row is a plain link to the platform host
          page — NO /api/space/switch call and NO ACTIVE_SPACE_COOKIE write, so
          the ambient Space context never points at a platform Space. */}
      {platform.length > 0 && (
        <div className="mt-3">
          <p className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Platform
          </p>
          <div className="space-y-0.5">
            {platform.map((p) => {
              const href     = `/dashboard/platform/${p.platformArea}`;
              const isActive = pathname === href;
              return (
                <Link
                  key={p.id}
                  href={href}
                  className={[
                    "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left text-[13px] border transition-[background-color,border-color,color]",
                    isActive
                      ? "text-[var(--text-primary)] bg-[rgba(59,130,246,.06)] border-[rgba(125,168,255,.16)]"
                      : "text-[var(--text-secondary)] border-transparent hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
                  ].join(" ")}
                >
                  <span className="shrink-0" style={{ color: isActive ? "var(--meridian-400)" : "var(--text-muted)" }}>
                    <Shield size={13} />
                  </span>
                  <span className="flex-1 min-w-0 truncate">{p.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Coming-soon platform row ────────────────────────────────────────────────
// Messages / Market Intel / Marketplace have no backing functionality yet.
// Presented inline (per the redesign brief) so the platform shape reads
// correctly today, without linking anywhere that 404s.

function ComingSoonRow({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div
      className="flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium cursor-default"
      style={{ color: "var(--text-muted)", opacity: 0.55 }}
    >
      <Icon size={17} strokeWidth={1.75} />
      <span className="flex-1">{label}</span>
      <span
        className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
        style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}
      >
        Soon
      </span>
    </div>
  );
}

// ── Refresh Data row ────────────────────────────────────────────────────────
// Wires to the same POST /api/plaid/refresh pipeline RefreshButton.tsx already
// calls from the topbar — this row previously rendered with no onClick at all.
// Reuses existing functionality only; no new backend surface.

function SidebarRefreshButton() {
  // Shared refresh/cooldown logic (same hook the topbar RefreshButton uses) so a
  // 200 where every item was on cooldown no longer shows a false "Synced".
  const { phase, banner, run } = useManualRefresh();

  const isError    = phase === "error";
  const isDone     = phase === "done" || phase === "partial";
  const isCooldown = phase === "cooldown";

  return (
    <div className="w-full">
      <button
        onClick={run}
        disabled={phase === "loading"}
        className={[
          "flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium border",
          "backdrop-blur-xl transition-[transform,background-color,border-color,color] duration-[var(--dur-base)] ease-[var(--ease-standard)]",
          "active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:active:scale-100",
          isError
            ? "text-[var(--coral-400)] bg-[rgba(237,82,71,.08)] hover:bg-[rgba(237,82,71,.14)] border-[rgba(237,82,71,.3)]"
            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--glass-ultrathin)] hover:bg-[var(--surface-hover-strong)] border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] hover:-translate-y-[1px]",
        ].join(" ")}
      >
        {phase === "loading" && <Loader2 size={17} className="animate-spin shrink-0" />}
        {isDone && <Check size={17} className="shrink-0 text-[var(--emerald-400)]" />}
        {isError && <AlertTriangle size={17} className="shrink-0" />}
        {isCooldown && <Clock size={17} strokeWidth={1.75} className="shrink-0 text-[var(--text-muted)]" />}
        {phase === "idle" && <RefreshCw size={17} strokeWidth={1.75} className="shrink-0" />}
        {phase === "loading"
          ? "Refreshing…"
          : phase === "done"
          ? "Synced"
          : phase === "partial"
          ? "Partial sync"
          : isCooldown
          ? "On cooldown"
          : isError
          ? "Failed — retry"
          : "Refresh Data"}
      </button>

      {banner && (
        <p
          role="status"
          className="mt-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-muted)] text-[11px] font-medium text-[var(--text-secondary)]"
        >
          {banner}
        </p>
      )}
    </div>
  );
}

// ── Main Sidebar ─────────────────────────────────────────────────────────────

export function Sidebar() {
  const path               = usePathname();
  const { data: session }  = useSession();

  const user     = session?.user;
  const initial  = (user?.name ?? user?.email ?? "?")[0].toUpperCase();
  const username = user?.username ? `@${user.username}` : null;

  const isBrief       = path === "/dashboard/brief";
  const isAI          = path.startsWith("/dashboard/analyze");
  const isConnections = path.startsWith("/dashboard/connections");
  const isSettings    = path.startsWith("/dashboard/settings");

  return (
    // `self-start` is the load-bearing part of this className: the parent
    // layout (DashboardChrome.tsx's outer `flex min-h-screen` row) defaults
    // every flex child to `align-items: stretch`, which silently stretches
    // this <aside> to match the height of the main content column next to
    // it — on any page taller than one viewport, that makes the aside's own
    // box as tall as the whole document. A `position: sticky` element can't
    // visibly stick once its box is already that tall (there's no room left
    // for it to "catch up" to the viewport as you scroll), so the logo row
    // below — and the rest of the rail — would just scroll away with the
    // page instead of pinning. `self-start` opts this element out of the
    // stretch, so `min-h-screen` + `sticky top-0` actually pin it at exactly
    // one viewport height, which is what lets the brand row line up with
    // and stay locked to DashboardChrome's sticky desktop header as the
    // page scrolls underneath both.
    <aside
      className="hidden lg:flex flex-col w-64 shrink-0 self-start min-h-screen sticky top-0"
      style={{
        borderRight:     "1px solid var(--border-hairline)",
        background:      "var(--glass-ultrathin)",
        backdropFilter:  "blur(30px) saturate(160%)",
      }}
    >
      {/* Logo — exact placement/sizing preserved; only the parent <aside>'s
          stretch behavior above changed, not this row. */}
      <div
        className="flex items-center gap-2 px-5 h-14 shrink-0"
        style={{ borderBottom: "1px solid var(--border-hairline)" }}
      >
        <AppLogo size={32} withWordmark wordmarkClassName="text-[var(--text-primary)] text-lg" priority />
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 space-y-5">
        <div className="px-3">
          <Link
            href="/dashboard/brief"
            className={[
              "flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium border transition-[background-color,border-color,color]",
              isBrief
                ? "text-[var(--meridian-400)] bg-[rgba(59,130,246,.06)] border-[rgba(125,168,255,.16)]"
                : "text-[var(--text-secondary)] border-transparent hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
            ].join(" ")}
          >
            <Sparkles size={17} strokeWidth={isBrief ? 2.5 : 1.75} />
            Daily Brief
          </Link>
        </div>

        <div className="mx-5 h-px" style={{ background: "var(--border-hairline)" }} />

        <SpacesNavSection pathname={path} />

        <div className="mx-5 h-px" style={{ background: "var(--border-hairline)" }} />

        <div className="px-3 space-y-0.5">
          <Link
            href="/dashboard/connections"
            className={[
              "flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium border transition-[background-color,border-color,color]",
              isConnections
                ? "text-[var(--meridian-400)] bg-[rgba(59,130,246,.06)] border-[rgba(125,168,255,.16)]"
                : "text-[var(--text-secondary)] border-transparent hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
            ].join(" ")}
          >
            <Link2 size={17} strokeWidth={isConnections ? 2.5 : 1.75} />
            Connections
          </Link>
          <Link
            href="/dashboard/analyze"
            className={[
              "flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium border transition-[background-color,border-color,color]",
              isAI
                ? "text-[var(--meridian-400)] bg-[rgba(59,130,246,.06)] border-[rgba(125,168,255,.16)]"
                : "text-[var(--text-secondary)] border-transparent hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
            ].join(" ")}
          >
            <Brain size={17} strokeWidth={isAI ? 2.5 : 1.75} />
            AI
          </Link>
          <ComingSoonRow icon={MessageSquare} label="Messages" />
          <ComingSoonRow icon={LineChart} label="Market Intel" />
          <ComingSoonRow icon={Store} label="Marketplace" />
        </div>

        <div className="mx-5 h-px" style={{ background: "var(--border-hairline)" }} />

        <div className="px-3">
          <Link
            href="/dashboard/settings"
            className={[
              "flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium border transition-[background-color,border-color,color]",
              isSettings
                ? "text-[var(--meridian-400)] bg-[rgba(59,130,246,.06)] border-[rgba(125,168,255,.16)]"
                : "text-[var(--text-secondary)] border-transparent hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
            ].join(" ")}
          >
            <SettingsIcon size={17} strokeWidth={isSettings ? 2.5 : 1.75} />
            Settings
          </Link>
        </div>
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-5 pt-3 space-y-1" style={{ borderTop: "1px solid var(--border-hairline)" }}>
        <SidebarRefreshButton />

        <button
          onClick={async () => { await signOut({ redirect: false }); window.location.href = "/login"; }}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
        >
          <LogOut size={17} strokeWidth={1.75} />
          Sign Out
        </button>

        {/* User identity */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{ background: "rgba(59,130,246,.16)", border: "1px solid rgba(125,168,255,.3)" }}
          >
            <span className="text-xs font-semibold" style={{ color: "var(--meridian-400)" }}>{initial}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-[var(--text-primary)] truncate">{user?.name ?? "—"}</p>
            <p className="text-xs text-[var(--text-muted)] truncate">{username ?? user?.email}</p>
          </div>
          <Link
            href="/dashboard/settings"
            className="p-1.5 rounded-lg transition-colors shrink-0"
            style={{ color: "var(--text-muted)" }}
            title="Edit profile"
          >
            <Pencil size={12} />
          </Link>
        </div>
      </div>
    </aside>
  );
}
