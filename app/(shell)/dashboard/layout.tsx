import { DashboardChrome } from "@/components/ui/DashboardChrome";
import { DisplayCurrencyProvider } from "@/lib/currency-context";
import { getSpaceContext } from "@/lib/space";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import { resolveEffectiveSpaceConversion } from "@/lib/money/server-context";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { yesterdayUTCISO } from "@/lib/fx/config";
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
  // A REVOKED session still carries a validly signed JWT, so proxy.ts lets it
  // through; only this revocation-aware read can tell. Without this check every
  // page below threw "Not authenticated — no active session" from
  // getSpaceContext() and the user got the error page instead of /login. Now
  // they sign in again and return to the page they opened
  // (lib/auth/login-redirect.ts).
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectToLogin();

  // MC1 Phase 4 Slice 1 (D-1) — resolve the active Space's display currency
  // once for the whole dashboard tree (getSpaceContext() is cache()-deduped,
  // so pages re-resolving it cost nothing extra).
  //
  // REVIEW-3 B-5 (E5, matrix row 34) — the EFFECTIVE display currency, through
  // the one decision point (lib/money/server-context.ts, V25-CLOSE-3A), not the
  // raw Space.reportingCurrency. The raw value here meant every page under this
  // layout that does not re-wrap (/dashboard/credit, /analyze, /connections,
  // settings) labelled amounts in a currency the archive may not be able to
  // satisfy, while /dashboard itself re-wrapped with the reverted one — two
  // labels for one Space in one shell. The probe asks the same floor question
  // /api/money/view-context asks (can USD legs convert into the requested
  // target at the latest close?); for a USD Space it is coverage-free and no
  // rate is ever resolved, so the universal case is byte-identical.
  //
  // Defensive fallback: the provider treats undefined as USD, so context- or
  // resolution-failure renders exactly the pre-MC1 display.
  let displayCurrency: string | undefined;
  try {
    const ctx = await getSpaceContext();
    const requested = ctx.space.reportingCurrency;
    if (!requested || requested === DEFAULT_DISPLAY_CURRENCY) {
      displayCurrency = requested ?? undefined;
    } else {
      const resolved = await resolveEffectiveSpaceConversion(
        { reportingCurrency: requested },
        { currencies: [DEFAULT_DISPLAY_CURRENCY], dates: [yesterdayUTCISO()] },
      );
      displayCurrency = resolved.effective;
    }
  } catch {
    displayCurrency = undefined;
  }

  return (
    <DisplayCurrencyProvider currency={displayCurrency}>
      <DashboardChrome>{children}</DashboardChrome>
    </DisplayCurrencyProvider>
  );
}
