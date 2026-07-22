/**
 * lib/email/email-change-confirm.ts  (OPS-2 UX fix — idempotent confirm)
 *
 * Pure predicate for the change-email confirm route's idempotent branch.
 *
 * The confirm route no longer clears pendingEmail / emailChangeToken /
 * emailChangeExpiry on a successful swap (the 1h expiry bounds the token
 * instead). This lets a REPEATED confirmation of the same token — fired by an
 * email-link pre-scanner, a SafeLinks/redirect pre-check, or a browser refresh
 * BEFORE the human's own click renders — resolve the same token and return
 * "changed" instead of a false "Invalid link".
 *
 * `true` means the swap has already been applied for this token's target
 * (the account email already equals the still-set pendingEmail), so the caller
 * returns idempotent success WITHOUT re-swapping, re-revoking sessions, or
 * writing a duplicate EMAIL_CHANGE_COMPLETED audit row.
 *
 * Pure — no DB, no I/O — so it is unit-testable in isolation
 * (lib/email/email-change-confirm.test.ts). Comparison is case-insensitive;
 * both columns are stored lowercase-normalized, this is defense-in-depth.
 */

export function isEmailChangeAlreadyApplied(user: {
  email:        string;
  pendingEmail: string | null;
}): boolean {
  return !!user.pendingEmail && user.email.toLowerCase() === user.pendingEmail.toLowerCase();
}
