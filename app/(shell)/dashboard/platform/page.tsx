/**
 * app/(shell)/dashboard/platform/page.tsx
 *
 * The Platform OVERVIEW — the first of the Platform context's three
 * destinations (Overview · AI · Current Space; lib/platform/nav). Server
 * Component, inside the ordinary dashboard shell. Platform Operations 2.0 R1:
 * the summary-first command center (components/platform/overview) replaced the
 * card directory; the Space switcher now lives in the navigation.
 *
 * This is a PAGE, not a Space: `/dashboard/platform` (no trailing segment) is
 * off the Space axis (ContextualNavbar `isPlatformSpaceRoute` is false here), so
 * no Space chrome mounts. It shows the Platform Spaces the viewer's ACTIVE
 * grants reach, in registry order, and NEVER auto-opens one (no redirect into an
 * area; the remembered Current Space only labels the nav — see lib/platform/nav).
 *
 * Gate order (mirrors [area]/page.tsx — redirect, never 404):
 *   1. a session must exist                    → else /login
 *   2. at least one ACTIVE PlatformGrant        → else /dashboard/spaces
 *   3. operator 2FA, when enforced              → else the enrolment screen
 * SYSTEM_ADMIN never reaches this page — proxy.ts redirects them off
 * /dashboard/* to /admin.
 *
 * AUTHORITY — this page decides nothing. The rows come from
 * lib/platform/directory.server.ts, a TENANT read keyed on the session's own
 * user id. The Overview mounts one reader per GRANTED area, and each reads only
 * that area's own /api/platform/<area>/ routes, which re-check the grant. No
 * customer-Space machinery here: no resolveSpaceContext, no ACTIVE_SPACE_COOKIE,
 * no SpaceMember lookup (tripwired in lib/platform-surface.test.ts).
 */

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import { loadPlatformDirectory, operatorHasTotp } from "@/lib/platform/directory.server";
import { OPERATOR_TOTP_ENROLMENT_PATH } from "@/lib/platform/authorize";
import { env } from "@/lib/env";
import { displaySpaceName } from "@/lib/format";
import { PlatformOverview } from "@/components/platform/overview/PlatformOverview";

export const runtime = "nodejs";

export default async function PlatformOverviewPage() {
  // 1. Session (same pattern as the launcher and [area]/page.tsx).
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectToLogin();

  // 2. The granted Platform Spaces, as the tenant. Zero ⇒ this page has nothing
  //    to show and the viewer has no business here: back to the launcher.
  const spaces = await loadPlatformDirectory(session.user.id);
  if (spaces.length === 0) redirect("/dashboard/spaces");
  // SEC-PLAT-1 — same rule as the shared guard, same destination as [area].
  if (env.isOperatorTotpEnforced && !(await operatorHasTotp(session.user.id))) redirect(OPERATOR_TOTP_ENROLMENT_PATH);

  return <PlatformOverview spaces={spaces.map((p) => ({ id: p.id, name: displaySpaceName(p.name), area: p.area }))} />;
}
