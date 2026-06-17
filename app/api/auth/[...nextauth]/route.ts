/**
 * app/api/auth/[...nextauth]/route.ts
 *
 * NextAuth catch-all route handler for the App Router.
 * All auth requests (/api/auth/signin, /api/auth/session, etc.) flow through here.
 */

import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

// Client-side SessionProvider polls /api/auth/session frequently — log
// evidence showed this round trip alone costing 1.5-3.6s, consistent with
// the Vercel-function-to-Singapore-Supabase distance. Co-locate.
export const preferredRegion = "sin1";
export const runtime = "nodejs";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
