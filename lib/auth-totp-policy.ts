/**
 * lib/auth-totp-policy.ts
 *
 * PO-1 — the PURE rule that decides whether a login must be forced into TOTP
 * enrolment (i.e. the session is marked `requireTotpSetup`, which every session
 * guard in lib/session.ts and lib/platform/authorize.ts rejects until enrolment
 * completes — see totpSetupPending()).
 *
 * Split out of lib/auth.ts's `authorize()` for the same reason
 * `hasPlatformAccess` is split out of `requirePlatformAccess`: the RULE is pure
 * and unit-tested here; the adapter (authorize) contributes only the I/O of
 * resolving the one platform setting it needs.
 *
 * THE INVARIANT (PO-1): a SYSTEM_ADMIN has NO password-only path to admin power.
 * An un-enrolled admin is ALWAYS forced into enrolment, independent of the
 * REQUIRE_TOTP_* platform settings — those settings remain the opt-in toggle for
 * ordinary users only. An admin who has already enrolled skips this decision
 * entirely and is challenged for a live TOTP/recovery code on every login by the
 * enforcement block in authorize().
 *
 * Customer authentication is unchanged: a normal USER is forced into enrolment
 * only when the platform operator has turned on require_totp_all_users (default
 * off), exactly as before.
 */

import { UserRole } from "@prisma/client";

export interface TotpEnrollmentInput {
  /** The authenticating user's role. */
  role: UserRole;
  /** Whether the user already has TOTP enabled (has completed enrolment). */
  totpEnabled: boolean;
  /** Resolved value of the require_totp_all_users platform setting (default false). */
  requireTotpAllUsers: boolean;
}

/**
 * Returns true when this login must be marked `requireTotpSetup` — i.e. the user
 * is authenticated by password but confined to the 2FA-enrolment flow until they
 * enrol, with zero access to any data/admin/space surface in the meantime.
 *
 *   - Already enrolled            → false (the TOTP challenge block handles them).
 *   - Un-enrolled SYSTEM_ADMIN    → true  (MANDATORY, not settings-gated).
 *   - Un-enrolled ordinary user   → require_totp_all_users (opt-in, default off).
 */
export function requiresTotpEnrollment(input: TotpEnrollmentInput): boolean {
  if (input.totpEnabled) return false;
  if (input.role === UserRole.SYSTEM_ADMIN) return true;
  return input.requireTotpAllUsers;
}
