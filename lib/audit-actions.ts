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
  // OPS-1 S2c — a first-class account-lifecycle event: the user proved
  // ownership of their email by consuming a verification link.
  EMAIL_VERIFIED:           "EMAIL_VERIFIED",
  // OPS-1 S2d — a fresh verification link was issued (token rotated) and sent.
  EMAIL_VERIFICATION_RESENT: "EMAIL_VERIFICATION_RESENT",
  // OPS-2 S3a — an authenticated user requested an email-address change (a
  // confirmation link was sent to the new address). The swap happens later
  // (S3b) under EMAIL_CHANGE_COMPLETED.
  EMAIL_CHANGE_REQUESTED:    "EMAIL_CHANGE_REQUESTED",
  // OPS-2 S3b — the new address was confirmed and the account email was
  // swapped (all sessions revoked; user re-authenticates with the new email).
  EMAIL_CHANGE_COMPLETED:    "EMAIL_CHANGE_COMPLETED",

  // ── Account lifecycle (OPS-2 S4) ─────────────────────────────────────────────
  // The user deactivated their own account (fresh auth + password re-auth;
  // all sessions revoked; data intact — deactivated ≠ deleted).
  ACCOUNT_DEACTIVATED:      "ACCOUNT_DEACTIVATED",
  // The user reactivated at login via the explicit "Reactivate and sign in"
  // leg (full auth incl. TOTP; clears User.deactivatedAt).
  ACCOUNT_REACTIVATED:      "ACCOUNT_REACTIVATED",
  // OPS-2 S6 — the user exported a copy of their personal data (fresh auth;
  // synchronous ZIP download). Recorded so the export is auditable and shows
  // in the user's own security history.
  DATA_EXPORTED:            "DATA_EXPORTED",
  // OPS-2 S7 — account-deletion lifecycle. REQUESTED/CANCELLED are written
  // while the account still exists (user-facing, in security history). DELETED
  // is written by the S7c purge just before db.user.delete(); its userId is
  // then SetNull'd by the cascade, so it survives anonymized as platform
  // forensics (not in the user allowlist). Only the constants land in S7a.
  ACCOUNT_DELETION_REQUESTED: "ACCOUNT_DELETION_REQUESTED",
  ACCOUNT_DELETION_CANCELLED: "ACCOUNT_DELETION_CANCELLED",
  ACCOUNT_DELETED:            "ACCOUNT_DELETED",

  // ── Password ─────────────────────────────────────────────────────────────────
  PASSWORD_CHANGED:         "PASSWORD_CHANGED",
  PASSWORD_RESET:           "PASSWORD_RESET",
  // SEC-1 — folded in from raw string literals that routes were already
  // writing (forgot-password / reset-password / change-password). They are
  // surfaced in the user's Security History; codifying them here makes
  // lib/audit-actions.ts the single source of truth for the vocabulary so a
  // route rename can no longer silently drop them off the security surfaces.
  PASSWORD_RESET_REQUESTED: "PASSWORD_RESET_REQUESTED",
  PASSWORD_RESET_COMPLETE:  "PASSWORD_RESET_COMPLETE",
  PASSWORD_CHANGE_FAILED:   "PASSWORD_CHANGE_FAILED",

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
  // Timeline T-2 — a HABIT goal check-in was recorded.
  GOAL_CHECKED_IN:          "GOAL_CHECKED_IN",

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
  // Timeline T-1 — member accepted an invite and joined. Codifies the string the
  // activity Timeline already renders ("Member joined").
  MEMBER_JOINED:            "MEMBER_JOINED",
  MEMBER_REMOVED:           "MEMBER_REMOVED",
  MEMBER_ROLE_CHANGED:      "MEMBER_ROLE_CHANGED",
  // EV-1 Slice 3 — self-leave. Codifies the string the activity Timeline
  // already treats as a first-class action ("Member left"); value is unchanged
  // from the previous inline literal.
  SPACE_LEAVE:              "SPACE_LEAVE",

  // ── Sync / Platform ──────────────────────────────────────────────────────────
  PLAID_SYNC:               "PLAID_SYNC",
  PLAID_REFRESH:            "PLAID_REFRESH",
  // The full deferred history pipeline finished for a just-connected item
  // (sync → snapshot backfill → reconstruction → prices → wealth regen). The
  // single record that anchors BOTH the SYNC_COMPLETED bell notification and the
  // Recent-Activity entry (never two independently-triggered paths).
  PLAID_HISTORY_SYNCED:     "PLAID_HISTORY_SYNCED",
  WALLET_SYNC:              "WALLET_SYNC",
  ACCOUNT_ADD:              "ACCOUNT_ADD",
  ACCOUNT_REMOVE:           "ACCOUNT_REMOVE",
  REGISTER:                 "REGISTER",

  // ── Imports (D2 Step 4D-3) ───────────────────────────────────────────────────
  // Only the rollback action is added in this slice — IMPORT_BATCH_CREATED /
  // IMPORT_BATCH_COMPLETED are deliberately deferred (see
  // docs/initiatives/d2/investigations/D2_STEP4D3_IMPORT_ROLLBACK_INVESTIGATION.md §8).
  IMPORT_BATCH_ROLLED_BACK: "IMPORT_BATCH_ROLLED_BACK",
  // D2 Step 4D-4 — one batch-level event when a QuickBooks externalId match
  // overwrites an existing Transaction's allow-listed fields. No per-row
  // entries, no before/after snapshots — see
  // docs/initiatives/d2/implementation/D2_STEP4D4_QUICKBOOKS_IMPLEMENTATION_CHECKLIST.md §8.
  IMPORT_BATCH_UPDATED_ON_MATCH: "IMPORT_BATCH_UPDATED_ON_MATCH",

  // ── Platform access (PO1.0) ─────────────────────────────────────────────
  // Grant lifecycle on a platform area (user × area × level). Never free
  // strings — the SECOPS vocabulary lesson applied from birth. Written
  // transactionally alongside the grant mutation, always with
  // performedByAdminId set (SYSTEM_ADMIN-only surface).
  PLATFORM_GRANT_CREATED:       "PLATFORM_GRANT_CREATED",
  PLATFORM_GRANT_LEVEL_CHANGED: "PLATFORM_GRANT_LEVEL_CHANGED",
  PLATFORM_GRANT_REVOKED:       "PLATFORM_GRANT_REVOKED",
  PLATFORM_GRANT_REINSTATED:    "PLATFORM_GRANT_REINSTATED",

  // ── AI Context ───────────────────────────────────────────────────────────────
  AI_CONTEXT_ASSEMBLED:     "AI_CONTEXT_ASSEMBLED",
  // Shadow-mode selection plan (D6.3D-1). Records what a token-budgeted
  // selection WOULD include/trim. Purely observational — no prompt is changed.
  AI_CONTEXT_SELECTION_PLANNED: "AI_CONTEXT_SELECTION_PLANNED",
  // Shadow-mode output validation (AI-4 / KD-2). Written ONLY when an LLM reply
  // contains a numeric claim that cannot be reconciled to the grounding context.
  // Observational only — the reply is returned byte-for-byte unchanged.
  AI_OUTPUT_VALIDATION_FLAGGED: "AI_OUTPUT_VALIDATION_FLAGGED",
} as const;

export type AuditActionType = typeof AuditAction[keyof typeof AuditAction];

// ── Security-event classification (SEC-1) ─────────────────────────────────────
//
// The single source of truth for "which audit actions are security events."
// Two surfaces consume this, and they intentionally differ — so this is
// expressed as two derived VIEWS of the canon above rather than one shared
// list. Collapsing them into a single set would change what each surface
// shows (and would break the locked lib/security-history.test.ts allowlist):
//
//   • USER_SECURITY_HISTORY_ACTIONS — the broad, user-facing Security History
//     (lib/security-history.ts). Includes account-lifecycle and email-change
//     events a person wants to see about their OWN account, but hides
//     admin-only actions (ADMIN_SESSION_REVOKED).
//   • ADMIN_SECURITY_FILTER_ACTIONS — the narrower admin audit "security only"
//     quick-filter (app/api/admin/audit/route.ts). Pure auth/session/2FA/
//     password events plus the admin-performed session revoke.
//
// Both are lists of canon constants, so a rename of any AuditAction member is
// a compile-time break here rather than a silent drift in a hand-typed literal
// array living in another file.

/** Actions surfaced in a user's own Security History (broad; hides admin-only). */
export const USER_SECURITY_HISTORY_ACTIONS: AuditActionType[] = [
  AuditAction.REGISTER,
  AuditAction.LOGIN,
  AuditAction.LOGIN_FAILED,
  AuditAction.LOGOUT,
  AuditAction.PASSWORD_CHANGED,
  AuditAction.PASSWORD_CHANGE_FAILED,
  AuditAction.PASSWORD_RESET,
  AuditAction.PASSWORD_RESET_REQUESTED,
  AuditAction.PASSWORD_RESET_COMPLETE,
  AuditAction.EMAIL_VERIFIED,
  AuditAction.EMAIL_VERIFICATION_RESENT,
  AuditAction.EMAIL_CHANGE_REQUESTED,
  AuditAction.EMAIL_CHANGE_COMPLETED,
  AuditAction.ACCOUNT_DEACTIVATED,
  AuditAction.ACCOUNT_REACTIVATED,
  AuditAction.DATA_EXPORTED,
  AuditAction.ACCOUNT_DELETION_REQUESTED,
  AuditAction.ACCOUNT_DELETION_CANCELLED,
  AuditAction.TWO_FACTOR_SETUP_STARTED,
  AuditAction.TWO_FACTOR_ENABLED,
  AuditAction.TWO_FACTOR_DISABLED,
  AuditAction.TWO_FACTOR_RESET,
  AuditAction.RECOVERY_CODE_USED,
  AuditAction.RECOVERY_CODES_GENERATED,
  AuditAction.RECOVERY_CODES_REGENERATED,
  AuditAction.SESSION_REVOKED,
];

/** Actions counted by the admin audit "security only" quick-filter. */
export const ADMIN_SECURITY_FILTER_ACTIONS: AuditActionType[] = [
  AuditAction.LOGIN,
  AuditAction.LOGIN_FAILED,
  AuditAction.LOGOUT,
  AuditAction.PASSWORD_CHANGED,
  AuditAction.PASSWORD_RESET,
  AuditAction.TWO_FACTOR_SETUP_STARTED,
  AuditAction.TWO_FACTOR_ENABLED,
  AuditAction.TWO_FACTOR_DISABLED,
  AuditAction.TWO_FACTOR_RESET,
  AuditAction.RECOVERY_CODE_USED,
  AuditAction.RECOVERY_CODES_GENERATED,
  AuditAction.RECOVERY_CODES_REGENERATED,
  AuditAction.SESSION_REVOKED,
  AuditAction.ADMIN_SESSION_REVOKED,
];

/**
 * All action types shown in the admin filter dropdown.
 * Grouped for readability.
 */
export const AUDIT_ACTION_GROUPS: { label: string; actions: AuditActionType[] }[] = [
  {
    label: "Platform Access",
    actions: [
      AuditAction.PLATFORM_GRANT_CREATED,
      AuditAction.PLATFORM_GRANT_LEVEL_CHANGED,
      AuditAction.PLATFORM_GRANT_REVOKED,
      AuditAction.PLATFORM_GRANT_REINSTATED,
    ],
  },
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
    label: "Account",
    actions: [
      AuditAction.ACCOUNT_DEACTIVATED,
      AuditAction.ACCOUNT_REACTIVATED,
      AuditAction.DATA_EXPORTED,
      AuditAction.ACCOUNT_DELETION_REQUESTED,
      AuditAction.ACCOUNT_DELETION_CANCELLED,
      AuditAction.ACCOUNT_DELETED,
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
