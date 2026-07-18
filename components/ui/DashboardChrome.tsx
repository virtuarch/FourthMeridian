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

import { useRouter } from "next/navigation";
import { ReactNode, Suspense, useEffect, useState } from "react";
// TI5-3C — single, shell-level Transaction Detail drawer host. Every transaction
// surface opens THIS drawer via ?transaction=; there is exactly one instance.
import { TransactionDetailDrawer } from "@/components/transactions/TransactionDetailDrawer";
import { GlobalHeader } from "@/components/ui/GlobalHeader";
import { ContextualNavbar } from "@/components/ui/ContextualNavbar";
import { BottomNav } from "@/components/ui/BottomNav";
import { CreateSpaceModal } from "@/components/dashboard/CreateSpaceModal";
import { TotpNudgeBanner } from "@/components/dashboard/TotpNudgeBanner";
import { SpaceChromeProvider } from "@/lib/space/space-chrome-context";
import { OPEN_CREATE_SPACE_EVENT } from "@/lib/space-nav";

export function DashboardChrome({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);

  useEffect(() => {
    function handleOpen() { setCreateSpaceOpen(true); }
    window.addEventListener(OPEN_CREATE_SPACE_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_CREATE_SPACE_EVENT, handleOpen);
  }, []);

  return (
    <SpaceChromeProvider>
      <div className="min-h-screen bg-[var(--bg-base)]">
        <GlobalHeader />

        <div className="mx-auto flex w-full max-w-[1320px] gap-0 px-4 sm:px-5 lg:gap-8 lg:px-8">
          <ContextualNavbar />

          <main className="min-w-0 flex-1 pb-24 pt-6 lg:pb-16">
            {/* S8 — dismissible 2FA nudge; renders nothing for users with TOTP
                enabled, for SYSTEM_ADMIN, or once dismissed (per-browser). */}
            <TotpNudgeBanner />
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
    </SpaceChromeProvider>
  );
}
