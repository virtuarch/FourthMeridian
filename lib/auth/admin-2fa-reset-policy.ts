/**
 * lib/auth/admin-2fa-reset-policy.ts — SEC-006: the PURE rule for an admin
 * resetting another user's TOTP.
 *
 * THE DEFECT THIS CLOSES. The route read `adminTotpCode` and never verified it
 * (the check was commented out "until TOTP verification is fully implemented" —
 * it has been implemented since PO-1), and it accepted SYSTEM_ADMIN targets. A
 * SYSTEM_ADMIN session therefore needed nothing beyond the literal "RESET" to
 * strip a peer admin's second factor; combined with SEC-001 that yielded a
 * password-only admin session.
 *
 * THE RULE (in order; every refusal is a distinct reason so tests can prove
 * WHICH rule rejected, and the route maps them to a status):
 *   SELF                    — an admin manages their own 2FA in settings.
 *   CONFIRM_TOKEN           — the literal "RESET" is still required.
 *   TARGET_IS_SYSTEM_ADMIN  — a peer admin's second factor is never reset from
 *                             this endpoint (no second-approver flow exists;
 *                             until one does, the answer is no).
 *   ACTOR_NOT_ENROLLED      — PO-1 makes enrolment mandatory for SYSTEM_ADMIN,
 *                             so an actor without a secret is an invariant
 *                             violation, refused rather than waved through.
 *   TOTP_CODE_MISSING / TOTP_CODE_INVALID — the actor's LIVE code, verified
 *                             against the actor's decrypted secret with the
 *                             same window as login.
 *   ALLOW
 *
 * Pure: imports only the TOTP verifier (HMAC arithmetic). Secret decryption
 * and every query stay in the route.
 */

import { verifyTOTP } from "@/lib/totp";

export type AdminTwoFactorResetDecision =
  | "ALLOW"
  | "SELF"
  | "CONFIRM_TOKEN"
  | "TARGET_IS_SYSTEM_ADMIN"
  | "ACTOR_NOT_ENROLLED"
  | "TOTP_CODE_MISSING"
  | "TOTP_CODE_INVALID";

export interface AdminTwoFactorResetInput {
  actorId:          string;
  targetId:         string;
  targetRole:       string;
  confirmToken:     unknown;
  /** The actor's DECRYPTED TOTP secret, or null when not enrolled. */
  actorTotpSecret:  string | null;
  actorTotpEnabled: boolean;
  adminTotpCode:    unknown;
}

export const ADMIN_TWO_FACTOR_RESET_CONFIRM = "RESET";

/** HTTP status for each refusal — one mapping, shared by the route and its tests. */
export const ADMIN_TWO_FACTOR_RESET_STATUS: Record<Exclude<AdminTwoFactorResetDecision, "ALLOW">, number> = {
  SELF:                   400,
  CONFIRM_TOKEN:          400,
  TARGET_IS_SYSTEM_ADMIN: 403,
  ACTOR_NOT_ENROLLED:     403,
  TOTP_CODE_MISSING:      403,
  TOTP_CODE_INVALID:      403,
};

export function decideAdminTwoFactorReset(input: AdminTwoFactorResetInput): AdminTwoFactorResetDecision {
  if (input.targetId === input.actorId)                       return "SELF";
  if (input.confirmToken !== ADMIN_TWO_FACTOR_RESET_CONFIRM)   return "CONFIRM_TOKEN";
  if (input.targetRole === "SYSTEM_ADMIN")                     return "TARGET_IS_SYSTEM_ADMIN";
  if (!input.actorTotpEnabled || !input.actorTotpSecret)       return "ACTOR_NOT_ENROLLED";
  const code = typeof input.adminTotpCode === "string" ? input.adminTotpCode.replace(/\s/g, "") : "";
  if (code.length === 0)                                       return "TOTP_CODE_MISSING";
  if (!verifyTOTP(code, input.actorTotpSecret, 1))             return "TOTP_CODE_INVALID";
  return "ALLOW";
}
