import { DashboardChrome } from "@/components/ui/DashboardChrome";
import { DisplayCurrencyProvider } from "@/lib/currency-context";
import { getSpaceContext } from "@/lib/space";
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
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // MC1 Phase 4 Slice 1 (D-1) — resolve the active Space's reporting currency
  // once for the whole dashboard tree (getSpaceContext() is cache()-deduped,
  // so pages re-resolving it cost nothing extra). Defensive fallback: the
  // provider treats undefined as USD, so context-resolution failure renders
  // exactly the pre-MC1 display.
  let reportingCurrency: string | undefined;
  try {
    const ctx = await getSpaceContext();
    reportingCurrency = ctx.space.reportingCurrency;
  } catch {
    reportingCurrency = undefined;
  }

  return (
    <DisplayCurrencyProvider currency={reportingCurrency}>
      <DashboardChrome>{children}</DashboardChrome>
    </DisplayCurrencyProvider>
  );
}
