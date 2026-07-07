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
 *
 * Create Space modal: this is also the actual common ancestor of the
 * Sidebar and every dashboard page (including the Spaces page), so it owns
 * the single mounted CreateSpaceModal instance + its open state. Both the
 * Sidebar's "Create Space" row and the Spaces page's own "Create Space"
 * button dispatch a window CustomEvent ("open-create-space") rather than
 * holding a reference to this component — the same decoupled pattern this
 * codebase already uses for "space-list-changed" /
 * "space-invites-changed" (see Sidebar.tsx, SpacesClient.tsx). On a
 * successful create, `router.refresh()` re-fetches the Spaces page's
 * server-provided `mine`/`publicSpaces` props so the card grid picks up
 * the new Space immediately.
 */

import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { Sidebar } from "@/components/ui/Sidebar";
import { BottomNav } from "@/components/ui/BottomNav";
import { UserButton } from "@/components/ui/UserButton";
import { RefreshButton } from "@/components/dashboard/RefreshButton";
import { AtlasField } from "@/components/atlas/AtlasField";
import { AppLogo } from "@/components/ui/AppLogo";
import { CreateSpaceModal } from "@/components/dashboard/CreateSpaceModal";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { OPEN_CREATE_SPACE_EVENT } from "@/lib/space-nav";

export function DashboardChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isSpaces = pathname.startsWith("/dashboard/spaces");
  // Refraction-test material-eval pass: the everyday Dashboard home also renders
  // the Atlas Field (dialed-back "balanced" intensity) so its glass panels have a
  // real globe backdrop to judge refraction against, not flat --bg-base. Scoped to
  // the home route only — data-dense sub-tabs (banking, transactions, …) stay flat.
  const isDashboardHome = pathname === "/dashboard";
  const immersive = isSpaces || isDashboardHome;

  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);

  useEffect(() => {
    function handleOpen() { setCreateSpaceOpen(true); }
    window.addEventListener(OPEN_CREATE_SPACE_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_CREATE_SPACE_EVENT, handleOpen);
  }, []);

  return (
    <div className="flex min-h-screen bg-[var(--bg-base)]">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Main area */}
      <div className={["flex-1 flex flex-col min-w-0", immersive ? "relative isolate" : ""].join(" ")}>
        {immersive && <AtlasField intensity={isSpaces ? "rich" : "balanced"} />}

        {/* Mobile header — sticky + glass (restored: this used to be a
            plain opaque bar that scrolled away with the page; it now stays
            pinned via `sticky top-0` like every other floating surface in
            this system, with a backdrop blur so content scrolls underneath
            it instead of behind a hard edge). isSpaces keeps zero tint so it
            blends into that page's own Atlas Field rather than drawing a
            seam across it; every other page gets a faint `--glass-ultrathin`
            tint + hairline border so it still reads as a bar over busy
            content. Hardcoded bg-gray-950/border-gray-800 replaced with
            theme tokens so this also respects Light Glass, not just dark. */}
        <header
          className={[
            "lg:hidden sticky top-0 z-40 backdrop-blur-md shrink-0",
            immersive ? "" : "border-b border-[var(--border-hairline)]",
          ].join(" ")}
          style={{ background: immersive ? "transparent" : "var(--glass-ultrathin)" }}
        >
          <div className="flex items-center justify-between px-4 h-14">
            <div className="flex items-center gap-1.5">
              <AppLogo size={32} withWordmark wordmarkClassName="text-[var(--text-primary)] text-lg" priority />
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton label="Refresh" />
              <NotificationBell />
              <UserButton />
            </div>
          </div>
        </header>

        {/* Desktop top bar — Refresh Data stays pinned top-right within this
            bar. Same sticky/glass restoration as the mobile header above:
            `sticky top-0 z-40` so it stays put while the page content
            scrolls underneath it, plus a backdrop blur instead of the old
            flat opaque strip.

            No brand mark here: the Sidebar's own header row (`<aside
            className="... self-start ... sticky top-0">` in Sidebar.tsx)
            pins the Fourth Meridian logo+wordmark to the far left at the
            same h-14 height with the same bottom hairline. (The `self-start`
            is required — without it, the aside gets flex-stretched to the
            main column's full page height and `sticky` has no room to take
            effect, so the brand row would scroll away instead of pinning.)
            With that in place, the Sidebar's logo row and this bar's
            Refresh button now scroll-lock together as one continuous glass
            strip across the top of the screen — this bar is just that
            strip's right end. Rendering AppLogo here too would put two
            brand marks on screen at once, which is exactly the duplicate
            this bar previously had. */}
        <header
          className={[
            "hidden lg:flex items-center justify-end px-8 h-14 sticky top-0 z-40 backdrop-blur-md shrink-0",
            immersive ? "" : "border-b border-[var(--border-hairline)]",
          ].join(" ")}
          style={{ background: immersive ? "transparent" : "var(--glass-ultrathin)" }}
        >
          <RefreshButton label="Refresh Data" />
          <div className="ml-3">
            <NotificationBell />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 px-4 lg:px-8 pt-5 pb-24 lg:pb-8">
          {children}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <BottomNav />

      <CreateSpaceModal
        open={createSpaceOpen}
        onClose={() => setCreateSpaceOpen(false)}
        onCreated={() => router.refresh()}
      />
    </div>
  );
}
