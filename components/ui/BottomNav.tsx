"use client";

/**
 * components/ui/BottomNav.tsx
 *
 * The mobile bar: Brief · My Space · AI · Spaces · Connections — the mobile
 * presentation of lib/space-nav PRIMARY_NAV, the SAME list, order, routes and
 * active rule the desktop rail (ContextualNavbar, global mode) renders. My Space
 * (/dashboard, the active Space's dashboard) is a destination of its own, distinct
 * from the Spaces launcher, and Settings lives in the account menu, not here.
 *
 * Prototype behaviour (DS-5 §6): a phone has room for one nav level, so it shows
 * the top-level app destinations and lets in-Space navigation become the
 * Space-local rail. AI takes the centre slot, standalone, emphasised through a
 * filled accent disc at an IDENTICAL footprint to its neighbours — emphasis
 * through contrast, not size. It is the only filled thing on the bar.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  House,
  Layers,
  Newspaper,
  Sparkles,
  Link2,
  LayoutGrid,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { PRIMARY_NAV, PLATFORM_DIRECTORY_HREF, isPrimaryDestActive, navContext, type PrimaryDestId } from "@/lib/space-nav";
import { usePlatformDestinations, type PlatformItem } from "@/components/ui/ContextualNavbar";
import { platformAreaHref } from "@/lib/platform/directory";
import { PLATFORM_AREAS } from "@/lib/platform/policy";

const NAV_ICONS: Record<PrimaryDestId, LucideIcon> = {
  brief: Newspaper,
  myspace: House,
  ai: Sparkles,
  spaces: Layers,
  connections: Link2,
};

export function BottomNav() {
  const pathname = usePathname();
  // P-1 — the Platform context gets its own bar; the personal bar is unchanged.
  const platformContext = navContext(pathname) === "platform";
  const platform = usePlatformDestinations(platformContext);
  return platformContext
    ? <PlatformBottomBar pathname={pathname} platform={platform} />
    : <BottomNavBar pathname={pathname} />;
}

/** P-1 — at most this many granted areas beside Overview (five slots in all). */
export const PLATFORM_BAR_AREAS = 4;

/**
 * P-1 — the mobile bar in the PLATFORM context: Overview (the Platform
 * directory, /dashboard/platform) + up to four granted areas, in the access-
 * derived order /api/spaces returns (the sidebar's one source). One Shield
 * icon for every area, as the sidebar's Platform list does. The way back to
 * Personal is the header's Personal | Platform switch. Labels come from the
 * area registry (navLabel), never from a literal here.
 */
export function PlatformBottomBar({ pathname, platform }: { pathname: string | null; platform: readonly PlatformItem[] }) {
  const items: { key: string; label: string; href: string; Icon: LucideIcon; on: boolean }[] = [
    { key: "platform-overview", label: "Overview", href: PLATFORM_DIRECTORY_HREF, Icon: LayoutGrid, on: pathname === PLATFORM_DIRECTORY_HREF },
    ...platform.slice(0, PLATFORM_BAR_AREAS).map((p) => {
      const href = platformAreaHref(p.platformArea);
      const meta = PLATFORM_AREAS[p.platformArea as keyof typeof PLATFORM_AREAS];
      return { key: p.id, label: meta?.navLabel ?? p.name, href, Icon: Shield, on: pathname === href || (pathname ?? "").startsWith(`${href}/`) };
    }),
  ];
  return (
    <nav
      aria-label="Platform"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-hairline)] lg:hidden"
      style={{
        background: "var(--glass-regular)",
        backdropFilter: "blur(30px) saturate(160%)",
        WebkitBackdropFilter: "blur(30px) saturate(160%)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex h-14 items-stretch">
        {items.map(({ key, label, href, Icon, on }) => (
          <Link
            key={key}
            href={href}
            prefetch={false}
            aria-current={on ? "true" : undefined}
            aria-label={label}
            className="flex flex-1 flex-col items-center justify-center gap-1"
          >
            <span className={["grid size-7 place-items-center rounded-full", "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
              on ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"].join(" ")}>
              <Icon size={16} strokeWidth={on ? 2.25 : 1.75} />
            </span>
            <span className={["text-[10px] leading-none transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
              on ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]"].join(" ")}>
              {label}
            </span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** The bar itself, pathname-driven (no router) — rendered by BottomNav; testable standalone. */
export function BottomNavBar({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Global"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border-hairline)] lg:hidden"
      style={{
        background: "var(--glass-regular)",
        backdropFilter: "blur(30px) saturate(160%)",
        WebkitBackdropFilter: "blur(30px) saturate(160%)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex h-14 items-stretch">
        {PRIMARY_NAV.map((d) => {
          const Icon = NAV_ICONS[d.id];
          const on = isPrimaryDestActive(d.id, pathname);
          const isAI = d.id === "ai";
          return (
            <Link
              key={d.id}
              href={d.href}
              // PS-6D prefetch containment — BottomNav is the ONE nav that stays
              // rendered during a Space mount on mobile (the desktop sidebar is in
              // SpaceMode then, so its global links are absent). Default viewport
              // prefetch would fire a full-context RSC render of all five sibling
              // routes (each re-running the shell layout's getSpaceContext)
              // concurrent with the Space mount — the exact authority fan-out
              // PS-4B tied to the P2024 incident. `false` drops only the eager
              // viewport prefetch; tap navigation (and touch/hover prefetch) is
              // unchanged, so this contains the mount burst without a UX loss.
              prefetch={false}
              aria-current={on ? "true" : undefined}
              aria-label={d.label}
              className="flex flex-1 flex-col items-center justify-center gap-1"
            >
              <span
                className={[
                  "grid size-7 place-items-center rounded-full",
                  "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  isAI
                    ? on
                      ? "bg-[var(--meridian-400)] text-[var(--ink-950)]"
                      : "bg-[rgba(88,150,251,.18)] text-[var(--meridian-400)]"
                    : on
                      ? "text-[var(--text-primary)]"
                      : "text-[var(--text-muted)]",
                ].join(" ")}
              >
                <Icon size={16} strokeWidth={on && !isAI ? 2.25 : 1.75} />
              </span>
              <span
                className={[
                  "text-[10px] leading-none transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
                  on ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]",
                ].join(" ")}
              >
                {d.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
