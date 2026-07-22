/**
 * app/(brief)/dashboard/brief/layout.tsx
 *
 * Standalone layout for the Daily Brief — no sidebar, no nav, no chrome.
 * Lives in the (brief) route group so it does not inherit the shell layout
 * from (shell)/dashboard/layout.tsx.
 *
 * Metadata is exported only from page.tsx to avoid registering two
 * metadata-collector entries for the same route in Turbopack, which caused
 * next-font-manifest.json ENOENT errors under HMR.
 */

import { BriefLogo } from "@/components/brief/BriefLogo";
// Product decision (UI cleanup): the Daily Brief reuses the SAME app-wide
// top-right menu as the rest of the app (UserButton) instead of its own
// UserMenu. This also removes the Appearance (theme) and Region controls that
// only lived in UserMenu. UserMenu/HeroRegionProvider are kept (inert) for now.
import { UserButton } from "@/components/ui/UserButton";
import { HeroRegionProvider } from "@/components/brief/HeroRegionProvider";
import { ReactNode } from "react";

export default function BriefLayout({ children }: { children: ReactNode }) {
  return (
    // HeroRegionProvider wraps both the header (UserMenu, which now hosts
    // the Appearance + Region controls) and the page content (BriefHero,
    // which reads the resolved region) — they're siblings here, so the
    // shared state has to live above both. See HeroRegionProvider.tsx.
    <HeroRegionProvider>
      <div
        className="min-h-screen text-[var(--text-primary)] overflow-x-hidden"
        style={{ background: "var(--bg-base)" }}
      >

        {/*
          ── Top bar ───────────────────────────────────────────────────────────
          Full-width and absolutely positioned so it can float over the hero,
          but it only ever has two small children at opposite ends. Without
          pointer-events-none, the empty space between them still swallows
          clicks meant for whatever sits underneath (this was the root cause
          of BriefHero's theme toggle being unclickable — see UserMenu, which
          now owns the Appearance/Region controls that used to live there).
          pointer-events-auto on each child keeps the logo and user menu
          themselves fully interactive.
        */}
        <header className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-6 md:px-10 py-5 pointer-events-none">
          <div className="pointer-events-auto">
            <BriefLogo />
          </div>
          <div className="pointer-events-auto">
            <UserButton />
          </div>
        </header>

        {/* ── Page content ──────────────────────────────────────────────────────── */}
        {children}
      </div>
    </HeroRegionProvider>
  );
}
