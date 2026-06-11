/**
 * lib/auth.ts
 *
 * NextAuth v4 configuration.
 *
 * Credentials provider only — email + bcrypt password.
 * Session strategy: JWT (no DB sessions).
 *
 * SYSTEM_ADMIN notes:
 *   - Logs in via this same flow
 *   - M3-TOTP: after TOTP is implemented, admin login will require TOTP verification
 *     Uncomment the TOTP guard block below once M3 is complete.
 *   - Admin routes are at /admin/* — the middleware redirects admins away from /dashboard
 *   - To disable SYSTEM_ADMIN entirely: set role = USER in the DB or set
 *     DISABLE_SYSTEM_ADMIN=true in .env and it will be rejected at login
 */

import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { UserRole } from "@prisma/client";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        identifier: { label: "Email or Username", type: "text"     },
        password:   { label: "Password",          type: "password" },
      },

      async authorize(credentials) {
        if (!credentials?.identifier || !credentials?.password) return null;

        const identifier = credentials.identifier.toLowerCase().trim();

        // ── Kill switch: disable SYSTEM_ADMIN login via env flag ──────────────
        // Set DISABLE_SYSTEM_ADMIN=true before going to production to lock out
        // the god account entirely without needing a DB change.
        const adminDisabled = process.env.DISABLE_SYSTEM_ADMIN === "true";

        // ── Look up user by email OR username ─────────────────────────────────
        const user = await db.user.findFirst({
          where: {
            OR: [
              { email:    identifier },
              { username: identifier },
            ],
          },
          select: { id: true, email: true, name: true, username: true, passwordHash: true, role: true, totpEnabled: true },
        });

        if (!user || !user.passwordHash) {
          // Log failed attempt — no userId because user may not exist
          await db.auditLog.create({
            data: {
              action:   "LOGIN_FAILED",
              metadata: { identifier, reason: "user_not_found" },
            },
          });
          return null;
        }

        // ── Kill switch check ─────────────────────────────────────────────────
        if (adminDisabled && user.role === UserRole.SYSTEM_ADMIN) {
          await db.auditLog.create({
            data: {
              userId:   user.id,
              action:   "LOGIN_FAILED",
              metadata: { reason: "system_admin_disabled", role: user.role },
            },
          });
          return null;
        }

        // ── Verify password ───────────────────────────────────────────────────
        const valid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!valid) {
          await db.auditLog.create({
            data: {
              userId:   user.id,
              action:   "LOGIN_FAILED",
              metadata: { identifier, reason: "invalid_password", role: user.role },
            },
          });
          return null;
        }

        // ── M3-TOTP guard (uncomment after TOTP milestone is complete) ────────
        // if (user.role === UserRole.SYSTEM_ADMIN && !user.totpEnabled) {
        //   await db.auditLog.create({
        //     data: {
        //       userId:   user.id,
        //       action:   "LOGIN_FAILED",
        //       metadata: { reason: "admin_totp_required", role: user.role },
        //     },
        //   });
        //   throw new Error("AdminTOTPRequired");
        // }

        // ── Log successful login ──────────────────────────────────────────────
        await db.auditLog.create({
          data: {
            userId:   user.id,
            action:   "LOGIN",
            metadata: { role: user.role },
          },
        });

        return {
          id:       user.id,
          email:    user.email,
          name:     user.name     ?? undefined,
          username: user.username ?? null,
          role:     user.role,
        };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user, trigger, session }) {
      // `user` is only present on first sign-in — persist to JWT
      if (user) {
        token.id       = user.id;
        token.role     = (user as { role: UserRole }).role;
        token.username = (user as { username?: string | null }).username ?? null;
      }
      // `trigger === "update"` fires when client calls useSession().update({ username })
      if (trigger === "update" && session?.username !== undefined) {
        token.username = session.username;
      }
      return token;
    },

    async session({ session, token }) {
      session.user.id       = token.id       as string;
      session.user.role     = token.role     as UserRole;
      session.user.username = token.username as string | null | undefined;
      return session;
    },
  },

  events: {
    // Append-only audit log on sign-out (client-triggered)
    async signOut({ token }) {
      if (token?.id) {
        await db.auditLog.create({
          data: {
            userId: token.id as string,
            action: "LOGOUT",
          },
        }).catch(() => { /* non-fatal */ });
      }
    },
  },

  pages: {
    signIn: "/login",
    error:  "/login",   // errors append ?error=... to the login URL
  },

  session: {
    strategy: "jwt",
    maxAge:   30 * 24 * 60 * 60, // 30 days
  },

  secret: process.env.NEXTAUTH_SECRET,
};
