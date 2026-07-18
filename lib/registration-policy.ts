/**
 * lib/registration-policy.ts  (PO-3C)
 *
 * The ONE authoritative registration policy. Both the public entry experience
 * (the register page, via GET-equivalent /api/registration-policy) and the
 * register API's redemption gate resolve the SAME logic here — invite validation
 * and mode meaning live in exactly one place, never duplicated.
 *
 * MODE MEANING (the exact contract):
 *   open        — anyone may register (public launch).
 *   invite_only — the register form is gated behind a VALID, email-bound invite;
 *                 no invite ⇒ steer to request-access.
 *   closed      — no new users; steer to request-access (waitlist).
 *
 * `validateInvite` is the single invite-validation authority (APPROVED +
 * unexpired, hashed-token lookup) and returns the BOUND email so the form can
 * lock it — the email-binding is still enforced authoritatively at redemption in
 * the register route (this only surfaces it).
 */

import "server-only";
import { db } from "@/lib/db";
import { hashResetToken } from "@/lib/password-reset-token";
import { getRegistrationMode, type RegistrationMode } from "@/lib/platform-settings";
import { BetaAccessRequestStatus } from "@prisma/client";

export interface InviteValidation {
  valid:     boolean;
  /** The address the invite was issued to, when valid (email-bound). */
  email:     string | null;
  requestId: string | null;
}

/** THE invite-validation authority: an APPROVED, un-expired invite for this token. */
export async function validateInvite(
  rawToken: string | null | undefined,
  now: Date = new Date(),
): Promise<InviteValidation> {
  if (!rawToken || typeof rawToken !== "string") return { valid: false, email: null, requestId: null };
  const row = await db.betaAccessRequest.findFirst({
    where: {
      inviteTokenHash: hashResetToken(rawToken),
      inviteExpiresAt: { gt: now },
      status:          BetaAccessRequestStatus.APPROVED,
    },
    select: { id: true, email: true },
  });
  return row ? { valid: true, email: row.email, requestId: row.id } : { valid: false, email: null, requestId: null };
}

export interface RegistrationPolicy {
  mode: RegistrationMode;
  /** Whether the visitor may see the registration FORM right now. */
  canRegister: boolean;
  /** The email the form must use (locked) when registering via a valid invite. */
  invitedEmail: string | null;
  /** True when the visitor should be steered to request-access (no valid invite). */
  requiresInvite: boolean;
}

/** PURE — the mode → policy decision (given an already-resolved invite result).
 *  Unit-tested; the I/O (mode read + invite lookup) is the async wrapper below. */
export function decideRegistrationPolicy(mode: RegistrationMode, invite: InviteValidation): RegistrationPolicy {
  if (mode === "open")   return { mode, canRegister: true,  invitedEmail: null, requiresInvite: false };
  if (mode === "closed") return { mode, canRegister: false, invitedEmail: null, requiresInvite: true };
  // invite_only — the form is gated behind a valid, email-bound invite.
  return { mode, canRegister: invite.valid, invitedEmail: invite.email, requiresInvite: !invite.valid };
}

/** Resolve the public registration decision for an optional invite token. */
export async function resolveRegistrationPolicy(rawToken?: string | null): Promise<RegistrationPolicy> {
  const mode = await getRegistrationMode();
  // Only invite_only needs the token lookup; open/closed ignore it.
  const invite = mode === "invite_only"
    ? await validateInvite(rawToken)
    : { valid: false, email: null, requestId: null };
  return decideRegistrationPolicy(mode, invite);
}
