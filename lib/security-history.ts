/**
 * lib/security-history.ts  (OPS-2 S1)
 *
 * The allowlist + display labels for the user-facing Security History surface.
 *
 * Pure config — no DB, no I/O — so it can be unit-tested and shared between the
 * read route (app/api/user/security-history) and the UI. The route filters the
 * caller's OWN AuditLog rows to exactly these actions and returns safe fields
 * only; nothing outside this list is ever exposed to the user.
 *
 * SEC-1 — the allowlist itself is now derived from the single canonical view
 * USER_SECURITY_HISTORY_ACTIONS in lib/audit-actions.ts (the previously
 * free-string PASSWORD_RESET_REQUESTED / PASSWORD_RESET_COMPLETE /
 * PASSWORD_CHANGE_FAILED are now first-class AuditAction constants). This file
 * owns only the user-facing DISPLAY LABELS; the membership question lives in
 * the canon so a route rename can't silently drop an action off this surface.
 *
 * Deliberately EXCLUDED (see the canon view): all Space/Goal/Account/Member/
 * Plaid/Import/AI actions, SPACE_SWITCH, and ADMIN_SESSION_REVOKED — not
 * security-relevant to the user (or too noisy for a personal security log).
 */

import { USER_SECURITY_HISTORY_ACTIONS } from "@/lib/audit-actions";

/** Human-readable label for each surfaced action. */
const SECURITY_HISTORY_LABELS: Record<string, string> = {
  REGISTER:                   "Account created",
  LOGIN:                      "Signed in",
  LOGIN_FAILED:               "Failed sign-in attempt",
  LOGOUT:                     "Signed out",
  PASSWORD_CHANGED:           "Password changed",
  PASSWORD_CHANGE_FAILED:     "Failed password change",
  PASSWORD_RESET:             "Password reset",
  PASSWORD_RESET_REQUESTED:   "Password reset requested",
  PASSWORD_RESET_COMPLETE:    "Password reset completed",
  EMAIL_VERIFIED:             "Email verified",
  EMAIL_VERIFICATION_RESENT:  "Verification email resent",
  EMAIL_CHANGE_REQUESTED:     "Email change requested",
  EMAIL_CHANGE_COMPLETED:     "Email changed",
  ACCOUNT_DEACTIVATED:        "Account deactivated",
  ACCOUNT_REACTIVATED:        "Account reactivated",
  DATA_EXPORTED:              "Data exported",
  ACCOUNT_DELETION_REQUESTED: "Account deletion requested",
  ACCOUNT_DELETION_CANCELLED: "Account deletion cancelled",
  TWO_FACTOR_SETUP_STARTED:   "Two-factor setup started",
  TWO_FACTOR_ENABLED:         "Two-factor enabled",
  TWO_FACTOR_DISABLED:        "Two-factor disabled",
  TWO_FACTOR_RESET:           "Two-factor reset",
  RECOVERY_CODE_USED:         "Recovery code used",
  RECOVERY_CODES_GENERATED:   "Recovery codes generated",
  RECOVERY_CODES_REGENERATED: "Recovery codes regenerated",
  SESSION_REVOKED:            "Session revoked",
};

/**
 * The allowlist — the exact set of AuditLog.action values the Security History
 * surface may return. Derived from the canonical view in lib/audit-actions.ts
 * (SEC-1) so membership has one source of truth; the labels above only need to
 * cover it (guarded by lib/security-history.test.ts).
 */
export const SECURITY_HISTORY_ACTIONS: string[] = [...USER_SECURITY_HISTORY_ACTIONS];

const SECURITY_HISTORY_ACTION_SET = new Set<string>(SECURITY_HISTORY_ACTIONS);

/** True if an action is safe to surface in the user's security history. */
export function isSecurityHistoryAction(action: string): boolean {
  return SECURITY_HISTORY_ACTION_SET.has(action);
}

/** Display label for an action; falls back to the raw action if unmapped. */
export function securityHistoryLabel(action: string): string {
  return SECURITY_HISTORY_LABELS[action] ?? action;
}
