/**
 * lib/audit-actions.ts
 *
 * Standardised audit log action constants.
 * Use these instead of free-text strings to ensure consistency
 * across API routes, background jobs, and admin filters.
 */

export const AuditAction = {
  // ── Auth ────────────────────────────────────────────────────────────────────
  LOGIN:                    "LOGIN",
  LOGIN_FAILED:             "LOGIN_FAILED",
  LOGOUT:                   "LOGOUT",
  WORKSPACE_SWITCH:         "WORKSPACE_SWITCH",

  // ── Password ─────────────────────────────────────────────────────────────────
  PASSWORD_CHANGED:         "PASSWORD_CHANGED",
  PASSWORD_RESET:           "PASSWORD_RESET",

  // ── 2FA / TOTP ───────────────────────────────────────────────────────────────
  TWO_FACTOR_SETUP_STARTED: "TWO_FACTOR_SETUP_STARTED",
  TWO_FACTOR_ENABLED:       "TWO_FACTOR_ENABLED",
  TWO_FACTOR_DISABLED:      "TWO_FACTOR_DISABLED",
  TWO_FACTOR_RESET:         "TWO_FACTOR_RESET",

  // ── Recovery codes ───────────────────────────────────────────────────────────
  RECOVERY_CODE_USED:       "RECOVERY_CODE_USED",
  RECOVERY_CODES_GENERATED: "RECOVERY_CODES_GENERATED",
  RECOVERY_CODES_REGENERATED:"RECOVERY_CODES_REGENERATED",

  // ── Sessions ─────────────────────────────────────────────────────────────────
  SESSION_REVOKED:          "SESSION_REVOKED",
  ADMIN_SESSION_REVOKED:    "ADMIN_SESSION_REVOKED",

  // ── Goals ────────────────────────────────────────────────────────────────────
  GOAL_CREATED:             "GOAL_CREATED",
  GOAL_UPDATED:             "GOAL_UPDATED",
  GOAL_ARCHIVED:            "GOAL_ARCHIVED",
  GOAL_TRASHED:             "GOAL_TRASHED",
  GOAL_RESTORED:            "GOAL_RESTORED",

  // ── Accounts ─────────────────────────────────────────────────────────────────
  ACCOUNT_SHARED:           "ACCOUNT_SHARED",
  ACCOUNT_REVOKED:          "ACCOUNT_REVOKED",
  ACCOUNT_RENAMED:          "ACCOUNT_RENAMED",
  DEBT_PROFILE_UPDATED:     "DEBT_PROFILE_UPDATED",

  // ── Members ──────────────────────────────────────────────────────────────────
  MEMBER_INVITED:           "MEMBER_INVITED",
  MEMBER_REMOVED:           "MEMBER_REMOVED",
  MEMBER_ROLE_CHANGED:      "MEMBER_ROLE_CHANGED",

  // ── Sync / Platform ──────────────────────────────────────────────────────────
  PLAID_SYNC:               "PLAID_SYNC",
  WALLET_SYNC:              "WALLET_SYNC",
  ACCOUNT_ADD:              "ACCOUNT_ADD",
  ACCOUNT_REMOVE:           "ACCOUNT_REMOVE",
  REGISTER:                 "REGISTER",
} as const;

export type AuditActionType = typeof AuditAction[keyof typeof AuditAction];

/**
 * All action types shown in the admin filter dropdown.
 * Grouped for readability.
 */
export const AUDIT_ACTION_GROUPS: { label: string; actions: AuditActionType[] }[] = [
  {
    label: "Auth",
    actions: [
      AuditAction.LOGIN,
      AuditAction.LOGIN_FAILED,
      AuditAction.LOGOUT,
      AuditAction.WORKSPACE_SWITCH,
    ],
  },
  {
    label: "Password",
    actions: [AuditAction.PASSWORD_CHANGED, AuditAction.PASSWORD_RESET],
  },
  {
    label: "2FA",
    actions: [
      AuditAction.TWO_FACTOR_SETUP_STARTED,
      AuditAction.TWO_FACTOR_ENABLED,
      AuditAction.TWO_FACTOR_DISABLED,
      AuditAction.TWO_FACTOR_RESET,
    ],
  },
  {
    label: "Recovery Codes",
    actions: [
      AuditAction.RECOVERY_CODE_USED,
      AuditAction.RECOVERY_CODES_GENERATED,
      AuditAction.RECOVERY_CODES_REGENERATED,
    ],
  },
  {
    label: "Sessions",
    actions: [AuditAction.SESSION_REVOKED, AuditAction.ADMIN_SESSION_REVOKED],
  },
  {
    label: "Goals",
    actions: [
      AuditAction.GOAL_CREATED,
      AuditAction.GOAL_UPDATED,
      AuditAction.GOAL_ARCHIVED,
      AuditAction.GOAL_TRASHED,
      AuditAction.GOAL_RESTORED,
    ],
  },
  {
    label: "Members",
    actions: [
      AuditAction.MEMBER_INVITED,
      AuditAction.MEMBER_REMOVED,
      AuditAction.MEMBER_ROLE_CHANGED,
    ],
  },
  {
    label: "Accounts",
    actions: [AuditAction.ACCOUNT_SHARED, AuditAction.ACCOUNT_REVOKED],
  },
];
