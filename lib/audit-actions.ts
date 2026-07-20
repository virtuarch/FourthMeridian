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
  // Wealth-timeline amendment system (Phase 2) — an explicit, consent-gated
  // rebuild of already-written historical SpaceSnapshot rows was applied.
  // metadata carries the quantified delta (net-worth before→after over the
  // range) so Activity can render "June net worth revised $X → $Y" without
  // knowing anything about snapshot internals.
  SNAPSHOT_AMENDMENT_APPLIED: "SNAPSHOT_AMENDMENT_APPLIED",

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
  // CONN-2B — a user-triggered financial-intelligence rebuild for a connection
  // (regenerateWealthHistoryForAccounts over its accounts — derived-truth
  // reconstruction, no re-acquisition/balance write). Records WHEN a connection's
  // intelligence was last rebuilt so lastReconstructedAt + diagnostics stay
  // honest across manual rebuilds, alongside PLAID_HISTORY_SYNCED. metadata:
  // { connectionId, provider, fromDate, toDate }.
  CONNECTION_INTELLIGENCE_REBUILT: "CONNECTION_INTELLIGENCE_REBUILT",
  // CONN-4A — user-initiated connection-level DISCONNECT (Model A: stop syncing,
  // revoke provider access when orphaned, PRESERVE history — never a deletion).
  // metadata: { institution, provider, accountCount }.
  CONNECTION_DISCONNECTED: "CONNECTION_DISCONNECTED",
  WALLET_SYNC:              "WALLET_SYNC",
  // CH-2 — durable connection status-transition history. One action per model
  // (not one-per-direction); direction lives in `{ from, to }` metadata, the
  // LOGIN_FAILED+`reason` grammar. Written only-on-change from the chokepoint
  // helper lib/connections/health-transitions.ts, alongside the existing live
  // status columns. PLAID_ITEM_STATUS_CHANGED compares the raw PlaidItem
  // (status, errorCode) tuple; WALLET_CONNECTION_STATUS_CHANGED compares the
  // derived wallet health (errorCode present vs absent — wallets never flip
  // `status` on a recoverable failure).
  PLAID_ITEM_STATUS_CHANGED:        "PLAID_ITEM_STATUS_CHANGED",
  WALLET_CONNECTION_STATUS_CHANGED: "WALLET_CONNECTION_STATUS_CHANGED",
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

  // ── Beta access (Wave 1 S3) ─────────────────────────────────────────────
  // The pre-registration access-request lifecycle. REQUESTED is written by the
  // public POST /api/access-request with NO userId (there is no account yet) —
  // ip/user-agent live in metadata. APPROVED/DENIED are written by the platform
  // queue (performedByAdminId-style, decidedById on the row). REDEEMED is
  // written inside the register $transaction when an invite is consumed.
  BETA_ACCESS_REQUESTED:    "BETA_ACCESS_REQUESTED",
  BETA_ACCESS_APPROVED:     "BETA_ACCESS_APPROVED",
  BETA_ACCESS_DENIED:       "BETA_ACCESS_DENIED",
  BETA_ACCESS_REDEEMED:     "BETA_ACCESS_REDEEMED",
  // PO-3B — beta operations write controls. Distinct operator mutations on the
  // same BetaAccessRequest lifecycle: the platform registration-mode switch, and
  // resend/revoke on an already-issued invitation (revoke nulls the token and
  // flips status to DENIED — it never touches users or existing access). All
  // three are written with performedByAdminId (the acting operator) and surface
  // in the Security Ops operator-action feed.
  BETA_MODE_CHANGED:        "BETA_MODE_CHANGED",
  // PO-3C — an operator issued a direct (cold) invitation to an email that never
  // submitted a request. Same email-bound single-use token as the approve flow.
  BETA_INVITATION_CREATED:  "BETA_INVITATION_CREATED",
  BETA_INVITATION_RESENT:   "BETA_INVITATION_RESENT",
  BETA_INVITATION_REVOKED:  "BETA_INVITATION_REVOKED",
  // PO-3C — the LAUNCH axis (development/beta/live), separate from the signup gate.
  PRODUCT_STATUS_CHANGED:   "PRODUCT_STATUS_CHANGED",
  // PO-4A — Platform Operations per-connection controls. An operator triggered a
  // resync of ONE customer connection (reuses the per-item sync body + lock +
  // cooldown), or asked the customer to reauthorize (marks NEEDS_REAUTH, lights
  // the existing owner reconnect prompt — NEVER itemRemove). Both carry
  // performedByAdminId and only operational metadata (connectionId, provider,
  // institution, outcome) — never financial content.
  CONNECTION_RESYNC_TRIGGERED: "CONNECTION_RESYNC_TRIGGERED",
  CONNECTION_REAUTH_REQUESTED: "CONNECTION_REAUTH_REQUESTED",

  // V25-CLOSE-3 Part 3 — SYSTEM_ADMIN Expand-History operations on a customer's
  // Plaid item. These mutate real customer infrastructure (create a fresh link
  // token, exchange a public_token into a new PlaidItem under the OWNER's
  // context, retire the superseded item via /item/remove) and previously left
  // no forensic record. All three carry performedByAdminId (the acting admin)
  // and operational metadata ONLY — item ids, institution, outcome counts —
  // never a public_token, access_token, link_token, or any financial value.
  ADMIN_PLAID_HISTORY_TOKEN_CREATED:   "ADMIN_PLAID_HISTORY_TOKEN_CREATED",
  ADMIN_PLAID_HISTORY_TOKEN_EXCHANGED: "ADMIN_PLAID_HISTORY_TOKEN_EXCHANGED",
  ADMIN_PLAID_ITEM_RETIRED:            "ADMIN_PLAID_ITEM_RETIRED",

  // ── Platform access (PO1.0) ─────────────────────────────────────────────
  // Grant lifecycle on a platform area (user × area × level). Never free
  // strings — the SECOPS vocabulary lesson applied from birth. Written
  // transactionally alongside the grant mutation, always with
  // performedByAdminId set (SYSTEM_ADMIN-only surface).
  PLATFORM_GRANT_CREATED:       "PLATFORM_GRANT_CREATED",
  PLATFORM_GRANT_LEVEL_CHANGED: "PLATFORM_GRANT_LEVEL_CHANGED",
  PLATFORM_GRANT_REVOKED:       "PLATFORM_GRANT_REVOKED",
  PLATFORM_GRANT_REINSTATED:    "PLATFORM_GRANT_REINSTATED",

  // ── Platform manual operations (OPS-5 S4) ────────────────────────────────
  // A grant-holder invoked a manual operation from the Platform Operations
  // Manual Operations panel. EXECUTED is written for a mutating run-now (which
  // also lands its own JobRun via runJob(trigger:"manual")); DRY_RUN is the
  // non-mutating preflight (no JobRun). metadata carries { commandId, kind,
  // targetJob, outcome, jobRunStatus? } — never job internals or values.
  // performedByAdminId is always set (the acting grant-holder), the platform
  // WRITE-surface convention.
  PLATFORM_OPERATION_EXECUTED:  "PLATFORM_OPERATION_EXECUTED",
  PLATFORM_OPERATION_DRY_RUN:   "PLATFORM_OPERATION_DRY_RUN",

  // ── Security Ops anomalies (Wave 3 ⑧) ────────────────────────────────────
  // Written once per open anomaly window by lib/security/anomaly-alerts.ts when
  // a threshold trips (failed-login burst per identifier/IP, recovery-code
  // streak, disabled-admin probe). `metadata.key` carries the dedupe identity
  // ({identifier|ip|…}); the row is BOTH the trip record the Security Ops
  // anomalies widget reads AND the suppress-while-open lock (one row per window,
  // not one per failed attempt).
  SECURITY_ANOMALY_DETECTED:    "SECURITY_ANOMALY_DETECTED",

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

/**
 * OPERATOR actions — what a platform operator (or SYSTEM_ADMIN) DID to the
 * platform, as opposed to end-user auth events. This is the read set behind the
 * Security Ops "operator action feed" (PO-3A): grant lifecycle, manual platform
 * operations, beta decisions, and operator-driven account state changes. Every
 * one of these is written with `performedByAdminId` set (the acting operator),
 * so the feed can attribute the actor honestly. Deliberately DISTINCT from
 * ADMIN_SECURITY_FILTER_ACTIONS (end-user auth/session/2FA events) — the two
 * answer different questions ("is auth healthy?" vs "what did operators do?").
 */
export const OPERATOR_ACTION_FEED_ACTIONS: AuditActionType[] = [
  AuditAction.PLATFORM_GRANT_CREATED,
  AuditAction.PLATFORM_GRANT_LEVEL_CHANGED,
  AuditAction.PLATFORM_GRANT_REVOKED,
  AuditAction.PLATFORM_GRANT_REINSTATED,
  AuditAction.PLATFORM_OPERATION_EXECUTED,
  AuditAction.PLATFORM_OPERATION_DRY_RUN,
  AuditAction.BETA_ACCESS_APPROVED,
  AuditAction.BETA_ACCESS_DENIED,
  AuditAction.BETA_MODE_CHANGED,
  AuditAction.BETA_INVITATION_CREATED,
  AuditAction.BETA_INVITATION_RESENT,
  AuditAction.BETA_INVITATION_REVOKED,
  AuditAction.PRODUCT_STATUS_CHANGED,
  AuditAction.CONNECTION_RESYNC_TRIGGERED,
  AuditAction.CONNECTION_REAUTH_REQUESTED,
  AuditAction.ACCOUNT_DEACTIVATED,
  AuditAction.ACCOUNT_REACTIVATED,
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
  // Wave 3 ⑧ — anomaly trips surface in the security audit feed too, not just
  // the dedicated anomalies widget.
  AuditAction.SECURITY_ANOMALY_DETECTED,
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
