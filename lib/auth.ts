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
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/plaid/encryption";
import { verifyRecoveryCode } from "@/lib/recovery-codes";
import { AuditAction } from "@/lib/audit-actions";
import { verifyTOTP } from "@/lib/totp";
import { UserRole } from "@prisma/client";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        identifier:   { label: "Email or Username", type: "text"     },
        password:     { label: "Password",          type: "password" },
        totpCode:     { label: "TOTP Code",         type: "text"     },
        recoveryCode: { label: "Recovery Code",     type: "text"     },
      },

      async authorize(credentials, req) {
        if (!credentials?.identifier || !credentials?.password) return null;

        const ipAddress = (req?.headers?.["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
          ?? (req?.headers?.["x-real-ip"] as string | undefined)
          ?? null;
        const userAgent = (req?.headers?.["user-agent"] as string | undefined) ?? null;

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
          select: { id: true, email: true, name: true, username: true, passwordHash: true, role: true, totpEnabled: true, totpSecret: true },
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

        // ── Platform TOTP requirement check ───────────────────────────────────
        // Check if the platform requires TOTP for this user's role.
        // If required but not yet enrolled, we still allow login but mark the
        // session with requireTotpSetup = true. Middleware redirects those
        // sessions to /settings?setup2fa=true for forced enrollment.
        let requireTotpSetup = false;
        if (!user.totpEnabled) {
          const roleKey =
            user.role === UserRole.SYSTEM_ADMIN ? "require_totp_system_admin" :
                                                  "require_totp_all_users";

          const [roleRequired, allRequired] = await Promise.all([
            db.platformSetting.findUnique({ where: { key: roleKey },             select: { value: true } }),
            db.platformSetting.findUnique({ where: { key: "require_totp_all_users" }, select: { value: true } }),
          ]);

          if (roleRequired?.value === "true" || allRequired?.value === "true") {
            requireTotpSetup = true;
          }
        }

        // ── TOTP enforcement ──────────────────────────────────────────────────
        // If the user has 2FA enabled, they must provide either a valid TOTP
        // code or a valid recovery code to complete login.
        // The login page sends these via the two-step flow (pre-login → TOTP screen).
        if (user.totpEnabled && user.totpSecret) {
          const totpCode     = (credentials as Record<string, string>).totpCode?.replace(/\s/g, "");
          const recoveryCode = (credentials as Record<string, string>).recoveryCode?.trim();

          if (!totpCode && !recoveryCode) {
            // No second factor provided — block login
            await db.auditLog.create({
              data: {
                userId:   user.id,
                action:   AuditAction.LOGIN_FAILED,
                ipAddress,
                userAgent,
                metadata: { reason: "totp_required", identifier },
              },
            });
            return null;
          }

          if (totpCode) {
            // Verify TOTP code
            let secret: string;
            try { secret = decrypt(user.totpSecret); }
            catch {
              return null; // corrupted secret — fail safe
            }
            if (!verifyTOTP(totpCode, secret, 1)) {
              await db.auditLog.create({
                data: {
                  userId:   user.id,
                  action:   AuditAction.LOGIN_FAILED,
                  ipAddress,
                  userAgent,
                  metadata: { reason: "totp_invalid", identifier },
                },
              });
              return null;
            }
          } else if (recoveryCode) {
            // Verify and consume a recovery code
            const used = await verifyRecoveryCode(user.id, recoveryCode);
            if (!used) {
              await db.auditLog.create({
                data: {
                  userId:   user.id,
                  action:   AuditAction.LOGIN_FAILED,
                  ipAddress,
                  userAgent,
                  metadata: { reason: "recovery_code_invalid", identifier },
                },
              });
              return null;
            }
            // verifyRecoveryCode marks the code used; write the login event below
          }
        }

        // ── Create session record + audit log ─────────────────────────────────
        const sessionToken = randomUUID();

        await db.$transaction([
          db.userSession.create({
            data: {
              userId: user.id,
              sessionToken,
              ipAddress,
              userAgent,
            },
          }),
          db.auditLog.create({
            data: {
              userId:    user.id,
              action:    "LOGIN",
              ipAddress,
              userAgent,
              metadata:  { role: user.role },
            },
          }),
        ]);

        return {
          id:               user.id,
          email:            user.email,
          name:             user.name     ?? undefined,
          username:         user.username ?? null,
          role:             user.role,
          sessionToken,
          requireTotpSetup: requireTotpSetup || null,
        } as never; // extra fields flow to JWT via jwt callback
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user, trigger, session }) {
      // `user` is only present on first sign-in — persist to JWT
      if (user) {
        const u = user as { role: UserRole; username?: string | null; sessionToken?: string; requireTotpSetup?: boolean | null };
        token.id               = user.id;
        token.role             = u.role;
        token.username         = u.username         ?? null;
        token.sessionToken     = u.sessionToken     ?? null;
        token.requireTotpSetup = u.requireTotpSetup ?? null;
      }
      // `trigger === "update"` fires when client calls useSession().update(...)
      if (trigger === "update") {
        if (session?.username !== undefined)         token.username         = session.username;
        if (session?.requireTotpSetup !== undefined) token.requireTotpSetup = session.requireTotpSetup;
      }
      return token;
    },

    async session({ session, token }) {
      const sessionToken = token.sessionToken as string | null | undefined;

      // ── Revocation check ───────────────────────────────────────────────────
      // JWT tokens are stateless — revoking a UserSession row doesn't invalidate
      // the cookie automatically. We check the DB on every session access so
      // revoked sessions are rejected immediately across all devices.
      //
      // This callback runs on EVERY getServerSession()/requireUser() call —
      // every Server Component render and every API route that checks auth —
      // each paying its own DB round trip here. Timed explicitly because this
      // is the leading suspect for the multi-second latency seen on
      // /dashboard/workspaces and its sibling API routes: even a trivial
      // count() query (api/workspaces/invites/pending) took 5+ seconds, which
      // only makes sense if the auth check wrapping it — not the query itself
      // — is the dominant cost.
      if (sessionToken) {
        const tRevoke = Date.now();
        const dbSession = await db.userSession.findFirst({
          where:  { sessionToken, revokedAt: null },
          select: { id: true },
        });
        console.log(`[auth] session callback revocation check: ${Date.now() - tRevoke}ms`);

        if (!dbSession) {
          // Return a bare expired session — middleware will redirect to /login
          return { ...session, user: undefined as never, expires: new Date(0).toISOString() };
        }

        // Bump lastActiveAt (fire-and-forget — don't block the response)
        db.userSession.updateMany({
          where: { sessionToken },
          data:  { lastActiveAt: new Date() },
        }).catch(() => {});
      }

      session.user.id        = token.id               as string;
      session.user.role      = token.role             as UserRole;
      session.user.username  = token.username         as string | null | undefined;
      session.sessionToken   = sessionToken           ?? null;
      session.requireTotpSetup = (token.requireTotpSetup as boolean | null | undefined) ?? null;
      return session;
    },
  },

  events: {
    async signOut({ token }) {
      if (!token?.id) return;
      const userId       = token.id           as string;
      const sessionToken = token.sessionToken as string | null | undefined;

      await Promise.all([
        // Mark the specific session revoked
        sessionToken
          ? db.userSession.updateMany({
              where: { userId, sessionToken, revokedAt: null },
              data:  { revokedAt: new Date() },
            }).catch(() => {})
          : Promise.resolve(),
        db.auditLog.create({
          data: { userId, action: "LOGOUT" },
        }).catch(() => {}),
      ]);
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
