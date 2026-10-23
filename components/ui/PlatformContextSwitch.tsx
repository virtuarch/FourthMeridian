"use client";

/**
 * components/ui/PlatformContextSwitch.tsx  (UX-P2 — navigation separation)
 *
 * The GlobalHeader's centre control: `[ Personal Spaces ] [ Platform Spaces ]`.
 * The ONE door between the two navigation contexts (lib/space-nav `navContext`),
 * visible at every width — the header strip is the only chrome that exists on
 * both the desktop rail and the phone bar.
 *
 * WHAT IT IS
 *   • Two LINKS in a segmented-control track: the launcher (`/dashboard/spaces`,
 *     the Spaces primary destination's own route) and the Platform Spaces
 *     DIRECTORY (`/dashboard/platform`). Links, not buttons: open-in-new-tab and
 *     copy-link work, and nothing happens on the client that the URL does not
 *     already say. `prefetch={false}`: the directory is a server page behind a
 *     grant read, and the launcher is heavy; neither is speculatively rendered.
 *   • The active segment is a ROUTE fact: `navContext(pathname)` — the Platform
 *     side lights on the directory and inside every Platform Space, the Personal
 *     side everywhere else (null pathname ⇒ Personal).
 *   • Rendered ONLY for a viewer with at least one ACTIVE PlatformGrant. The flag
 *     is a SERVER prop (app/(shell)/dashboard/layout.tsx → DashboardChrome →
 *     GlobalHeader): no client fetch, no post-mount pop-in, no second
 *     `/api/spaces` call (the sidebar's one fetch stays the one fetch).
 *
 * WHAT IT IS NOT — pinned by platform-context-switch.test.ts
 *   • Not an authority: it reads no cookie, writes no cookie, touches no storage,
 *     calls no `/api/space/switch`, performs no fetch. The Platform Space pages
 *     and `/api/spaces` remain the only places access is decided.
 *   • Not auto-open: the Platform link goes to the directory, never to a "last
 *     used" area (none is stored anywhere).
 *
 * WHY NOT `components/atlas/SegmentedControl` DIRECTLY
 *   That primitive is a `role="tablist"` of `<button>`s with an imperative
 *   `onChange`, and it has no href. Wrapping it would make the segments buttons
 *   (losing open-in-new-tab and the no-JS path) or require an atlas change
 *   outside this slice. So this renders the SAME visual grammar — the glass
 *   track, the neutral white-glass active pill, muted inactive text, icon +
 *   label per segment, inactive labels collapsing to the icon below `sm`
 *   (SegmentedControl's `labelVisibility="activeOnly"` idiom, made responsive)
 *   — with link semantics: a `<nav>` of `<a aria-current>`s.
 *
 * MOBILE: below `sm` the inactive label is `sr-only` (the icon carries it, the
 * accessible name stays), the active label stays visible, so the control reads
 * "[◧] [⛊ Platform Spaces]" beside the wordmark-less logo. BottomNav is untouched
 * (Phase C is post-beta).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Layers, Shield, type LucideIcon } from "lucide-react";
import { PLATFORM_DIRECTORY_HREF, navContext, primaryHref, type NavContext } from "@/lib/space-nav";

interface Segment {
  id:    NavContext;
  label: string;
  href:  string;
  Icon:  LucideIcon;
}

const SEGMENTS: readonly Segment[] = [
  { id: "personal", label: "Personal Spaces", href: primaryHref("spaces"),  Icon: Layers },
  { id: "platform", label: "Platform Spaces", href: PLATFORM_DIRECTORY_HREF, Icon: Shield },
];

/** The route-aware wrapper the GlobalHeader mounts. */
export function PlatformContextSwitch({ hasPlatformGrants }: { hasPlatformGrants: boolean }) {
  const pathname = usePathname();
  return <PlatformContextSwitchView hasPlatformGrants={hasPlatformGrants} pathname={pathname} />;
}

/** Pure over its props (grant flag + pathname) so it renders in a test without
 *  the App Router. Renders NOTHING — not an empty track — without a grant. */
export function PlatformContextSwitchView({
  hasPlatformGrants,
  pathname,
}: {
  hasPlatformGrants: boolean;
  pathname: string | null;
}) {
  if (!hasPlatformGrants) return null;
  const active = navContext(pathname);

  return (
    <nav
      aria-label="Context"
      className="relative inline-flex max-w-full shrink-0 gap-0 p-1"
      style={{
        background: "var(--glass-ultrathin)",
        border: "1px solid var(--border-hairline)",
        borderRadius: "var(--radius-full)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
      }}
    >
      {SEGMENTS.map(({ id, label, href, Icon }) => {
        const on = id === active;
        return (
          <Link
            key={id}
            href={href}
            prefetch={false}
            aria-current={on ? "page" : undefined}
            aria-label={label}
            className={[
              "relative z-10 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-full)] min-h-9 min-w-9 justify-center px-2 py-1.5 text-xs font-medium sm:px-4",
              "transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-hairline-strong)]",
              on
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
            ].join(" ")}
            style={
              on
                ? {
                    background: "rgba(255,255,255,.09)",
                    border: "1px solid rgba(255,255,255,.10)",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,.10)",
                  }
                : { border: "1px solid transparent" }
            }
          >
            <span aria-hidden className="inline-flex shrink-0">
              <Icon size={13} strokeWidth={1.75} />
            </span>
            {/* The active label stays visible from 400px; an inactive one collapses to
                its icon below sm (sr-only keeps the text in the DOM). */}
            <span className={on ? "max-[399px]:sr-only" : "sr-only sm:not-sr-only"}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
