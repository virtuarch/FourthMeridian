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
  // PRE-BETA-OPS-CLOSE Phase 3 — bounded provider-revocation retry evidence.
  // One row per FAILED daily revocation attempt during deletion processing.
  // Carries provider + safe item id + institution + attempt number + a sanitized
  // error classification. NEVER an access token. `AuditLog.userId` is SetNull on
  // user delete, so these rows SURVIVE the deletion they describe — which is the
  // whole point: they are the only remaining record that an upstream consent was
  // never confirmed revoked.
  ACCOUNT_DELETION_REVOCATION_FAILED: "ACCOUNT_DELETION_REVOCATION_FAILED",
  // Terminal: the deletion completed after the daily attempt budget was spent
  // WITHOUT confirmed upstream revocation. Deliberately a distinct action from
  // ACCOUNT_DELETED so no consumer can read a successful deletion as a
  // successful revocation.
  ACCOUNT_DELETED_UNREVOKED:  "ACCOUNT_DELETED_UNREVOKED",

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
  // A7 (2026-10-22) — an admin rescinded a pending invite. The DELETE used to
  // leave no trace at all: the row is hard-deleted, so this is its only record.
  MEMBER_INVITE_CANCELLED:  "MEMBER_INVITE_CANCELLED",
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

  // ── Provider-removal confirmation, which is NOT the same fact as status ────
  // `PlaidItem.status = REVOKED` is the PRODUCT truth: the user disconnected,
  // and a failed upstream removal must never make the institution reappear
  // (lib/connections/space-data.ts loads the hub with `status: { not: REVOKED }`).
  // These two record the SEPARATE question of whether the removal was CONFIRMED
  // upstream, because status could not carry it: REVOKED is a one-way door and
  // every retry work-list selects `status: ACTIVE`, so an unconfirmed failure
  // used to drop out of all of them at once while the Item kept existing — and,
  // per the vendored SDK, kept BILLING — at Plaid. That is what stranded seven
  // live Items on 2026-07-22 (named by path in 056de06).
  // The pair is a LIFECYCLE, read newest-first: an item owes cleanup when its
  // most recent marker is UNCONFIRMED. CONFIRMED resolves it additively, so the
  // failure record is never deleted. No schema change — AuditLog.action is a
  // String by design.
  PLAID_ITEM_REVOCATION_UNCONFIRMED: "PLAID_ITEM_REVOCATION_UNCONFIRMED",
  PLAID_ITEM_REVOCATION_CONFIRMED:   "PLAID_ITEM_REVOCATION_CONFIRMED",
  // An OPERATOR asked for the cleanup to be retried (Platform Ops). Distinct
  // from the two above on purpose: those are the lifecycle VERDICT, written by
  // the revocation path itself, and this is a record of a human asking. Its
  // `outcome` is read back off the marker after the attempt, never from
  // PlaidItem.status.
  PLAID_ITEM_REVOCATION_RETRY_REQUESTED: "PLAID_ITEM_REVOCATION_RETRY_REQUESTED",
  ACCOUNT_ADD:              "ACCOUNT_ADD",
  ACCOUNT_REMOVE:           "ACCOUNT_REMOVE",
  // BETA A2 — two writers that pre-dated this canon and wrote raw strings
  // (app/api/accounts/wallet, app/api/accounts/manual). Promoted so the
  // product-analytics readers and the feed allowlists name one constant; the
  // VALUES are unchanged, so historical rows still match. Their metadata is
  // now ids and kinds only: { connectionId, chain } and { accountId, currency }
  // — never the address, the name, the balance or the purchase price.
  WALLET_ADD:               "WALLET_ADD",
  MANUAL_ASSET_ADD:         "MANUAL_ASSET_ADD",
  REGISTER:                 "REGISTER",

  // ── Product events (BETA A1–A8, lib/analytics/product-events.ts) ──────────
  // First-party behavioural analytics, written SERVER-SIDE only, one row per
  // (user, action, day-or-key) where stated, metadata = ids / kinds / UTC day
  // only. They are PRESENCE and ENGAGEMENT facts, not security or operator
  // events: PRODUCT_EVENT_ACTIONS below is pinned DISJOINT from every security,
  // operator and member-feed allowlist, so a product event can never surface
  // as "something happened to your account".
  //   SESSION_ACTIVE_DAY          first live session check of a UTC day (presence)
  //   SPACE_VIEWED                a Space's server page rendered for a member
  //   BRIEF_VIEWED                a Daily Brief was shown to its reader
  //   TRANSACTIONS_VIEWED         the Transactions workspace loaded its first page
  //   MANUAL_ASSET_VALUE_UPDATED  a manual asset's value was changed (no value)
  SESSION_ACTIVE_DAY:         "SESSION_ACTIVE_DAY",
  SPACE_VIEWED:               "SPACE_VIEWED",
  BRIEF_VIEWED:               "BRIEF_VIEWED",
  TRANSACTIONS_VIEWED:        "TRANSACTIONS_VIEWED",
  MANUAL_ASSET_VALUE_UPDATED: "MANUAL_ASSET_VALUE_UPDATED",
  // S2-(a) — the connection funnel and AI failures (enum properties only):
  //   CONNECTION_LINK_STARTED     a Plaid Link token was minted {provider}
  //   CONNECTION_LINK_EXITED      Plaid Link closed without success {provider, stage, errorCode}
  //   FIRST_SYNC_SUCCEEDED        the user's first successful refresh, once ever {sourceKind}
  //   AI_TURN_FAILED              an accepted Conversations turn had no answer {surface, reason}
  CONNECTION_LINK_STARTED:    "CONNECTION_LINK_STARTED",
  CONNECTION_LINK_EXITED:     "CONNECTION_LINK_EXITED",
  FIRST_SYNC_SUCCEEDED:       "FIRST_SYNC_SUCCEEDED",
  AI_TURN_FAILED:             "AI_TURN_FAILED",

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
  // R2 (2026-10-31) — intake MONITORING rows, written by POST /api/access-request
  // with no userId and no address/hash: at most ONE row per fixed UTC hour each
  // (the first event of the hour writes it; the per-hour count lives in the
  // RateLimit counter store). Metadata: { hourWindow, limit }.
  //   THROTTLED          the global per-hour ceiling refused a submission (429).
  //   DUPLICATE_DROPPED  the per-address ceiling silently dropped a submission.
  BETA_INTAKE_THROTTLED:         "BETA_INTAKE_THROTTLED",
  BETA_INTAKE_DUPLICATE_DROPPED: "BETA_INTAKE_DUPLICATE_DROPPED",
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
  // BETA-REQUEST RISK (2026-10-31) — an operator recorded a review verdict
  // (UNREVIEWED / LEGITIMATE / SUSPICIOUS) on a request's advisory risk signals.
  // Appends one BetaAccessRequestReview row in the same transaction; never
  // changes the request's status or the heuristic evidence. Reason-required.
  BETA_REQUEST_RISK_REVIEWED: "BETA_REQUEST_RISK_REVIEWED",
  // PR B (2026-10-31) — the one issuance mechanism (lib/platform/growth/invitation-issue.ts).
  //   VALIDITY_CHANGED  the beta_invitation_validity_days setting changed (reason
  //                     required; before/after in the same transaction).
  //   EXTENDED          an issued invitation's expiry moved, token KEPT, no email
  //                     (reason required; before/after expiry).
  //   EMAIL_OUTCOME     the provider hand-off of an invite email, appended AFTER
  //                     the issuance commit (the issuance row itself commits with
  //                     the state change, before any email leaves). Readers of the
  //                     last invite-email status read it beside the issuance rows.
  BETA_INVITATION_VALIDITY_CHANGED: "BETA_INVITATION_VALIDITY_CHANGED",
  BETA_INVITATION_EXTENDED:         "BETA_INVITATION_EXTENDED",
  BETA_INVITATION_EMAIL_OUTCOME:    "BETA_INVITATION_EMAIL_OUTCOME",
  // PR C (2026-10-31) — one operator bulk approval (Growth). ONE row per batch,
  // written AFTER its per-request approvals (each keeps its own
  // BETA_ACCESS_APPROVED row): { batchKey, counts, validityDays, requestCount }
  // and opaque request ids — never an email, a hash of one, or a token.
  // Reason-optional, as single approve (lib/platform/growth/bulk-approve.ts).
  BETA_ACCESS_BULK_APPROVED:        "BETA_ACCESS_BULK_APPROVED",
  // OWNER P2-1 (2026-11-01) — hashed blocked identifiers + preserved abuse evidence
  // (docs/plans/BETA-BLOCKED-IDENTIFIER-DESIGN-2026-11-01.md). NEVER an address and
  // never a full HMAC in any of these rows: ids, key version, an 8-hex prefix at
  // most, and (lookup only) the usual auditEmailHash.
  //   IDENTIFIER_BLOCKED        a DENIED request whose latest operator verdict is
  //                             SUSPICIOUS blocked its canonical mailbox (deny or
  //                             risk-review transaction, or the backfill). Also
  //                             written with alreadyBlocked: true when an ACTIVE
  //                             block already stood (nothing created or extended).
  //   IDENTIFIER_UNBLOCKED      a block was removed — by a newer LEGITIMATE /
  //                             UNREVIEWED verdict on its source request, or the
  //                             manual remove route (reason required).
  //   IDENTIFIER_BLOCK_CORRECTED  a block's expiry was corrected (before/after; reason required).
  //   IDENTIFIER_LOOKUP         an operator asked whether an address is blocked
  //                             (emailHash + result; reason required).
  //   IDENTIFIER_BACKFILL       one counts-only row per backfill run (reason required).
  //   ABUSE_EVIDENCE_PRESERVED  a SYSTEM_ADMIN sealed a request's evidence (reason required).
  //   ABUSE_EVIDENCE_ACCESSED   EVERY read of a sealed payload.
  //   ABUSE_EVIDENCE_DELETED    an explicit delete before retainUntil (reason required).
  //   INTAKE_BLOCKED_DROPPED    the public intake silently dropped a blocked
  //                             mailbox: AT MOST ONE row per UTC hour, { hourWindow }
  //                             only (the per-hour count lives in the RateLimit
  //                             counter) — the #160 per-address drop pattern.
  BETA_IDENTIFIER_BLOCKED:          "BETA_IDENTIFIER_BLOCKED",
  BETA_IDENTIFIER_UNBLOCKED:        "BETA_IDENTIFIER_UNBLOCKED",
  BETA_IDENTIFIER_BLOCK_CORRECTED:  "BETA_IDENTIFIER_BLOCK_CORRECTED",
  BETA_IDENTIFIER_LOOKUP:           "BETA_IDENTIFIER_LOOKUP",
  BETA_IDENTIFIER_BACKFILL:         "BETA_IDENTIFIER_BACKFILL",
  BETA_ABUSE_EVIDENCE_PRESERVED:    "BETA_ABUSE_EVIDENCE_PRESERVED",
  BETA_ABUSE_EVIDENCE_ACCESSED:     "BETA_ABUSE_EVIDENCE_ACCESSED",
  BETA_ABUSE_EVIDENCE_DELETED:      "BETA_ABUSE_EVIDENCE_DELETED",
  BETA_INTAKE_BLOCKED_DROPPED:      "BETA_INTAKE_BLOCKED_DROPPED",
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
  // PB-5 — a SYSTEM_ADMIN removed ONE customer connection from Platform Ops
  // (app/api/platform/platform-ops/connections/[id]/remove). The SAME engine as
  // the customer's own disconnect (lib/accounts/disconnect.ts disconnectAccounts:
  // soft-delete, link revoke, orphan-gated itemRemove, token scrub, cleanup
  // marker). Reason REQUIRED. Target = the PLAID_ITEM / CONNECTION; detail
  // carries the owner's user id, the account count, the removal reason and the
  // provider outcome as the marker reads it — never financial content. Distinct
  // from CONNECTION_DISCONNECTED (the customer's own act, in their history).
  CONNECTION_REMOVED_BY_OPERATOR: "CONNECTION_REMOVED_BY_OPERATOR",
  // PB-5 (S2 flag) — the INTENT row of that removal, written BEFORE anything
  // changes (the PLATFORM_OPERATION_REQUESTED idiom): who, why, which
  // connection. A crash before the outcome row leaves this as the trace; the
  // outcome row names it in `detail.intentAuditId`. Reason REQUIRED.
  CONNECTION_REMOVAL_REQUESTED: "CONNECTION_REMOVAL_REQUESTED",
  // PB-5 (owner decision 2026-11-02) — the CUSTOMER-FACING fact of an operator
  // removal, on the owner's own row (userId = owner) so it shows in their
  // Security History as "Removed by Fourth Meridian support · <reason>".
  // Deliberately carries NO operator identity: no performedByAdminId, no IP,
  // no user agent; metadata = connectionId, provider, institution,
  // reasonCategory. The operator lives on CONNECTION_REMOVED_BY_OPERATOR.
  CONNECTION_REMOVED_BY_SUPPORT: "CONNECTION_REMOVED_BY_SUPPORT",
  // Release 2 (domain split) — an operator repointed ONE Plaid Item's webhook to
  // this deployment's own /api/plaid/webhook (Plaid /item/webhook/update, then
  // read back). Carries the before/after webhook ORIGIN+PATH only — never a token.
  PLAID_ITEM_WEBHOOK_UPDATED:  "PLAID_ITEM_WEBHOOK_UPDATED",
  // OPS — an operator resumed ONE self-custody wallet's resumable history
  // (SOL / BTC / ETH) from RECOVERY_REQUIRED or FAILED: one bounded pass under
  // the wallet's sync lock and the shared provider budget, checkpoints kept
  // (lib/platform/wallet-history-recovery.ts). Reason REQUIRED. Every outcome
  // after the reason parses is recorded — SUCCESS, FAILURE, REFUSED — with the
  // chain, the prior and resulting state, and requests consumed. Never an
  // address, a balance, or provider text.
  WALLET_HISTORY_RESUMED:      "WALLET_HISTORY_RESUMED",

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

  // ── Merchant operations (MERCHANT_OPS platform area) ─────────────────────
  // A merge rewrites merchant identity for every tenant and is irreversible in
  // the database; its record carries the full report and a recovery snapshot.
  MERCHANT_MERGE_APPLIED:              "MERCHANT_MERGE_APPLIED",
  MERCHANT_MERGE_DISMISSED:            "MERCHANT_MERGE_DISMISSED",

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
  // PLATFORM-SEC-1 — written BEFORE a fleet-wide run executes, carrying the
  // operator and the required reason, so a run that outlives its request
  // (function timeout) still records who started it and why. EXECUTED follows.
  PLATFORM_OPERATION_REQUESTED: "PLATFORM_OPERATION_REQUESTED",

  // ── Platform policy (PLATFORM OPS POLICIES — Slice 2) ────────────────────
  // A CONTROL grant-holder changed declared operational policy through the
  // canonical mutation service (lib/platform/policies/mutate.ts). CHANGED is an
  // override written (created or updated); RESET is the override row DELETED so
  // the code default is in force again. Both are written in the SAME transaction
  // as the PlatformSetting mutation — neither can exist without the other — and
  // both carry performedByAdminId (the acting operator) plus metadata
  // { key, sourceKind, previous: { raw, origin, cadence, overdueAfterHours,
  // updatedAt }, next: { … } }: policy facts only, never a secret or a value.
  PLATFORM_POLICY_CHANGED:      "PLATFORM_POLICY_CHANGED",
  PLATFORM_POLICY_RESET:        "PLATFORM_POLICY_RESET",
  // P1 HUMAN OPERABILITY — consequential operator actions on a CUSTOMER's
  // policy/cohort (Customer Success), on platform execution cadence (Platform
  // Ops CONTROL), and the two refresh-all authorities (the customer's own, and
  // an operator's on their behalf). All written through recordOperatorAction()
  // (lib/audit.ts) with a structured reason where REASON_REQUIRED_ACTIONS says so.
  CUSTOMER_POLICY_ASSIGNED:        "CUSTOMER_POLICY_ASSIGNED",
  CUSTOMER_POLICY_OVERLAY_CHANGED: "CUSTOMER_POLICY_OVERLAY_CHANGED",
  // AI COST CONTROLS — the per-customer daily AI allowance override was set or
  // removed (lib/platform/customer/assign.ts; reason-required; change carries
  // the before/after USD figure, a policy value, never a balance).
  CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED: "CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED",
  CUSTOMER_COHORT_ASSIGNED:        "CUSTOMER_COHORT_ASSIGNED",
  // BETA RECONCILIATION (owner ruling 2026-10-30) — a PLATFORM_OPS CONTROL
  // holder gave every ACTIVE customer with NO assignment the beta default
  // (lib/platform/policies/reconcile-beta.ts). ONE row per run, written in the
  // same transaction as the inserts, reason-required; target = the POLICY_GROUP;
  // metadata carries counts only (eligible, created, skipped) — never an identity.
  CUSTOMER_POLICY_RECONCILED:      "CUSTOMER_POLICY_RECONCILED",
  // POLICY EDITOR (owner ruling 2026-10-30) — a PLATFORM_OPS CONTROL holder
  // created / cloned, edited (a new immutable version), rolled back (a new
  // version from an earlier one), archived, or moved the default of a customer
  // Policy Group (lib/platform/policies/policy-groups-write.ts). ONE row per
  // operation, in the same transaction, reason-required; target = the
  // POLICY_GROUP; metadata carries the change summary (dimension, before,
  // after) and customer COUNTS — never a customer id.
  POLICY_GROUP_CREATED:            "POLICY_GROUP_CREATED",
  POLICY_GROUP_UPDATED:            "POLICY_GROUP_UPDATED",
  POLICY_GROUP_ROLLED_BACK:        "POLICY_GROUP_ROLLED_BACK",
  POLICY_GROUP_ARCHIVED:           "POLICY_GROUP_ARCHIVED",
  POLICY_GROUP_DEFAULT_CHANGED:    "POLICY_GROUP_DEFAULT_CHANGED",
  // BETA LIFECYCLE (L1, owner decisions 2026-10-31) — a PLATFORM_OPS CONTROL
  // holder paused, resumed (incl. reopening an ended group — reason note
  // required), ended, cost-froze or unfroze a customer Policy Group
  // (lib/platform/policies/policy-group-lifecycle-write.ts). ONE row per
  // transition, in the same transaction as the PolicyGroupTransition row;
  // reason-required; target = the POLICY_GROUP; metadata carries the
  // before/after state and member COUNTS — never a customer id.
  POLICY_GROUP_PAUSED:             "POLICY_GROUP_PAUSED",
  POLICY_GROUP_RESUMED:            "POLICY_GROUP_RESUMED",
  POLICY_GROUP_ENDED:              "POLICY_GROUP_ENDED",
  POLICY_GROUP_COST_FROZEN:        "POLICY_GROUP_COST_FROZEN",
  POLICY_GROUP_COST_UNFROZEN:      "POLICY_GROUP_COST_UNFROZEN",
  // COMMS CENTER B1 (contract v1.1 §9.2) — a Customer Success operator saved a
  // DRAFT content version, asked the AI for a suggestion, PUBLISHED a version
  // (CONTROL, reason required) or ROLLED BACK (CONTROL, reason required) a
  // notification template (lib/notifications/content/store.ts). ONE row per
  // operation, in the same transaction; target = the COMMS_TEMPLATE stream
  // "<key>:<channel>:<variant>"; metadata carries ids, versions, content HASHES
  // and codes — never the text, never customer data.
  COMMS_TEMPLATE_DRAFT_SAVED:      "COMMS_TEMPLATE_DRAFT_SAVED",
  COMMS_TEMPLATE_AI_SUGGESTED:     "COMMS_TEMPLATE_AI_SUGGESTED",
  COMMS_TEMPLATE_PUBLISHED:        "COMMS_TEMPLATE_PUBLISHED",
  COMMS_TEMPLATE_ROLLED_BACK:      "COMMS_TEMPLATE_ROLLED_BACK",
  // COMMS CENTER B2 (contract v1 §3.5, v1.1 §6.1, §9.2) — a Customer Success
  // operator created / edited (WRITE) a DRAFT automation, dry-ran it (WRITE),
  // ACTIVATED it (CONTROL), paused or disabled it (WRITE); the owner recorded
  // the OWNER APPROVAL (SYSTEM_ADMIN); an operator test-sent a message to their
  // own address (WRITE). Every one is reason-required and written in the SAME
  // transaction as its change (lib/notifications/automations/store.ts); target
  // COMMS_AUTOMATION <id> / COMMS_TEST_SEND <key>:<channel>; metadata carries
  // ids, versions, enums and counts — never copy, never customer data.
  COMMS_AUTOMATION_CREATED:        "COMMS_AUTOMATION_CREATED",
  COMMS_AUTOMATION_UPDATED:        "COMMS_AUTOMATION_UPDATED",
  COMMS_AUTOMATION_DRY_RUN:        "COMMS_AUTOMATION_DRY_RUN",
  COMMS_AUTOMATION_OWNER_APPROVED: "COMMS_AUTOMATION_OWNER_APPROVED",
  COMMS_AUTOMATION_ACTIVATED:      "COMMS_AUTOMATION_ACTIVATED",
  // Preview activation (2026-11-01): an activation refused by the closed gate (not Preview / switch off).
  COMMS_AUTOMATION_ACTIVATION_REFUSED: "COMMS_AUTOMATION_ACTIVATION_REFUSED",
  COMMS_AUTOMATION_PAUSED:         "COMMS_AUTOMATION_PAUSED",
  COMMS_AUTOMATION_DISABLED:       "COMMS_AUTOMATION_DISABLED",
  COMMS_TEST_SEND:                 "COMMS_TEST_SEND",
  JOB_CADENCE_CHANGED:             "JOB_CADENCE_CHANGED",
  JOB_CADENCE_RESET:               "JOB_CADENCE_RESET",
  REFRESH_ALL_REQUESTED:           "REFRESH_ALL_REQUESTED",
  OPERATOR_REFRESH_ALL:            "OPERATOR_REFRESH_ALL",

  // SEC-PLAT-2 — a refused CONTROL mutation (refresh cadence, job cadence, AI
  // cost controls). The attempt is a fact: recorded REFUSED through
  // recordOperatorAction with the control, the verb, the target and the refusal
  // CODE — never the submitted value (lib/platform/control-refusal.ts). Not
  // reason-required: a refusal for a missing reason must still be recordable.
  // (Maintenance mode keeps its own REFUSED rows on PLATFORM_POLICY_*.)
  PLATFORM_CONTROL_REFUSED:        "PLATFORM_CONTROL_REFUSED",
  // SEC-PLAT-2 — a CONTROL holder ran the Plaid webhook DRY RUN for one Item
  // (GET /api/platform/platform-ops/connections/[id]/webhook). It reads the Item
  // from Plaid, so it is recorded; it changes nothing (the apply is
  // PLAID_ITEM_WEBHOOK_UPDATED). Facts only: target Item id + outcome word.
  PLAID_ITEM_WEBHOOK_DRY_RUN:      "PLAID_ITEM_WEBHOOK_DRY_RUN",
  // SEC-PLAT-3 — owner ruling P-4: Customer Success may resolve customer
  // identity under explicit authorization, and every such resolution is
  // audited. One row per customer-profile open (GET
  // /api/platform/customer-success/customers/[userId]), written BEFORE the
  // profile is returned — no audit, no profile. Target = the customer (USER);
  // performedByAdminId = the operator. Not shown in the customer's own security
  // history (not in USER_SECURITY_HISTORY_ACTIONS) and excluded from the
  // profile's own operator-action list so views never crowd out changes.
  CUSTOMER_PROFILE_VIEWED:         "CUSTOMER_PROFILE_VIEWED",

  // ── Security Ops anomalies (Wave 3 ⑧) ────────────────────────────────────
  // Written once per open anomaly window by lib/security/anomaly-alerts.ts when
  // a threshold trips (failed-login burst per identifier/IP, recovery-code
  // streak, disabled-admin probe). `metadata.key` carries the dedupe identity
  // ({identifier|ip|…}); the row is BOTH the trip record the Security Ops
  // anomalies widget reads AND the suppress-while-open lock (one row per window,
  // not one per failed attempt).
  SECURITY_ANOMALY_DETECTED:    "SECURITY_ANOMALY_DETECTED",

  // ── First-time onboarding (Connections pass PR 2) ────────────────────────
  // The welcome view was shown to a first-run user (one row per user, written
  // by POST /api/onboarding). Its existence is what stops the post-login
  // redirect from ever firing twice — the Brief is reachable again at once.
  ONBOARDING_PRESENTED:         "ONBOARDING_PRESENTED",
  // The user chose "Explore My Space" or dismissed the invitation. Persisted
  // server-side so it holds across devices. Deliberately NOT a product event
  // (PRODUCT_EVENT_ACTIONS is purged at 13 months; a dismissal must not expire).
  ONBOARDING_DISMISSED:         "ONBOARDING_DISMISSED",

  // ── AI Context ───────────────────────────────────────────────────────────────
  // ⚠️ NO LIVE WRITER. RLS-AI-S1 deleted `lib/ai/context-builder.ts`, which was
  // this event's ONLY writer and had no importer outside its own barrel. The claim
  // that stood here — "written on every context assembly; still live: the Brief
  // and the expense-baseline route both build contexts" — was false in both
  // halves before the deletion: `lib/ai/brief/load.ts` says in its own header that
  // it calls the authorities DIRECTLY, not through the context builder, and the
  // conversation surface (`lib/ai/conversation/evidence.ts`) assembles domains
  // itself and writes no audit row.
  //
  // The constant stays because HISTORICAL ROWS CARRY IT and
  // lib/security-history.test.ts pins the vocabulary; a new writer was NOT
  // invented to preserve the event. If observability over context assembly is
  // wanted again it belongs on the live boundary, which is the turn loop, and that
  // is a decision with a cost (one row per turn) rather than a comment fix.
  AI_CONTEXT_ASSEMBLED:     "AI_CONTEXT_ASSEMBLED",
  // Memory V2 — the user erased one remembered item AND its history from their
  // own Memory panel (DELETE /api/ai/memory/[id]). CONTENT-FREE by contract: the
  // row says that an erasure happened, in which Space, of which class and how
  // many versions — never what the item said, which is the thing they erased.
  AI_MEMORY_ERASED:         "AI_MEMORY_ERASED",
  //
  // ⚠️ TWO CONSTANTS WERE REMOVED HERE BY THE AI CONVERSATION RESET, because
  // their only writers were deleted with the conversation layer:
  //   AI_CONTEXT_SELECTION_PLANNED   the shadow retrieval plan, per turn
  //   AI_OUTPUT_VALIDATION_FLAGGED   an unreconciled numeric claim in a reply
  // `AuditLog.action` is a plain String, so historical rows carrying those two
  // values are unaffected and still render in the admin audit view. Neither
  // appears in AUDIT_ACTION_GROUPS, so no filter changes. A constant with no
  // writer is a promise the codebase no longer keeps.
} as const;

export type AuditActionType = typeof AuditAction[keyof typeof AuditAction];

/**
 * BETA A2 — the product-event vocabulary. EXACTLY these nine (the five A2
 * presence/engagement events plus the four S2-(a) funnel / AI-failure events); the retention job
 * (jobs/product-event-retention.ts) deletes rows of these actions after the
 * owner's 13-month window and must never touch anything else, and every feed /
 * security allowlist is pinned disjoint from this set (lib/security-surface.test.ts,
 * lib/analytics/product-events.test.ts). WALLET_ADD / MANUAL_ASSET_ADD /
 * ACCOUNT_ADD are product-LIFECYCLE events that the engagement predicate also
 * reads (lib/platform/growth/product-analytics-core.ts), but they are not
 * product events: they predate this slice, carry their own retention and
 * already render in the member Space feed.
 */
export const PRODUCT_EVENT_ACTIONS: readonly AuditActionType[] = [
  AuditAction.SESSION_ACTIVE_DAY,
  AuditAction.SPACE_VIEWED,
  AuditAction.BRIEF_VIEWED,
  AuditAction.TRANSACTIONS_VIEWED,
  AuditAction.MANUAL_ASSET_VALUE_UPDATED,
  AuditAction.CONNECTION_LINK_STARTED,
  AuditAction.CONNECTION_LINK_EXITED,
  AuditAction.FIRST_SYNC_SUCCEEDED,
  AuditAction.AI_TURN_FAILED,
];

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
  // PB-5 — support removed one of the user's connections (no operator identity on the row).
  AuditAction.CONNECTION_REMOVED_BY_SUPPORT,
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
  AuditAction.PLATFORM_OPERATION_REQUESTED,
  AuditAction.PLATFORM_POLICY_CHANGED,
  AuditAction.PLATFORM_POLICY_RESET,
  AuditAction.BETA_ACCESS_APPROVED,
  AuditAction.BETA_ACCESS_DENIED,
  AuditAction.BETA_MODE_CHANGED,
  AuditAction.BETA_INVITATION_CREATED,
  AuditAction.BETA_INVITATION_RESENT,
  AuditAction.BETA_INVITATION_REVOKED,
  AuditAction.BETA_REQUEST_RISK_REVIEWED,
  AuditAction.BETA_INVITATION_VALIDITY_CHANGED,
  AuditAction.BETA_INVITATION_EXTENDED,
  AuditAction.BETA_ACCESS_BULK_APPROVED,
  // Owner P2-1 — blocked identifiers and preserved abuse evidence.
  AuditAction.BETA_IDENTIFIER_BLOCKED,
  AuditAction.BETA_IDENTIFIER_UNBLOCKED,
  AuditAction.BETA_IDENTIFIER_BLOCK_CORRECTED,
  AuditAction.BETA_IDENTIFIER_LOOKUP,
  AuditAction.BETA_IDENTIFIER_BACKFILL,
  AuditAction.BETA_ABUSE_EVIDENCE_PRESERVED,
  AuditAction.BETA_ABUSE_EVIDENCE_ACCESSED,
  AuditAction.BETA_ABUSE_EVIDENCE_DELETED,
  AuditAction.PRODUCT_STATUS_CHANGED,
  AuditAction.CONNECTION_RESYNC_TRIGGERED,
  AuditAction.CONNECTION_REAUTH_REQUESTED,
  AuditAction.CONNECTION_REMOVAL_REQUESTED,
  AuditAction.CONNECTION_REMOVED_BY_OPERATOR,
  AuditAction.PLAID_ITEM_WEBHOOK_UPDATED,
  AuditAction.WALLET_HISTORY_RESUMED,
  AuditAction.ACCOUNT_DEACTIVATED,
  AuditAction.ACCOUNT_REACTIVATED,
  // P1 — customer policy / cohort, execution cadence, operator refresh-all.
  AuditAction.CUSTOMER_POLICY_ASSIGNED,
  AuditAction.CUSTOMER_POLICY_OVERLAY_CHANGED,
  AuditAction.CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED,
  AuditAction.CUSTOMER_COHORT_ASSIGNED,
  // Beta reconciliation — the fleet-wide default-assignment run (counts only).
  AuditAction.CUSTOMER_POLICY_RECONCILED,
  // Policy editor — group create / edit / rollback / archive / default (counts only).
  AuditAction.POLICY_GROUP_CREATED,
  AuditAction.POLICY_GROUP_UPDATED,
  AuditAction.POLICY_GROUP_ROLLED_BACK,
  AuditAction.POLICY_GROUP_ARCHIVED,
  AuditAction.POLICY_GROUP_DEFAULT_CHANGED,
  // Beta lifecycle — pause / resume / end / cost freeze / unfreeze (counts only).
  AuditAction.POLICY_GROUP_PAUSED,
  AuditAction.POLICY_GROUP_RESUMED,
  AuditAction.POLICY_GROUP_ENDED,
  AuditAction.POLICY_GROUP_COST_FROZEN,
  AuditAction.POLICY_GROUP_COST_UNFROZEN,
  AuditAction.JOB_CADENCE_CHANGED,
  AuditAction.JOB_CADENCE_RESET,
  AuditAction.OPERATOR_REFRESH_ALL,
  // Pre-existing operator action that was never listed (the provider-cleanup retry).
  AuditAction.PLAID_ITEM_REVOCATION_RETRY_REQUESTED,
  // SEC-PLAT-2 — operator actions that were written but never listed: merchant
  // merge decisions (now through the operator-action envelope), refused CONTROL
  // mutations, and the Plaid webhook dry run.
  AuditAction.MERCHANT_MERGE_APPLIED,
  AuditAction.MERCHANT_MERGE_DISMISSED,
  AuditAction.PLATFORM_CONTROL_REFUSED,
  AuditAction.PLAID_ITEM_WEBHOOK_DRY_RUN,
  // SEC-PLAT-3 — authorized customer-identity reads.
  AuditAction.CUSTOMER_PROFILE_VIEWED,
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
    label: "Platform Policy",
    actions: [
      AuditAction.PLATFORM_POLICY_CHANGED,
      AuditAction.PLATFORM_POLICY_RESET,
      AuditAction.PLATFORM_CONTROL_REFUSED,
      AuditAction.PLAID_ITEM_WEBHOOK_DRY_RUN,
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
      AuditAction.MEMBER_INVITE_CANCELLED,
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
