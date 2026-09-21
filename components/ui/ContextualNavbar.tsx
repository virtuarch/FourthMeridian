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
 *              PLATFORM Space it instead carries that HQ workspace's section
 *              anchors plus the same access-derived Platform destinations global
 *              mode shows, so the operator can move between HQ Spaces without
 *              first leaving to the launcher.
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
  type PrimaryDestId,
} from "@/lib/space-nav";
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
  markets: ChartCandlestick,
};

type PlatformItem = { id: string; name: string; platformArea: string };

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
  return typeof pathname === "string" && pathname.startsWith(PLATFORM_ROUTE_PREFIX);
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
function usePlatformDestinations(enabled: boolean): PlatformItem[] {
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

// ── global mode ──────────────────────────────────────────────────────────────

function GlobalMode({ pathname, pendingInvites }: { pathname: string | null; pendingInvites: number }) {
  // The access-derived platform destinations — the SAME hook Space mode uses.
  const platform = usePlatformDestinations(true);

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
 * · Cash Flow), published by the host from the navigation state it owns. Peers of
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
        const Icon = WORKSPACE_ICONS[item.id];
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
  const platform = usePlatformDestinations(onPlatformAxis);

  return (
    <>
      {/* SITE — the same block global mode renders. Fourth Meridian stays on
          screen; the Space is a place INSIDE it, not a shell that replaces it. */}
      <PrimaryNav pathname={pathname} pendingInvites={pendingInvites} />

      {/* SPACE — under a hairline, so the order reads site → this Space → its
          workspaces. There is no in-Space "All Spaces" back control: the site's
          Spaces destination above is the way back up (same route, one hop). */}
      <div data-nav-context="space" className="border-t border-[var(--border-hairline)] pt-5">
        {/* SpaceControls — the canonical FX + Manage cluster, ABOVE the name it
            governs. At this (wide) width it lives here in the Space sidebar.
            Narrow widths get the SAME cluster relocated near the rail (see
            SpaceShell). One state source: the FX node is owned above, Manage is
            the host's handler; this is purely the wide mount point. */}
        <SpaceControls currencyControl={currencyControl} onManage={onManage} className="mb-3" />

        <div className="flex items-center gap-2">
          <h1 className="truncate text-[15px] font-semibold text-[var(--text-primary)]">
            {identity.name}
          </h1>
          {identity.shared && (
            <span
              className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]"
              style={{ background: "var(--surface-hover)", border: "1px solid var(--border-hairline)" }}
            >
              Shared
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">{identity.subtitle}</p>
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

        {/* WORKSPACES — Net Worth · Cash Flow, inside the Space block so they
            read as THIS Space's destinations, attached to its identity. */}
        {workspaceNav && workspaceNav.items.length > 0 && (
          <div className="mt-4">
            <SpaceWorkspaceNav nav={workspaceNav} />
          </div>
        )}
      </div>

      {/* Section anchors survive ONLY on the platform axis (HQ workspaces have
          no Net Worth / Cash Flow); a customer Space never renders them. */}
      {onPlatformAxis && (
        <SectionsNav
          sections={sections}
          activeSection={activeSection}
          onSelectSection={onSelectSection}
        />
      )}

      {onPlatformAxis && <PlatformNav items={platform} pathname={pathname} className="mt-2" />}

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
