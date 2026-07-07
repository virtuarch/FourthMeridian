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

export { handler as GET, limitedPost as POST };
