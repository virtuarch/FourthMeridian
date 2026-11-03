/**
 * app/api/auth/[...nextauth]/route.ts
 *
 * NextAuth catch-all route handler for the App Router.
 * All auth requests (/api/auth/signin, /api/auth/session, etc.) flow through here.
 *
 * OPS-1 S4: POST is wrapped with a per-IP rate limit that applies ONLY to the
 * credentials login callback sub-path (/api/auth/callback/credentials) — the
 * real login attempt, not just the advisory /api/auth/pre-login probe. Session
 * polling, CSRF fetches, and sign-out stay unthrottled. The companion
 * per-identifier limit runs inside authorize() (lib/auth.ts).
 */

import NextAuth from "next-auth";
import type { NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";
import { limitByIp } from "@/lib/rate-limit";
import { runWithoutSessionTouch } from "@/lib/auth/presence-scope";

// Client-side SessionProvider polls /api/auth/session frequently — log
// evidence showed this round trip alone costing 1.5-3.6s, consistent with
// the Vercel-function-to-Singapore-Supabase distance. Co-locate.
export const preferredRegion = "sin1";
export const runtime = "nodejs";

const handler = NextAuth(authOptions);

async function limitedPost(
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> },
) {
  if (req.nextUrl.pathname.endsWith("/callback/credentials")) {
    const limited = await limitByIp(req, "login-callback", { limit: 20, windowSec: 900 });
    if (limited) return limited;
  }
  return handler(req, ctx);
}

/**
 * PB-10 F3 (S2 ruling) — the SessionProvider's focus/visibility refetch,
 * GET /api/auth/session, is BACKGROUND, not session use. It is KEPT (it carries
 * revocation and role changes to an open tab) but runs with the lastActiveAt
 * touch switched off, so an idle open tab no longer extends the SEC-010 idle
 * deadline. Everything else is unchanged: the same session callback validates
 * the token, the row, the owner, the SEC-010 lifetime, the role and the TOTP
 * requirement; the revocation-cache TTL is untouched.
 *
 * NARROW: only a GET whose NextAuth action is exactly `session` (the catch-all's
 * own route parameter). signin, callback, csrf, signout, providers and EVERY
 * POST — including the client `update()` of /api/auth/session — keep the normal
 * touch. The decision is this route's, never a client header or query.
 */
function isBackgroundSessionRead(nextauth: readonly string[] | undefined): boolean {
  return Array.isArray(nextauth) && nextauth.length === 1 && nextauth[0] === "session";
}

async function sessionAwareGet(
  req: NextRequest,
  ctx: { params: Promise<{ nextauth: string[] }> },
) {
  const { nextauth } = await ctx.params;
  if (isBackgroundSessionRead(nextauth)) return runWithoutSessionTouch(() => handler(req, ctx));
  return handler(req, ctx);
}

export { sessionAwareGet as GET, limitedPost as POST };
