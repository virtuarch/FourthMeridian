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
 *     Unauthenticated requests are redirected to /login?callbackUrl=<path>.
 *   - SYSTEM_ADMIN users are redirected away from /dashboard/* to /admin.
 *   - Regular USER/ADMIN accounts cannot access /admin/* routes.
 *   - If the platform requires TOTP and this user hasn't enrolled yet,
 *     redirect to the appropriate setup page for their role:
 *       SYSTEM_ADMIN → /admin/security?setup2fa=true
 *       USER/ADMIN   → /dashboard/settings?setup2fa=true
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
    signIn.searchParams.set("callbackUrl", pathname);
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
  const totpSetupAllowed =
    pathname.startsWith("/dashboard/settings") ||
    pathname.startsWith("/admin/security")     ||
    pathname.startsWith("/api/user/totp")      ||
    pathname.startsWith("/api/auth");

  if (token.requireTotpSetup && !totpSetupAllowed) {
    const isSysAdmin = token.role === "SYSTEM_ADMIN";
    const setupPath  = isSysAdmin
      ? "/admin/security?setup2fa=true"
      : "/dashboard/settings?setup2fa=true";
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
