import { Sidebar } from "@/components/ui/Sidebar";
import { BottomNav } from "@/components/ui/BottomNav";
import { UserButton } from "@/components/ui/UserButton";
import { ReactNode } from "react";

// Applies to every page nested under this layout (all /dashboard/* tabs) —
// kept explicit per-page too since route-segment config inheritance for
// route handlers vs. pages isn't relied upon here.
export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-gray-950">
      {/* Desktop sidebar */}
      <Sidebar />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden sticky top-0 z-40 border-b border-gray-800 bg-gray-950/95 backdrop-blur-sm">
          <div className="flex items-center justify-between px-4 h-14">
            <div className="flex items-center gap-1.5">
              <img src="/logo-icon.png" alt="FinTracker" className="w-8 h-8 rounded-xl shrink-0 object-contain" />
              <span className="font-bold text-white text-lg">FinTracker</span>
            </div>
            <div className="flex items-center gap-2">
              <button className="text-xs text-gray-400 border border-gray-700 rounded-lg px-3 py-1.5 hover:text-white hover:border-gray-500 transition-colors">
                Refresh
              </button>
              <UserButton />
            </div>
          </div>
        </header>

        {/* Desktop top bar */}
        <header className="hidden lg:flex items-center justify-between px-8 h-14 border-b border-gray-800">
          <div /> {/* spacer */}
          <button className="flex items-center gap-2 text-xs text-gray-400 border border-gray-700 rounded-lg px-3 py-1.5 hover:text-white hover:border-gray-500 transition-colors">
            <span>Refresh Data</span>
          </button>
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
