"use client";

/**
 * components/ui/GlobalHeader.tsx
 *
 * The one global application bar — the persistent, full-width strip at the top
 * of every dashboard route. This is the prototype's AppBar (components/app/
 * AppBar.tsx) brought into production, and it REPLACES production's former
 * L-shaped header (the brand row that lived in the Sidebar's top corner + the
 * separate desktop top-bar that only held Refresh/Bell over the content
 * column). One continuous 48px glass strip across the whole width now.
 *
 * WHY IT READS AS AN APP, NOT A WEBSITE (prototype doctrine):
 *  • 48px, not 56–72px — app chrome is short because it's in the way of work.
 *  • The centre carries no nav and no search. Navigation lives in the
 *    ContextualNavbar (left rail on desktop, BottomNav on mobile); the header's
 *    job is identity (left) and utilities (right) — plus, since UX-P2, the ONE
 *    thing that is neither: the CONTEXT switch between Personal Spaces and
 *    Platform Spaces (PlatformContextSwitch), because the header is the only
 *    chrome present at every width and on both navigation axes. It renders
 *    nothing for a viewer without a platform grant, so for everyone else the
 *    centre is exactly as empty as before.
 *  • Icon-only utilities on the right (GlobalActions).
 *
 * The header itself is domain- and route-agnostic: it never changes between the
 * launcher and inside a Space. Only the ContextualNavbar below it transforms
 * (the context switch lights by route, but it is the same control everywhere).
 *
 * `hasPlatformGrants` is a SERVER fact (app/(shell)/dashboard/layout.tsx counts
 * the viewer's ACTIVE grants as the tenant, fail-closed) handed down through
 * DashboardChrome — no client fetch, so no pop-in after mount.
 */

import { AppLogo } from "@/components/ui/AppLogo";
import { GlobalActions } from "@/components/ui/GlobalActions";
import { PlatformContextSwitch } from "@/components/ui/PlatformContextSwitch";

export function GlobalHeader({ hasPlatformGrants = false }: { hasPlatformGrants?: boolean }) {
  return (
    <header
      className="sticky top-0 z-40 shrink-0 border-b border-[var(--border-hairline)]"
      style={{
        background: "var(--glass-ultrathin)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
      }}
    >
      <div className="flex h-12 items-center gap-3 px-4 sm:px-5">
        {/* Left — the brand mark + wordmark. The wordmark drops below sm so the
            mark alone carries identity on a phone (the prototype hides it too). */}
        <AppLogo
          size={24}
          withWordmark
          priority
          wordmarkClassName="hidden sm:inline text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]"
        />

        {/* Centre — the context switch (UX-P2), or nothing at all. */}
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <PlatformContextSwitch hasPlatformGrants={hasPlatformGrants} />
        </div>

        <GlobalActions />
      </div>
    </header>
  );
}
