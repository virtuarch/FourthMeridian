"use client";

/**
 * DashboardChrome
 *
 * The app-global chrome that wraps every /dashboard/* route — production's
 * realization of the prototype's AppShell (components/app/AppShell.tsx). It is
 * the SAME persistent frame before and after you enter a Space; only the
 * ContextualNavbar's contents and the content column change, never the frame:
 *
 *   SpaceChromeProvider           bridge: the in-Space host publishes its
 *   ├─ GlobalHeader               Space-mode payload UP to the ContextualNavbar
 *   ├─ [ ContextualNavbar | main ]
 *   └─ BottomNav
 *
 * This REPLACES the former L-shaped chrome (a brand row buried in the Sidebar's
 * top corner + a separate desktop top-bar that only held Refresh/Bell over the
 * content column + a duplicate mobile header). Now: one full-width GlobalHeader
 * across the top (brand + utilities), one transforming ContextualNavbar on the
 * left (desktop) whose mobile presentation is BottomNav, and the route children
 * in the centred content column. The old Sidebar.tsx is retired entirely.
 *
 * Split out of app/(shell)/dashboard/layout.tsx so the layout stays a Server
 * Component (it exports route-segment config Next only honors there); this
 * client shell owns the interactive chrome.
 *
 * Create Space modal: this is the common ancestor of the ContextualNavbar and
 * every dashboard page, so it owns the single mounted CreateSpaceModal + its
 * open state, opened via the decoupled "open-create-space" window event.
 */

import { usePathname, useRouter } from "next/navigation";
import { ReactNode, Suspense, useEffect, useState } from "react";
// TI5-3C — single, shell-level Transaction Detail drawer host. Every transaction
// surface opens THIS drawer via ?transaction=; there is exactly one instance.
import { TransactionDetailDrawer } from "@/components/transactions/TransactionDetailDrawer";
import { GlobalHeader } from "@/components/ui/GlobalHeader";
import { ContextualNavbar } from "@/components/ui/ContextualNavbar";
import { BottomNav } from "@/components/ui/BottomNav";
import { CreateSpaceModal } from "@/components/dashboard/CreateSpaceModal";
import { NoticeRail } from "@/components/notices/NoticeRail";
import type { AppNoticeStatus } from "@/components/notices/notice-model";
import { SpaceChromeProvider } from "@/lib/space/space-chrome-context";
import { OPEN_CREATE_SPACE_EVENT } from "@/lib/space-nav";
import { chromeSurface } from "@/components/ui/chrome-surface";
import { PlatformNavProvider } from "@/components/ui/PlatformNavContext";
import type { PlatformSpaceOption } from "@/lib/platform/nav";

export function DashboardChrome({
  children,
  hasPlatformGrants = false,
  operatorTotpPending = false,
  noticeStatus = null,
  platformSpaces,
  platformArea = null,
}: {
  children: ReactNode;
  // UNIFIED NOTICES — the rail's first status, read by the layout (no pop-in);
  // the rail revalidates it client-side. Optional so every other mount is unchanged.
  noticeStatus?: AppNoticeStatus | null;
  // UX-P2 — a SERVER fact from the layout (the viewer's ACTIVE PlatformGrant
  // count, as the tenant, fail-closed to false): shows the GlobalHeader's
  // Personal/Platform context switch. Optional so every other mount is unchanged.
  hasPlatformGrants?: boolean;
  // Owner D4 — a SERVER fact from the layout (grant held, operator 2FA enforced,
  // not enrolled; fail-quiet false): the toggle opens enrolment directly.
  operatorTotpPending?: boolean;
  // Platform Operations 2.0 R1 — SERVER facts from the layout for the Platform
  // context's three-destination nav: the granted Platform Spaces (tenant read)
  // and the remembered Current Space, already intersected with those grants.
  // Optional so every other mount is unchanged (no Platform Spaces).
  platformSpaces?: readonly PlatformSpaceOption[];
  platformArea?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);

  // AI-4 — the AI pages are full-height conversation surfaces: each owns exactly
  // the viewport left between the GlobalHeader and the bottom edge, and scrolls
  // inside itself. Parity PR2: Personal Space AI AND Platform AI get this LAYOUT
  // (components/ui/chrome-surface.ts):
  //  • <main>'s bottom padding is exactly the bottom bar's footprint (h-14 + its
  //    1px border-t + the safe-area inset it pads by — identical for BottomNav
  //    and PlatformBottomBar) instead of pb-24, and 16px on lg, so the docked
  //    composer sits directly on the bar. AiShell's height subtracts the same
  //    expression — change one, change both.
  //  • the notice rail withholds the 2FA reminder on Personal Space AI only
  //    (AI-4). On Platform AI it is NOT hidden by path (S2 2026-11-07): its own
  //    TOTP condition decides, and the rail publishes its height so AiShell
  //    leaves room for it.
  const { conversationLayout: conversationSurface, noticeConversationSurface } = chromeSurface(pathname);

  useEffect(() => {
    function handleOpen() { setCreateSpaceOpen(true); }
    window.addEventListener(OPEN_CREATE_SPACE_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_CREATE_SPACE_EVENT, handleOpen);
  }, []);

  return (
    <SpaceChromeProvider>
      <PlatformNavProvider spaces={platformSpaces} rememberedArea={platformArea} pathname={pathname}>
        <div className="min-h-screen bg-[var(--bg-base)]">
          <GlobalHeader hasPlatformGrants={hasPlatformGrants} operatorTotpPending={operatorTotpPending} />

          <div className="mx-auto flex w-full max-w-[1320px] gap-0 px-4 sm:px-5 lg:gap-8 lg:px-8">
            <ContextualNavbar />

            <main
              className={
                conversationSurface
                  ? "min-w-0 flex-1 pt-6 pb-[calc(3.5rem+1px+env(safe-area-inset-bottom))] lg:pb-4"
                  : "min-w-0 flex-1 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-6 lg:pb-16"
              }
            >
              {/* UNIFIED NOTICES — ONE rail for the whole shell: maintenance (highest
                  priority) and the 2FA reminder (not on Personal Space AI). Renders
                  nothing when no notice applies. Replaces the S8 TotpNudgeBanner. */}
              <NoticeRail initialStatus={noticeStatus} conversationSurface={noticeConversationSurface} />
              {children}
            </main>
          </div>

          {/* Mobile presentation of the same navigation model as ContextualNavbar. */}
          <BottomNav />

          {/* TI5-3C — the single Transaction Detail drawer, shared by every surface
              (Banking, Space, Debt, AccountModal). ?transaction= driven. */}
          <Suspense fallback={null}>
            <TransactionDetailDrawer />
          </Suspense>

          <CreateSpaceModal
            open={createSpaceOpen}
            onClose={() => setCreateSpaceOpen(false)}
            onCreated={() => router.refresh()}
          />
        </div>
      </PlatformNavProvider>
    </SpaceChromeProvider>
  );
}
