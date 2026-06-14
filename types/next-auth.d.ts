/**
 * types/next-auth.d.ts
 *
 * Extends NextAuth's built-in types so that session fields are fully typed
 * everywhere in the app without casting.
 */

import "next-auth";
import { UserRole } from "@prisma/client";

declare module "next-auth" {
  interface Session {
    user: {
      id:           string;
      email:        string;
      name?:        string | null;
      username?:    string | null;
      role:         UserRole;
    };
    sessionToken?:     string | null; // opaque id matching UserSession.sessionToken — used to identify current session
    requireTotpSetup?: boolean | null; // set when platform requires TOTP but user hasn't enrolled yet — middleware redirects to /settings
  }

  interface User {
    id:       string;
    role:     UserRole;
    username?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id:                string;
    role:              UserRole;
    username?:         string | null;
    sessionToken?:     string | null;
    requireTotpSetup?: boolean | null;
  }
}
