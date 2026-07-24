/**
 * lib/auth.ts
 *
 * NextAuth v4 configuration.
 *
 * Credentials provider only — email + bcrypt password.
 * Session strategy: JWT (no DB sessions).
 *
 * SYSTEM_ADMIN notes:
 *   - Logs in via this same flow.
 *   - MFA is MANDATORY (PO-1): an un-enrolled admin is forced into TOTP
 *     enrolment (requireTotpSetup) and can reach nothing but the 2FA-setup flow;
 *     an enrolled admin is challenged for a live TOTP/recovery code every login.
 *     There is no password-only path to admin power. This is NOT gated on the
 *     REQUIRE_TOTP_* platform settings — see lib/auth-totp-policy.ts.
 *   - Admin routes are at /admin/* — the middleware redirects admins away from /dashboard
 *   - To disable SYSTEM_ADMIN entirely: set role = USER in the DB or set
 *     DISABLE_SYSTEM_ADMIN=true in .env and it will be rejected at login
 */

import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { decryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { verifyRecoveryCode } from "@/lib/recovery-codes";
import { AuditAction } from "@/lib/audit-actions";
import { buildAuditData } from "@/lib/audit";
import { requiresTotpEnrollment } from "@/lib/auth-totp-policy";
import { PlatformSettingKey } from "@/lib/platform-settings";
import { verifyTOTP } from "@/lib/totp";
import { sendEmail } from "@/lib/email/send";
import { createNotification } from "@/lib/notifications/create";
import { formatDateTime } from "@/lib/format";
import { UserRole } from "@prisma/client";
import { getCachedRevocation, setCachedRevocation, invalidateSession } from "@/lib/session-cache";
import { checkKeyLimitStrict, peekKey } from "@/lib/rate-limit";
import { captureAuthInfraFailure } from "@/lib/monitoring/capture";
import { AUTH_UNAVAILABLE_TOKEN } from "@/lib/auth/login-outcome";
import { verifyCaptchaToken } from "@/lib/captcha";
import { LOGIN_ID_WINDOW_SEC, LOGIN_ID_LIMIT, LOGIN_CAPTCHA_THRESHOLD } from "@/lib/login-limits";
import { reportLoginFailureAnomalies } from "@/lib/security/anomaly-alerts";

// ── Login-failure recording + inline anomaly detection (Wave 3 ⑧) ─────────────
// Reasons that could contribute to a security anomaly (credential guessing /
// disabled-admin probing) — only these trigger the detector, so a
// blocked-but-correct-password failure (unverified/deactivated/pending) skips
// the extra queries.
const ANOMALY_SUSPICIOUS_REASONS = new Set<string>([
  "user_not_found",
  "invalid_password",
  "totp_required",
  "totp_invalid",
  "recovery_code_invalid",
  "system_admin_disabled",
]);

/**
 * Write the LOGIN_FAILED audit row (canonical shape: userId when the account
 * resolved, always ipAddress + userAgent, `{ identifier, reason, role? }`
 * metadata) and, for suspicious reasons, run the inline anomaly detector. The
 * detector is best-effort and non-throwing, so awaiting it here never affects
 * the (already-failed) login outcome — it only adds a cheap bounded count on the
 * common path, and the fan-out cost only on an actual threshold trip.
 */
async function recordLoginFailure(args: {
  reason:     string;
  identifier: string;
  ipAddress:  string | null;
  userAgent:  string | null;
  userId?:    string;
  role?:      UserRole;
  userEmail?: string | null;
}): Promise<void> {
  const { reason, identifier, ipAddress, userAgent, userId, role, userEmail } = args;
  // PS-4A — BEST-EFFORT. The auth DECISION (valid vs invalid) is always made
  // before this is called; a failed audit write must never flip that decision
  // or, worse, propagate as an exception that authorize()'s infra-guard would
  // then misclassify as "authority unavailable". So this swallows its own
  // errors: a genuine invalid_password stays invalid even if the DB is
  // struggling. (The write is still attempted; only its failure is contained.)
  try {
    await db.auditLog.create({
      data: {
        ...(userId ? { userId } : {}),
        action:    AuditAction.LOGIN_FAILED,
        ipAddress,
        userAgent,
        metadata:  { identifier, reason, ...(role ? { role } : {}) },
      },
    });
    if (ANOMALY_SUSPICIOUS_REASONS.has(reason)) {
      await reportLoginFailureAnomalies({ identifier, ip: ipAddress, reason, userId, userEmail });
    }
  } catch (err) {
    console.error("[auth] recordLoginFailure write failed (non-fatal):", err);
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        identifier:   { label: "Email or Username", type: "text"     },
        password:     { label: "Password",          type: "password" },
        totpCode:     { label: "TOTP Code",         type: "text"     },
        recoveryCode: { label: "Recovery Code",     type: "text"     },
        // OPS-2 S4 — explicit opt-in to reactivate a deactivated account as
        // part of this login. Set to "true" only by the login page's
        // "Reactivate and sign in" button; never auto-set.
        reactivate:   { label: "Reactivate",        type: "text"     },
        // OPS-2 S7a — explicit opt-in to CANCEL a pending account deletion as
        // part of this login. Set to "true" only by the login page's "Cancel
        // deletion and sign in" button; never auto-set. Mirrors `reactivate`.
        cancelDeletion: { label: "Cancel Deletion",  type: "text"     },
        // Wave 2 ⑥ — Cloudflare Turnstile token, sent by the login page only
        // once pre-login flags captchaRequired. Verified server-side below past
        // the same per-identifier threshold; the client flag is advisory only.
        captchaToken:   { label: "Captcha Token",    type: "text"     },
      },

      async authorize(credentials, req) {
        if (!credentials?.identifier || !credentials?.password) return null;

        // SEC-FIX-1 — prioritise cf-connecting-ip (set by Cloudflare, not
        // client-spoofable) so the rate-limit/audit IP matches lib/api.ts
        // getRequestMeta(); fall back to the x-forwarded-for chain then
        // x-real-ip for non-Cloudflare paths.
        const ipAddress = (req?.headers?.["cf-connecting-ip"] as string | undefined)?.trim()
          ?? (req?.headers?.["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
          ?? (req?.headers?.["x-real-ip"] as string | undefined)?.trim()
          ?? null;
        const userAgent = (req?.headers?.["user-agent"] as string | undefined) ?? null;

        const identifier = credentials.identifier.toLowerCase().trim();

        // ── Rate limit (OPS-1 S4) — the REAL credentials callback path ────────
        // Keyed on the submitted identifier, checked BEFORE any user lookup or
        // password/TOTP work. The companion per-IP limit lives in the NextAuth
        // route wrapper (app/api/auth/[...nextauth]/route.ts), where a proper
        // 429 can still be returned; here a limited attempt is denied like any
        // other failed login (non-enumerating — same generic CredentialsSignin).
        // Deliberately no auditLog write on the limited path: under a
        // brute-force burst the limiter must not amplify DB writes.
        //
        // Peek the identifier's PRIOR attempt count BEFORE the increment below,
        // so the CAPTCHA threshold here matches pre-login's peek exactly (both
        // see the same pre-attempt value → the widget the client shows and the
        // token the server demands stay in step, with no off-by-one that would
        // reject a legitimate attempt the client couldn't have tokenized).
        const priorAttempts = await peekKey(identifier, "login-id", LOGIN_ID_WINDOW_SEC);

        // PS-4A — FAIL CLOSED. The limiter is the authoritative increment for the
        // login-id bucket. If its store is unreachable we must NOT verify the
        // password with brute-force protection disabled: throw the
        // authority-unavailable sentinel (translated by the client to the
        // temporary-unavailability message), NOT return null (which NextAuth
        // reads as a credential rejection). A genuine over-limit still denies via
        // return null, exactly as before.
        const idLimit = await checkKeyLimitStrict(identifier, "login-id", { limit: LOGIN_ID_LIMIT, windowSec: LOGIN_ID_WINDOW_SEC });
        if (idLimit.status === "unavailable") {
          captureAuthInfraFailure("rate-limit", new Error("authorize rate-limit store unavailable"));
          throw new Error(AUTH_UNAVAILABLE_TOKEN);
        }
        if (idLimit.status === "limited") return null;

        // ── CAPTCHA step-up (Wave 2 ⑥) ────────────────────────────────────────
        // Past the per-identifier threshold, a valid Turnstile token is required.
        // Authoritative check (the pre-login `captchaRequired` hint is advisory).
        // A missing/invalid token is denied like any other failed login
        // (non-enumerating, no audit write — same posture as the limited path).
        // No-ops when CAPTCHA is unconfigured: verifyCaptchaToken returns true.
        if (priorAttempts >= LOGIN_CAPTCHA_THRESHOLD) {
          const captchaOk = await verifyCaptchaToken(credentials.captchaToken || null, ipAddress ?? undefined);
          if (!captchaOk) return null;
        }

        // ── Kill switch: disable SYSTEM_ADMIN login via env flag ──────────────
        // Set DISABLE_SYSTEM_ADMIN=true before going to production to lock out
        // the god account entirely without needing a DB change.
        const adminDisabled = process.env.DISABLE_SYSTEM_ADMIN === "true";

        // ── Look up user by email OR username ─────────────────────────────────
        // PS-4A — the credential AUTHORITY. A throw here (Prisma pool timeout —
        // P2024 / ECHECKOUTTIMEOUT) means we could not CONSULT the authority; it
        // is NOT "wrong password". Convert it to the authority-unavailable
        // sentinel (capture once) instead of letting a raw Prisma error surface
        // as a generic CredentialsSignin the client reads as invalid credentials.
        const user = await (async () => {
          try {
            return await db.user.findFirst({
              where: {
                OR: [
                  { email:    identifier },
                  { username: identifier },
                ],
              },
              select: { id: true, email: true, name: true, username: true, passwordHash: true, role: true, totpEnabled: true, totpSecret: true, emailVerifiedAt: true, deactivatedAt: true, deletionScheduledAt: true, deletionRequestedAt: true },
            });
          } catch (err) {
            captureAuthInfraFailure("user-lookup", err);
            throw new Error(AUTH_UNAVAILABLE_TOKEN);
          }
        })();

        if (!user || !user.passwordHash) {
          // Log failed attempt — no userId because user may not exist. No owner
          // email is possible here (unresolved identifier) — the enumeration-safe
          // property: the hybrid only ever reaches a real, resolved inbox.
          await recordLoginFailure({ reason: "user_not_found", identifier, ipAddress, userAgent });
          return null;
        }

        // ── Kill switch check ─────────────────────────────────────────────────
        if (adminDisabled && user.role === UserRole.SYSTEM_ADMIN) {
          await recordLoginFailure({
            reason: "system_admin_disabled", identifier, ipAddress, userAgent,
            userId: user.id, role: user.role, userEmail: user.email,
          });
          return null;
        }

        // ── Verify password ───────────────────────────────────────────────────
        const valid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!valid) {
          await recordLoginFailure({
            reason: "invalid_password", identifier, ipAddress, userAgent,
            userId: user.id, role: user.role, userEmail: user.email,
          });
          return null;
        }

        // ── Email verification gate (OPS-1 S2e — block mode) ──────────────────
        // Unverified accounts cannot log in — no exemptions, including
        // SYSTEM_ADMIN (admin accounts are highest-risk and must prove email
        // ownership). Existing accounts were backfilled to verified in S2b, so
        // only genuinely-unverified new signups are blocked. Checked before
        // TOTP so an unverified user never reaches the 2FA step. Password reset
        // is deliberately NOT gated on verification. The generic
        // CredentialsSignin error is fine here — the two-step login UI surfaces
        // the specific "verify your email" message via /api/auth/pre-login.
        if (!user.emailVerifiedAt) {
          await recordLoginFailure({
            reason: "email_unverified", identifier, ipAddress, userAgent,
            userId: user.id, role: user.role, userEmail: user.email,
          });
          return null;
        }

        // ── Deactivation gate (OPS-2 S4) ──────────────────────────────────────
        // A deactivated account cannot log in UNLESS this attempt explicitly
        // opted in to reactivation (the login page's "Reactivate and sign in"
        // button sets reactivate:"true" after pre-login surfaced the state).
        // Checked after the password and verification gates but BEFORE TOTP —
        // reactivation itself only happens further down, after the FULL auth
        // (incl. second factor) succeeds, so a password alone never
        // reactivates a 2FA-protected account.
        const wantsReactivation =
          (credentials as Record<string, string>).reactivate === "true";

        // ── Pending-deletion gate (OPS-2 S7a) ─────────────────────────────────
        // Mirrors the deactivation gate but is checked FIRST: a pending account
        // also has deactivatedAt set, and a valid cancelDeletion attempt must
        // not be blocked by the deactivation gate below. Deny login unless the
        // user explicitly opted to cancel the deletion (the login page's
        // "Cancel deletion and sign in" button sets cancelDeletion:"true").
        // The cancellation itself only happens further down, after FULL auth.
        const wantsCancelDeletion =
          (credentials as Record<string, string>).cancelDeletion === "true";
        if (user.deletionScheduledAt && !wantsCancelDeletion) {
          await recordLoginFailure({
            reason: "pending_deletion", identifier, ipAddress, userAgent,
            userId: user.id, role: user.role, userEmail: user.email,
          });
          return null;
        }

        // OPS-2 S4 deactivation gate. The extra `!(deletionScheduledAt &&
        // wantsCancelDeletion)` term lets a valid cancel-deletion attempt (which
        // also carries deactivatedAt) through to full auth; it never lets a
        // merely-deactivated account (deletionScheduledAt null) bypass the gate.
        if (user.deactivatedAt && !wantsReactivation && !(user.deletionScheduledAt && wantsCancelDeletion)) {
          await recordLoginFailure({
            reason: "account_deactivated", identifier, ipAddress, userAgent,
            userId: user.id, role: user.role, userEmail: user.email,
          });
          return null;
        }

        // ── Mandatory-MFA / forced-enrolment decision (PO-1) ──────────────────
        // A SYSTEM_ADMIN without TOTP is ALWAYS forced into enrolment,
        // independent of the REQUIRE_TOTP_* platform settings — there is no
        // password-only path to admin power. The session is marked
        // requireTotpSetup = true: every session guard (lib/session.ts +
        // lib/platform/authorize.ts) rejects it via totpSetupPending(), and
        // proxy.ts confines the browser to /admin/security?setup2fa=true, so the
        // admin can complete enrolment but reach nothing else until they do.
        // Once enrolled, the totpEnabled branch below challenges them for a live
        // code on every subsequent login.
        //
        // Customer authentication is UNCHANGED: a normal USER is forced into
        // enrolment only when the operator has turned on require_totp_all_users
        // (default off). The pure rule lives in lib/auth-totp-policy.ts
        // (unit-tested); this adapter resolves only the one setting it needs, and
        // skips even that DB read for admins (mandatory regardless).
        let requireTotpSetup = false;
        if (!user.totpEnabled) {
          // PS-4A — this DB read gates whether a non-admin is forced into TOTP
          // enrolment. A throw here is infrastructure, and the password has
          // already been VERIFIED at this point, so treating it as a credential
          // rejection would be doubly wrong. Convert to the authority-unavailable
          // sentinel (capture once) so a settings-read outage is truthful, not a
          // silent bypass of the enrolment gate.
          let requireTotpAllUsers: boolean;
          try {
            requireTotpAllUsers =
              user.role === UserRole.SYSTEM_ADMIN
                ? false // not consulted for admins — enrolment is mandatory
                : (await db.platformSetting.findUnique({
                    where:  { key: PlatformSettingKey.REQUIRE_TOTP_ALL_USERS },
                    select: { value: true },
                  }))?.value === "true";
          } catch (err) {
            captureAuthInfraFailure("totp-config", err);
            throw new Error(AUTH_UNAVAILABLE_TOKEN);
          }

          requireTotpSetup = requiresTotpEnrollment({
            role:        user.role,
            totpEnabled: user.totpEnabled,
            requireTotpAllUsers,
          });
        }

        // ── TOTP enforcement ──────────────────────────────────────────────────
        // If the user has 2FA enabled, they must provide either a valid TOTP
        // code or a valid recovery code to complete login.
        // The login page sends these via the two-step flow (pre-login → TOTP screen).
        // `mfaMethod` records which second factor actually completed the login so
        // the success audit event is honest about it ("TOTP verified") — PO-1.
        let mfaMethod: "totp" | "recovery" | "none" = "none";
        if (user.totpEnabled && user.totpSecret) {
          const totpCode     = (credentials as Record<string, string>).totpCode?.replace(/\s/g, "");
          const recoveryCode = (credentials as Record<string, string>).recoveryCode?.trim();

          if (!totpCode && !recoveryCode) {
            // No second factor provided — block login
            await recordLoginFailure({
              reason: "totp_required", identifier, ipAddress, userAgent,
              userId: user.id, role: user.role, userEmail: user.email,
            });
            return null;
          }

          if (totpCode) {
            // Verify TOTP code
            let secret: string;
            try { secret = decryptWithPurpose(user.totpSecret, EncryptionPurpose.TOTP_SECRET); }
            catch {
              return null; // corrupted secret — fail safe
            }
            if (!verifyTOTP(totpCode, secret, 1)) {
              await recordLoginFailure({
                reason: "totp_invalid", identifier, ipAddress, userAgent,
                userId: user.id, role: user.role, userEmail: user.email,
              });
              return null;
            }
            mfaMethod = "totp";
          } else if (recoveryCode) {
            // Verify and consume a recovery code
            const used = await verifyRecoveryCode(user.id, recoveryCode);
            if (!used) {
              await recordLoginFailure({
                reason: "recovery_code_invalid", identifier, ipAddress, userAgent,
                userId: user.id, role: user.role, userEmail: user.email,
              });
              return null;
            }
            // verifyRecoveryCode marks the code used; write the login event below
            mfaMethod = "recovery";
          }
        }

        // ── Reactivation (OPS-2 S4) ───────────────────────────────────────────
        // Full auth has succeeded (password + TOTP/recovery where enabled) and
        // the user explicitly asked to reactivate — clear the flag, audit, and
        // notify. Email is NON-THROWING: a delivery failure never blocks the
        // reactivation or the login.
        if (user.deactivatedAt && wantsReactivation) {
          const [, reactivationAudit] = await db.$transaction([
            db.user.update({
              where: { id: user.id },
              data:  { deactivatedAt: null },
            }),
            db.auditLog.create({
              data: {
                userId:   user.id,
                action:   AuditAction.ACCOUNT_REACTIVATED,
                ipAddress,
                userAgent,
                metadata: { deactivatedAt: user.deactivatedAt.toISOString() },
              },
            }),
          ]);

          const emailResult = await sendEmail("security-alert", user.email, {
            title:   "Your account was reactivated",
            message: `Your Fourth Meridian account was reactivated on ${formatDateTime(new Date().toISOString())}.`,
          });
          if (emailResult.status === "error") {
            console.error("[auth] reactivation security-alert email failed to send:", emailResult.error);
          }

          // OPS-3 S5 Wave 1 — bell mirror; waiting when the fresh session opens.
          await createNotification({
            type: "ACCOUNT_REACTIVATED",
            userId: user.id,
            auditLogId: reactivationAudit.id,
          });
        }

        // ── Deletion cancellation (OPS-2 S7a) ─────────────────────────────────
        // Full auth has succeeded and the user explicitly asked to cancel a
        // pending deletion — clear the two deletion timestamps AND the
        // deactivatedAt lockout they were set alongside, audit, and notify.
        // Mirrors the reactivation leg above; email is NON-THROWING.
        if (user.deletionScheduledAt && wantsCancelDeletion) {
          const [, cancellationAudit] = await db.$transaction([
            db.user.update({
              where: { id: user.id },
              data:  { deletionRequestedAt: null, deletionScheduledAt: null, deactivatedAt: null },
            }),
            db.auditLog.create({
              data: {
                userId:   user.id,
                action:   AuditAction.ACCOUNT_DELETION_CANCELLED,
                ipAddress,
                userAgent,
                metadata: { deletionScheduledAt: user.deletionScheduledAt.toISOString() },
              },
            }),
          ]);

          const emailResult = await sendEmail("security-alert", user.email, {
            title:   "Your account deletion was cancelled",
            message: `Your scheduled Fourth Meridian account deletion was cancelled on ${formatDateTime(new Date().toISOString())}. Your account is active again.`,
          });
          if (emailResult.status === "error") {
            console.error("[auth] deletion-cancellation security-alert email failed to send:", emailResult.error);
          }

          // OPS-3 S5 Wave 1 — bell mirror; waiting when the fresh session opens.
          await createNotification({
            type: "ACCOUNT_DELETION_CANCELLED",
            userId: user.id,
            auditLogId: cancellationAudit.id,
          });
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
            // PO-1 — normalise onto the operator/security audit shape
            // (lib/audit.ts). Keeps action = LOGIN and metadata.role for the
            // existing security-history/activity consumers, and ADDS actorType +
            // result + the second-factor method so an admin login records "TOTP
            // verified" honestly. Written in the same $transaction as the
            // session row, so the session and its audit fact commit atomically.
            data: buildAuditData({
              actorId:   user.id,
              actorType: user.role === UserRole.SYSTEM_ADMIN ? "SYSTEM_ADMIN" : "USER",
              action:    AuditAction.LOGIN,
              result:    "SUCCESS",
              ipAddress,
              userAgent,
              metadata:  { role: user.role, mfa: mfaMethod },
            }),
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

      // ── Revocation check (cached, short TTL) ────────────────────────────────
      // JWT tokens are stateless — revoking a UserSession row doesn't invalidate
      // the cookie automatically, so we still must check the DB to reject
      // revoked sessions. But this callback runs on EVERY
      // getServerSession()/requireUser() call — every Server Component render
      // and every API route that checks auth — and production logs showed
      // this single query costing 1.1-2.4s each time, the dominant cost behind
      // the multi-second /dashboard/spaces latency (a trivial count()
      // query elsewhere still took 5+ seconds once wrapped in this check).
      //
      // Fix: cache the verified result per sessionToken for
      // SESSION_CACHE_TTL_MS (lib/session-cache.ts, currently 30s). Ordinary
      // page loads/navigation read the cache and skip the DB entirely on a
      // hit. Sensitive actions (password change, disabling 2FA, regenerating
      // recovery codes, revoking sessions, admin security actions) must NOT
      // rely on this — they call requireFreshUser()/requireFreshSystemAdmin()
      // (lib/session.ts) instead, which always bypasses this cache and hits
      // the DB live. Revocation is NOT removed — only the polling frequency
      // for low-stakes requests is throttled.
      if (sessionToken) {
        const tRevoke = Date.now();
        const cached = getCachedRevocation(sessionToken);
        let valid: boolean;

        if (cached !== null) {
          valid = cached;
          if (process.env.NODE_ENV !== "production") {
            console.log(`[auth] session callback revocation check: CACHE HIT, ${Date.now() - tRevoke}ms, valid=${valid}`);
          }
        } else {
          const dbSession = await db.userSession.findFirst({
            where:  { sessionToken, revokedAt: null },
            select: { id: true },
          });
          valid = !!dbSession;
          setCachedRevocation(sessionToken, valid);
          if (process.env.NODE_ENV !== "production") {
            console.log(`[auth] session callback revocation check: LIVE DB, ${Date.now() - tRevoke}ms, valid=${valid}`);
          }

          if (valid) {
            // Bump lastActiveAt (fire-and-forget — don't block the response).
            // Only happens on a live check now (at most once per TTL window
            // per session), not on every single call as before.
            db.userSession.updateMany({
              where: { sessionToken },
              data:  { lastActiveAt: new Date() },
            }).catch(() => {});
          }
        }

        if (!valid) {
          // Return a bare expired session — middleware will redirect to /login
          return { ...session, user: undefined as never, expires: new Date(0).toISOString() };
        }
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

      // Invalidate the cached revocation result immediately so this instance
      // doesn't keep serving "valid" from cache for the rest of the TTL
      // window after sign-out revokes the row.
      if (sessionToken) invalidateSession(sessionToken);

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
