import { DashboardChrome } from "@/components/ui/DashboardChrome";
import { ReactNode } from "react";

// Applies to every page nested under this layout (all /dashboard/* tabs) —
// kept explicit per-page too since route-segment config inheritance for
// route handlers vs. pages isn't relied upon here.
export const preferredRegion = "sin1";
export const runtime = "nodejs";

// Stays a Server Component specifically so the segment config above is
// honored — the actual chrome (Sidebar/headers/main/BottomNav) lives in
// DashboardChrome.tsx, a Client Component, since it needs usePathname() to
// drop the top-bar divider only on the Spaces page (see that file's header
// comment for why).
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardChrome>{children}</DashboardChrome>;
}
