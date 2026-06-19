"use client";

/**
 * DashboardChrome
 *
 * Client-side shell for app/(shell)/dashboard/layout.tsx — split out of
 * that file specifically so the layout itself can stay a Server Component
 * (it exports the `runtime`/`preferredRegion` route-segment config, which
 * Next.js only honors in a Server Component file; adding "use client"
 * directly to layout.tsx would silently break that config).
 *
 * Pathname-aware for exactly one thing: the Spaces page now renders its own
 * immersive Atlas Field background (see AtlasField.tsx / SpacesClient.tsx),
 * so the shared top bar's hairline divider would cut across that continuous
 * backdrop like a hard seam. Every other dashboard tab keeps the divider —
 * this is a Spaces-only presentation tweak, not a global redesign.
 *
 * Phase G: the Atlas Field itself now renders from here (not from inside
 * SpacesClient.tsx) so it can paint behind the header strip too, not just
 * the page content below it — the column below is a true common ancestor
 * of both. `relative isolate` on that column scopes the field's negative
 * z-index to this column's own stacking context, so it can't be painted
 * over by the Sidebar or bleed past the Refresh Data button, which stays
 * exactly where it was (still its own `<header>`, just no longer opaque).
 */

import { usePathname } from "next/navigation";
import { ReactNode } from "react";
import { Sidebar } from "@/components/ui/Sidebar";
import { BottomNav } from "@/components/ui/BottomNav";
import { UserButton } from "@/components/ui/UserButton";
import { RefreshButton } from "@/components/dashboard/RefreshButton";
import { AtlasField } from "@/components/atlas/AtlasField";
import { AppLogo } from "@/components/ui/AppLogo";

export function DashboardChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isSpaces = pathname.startsWith("/dashboard/spaces");

  return (
    <div className="flex min-h-screen bg-[var(--bg-base)]">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Main area */}
      <div className={["flex-1 flex flex-col min-w-0", isSpaces ? "relative isolate" : ""].join(" ")}>
        {isSpaces && <AtlasField />}

        {/* Mobile header */}
        <header
          className={[
            "lg:hidden sticky top-0 z-40 backdrop-blur-sm",
            isSpaces ? "" : "border-b border-gray-800 bg-gray-950/95",
          ].join(" ")}
        >
          <div className="flex items-center justify-between px-4 h-14">
            <div className="flex items-center gap-1.5">
              <AppLogo size={32} withWordmark wordmarkClassName="text-[var(--text-primary)] text-lg" priority />
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton label="Refresh" />
              <UserButton />
            </div>
          </div>
        </header>

        {/* Desktop top bar — Refresh Data stays pinned top-right; on Spaces
            it now sits directly on the page's own glass/Atlas background
            instead of its own bordered strip. */}
        <header
          className={[
            "hidden lg:flex items-center justify-between px-8 h-14",
            isSpaces ? "" : "border-b border-gray-800",
          ].join(" ")}
        >
          <div /> {/* spacer */}
          <RefreshButton label="Refresh Data" />
        </header>

        {/* Page content */}
        <main className="flex-1 px-4 lg:px-8 pt-5 pb-24 lg:pb-8">
          {children}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <BottomNav />
    </div>
  );
}
