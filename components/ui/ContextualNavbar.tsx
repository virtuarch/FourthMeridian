"use client";

/**
 * components/ui/ContextualNavbar.tsx
 *
 * The one desktop sidebar (prototype DS-4 §6 — components/shell/Sidebar.tsx).
 *
 * SITE NAVIGATION IS CONSTANT; the sidebar's CONTEXT block is what transforms.
 * `PrimaryNav` — the five primary destinations (Brief · My Space · AI · Spaces ·
 * Connections — lib/space-nav PRIMARY_NAV, the same list the mobile BottomNav
 * renders; Settings is in the account menu, not here) — is rendered FIRST in
 * BOTH modes, by one component, so entering a Space never takes Fourth Meridian
 * away. It used to live inside global mode only, and the two modes were an
 * either/or: the moment a Space published itself into SpaceChrome the site nav
 * was unmounted, and desktop (where BottomNav is hidden) had no way to another
 * destination except out through the launcher.
 *
 *   global   — on the launcher and every non-Space route: the site nav, plus any
 *              platform-HQ destinations the user is granted.
 *   space    — inside a Space (published through SpaceChrome by SpaceDashboard):
 *              the site nav, THEN — under a hairline, so the hierarchy reads
 *              site → Space → workspace — the Space's display-currency +
 *              Manage controls, its identity, and the Space's workspace
 *              destinations: Net Worth · Cash Flow · Markets. There is NO
 *              Sections list inside a customer Space (the page-anchor list was
 *              retired in favour of workspace-level destinations). Inside a
 *              PLATFORM Space the SAME workspace block carries that area's
 *              workspaces (Overview · Jobs · Policies … — UX-P1 Change B: the
 *              host publishes them through the one `workspaceNav` channel, so
 *              at lg+ the sidebar is the primary switcher and the in-content
 *              rail serves smaller screens), THEN the open workspace's section
 *              anchors, THEN the same access-derived Platform destinations
 *              global mode shows, so the operator can move between HQ Spaces
 *              without first leaving to the launcher.
 *
 * UX-P2 Phase B — THE PLATFORM CONTEXT. Both modes additionally read the
 * navigation CONTEXT (lib/space-nav `navContext`: a route fact). On the
 * platform axis — the Platform Spaces directory (/dashboard/platform, global
 * mode) and inside a Platform Space (space mode) — the ORDER changes:
 *
 *   platform — Platform Operations 2.0 R1: the THREE Platform destinations
 *              (PlatformDestinationsNav: Overview · AI · Current Space, the
 *              same list as the mobile bar, lib/platform/nav) LEAD, with the
 *              Space switcher nested under Current Space; then, inside a
 *              Platform Space, the Space block + its Sections as above; then a
 *              single "Personal Spaces" exit row back to the launcher.
 *              P-1 (owner-approved separate Platform shell, 2026-10-27): the
 *              personal site nav is NO LONGER rendered in the platform context
 *              (it was retained, demoted, under Phase B). The way back is one
 *              click on every width: the exit row here and the header's
 *              Personal | Platform switch. Personal context is unchanged byte
 *              for byte (components/ui/personal-nav-baseline.test.ts).
 *
 * PrimaryNav is still mounted exactly twice in source (once per mode, both on
 * the personal context), PlatformNav once (the personal sidebar's way in),
 * PlatformContextNav twice (once per mode, platform context), PRIMARY_NAV mapped
 * once, /api/spaces fetched once (personal context only). Inside a PERSONAL Space nothing changes (D2: no
 * operator door in a member's room).
 *
 * Both modes share DOM position and the left-accent-bar selection idiom, so
 * moving between them reads as the sidebar re-resolving, not one panel replacing
 * another. This REPLACES the former components/ui/Sidebar.tsx, whose persistent
 * global tree, inline Spaces list, footer Refresh/Sign-out and brand row are all
 * retired — brand → GlobalHeader, Refresh/identity/Sign-out → GlobalActions,
 * the in-Space identity/FX/Manage/workspaces → Space mode here.
 *
 * Navigation is route-based (production uses real routes, not the prototype's
 * single-page state), so the mobile presentation of this SAME model is
 * BottomNav — the two are one navigation model, two responsive presentations.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  House,
  Layers,
  Newspaper,
  Sparkles,
  Link2,
  Shield,
  ChartCandlestick,
  Gem,
  LayoutGrid,
  LogOut,
  Waves,
  Receipt,
  LayoutDashboard,
  TriangleAlert,
  ScrollText,
  UserCog,
  Timer,
  PlugZap,
  History,
  Gauge,
  RefreshCw,
  SlidersHorizontal,
  Check,
  type LucideIcon,
} from "lucide-react";
import {
  useSpaceChrome,
  type SpaceChromeSpace,
  type SpaceChromeSection,
  type SpaceChromeWorkspaceNav,
} from "@/lib/space/space-chrome-context";
import { SpaceControls } from "@/components/space/shell/SpaceControls";
import {
  PRIMARY_NAV,
  isPrimaryDestActive,
  navContext,
  primaryHref,
  type PrimaryDestId,
} from "@/lib/space-nav";
import { isPlatformAiPath, platformDestinations, type PlatformDestinationId, type PlatformSpaceOption } from "@/lib/platform/nav";
import { platformAreaHref } from "@/lib/platform/directory";
import { usePlatformNav } from "@/components/ui/PlatformNavContext";
import {
  SPACE_LIST_CHANGED_EVENT,
  SPACE_INVITES_CHANGED_EVENT,
} from "@/lib/space-nav";

const NAV_ICONS: Record<PrimaryDestId, LucideIcon> = {
  brief: Newspaper,
  myspace: House,
  ai: Sparkles,
  spaces: Layers,
  connections: Link2,
};

/**
 * Workspace icons — the perspective library's own (lib/perspectives: wealth
 * "Gem", cashFlow "Waves", markets "ChartCandlestick"), so the sidebar and the
 * lens identity agree. Keyed by
 * the lens id the host publishes; an unknown id renders without an icon rather
 * than borrowing one.
 */
const WORKSPACE_ICONS: Record<string, LucideIcon> = {
  networth: Gem,
  cashFlow: Waves,
  spending: Receipt,
  markets: ChartCandlestick,
};

/**
 * Workspace icons by Lucide NAME — for a host that publishes each item's icon
 * as the contract's string (a Platform Space: lib/platform/workspaces.ts
 * `icon`, carried as `MountWorkspaceSummary.icon`). The sidebar resolves the
 * name here and never imports a domain module to find it; an unknown name
 * renders without an icon rather than borrowing one.
 */
const WORKSPACE_ICONS_BY_NAME: Record<string, LucideIcon> = {
  LayoutDashboard, Timer, PlugZap, History, Sparkles, Gauge, RefreshCw, SlidersHorizontal,
  // Platform redesign — Customer Success › Incidents.
  TriangleAlert,
  // Platform redesign — Security › Audit, Security › Operator actions.
  ScrollText, UserCog,
};

/** The row icon: the published icon NAME first, else the id-keyed lens map. */
function workspaceIcon(item: { id: string; icon?: string }): LucideIcon | undefined {
  return (item.icon ? WORKSPACE_ICONS_BY_NAME[item.icon] : undefined) ?? WORKSPACE_ICONS[item.id];
}

export type PlatformItem = { id: string; name: string; platformArea: string };

/** The ONLY route that renders a platform HQ Space (app/(shell)/dashboard/platform/[area]). */
const PLATFORM_ROUTE_PREFIX = "/dashboard/platform/";

/**
 * Is the current route a platform HQ Space?
 *
 * This is a ROUTE fact, not an access fact: it answers "which axis is the
 * operator standing on", never "may they see anything". Visibility of the
 * Platform list still comes exclusively from the access-derived `/api/spaces`
 * response (`data.platform`, built from ACTIVE PlatformGrant rows), so a route
 * that is not granted redirects long before this matters.
 */
export function isPlatformSpaceRoute(pathname: string | null | undefined): boolean {
  // R1 — /dashboard/platform/ai is a Platform DESTINATION (the AI page), not a
  // Space: it sits under the same prefix but is a static route, never an area.
  return typeof pathname === "string" && pathname.startsWith(PLATFORM_ROUTE_PREFIX) && !isPlatformAiPath(pathname);
}

/**
 * The access-derived platform destinations, from the ONE source both sidebar
 * modes read: `GET /api/spaces` → `data.platform`, which the route derives from
 * the caller's ACTIVE `PlatformGrant` rows. No client-side inference of access,
 * and no second list: an operator with one grant gets one item, none gets none.
 *
 * `enabled` exists because Space mode only wants this on the platform axis;
 * disabled it performs no network work at all (hooks can't be conditional).
 */
/** The granted Platform areas (GET /api/spaces → data.platform). Exported for the
 *  mobile bar's Platform presentation (BottomNav); the ONE fetch site stays here. */
export function usePlatformDestinations(enabled: boolean): PlatformItem[] {
  const [platform, setPlatform] = useState<PlatformItem[]>([]);

  // State is set only from the fetch callback (external-subscription shape), so a
  // route change / re-fire never races a slow response into a stale setState.
  const load = useCallback((signal: () => boolean) => {
    fetch("/api/spaces")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (signal() || !data) return;
        setPlatform(
          (data.platform ?? []).map((p: PlatformItem) => ({
            id: p.id,
            name: p.name,
            platformArea: p.platformArea,
          })),
        );
      })
      .catch(() => {
        /* non-fatal */
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled) return;
    const handle = () => load(() => false);
    window.addEventListener(SPACE_LIST_CHANGED_EVENT, handle);
    window.addEventListener(SPACE_INVITES_CHANGED_EVENT, handle);
    return () => {
      window.removeEventListener(SPACE_LIST_CHANGED_EVENT, handle);
      window.removeEventListener(SPACE_INVITES_CHANGED_EVENT, handle);
    };
  }, [enabled, load]);

  return platform;
}

/**
 * The PLATFORM block — the HQ Platform Spaces switcher. ONE component, rendered
 * by BOTH sidebar modes (global nav and Space mode), so the two can never drift
 * into two navigation patterns. Renders nothing when the operator holds no
 * grants: the eyebrow is part of the block, not chrome around it.
 */
export function PlatformNav({
  items,
  pathname,
  className,
}: {
  items: PlatformItem[];
  pathname: string | null;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={className}>
      <p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Platform
      </p>
      <nav aria-label="Platform" className="flex flex-col gap-0.5">
        {items.map((p) => {
          const href = `${PLATFORM_ROUTE_PREFIX}${p.platformArea}`;
          const on = pathname === href;
          return (
            <Link
              key={p.id}
              href={href}
              aria-current={on ? "true" : undefined}
              className={[
                "group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] py-1.5 pl-3 pr-2 text-left text-[13px]",
                "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                on
                  ? "text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              ].join(" ")}
            >
              <span
                aria-hidden
                className={[
                  "absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)]",
                  "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  on ? "opacity-100" : "opacity-0",
                ].join(" ")}
              />
              <Shield size={14} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1 truncate">{p.name}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

// ── the Platform context's rail (Platform Operations 2.0 — R1) ───────────────

const PLATFORM_DEST_ICONS: Record<PlatformDestinationId, LucideIcon> = {
  overview: LayoutGrid,
  ai: Sparkles,
  space: Shield,
};

/** The rail's row idiom (the same accent-bar row every sidebar list uses). */
const RAIL_ROW = "group relative flex min-h-9 items-center gap-2.5 rounded-[var(--radius-sm)] py-1.5 pl-3 pr-2 text-left text-[13px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]";

/**
 * R1 — the Platform context's TOP block on desktop: the SAME three destinations
 * the mobile bar shows (lib/platform/nav `platformDestinations`: Overview · AI ·
 * Current Space), and — nested under Current Space, only when the operator holds
 * more than one — the Space SWITCHER: the granted Spaces as links. Picking one
 * opens it (and so becomes the Current Space); the three never change.
 *
 * The rows come from the Platform nav provider (granted Spaces, server-loaded as
 * the tenant), never from a literal. Pure over its props so it renders in a test.
 */
export function PlatformDestinationsNav({
  pathname,
  spaces,
  current,
}: {
  pathname: string | null;
  spaces:   readonly PlatformSpaceOption[];
  current:  PlatformSpaceOption | null;
}) {
  const destinations = platformDestinations(pathname, current);
  return (
    <div>
      <p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Platform
      </p>
      <nav aria-label="Platform" className="flex flex-col gap-0.5">
        {destinations.map((d) => {
          const Icon = PLATFORM_DEST_ICONS[d.id];
          return (
            <div key={d.id} className="flex flex-col gap-0.5">
              <Link
                href={d.href}
                prefetch={false}
                aria-current={d.on ? "true" : undefined}
                className={[RAIL_ROW, d.on ? "text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)]",
                    "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                    d.on ? "opacity-100" : "opacity-0",
                  ].join(" ")}
                />
                <Icon size={14} strokeWidth={1.75} className="shrink-0" />
                {/* it2 — with the Space list nested beneath, the destination reads
                    "Current Space" (the list names and marks it), so the Space's
                    name appears once, not twice. */}
                <span className="flex-1 truncate">{d.id === "space" && spaces.length > 1 ? "Current Space" : d.label}</span>
              </Link>
              {d.id === "space" && spaces.length > 1 && (
                <PlatformSpaceSwitchList pathname={pathname} spaces={spaces} current={current} />
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}

/** The desktop Space switcher, nested under Current Space (guide line, like a
 *  workspace's children). The selected Space reads in the primary weight; the
 *  accent bar is reserved for the destination above it. */
function PlatformSpaceSwitchList({
  pathname,
  spaces,
  current,
}: {
  pathname: string | null;
  spaces:   readonly PlatformSpaceOption[];
  current:  PlatformSpaceOption | null;
}) {
  return (
    <div role="group" aria-label="Platform Spaces" className="ml-[18px] flex flex-col border-l border-[var(--border-hairline)]">
      {spaces.map((s) => {
        const href = platformAreaHref(s.area);
        const selected = current?.area === s.area;
        return (
          <Link
            key={s.id}
            href={href}
            prefetch={false}
            aria-current={pathname === href ? "page" : undefined}
            className={[
              "relative flex min-h-8 items-center rounded-[var(--radius-sm)] py-1 pl-[17px] pr-2 text-left text-[12px]",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]",
              selected ? "font-medium text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
            ].join(" ")}
          >
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {/* it2 — the current Space is marked, not just weighted. */}
            {selected && <Check size={12} aria-hidden className="shrink-0 text-[var(--meridian-400)]" />}
            {selected && <span className="sr-only"> (current)</span>}
          </Link>
        );
      })}
    </div>
  );
}

/** The Platform context's top block, wired to the provider (both modes mount it). */
function PlatformContextNav({ pathname }: { pathname: string | null }) {
  const { spaces, current } = usePlatformNav();
  return <PlatformDestinationsNav pathname={pathname} spaces={spaces} current={current} />;
}

export function ContextualNavbar() {
  const { space, currencyControl, workspaceNav, sections, activeSection, setActiveSection } = useSpaceChrome();
  // Owned HERE, above the mode switch: the site nav's inputs must not reset (and
  // the badge must not re-fetch) when a Space publishes or clears its chrome.
  const pathname = usePathname();
  const pendingInvites = usePendingInvites();

  return (
    <aside className="hidden w-[212px] shrink-0 lg:block">
      <div className="sticky top-12 flex max-h-[calc(100dvh-3rem)] flex-col gap-5 overflow-y-auto py-6 pr-5">
        {space ? (
          <SpaceMode
            pathname={pathname}
            pendingInvites={pendingInvites}
            space={space}
            currencyControl={currencyControl}
            workspaceNav={workspaceNav}
            sections={sections}
            activeSection={activeSection}
            onSelectSection={setActiveSection}
          />
        ) : (
          <GlobalMode pathname={pathname} pendingInvites={pendingInvites} />
        )}
      </div>
    </aside>
  );
}

// ── site navigation (both modes) ─────────────────────────────────────────────

/**
 * The pending-invite count for the Spaces badge. The sidebar does not inline the
 * Spaces list (the prototype's flat nav model — switching happens on the Spaces
 * launcher); it still needs this one number from the network, a no-op for users
 * without invites. State is set only from the fetch callback
 * (external-subscription shape), so a route change / re-fire never races a slow
 * response into a stale setState.
 */
function usePendingInvites(): number {
  const [pendingInvites, setPendingInvites] = useState(0);

  const load = useCallback((signal: () => boolean) => {
    fetch("/api/spaces/invites/pending")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (signal() || !data) return;
        setPendingInvites(data.count ?? 0);
      })
      .catch(() => {
        /* non-fatal */
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    const handle = () => load(() => false);
    window.addEventListener(SPACE_LIST_CHANGED_EVENT, handle);
    window.addEventListener(SPACE_INVITES_CHANGED_EVENT, handle);
    return () => {
      window.removeEventListener(SPACE_LIST_CHANGED_EVENT, handle);
      window.removeEventListener(SPACE_INVITES_CHANGED_EVENT, handle);
    };
  }, [load]);

  return pendingInvites;
}

/**
 * The SITE NAVIGATION block — ONE component, rendered by BOTH sidebar modes, so
 * there is one desktop presentation of lib/space-nav PRIMARY_NAV and it cannot
 * differ between "on the launcher" and "inside a Space". The list, the order,
 * the routes and the active rule (`isPrimaryDestActive`) all come from
 * lib/space-nav; nothing about a destination is restated here.
 *
 * Inside a Space the active rule is unchanged, deliberately: /dashboard IS the
 * active Space's dashboard, so My Space is lit there exactly as it is on the
 * mobile bar; a platform HQ route lights nothing, as it always has.
 *
 * Pure over its props (pathname + badge count) so it renders in a test without
 * the App Router.
 */
export function PrimaryNav({
  pathname: rawPathname,
  pendingInvites = 0,
}: {
  pathname: string | null;
  pendingInvites?: number;
}) {
  // Before hydration there may be no pathname: nothing is lit, nothing throws.
  const pathname = rawPathname ?? "";
  return (
    <div>
      <p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        Fourth Meridian
      </p>
      <nav aria-label="Global" className="flex flex-col gap-0.5">
        {PRIMARY_NAV.map((d) => {
          const Icon = NAV_ICONS[d.id];
          const on = isPrimaryDestActive(d.id, pathname);
          return (
            <Link
              key={d.id}
              href={d.href}
              aria-current={on ? "true" : undefined}
              className={[
                "group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] py-1.5 pl-3 pr-2 text-left text-[13px]",
                "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                on
                  ? "text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              ].join(" ")}
            >
              <span
                aria-hidden
                className={[
                  "absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)]",
                  "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  on ? "opacity-100" : "opacity-0",
                ].join(" ")}
              />
              <Icon size={14} strokeWidth={1.75} className="shrink-0" />
              <span className="flex-1">{d.label}</span>
              {d.id === "spaces" && pendingInvites > 0 && (
                <span
                  className="flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
                  style={{ background: "var(--coral-500)" }}
                >
                  {pendingInvites > 9 ? "9+" : pendingInvites}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

// ── the platform context's two fixtures (both modes) ─────────────────────────

/**
 * The ONE exit from the platform context — a single "Personal Spaces" row back
 * to the launcher. The href is the Spaces primary destination's own route
 * (lib/space-nav `primaryHref`), never restated here. It is a plain link: no
 * cookie, no switch call — leaving the platform axis changes no Space.
 */
function PersonalSpacesExit() {
  return (
    <nav aria-label="Exit" className="flex flex-col gap-0.5">
      <Link
        href={primaryHref("spaces")}
        className={[
          "group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] py-1.5 pl-3 pr-2 text-left text-[13px]",
          "text-[var(--text-secondary)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:text-[var(--text-primary)]",
        ].join(" ")}
      >
        <ArrowLeft size={14} strokeWidth={1.75} className="shrink-0" />
        <span className="flex-1">Personal Spaces</span>
      </Link>
    </nav>
  );
}

/**
 * The site nav, RETAINED under a hairline on the platform context. Demoted in
 * position only — same block, same five, same active rule — so the operator
 * never loses Fourth Meridian on desktop, where there is no BottomNav.
 */
// ── global mode ──────────────────────────────────────────────────────────────

/** Exported so the COMPOSITION (which list leads on which context) renders in a test. */
export function GlobalMode({ pathname, pendingInvites }: { pathname: string | null; pendingInvites: number }) {
  const platformContext = navContext(pathname) === "platform";
  // The access-derived platform destinations for the PERSONAL sidebar's way in
  // (unchanged). In the Platform context the provider's server-loaded rows are
  // the source instead, so the fetch is not made there.
  const platform = usePlatformDestinations(!platformContext);

  // R1 — on the Platform Overview and the AI page the operator stands in the
  // platform context: the three destinations (+ Space switcher), then one exit
  // row back to Personal Spaces. The personal site nav is not part of it.
  if (platformContext) {
    return (
      <>
        <PlatformContextNav pathname={pathname} />
        <PersonalSpacesExit />
      </>
    );
  }

  return (
    <>
      <PrimaryNav pathname={pathname} pendingInvites={pendingInvites} />
      <PlatformNav items={platform} pathname={pathname} />
    </>
  );
}

/** A plain primary click is handled in place; anything else (⌘/Ctrl/Shift/Alt,
 *  middle button) is the browser's — open the canonical href in a new tab. */
function isPlainPrimaryClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/**
 * The SPACE WORKSPACE block — the Space's workspace-level destinations (Net Worth
 * · Cash Flow in a customer Space; Overview · Jobs · Policies … in a Platform
 * Space), published by the host from the navigation state it owns. Peers of
 * the site destinations above: same row, accent bar, icon size and type — never
 * indented like a subsection.
 *
 * Each row is a real link to its canonical deep link (lib/space/use-space-
 * navigation `lensHref`), so open-in-new-tab / copy-link work; a plain primary
 * click selects IN PLACE through the host's state (`onSelect`) — the Space's
 * navigation is History-driven, not a route change, and a router navigation to
 * the same page would not re-read it. Active state is the host's `activeId`
 * (the RENDERED workspace), never text matching, so Net Worth stays lit across
 * its own Total · Assets · Debt modes.
 *
 * CHILDREN — a workspace that publishes `children` (Net Worth: Total · Assets ·
 * Debt) shows them nested under it ONLY while it is the open workspace; they
 * collapse when another workspace opens. They are links too (canonical href +
 * in-place `onSelectChild`), grouped under the parent's name. ONE accent bar in
 * this block at a time: while a child list is showing, the bar marks the current
 * CHILD on the guide line and the parent reads as open through its text weight
 * — so the parent and the child are never two identical indicators.
 */
export function SpaceWorkspaceNav({ nav }: { nav: SpaceChromeWorkspaceNav | null }) {
  if (!nav || nav.items.length === 0) return null;
  return (
    <nav aria-label="Space" className="flex flex-col gap-0.5">
      {nav.items.map((item) => {
        const on = item.id === nav.activeId;
        const Icon = workspaceIcon(item);
        const children = on && item.children && item.children.length > 0 ? item.children : null;
        return (
          <div key={item.id} className="flex flex-col gap-0.5">
            <a
              href={item.href}
              onClick={(e) => {
                if (!isPlainPrimaryClick(e)) return;
                e.preventDefault();
                nav.onSelect(item.id);
              }}
              aria-current={on ? "true" : undefined}
              className={[
                "group relative flex items-center gap-2.5 rounded-[var(--radius-sm)] py-1.5 pl-3 pr-2 text-left text-[13px]",
                "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                on
                  ? "text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                children ? "font-medium" : "",
              ].join(" ")}
            >
              <span
                aria-hidden
                className={[
                  "absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)]",
                  "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  on && !children ? "opacity-100" : "opacity-0",
                ].join(" ")}
              />
              {Icon && <Icon size={14} strokeWidth={1.75} className="shrink-0" />}
              <span className="flex-1 truncate">{item.label}</span>
            </a>
            {children && (
              <div
                role="group"
                aria-label={item.label}
                className="ml-[18px] flex flex-col border-l border-[var(--border-hairline)]"
              >
                {children.map((c) => {
                  const cOn = c.id === nav.activeChildId;
                  return (
                    <a
                      key={c.id}
                      href={c.href}
                      onClick={(e) => {
                        if (!isPlainPrimaryClick(e)) return;
                        e.preventDefault();
                        nav.onSelectChild?.(item.id, c.id);
                      }}
                      aria-current={cOn ? "true" : undefined}
                      className={[
                        "relative block rounded-[var(--radius-sm)] py-1 pl-[17px] pr-2 text-left text-[12px]",
                        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                        cOn
                          ? "text-[var(--text-primary)]"
                          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                      ].join(" ")}
                    >
                      <span
                        aria-hidden
                        className={[
                          "absolute inset-y-1 -left-px w-0.5 rounded-full bg-[var(--meridian-400)]",
                          "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                          cOn ? "opacity-100" : "opacity-0",
                        ].join(" ")}
                      />
                      <span className="truncate">{c.label}</span>
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The SECTIONS block — a Platform workspace's "what's inside" anchors, published
 * up through SpaceChrome. Rendered ONLY on the platform axis: inside a customer
 * Space the sidebar shows workspace destinations (SpaceWorkspaceNav) instead, and
 * never a section list. Directly renderable in a test.
 *
 * A section whose `anchor` is null is DISABLED and marked "· soon": the page has
 * no element to scroll to, and inventing one would scroll nowhere in silence.
 */
export function SectionsNav({
  sections,
  activeSection,
  onSelectSection,
}: {
  sections: SpaceChromeSection[];
  activeSection: string;
  onSelectSection: (label: string) => void;
}) {
  if (sections.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        <LayoutGrid size={10} strokeWidth={2} />
        Sections
      </p>
      <nav aria-label="Sections" className="flex flex-col gap-0.5">
        {sections.map((s) => {
          const on = s.label === activeSection;
          const live = s.anchor != null;
          return (
            <button
              key={s.label}
              disabled={!live}
              onClick={() => {
                if (!s.anchor) return;
                onSelectSection(s.label);
                document
                  .getElementById(s.anchor)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              aria-current={on ? "true" : undefined}
              className={[
                "group relative rounded-[var(--radius-sm)] py-1.5 pl-3 pr-2 text-left text-[13px]",
                "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                !live
                  ? "cursor-default text-[var(--text-muted)]"
                  : on
                    ? "text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              ].join(" ")}
            >
              <span
                aria-hidden
                className={[
                  "absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)]",
                  "transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  on && live ? "opacity-100" : "opacity-0",
                  live && !on ? "group-hover:opacity-40" : "",
                ].join(" ")}
              />
              {s.label}
              {!live && <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">· soon</span>}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ── space mode ───────────────────────────────────────────────────────────────

/** Exported so the COMPOSITION (site nav above the Space block) renders in a test. */
export function SpaceMode({
  pathname,
  pendingInvites,
  space,
  currencyControl,
  workspaceNav,
  sections,
  activeSection,
  onSelectSection,
}: {
  pathname: string | null;
  pendingInvites: number;
  space: SpaceChromeSpace;
  currencyControl: React.ReactNode;
  workspaceNav: SpaceChromeWorkspaceNav | null;
  sections: SpaceChromeSection[];
  activeSection: string;
  onSelectSection: (label: string) => void;
}) {
  const { identity, onManage, onLeaveSpace } = space;

  // PLATFORM inside a Space — rendered ONLY on the platform axis.
  //
  // WHY NOT IN EVERY SPACE: a customer Space is the SpaceMember axis; a platform
  // HQ Space is the PlatformGrant axis. lib/platform/policy.ts treats that split
  // as structural, and standing inside a customer's financial Space is exactly
  // where operator navigation must not appear — it would put an operator door in
  // a member's room and blur which axis the current view is authorized on. The
  // global sidebar (GlobalMode) already carries the operator's way IN, so nothing
  // is unreachable; this block is the platform-axis switcher, shown while on it.
  //
  // The list itself is still access-derived (usePlatformDestinations → the same
  // /api/spaces `platform` projection): the route only decides WHETHER to ask.
  const onPlatformAxis = isPlatformSpaceRoute(pathname);

  // SITE — the same block global mode renders. Fourth Meridian stays on screen;
  // the Space is a place INSIDE it, not a shell that replaces it. In a personal
  // Space it LEADS; in a Platform Space (UX-P2 Phase B) it is retained under a
  // hairline after the exit row — one element, placed by context, never two.
  const site = <PrimaryNav pathname={pathname} pendingInvites={pendingInvites} />;

  return (
    <>
      {/* PLATFORM (platform axis only) — R1: the three destinations (Overview ·
          AI · Current Space, with the Space switcher under Current Space) LEAD
          inside a Platform Space; this Space's block and workspaces follow.
          Gated on the route (see above). */}
      {onPlatformAxis && <PlatformContextNav pathname={pathname} />}

      {!onPlatformAxis && site}

      {/* SPACE — under a hairline, so the order reads site → this Space → its
          workspaces (or, on the platform axis, Platform → this Space). There is
          no in-Space "All Spaces" back control: the site's Spaces destination is
          the way back up (same route, one hop). */}
      <div data-nav-context="space" className="border-t border-[var(--border-hairline)] pt-5">
        {/* SpaceControls — the canonical FX + Manage cluster, ABOVE the name it
            governs. At this (wide) width it lives here in the Space sidebar.
            Narrow widths get the SAME cluster relocated near the rail (see
            SpaceShell). One state source: the FX node is owned above, Manage is
            the host's handler; this is purely the wide mount point. */}
        <SpaceControls currencyControl={currencyControl} onManage={onManage} className="mb-3" />

        <div className="flex items-center gap-2">
          {/* it2 — on the platform axis the Space's name already reads in the
              Space list above, so this block is headed "Workspaces" + the access
              chip, with no name / meta line (the name stays the accessible heading). */}
          {onPlatformAxis ? (
            <h1 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              <span className="sr-only">{identity.name} · </span>Workspaces
            </h1>
          ) : (
          <h1 className="truncate text-[15px] font-semibold text-[var(--text-primary)]">
            {identity.name}
          </h1>
          )}
          {onPlatformAxis && identity.accessChip && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]"
              style={{ background: "var(--surface-hover)", border: "1px solid var(--border-hairline)" }}
              data-access-chip
            >
              <span className="sr-only">Access: </span>{identity.accessChip}
            </span>
          )}
          {identity.shared && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]"
              style={{ background: "var(--surface-hover)", border: "1px solid var(--border-hairline)" }}
            >
              Shared
            </span>
          )}
        </div>
        {!onPlatformAxis && <p className="mt-1 text-[11px] text-[var(--text-muted)]">{identity.subtitle}</p>}
        {identity.updatedLabel && (
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{identity.updatedLabel}</p>
        )}
        {/* v2.6-L1 — the freshness DISTRIBUTION the single age above cannot carry.
            Warned (amber) only when stale or unverified value is what it reports;
            a mere spread stays a quiet footnote. */}
        {identity.freshnessNote && (
          <p
            className="mt-0.5 text-[11px]"
            style={{ color: identity.freshnessWarn ? "var(--accent-warning)" : "var(--text-faint)" }}
          >
            {identity.freshnessNote}
          </p>
        )}

        {/* WORKSPACES — Net Worth · Cash Flow (or a Platform area's Overview ·
            Jobs · …), inside the Space block so they read as THIS Space's
            destinations, attached to its identity. */}
        {workspaceNav && workspaceNav.items.length > 0 && (
          <div className={onPlatformAxis ? "mt-2" : "mt-4"}>
            <SpaceWorkspaceNav nav={workspaceNav} />
          </div>
        )}
      </div>

      {/* Section anchors survive ONLY on the platform axis, BELOW the workspace
          list: "which workspace" above, "what's inside it" beneath (the labels
          are DB text, the anchors are ids the workspace body really emits);
          a customer Space never renders them. */}
      {onPlatformAxis && (
        <SectionsNav
          sections={sections}
          activeSection={activeSection}
          onSelectSection={onSelectSection}
        />
      )}

      {/* The way OUT of the platform context (P-1: the personal site nav is no
          longer retained here — the exit row and the header switch lead back). */}
      {onPlatformAxis && <PersonalSpacesExit />}

      {onLeaveSpace && (
        <button
          onClick={onLeaveSpace}
          className="mt-auto flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-left text-[13px] text-[var(--text-muted)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:text-[var(--accent-negative)]"
        >
          <LogOut size={13} strokeWidth={1.75} className="shrink-0" />
          Leave Space
        </button>
      )}
    </>
  );
}
