/**
 * app/api/auth/[...nextauth]/route.ts
 *
 * NextAuth catch-all route handler for the App Router.
 * All auth requests (/api/auth/signin, /api/auth/session, etc.) flow through here.
 */

import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
