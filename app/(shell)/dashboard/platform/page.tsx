/**
 * app/(shell)/dashboard/platform/page.tsx  (UX-P2 — navigation separation)
 *
 * The Platform Spaces DIRECTORY — what the GlobalHeader's "Platform Spaces"
 * segment opens. Server Component, inside the ordinary dashboard shell.
 *
 * This is a PAGE, not a Space: `/dashboard/platform` (no trailing segment) is
 * off the Space axis (ContextualNavbar `isPlatformSpaceRoute` is false here), so
 * no Space chrome mounts and no primary destination lights. It lists the
 * Platform Spaces the viewer's ACTIVE grants reach, as HQ cards, in registry
 * order, each a plain link to the bare area URL. It NEVER auto-opens one: there
 * is no stored "last area", no cookie, no `/api/space/switch`.
 *
 * Gate order (mirrors [area]/page.tsx — redirect, never 404):
 *   1. a session must exist                    → else /login
 *   2. at least one ACTIVE PlatformGrant        → else /dashboard/spaces
 * SYSTEM_ADMIN never reaches this page — proxy.ts redirects them off
 * /dashboard/* to /admin.
 *
 * AUTHORITY — this page decides nothing. The rows come from
 * lib/platform/directory.server.ts, a TENANT read keyed on the session's own
 * user id (a grant is a fact about the viewer; `Space.fm_app_sel`'s platform
 * arm admits the Spaces those grants name). Opening a card lands on
 * [area]/page.tsx, which re-checks the grant itself. No customer-Space
 * machinery here: no resolveSpaceContext, no ACTIVE_SPACE_COOKIE, no
 * SpaceMember lookup (tripwired in lib/platform-surface.test.ts).
 */

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import { loadPlatformDirectory } from "@/lib/platform/directory.server";
import { PlatformSpaceDirectory } from "@/components/platform/PlatformSpaceDirectory";

export const runtime = "nodejs";

export default async function PlatformDirectoryPage() {
  // 1. Session (same pattern as the launcher and [area]/page.tsx).
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectToLogin();

  // 2. The granted Platform Spaces, as the tenant. Zero ⇒ this page has nothing
  //    to show and the viewer has no business here: back to the launcher.
  const spaces = await loadPlatformDirectory(session.user.id);
  if (spaces.length === 0) redirect("/dashboard/spaces");

  return <PlatformSpaceDirectory spaces={spaces} />;
}
