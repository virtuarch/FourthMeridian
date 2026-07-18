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
 *  • The centre is empty and STAYS empty — no nav, no search. Navigation lives
 *    in the ContextualNavbar (left rail on desktop, BottomNav on mobile); the
 *    header's job is identity (left) and utilities (right).
 *  • Icon-only utilities on the right (GlobalActions).
 *
 * The header itself is domain- and route-agnostic: it never changes between the
 * launcher and inside a Space. Only the ContextualNavbar below it transforms.
 */

import { AppLogo } from "@/components/ui/AppLogo";
import { GlobalActions } from "@/components/ui/GlobalActions";

export function GlobalHeader() {
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

        {/* Centre — deliberately, permanently empty. */}
        <div className="flex-1" />

        <GlobalActions />
      </div>
    </header>
  );
}
