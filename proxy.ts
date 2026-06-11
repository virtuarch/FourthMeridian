/**
 * proxy.ts  (Next.js 16+ — replaces middleware.ts)
 *
 * Route protection via NextAuth's withAuth helper.
 *
 * Rules:
 *   - Any route matching /dashboard/* or /admin/* requires a valid JWT session.
 *     Unauthenticated requests are redirected to /login.
 *   - SYSTEM_ADMIN users are redirected away from /dashboard/* to /admin
 *     (the admin panel lives at /admin, regular finance dashboard is off-limits).
 *   - Regular USER accounts cannot access /admin/* routes.
 *
 * To fully disable SYSTEM_ADMIN access before production:
 *   Set DISABLE_SYSTEM_ADMIN=true in .env — the authorize() callback in lib/auth.ts
 *   will reject their credentials before a session is ever issued.
 */

import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

export default withAuth(
  function middleware(req) {
    const { token }    = req.nextauth;
    const { pathname } = req.nextUrl;

    // SYSTEM_ADMIN trying to use the regular dashboard → send to admin panel
    if (token?.role === "SYSTEM_ADMIN" && pathname.startsWith("/dashboard")) {
      return NextResponse.redirect(new URL("/admin", req.url));
    }

    // Regular user trying to access admin routes → send back to dashboard
    if (token?.role !== "SYSTEM_ADMIN" && pathname.startsWith("/admin")) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      // Return true if a valid JWT exists — withAuth handles the /login redirect
      authorized: ({ token }) => !!token,
    },
    pages: {
      signIn: "/login",
    },
  }
);

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/admin/:path*",
  ],
};
