/**
 * proxy.ts  (Next.js 16+ — replaces middleware.ts)
 *
 * Route protection via direct getToken — Edge-safe, no dynamic dependency graph.
 *
 * Using getToken instead of withAuth avoids a Turbopack recompilation issue:
 * withAuth's dynamic require() chain (→ jose → @babel/runtime) causes Turbopack
 * to re-evaluate the middleware module graph on every HMR cycle, triggering
 * routes-manifest/build-manifest regeneration races. getToken is a single
 * static import with no such side-effects.
 *
 * Rules:
 *   - Any route matching /dashboard/* or /admin/* requires a valid JWT session.
 *     Unauthenticated requests are redirected to /login?callbackUrl=<path+query>.
 *   - SYSTEM_ADMIN users are redirected away from /dashboard/* to /admin.
 *   - Regular USER accounts cannot access /admin/* routes.
 *   - If the platform requires TOTP and this user hasn't enrolled yet,
 *     redirect to the appropriate setup page for their role:
 *       SYSTEM_ADMIN → /admin/security?setup2fa=true
 *       USER         → /dashboard/settings/security?setup2fa=true
 *
 * (UserRole has exactly two members — USER and SYSTEM_ADMIN. Earlier revisions
 * of this comment referred to an "ADMIN" role that does not exist.)
 *
 * SCOPE (PO-1A) — this file picks the enrolment SURFACE for page navigations.
 * It is NOT the authorization boundary and cannot be: the matcher below is
 * ["/dashboard/:path*", "/admin/:path*"], so this never executes for a single
 * /api/* request. API authorization lives in lib/session.ts, which denies every
 * pending session independently. Both must agree — a surface this file routes a
 * pending session TO must compose only data lib/session.ts will serve a pending
 * session, i.e. /api/user/totp/* and nothing else.
 *
 * To fully disable SYSTEM_ADMIN access before production:
 *   Set DISABLE_SYSTEM_ADMIN=true in .env — the authorize() callback in lib/auth.ts
 *   will reject their credentials before a session is ever issued.
 */

import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export default async function middleware(req: NextRequest) {
  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  });

  const { pathname } = req.nextUrl;

  // ── Authentication gate ─────────────────────────────────────────────────
  // No valid JWT → redirect to login, preserving the intended destination.
  if (!token) {
    const signIn = new URL("/login", req.url);
    // Preserve the FULL intended destination, not just the path: virtually all
    // deep-link state (tab, perspective, asof, compareto, preset, account, …)
    // lives in the query string, so `pathname` alone silently drops it. `search`
    // includes the leading "?" (empty string when there's no query), keeping this
    // a same-origin-relative "/dashboard?…" value — it still starts with "/", so
    // the open-redirect guard in app/(auth)/login/page.tsx (dest.startsWith("/"))
    // passes it through unchanged after a successful login.
    signIn.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
    return NextResponse.redirect(signIn);
  }

  // ── Role-based routing ──────────────────────────────────────────────────
  // SYSTEM_ADMIN trying to use the regular dashboard → send to admin panel
  if (token.role === "SYSTEM_ADMIN" && pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/admin", req.url));
  }

  // Regular user trying to access admin routes → send back to dashboard
  if (token.role !== "SYSTEM_ADMIN" && pathname.startsWith("/admin")) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  // ── TOTP enforcement ────────────────────────────────────────────────────
  // If a platform setting requires TOTP and this user hasn't enrolled yet,
  // allow access only to the pages needed to complete enrollment.
  //
  // PO-1A — narrowed from the whole /dashboard/settings subtree to the security
  // section that actually hosts the enrolment widget. The other sections
  // (account, preferences, notifications, data) are ordinary authenticated
  // surfaces a pending session has no business reading; their loaders now
  // enforce the same gate (lib/settings/loaders.ts), so this is the outer half
  // of a matched pair rather than the only lock.
  //
  // The previous list also tested /api/user/totp and /api/auth. Those branches
  // were dead: the matcher at the bottom of this file scopes execution to
  // /dashboard/* and /admin/*, so `pathname` can never begin with /api. They
  // read as if this file protected the enrolment API, which it does not and
  // cannot — lib/session.ts does, via allowTotpSetupPending.
  const totpSetupAllowed =
    pathname.startsWith("/dashboard/settings/security") ||
    pathname.startsWith("/admin/security");

  if (token.requireTotpSetup && !totpSetupAllowed) {
    const isSysAdmin = token.role === "SYSTEM_ADMIN";
    // Deep-links to the SECTION, not the /dashboard/settings index: that index
    // is a server redirect to …/settings/account which drops the query string,
    // so routing enrolment through it silently stripped setup2fa and stranded
    // the user on a page with no enrolment UI.
    // Mirrors ADMIN_TOTP_ENROLLMENT_PATH / USER_TOTP_ENROLLMENT_PATH in
    // lib/admin-totp-enrollment.ts — duplicated because this module runs on the
    // Edge and keeps a zero-import graph (see the header); the two are locked
    // together by lib/admin-totp-enrollment-surface.test.ts.
    const setupPath  = isSysAdmin
      ? "/admin/security?setup2fa=true"
      : "/dashboard/settings/security?setup2fa=true";
    return NextResponse.redirect(new URL(setupPath, req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/admin/:path*",
  ],
};
