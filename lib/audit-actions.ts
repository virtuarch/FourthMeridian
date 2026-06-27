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
  SPACE_SWITCH:         "SPACE_SWITCH",

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

  // ── Spaces (lifecycle) ──────────────────────────────────────────────────
  SPACE_CREATE:         "SPACE_CREATE",
  SPACE_UPDATE:         "SPACE_UPDATE",
  SPACE_ARCHIVED:       "SPACE_ARCHIVED",
  SPACE_UNARCHIVED:     "SPACE_UNARCHIVED",
  SPACE_TRASHED:        "SPACE_TRASHED",
  SPACE_RESTORED:       "SPACE_RESTORED",
  SPACE_PERMANENT_DELETE: "SPACE_PERMANENT_DELETE",

  // ── Accounts ─────────────────────────────────────────────────────────────────
  ACCOUNT_SHARED:           "ACCOUNT_SHARED",
  ACCOUNT_REVOKED:          "ACCOUNT_REVOKED",
  ACCOUNT_RENAMED:          "ACCOUNT_RENAMED",
  ACCOUNT_RESTORE:          "ACCOUNT_RESTORE",
  DEBT_PROFILE_UPDATED:     "DEBT_PROFILE_UPDATED",

  // ── Members ──────────────────────────────────────────────────────────────────
  MEMBER_INVITED:           "MEMBER_INVITED",
  MEMBER_REMOVED:           "MEMBER_REMOVED",
  MEMBER_ROLE_CHANGED:      "MEMBER_ROLE_CHANGED",

  // ── Sync / Platform ──────────────────────────────────────────────────────────
  PLAID_SYNC:               "PLAID_SYNC",
  PLAID_REFRESH:            "PLAID_REFRESH",
  WALLET_SYNC:              "WALLET_SYNC",
  ACCOUNT_ADD:              "ACCOUNT_ADD",
  ACCOUNT_REMOVE:           "ACCOUNT_REMOVE",
  REGISTER:                 "REGISTER",

  // ── Imports (D2 Step 4D-3) ───────────────────────────────────────────────────
  // Only the rollback action is added in this slice — IMPORT_BATCH_CREATED /
  // IMPORT_BATCH_COMPLETED are deliberately deferred (see
  // docs/initiatives/d2/D2_STEP4D3_IMPORT_ROLLBACK_INVESTIGATION.md §8).
  IMPORT_BATCH_ROLLED_BACK: "IMPORT_BATCH_ROLLED_BACK",
  // D2 Step 4D-4 — one batch-level event when a QuickBooks externalId match
  // overwrites an existing Transaction's allow-listed fields. No per-row
  // entries, no before/after snapshots — see
  // docs/initiatives/d2/D2_STEP4D4_QUICKBOOKS_IMPLEMENTATION_CHECKLIST.md §8.
  IMPORT_BATCH_UPDATED_ON_MATCH: "IMPORT_BATCH_UPDATED_ON_MATCH",
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
      AuditAction.SPACE_SWITCH,
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
    label: "Spaces",
    actions: [
      AuditAction.SPACE_CREATE,
      AuditAction.SPACE_UPDATE,
      AuditAction.SPACE_ARCHIVED,
      AuditAction.SPACE_UNARCHIVED,
      AuditAction.SPACE_TRASHED,
      AuditAction.SPACE_RESTORED,
      AuditAction.SPACE_PERMANENT_DELETE,
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
  {
    label: "Imports",
    actions: [AuditAction.IMPORT_BATCH_ROLLED_BACK, AuditAction.IMPORT_BATCH_UPDATED_ON_MATCH],
  },
];
