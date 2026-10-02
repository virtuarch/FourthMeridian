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
 *
 * ── RLS-C-S6 — WHY THE READ IS A CAPABILITY AND THE WRITE IS NOT ─────────────
 *
 * BetaAccessRequest is revoked from the tenant role (migration …000100 §4) and
 * is PRE-TENANT by construction: the subject has no User row, so no policy
 * predicate can exist for it. The two halves of the invite lifecycle therefore
 * take different authorities, and the difference is the point.
 *
 *   READ (validateInvite) — a CAPABILITY on systemDb, the lib/users/availability
 *     idiom: the widest authority reached through the narrowest opening. A raw
 *     token goes in; a closed `{valid, email, requestId}` comes out; no row, no
 *     other column, and no way to ask about an address. Granting this read to a
 *     public role instead would have handed it `email` (the enumeration surface:
 *     a stranger must not learn whether an address is on the waitlist) and
 *     `inviteTokenHash` (the secret itself). The TOKEN is the authorisation — a
 *     32-byte value only the addressee was emailed — so possession proves the
 *     right to learn that one address and no other.
 *
 *   WRITE (redeemBetaInvite) — the CALLER'S authority, passed in as a client,
 *     because consuming an invite is an act performed by the registering
 *     request and must be bounded by whatever that request is allowed to do.
 *     fm_auth is granted exactly this transition, one-way, in migration
 *     …000600.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { hashResetToken } from "@/lib/password-reset-token";
import { getRegistrationMode, type RegistrationMode } from "@/lib/platform-settings";
import { BetaAccessRequestStatus, type Prisma } from "@prisma/client";

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
  // ⚠️ KEYED ON THE TOKEN HASH, NEVER ON AN ADDRESS. This is the whole reason
  // the capability may hold a deployment-wide authority: there is no argument
  // through which a caller could ask it about an email it was not given the
  // token for. Adding an email-keyed lookup here turns it into the waitlist
  // directory the column grants in …000600 exist to prevent.
  const row = await systemDb.betaAccessRequest.findFirst({
    where: {
      inviteTokenHash: hashResetToken(rawToken),
      inviteExpiresAt: { gt: now },
      status:          BetaAccessRequestStatus.APPROVED,
    },
    select: { id: true, email: true },
  });
  return row ? { valid: true, email: row.email, requestId: row.id } : { valid: false, email: null, requestId: null };
}

/**
 * A redemption that did not consume exactly one invite.
 *
 * ⚠️ IT IS NEVER A BENIGN OUTCOME, AND THAT IS THE WHOLE POINT. The three things
 * that can produce a zero count are a row-level-security refusal, a concurrent
 * second redemption, and a row that no longer exists — and all three mean the
 * same thing here: the invite was NOT consumed. An account minted anyway would
 * leave `inviteTokenHash` non-null and the invite reusable for ever by whoever
 * holds the emailed link. So this aborts the enclosing transaction instead of
 * being reported, retried or counted.
 *
 * ⚠️ IT IS ALSO WHY THIS SITE DOES NOT USE resolveConditionalWrite(). That guard
 * exists to tell a REFUSAL apart from CONTENTION, because contention is a
 * legitimate `false`. Here it is not: a single-use invite redeemed by somebody
 * else is exactly as fatal as one the database refused, so the stronger contract
 * — one row or raise — needs no visibility probe and admits no third state.
 */
export class InviteNotConsumedError extends Error {
  readonly requestId: string;
  readonly matched: number;

  constructor(requestId: string, matched: number) {
    super(
      `beta invite "${requestId}" was NOT consumed: the redemption matched ${matched} row(s), not 1. ` +
        `Refusing to complete a registration that leaves a single-use invite outstanding — the update was ` +
        `either refused by row-level security, raced by another redemption, or aimed at a row that is gone.`,
    );
    this.name = "InviteNotConsumedError";
    this.requestId = requestId;
    this.matched = matched;
  }
}

/**
 * THE invite-redemption authority: consume one APPROVED invite, single-use.
 *
 * The client is a PARAMETER, not a module-level handle — authority follows the
 * execution phase (RLS-13), and this runs inside the register route's
 * `$transaction` so the account and the redemption commit together or not at
 * all. `redeemedUserId` is a soft reference (no FK), matching the schema.
 *
 * Throws InviteNotConsumedError unless exactly one row was consumed.
 */
export async function redeemBetaInvite(
  client: Prisma.TransactionClient,
  input: { requestId: string; redeemedUserId: string; now?: Date },
): Promise<void> {
  const { count } = await client.betaAccessRequest.updateMany({
    where: { id: input.requestId, status: BetaAccessRequestStatus.APPROVED },
    data: {
      status:          BetaAccessRequestStatus.REDEEMED,
      redeemedAt:      input.now ?? new Date(),
      redeemedUserId:  input.redeemedUserId,
      inviteTokenHash: null, // single-use — the token can never resolve again
    },
  });
  if (count !== 1) throw new InviteNotConsumedError(input.requestId, count);
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
