/**
 * lib/notifications/registry.ts  (OPS-3 S0)
 *
 * THE single notification registry — the one definition site for every
 * notification type the platform knows about (frozen decision F1,
 * docs/initiatives/ops3/OPS3_IMPLEMENTATION_PLAN.md). The lib/widget-registry
 * contract applied to notifications:
 *
 *   Adding a new notification type = add ONE entry here + ONE producer call
 *   site. No switch/case edits, no migration, no other file.
 *
 * Pure config — no DB, no I/O, no side effects. The DB stores category/type
 * as strings (never enums); THIS module is the validation gate: the S1
 * chokepoint rejects any type not present here (the emitDomainEvent
 * "no AuditAction mapped" idiom).
 *
 * GRAMMAR (F2 — PO1 P0, Master Plan Rev B R.2): ids are DOMAIN_OBJECT_EVENT,
 * past-tense SCREAMING_SNAKE ("PASSWORD_CHANGED", "SYNC_FAILED"). Where an
 * AuditAction with the same meaning exists, the id CITES it verbatim rather
 * than coining a synonym; where the legacy audit grammar drifts (e.g.
 * SPACE_LEAVE), the canonical form is used here and the mapping to the legacy
 * string lives at the producer (grandfather-never-rename — legacy audit rows
 * are historical data). This registry deliberately does NOT introduce a
 * second vocabulary: when PO1 P0's platform event registry lands, these ids
 * reconcile into it as-is.
 *
 * STATUS MARKERS: every entry is status "VOCABULARY" at S0 — declared, no
 * producer wired (the EV-1 PROVISIONAL/EXERCISED idiom). The slice that wires
 * a producer flips its entry to "WIRED" in this file only.
 *
 * DOCTRINE (chokepoint invariant, named bypasses, in-app asymmetry, trust
 * boundary, pointer-contract philosophy): see the header of
 * lib/notifications/types.ts — stated once, referenced here.
 */

import type {
  NotificationCategory,
  NotificationChannel,
  NotificationPriorityValue,
  NotificationRenderData,
  NotificationTypeDefinition,
  RetentionPolicy,
} from "@/lib/notifications/types";
import { connectionAttentionCopy } from "@/lib/notifications/connection-attention";
import { walletAttentionCopy } from "@/lib/notifications/wallet-attention";

// ── Shared policy values ──────────────────────────────────────────────────────

/** Default lifecycle: read rows auto-archive at 30 days; archived rows delete at 90 (F9). */
export const DEFAULT_RETENTION: RetentionPolicy = { autoArchiveDays: 30, deleteDays: 90 };

/** Render-data helper: string field with fallback, so render({}) is always safe. */
function str(data: NotificationRenderData, key: string, fallback: string): string {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** In-app link to a Platform area, only for a well-formed PlatformArea value (render data is untrusted). */
function platformAreaHref(area: unknown): string {
  return typeof area === "string" && /^[A-Z][A-Z_]{1,40}$/.test(area) ? `/dashboard/platform/${area}` : "/dashboard/platform";
}

/**
 * Shared per-category partials. locked/priority/channels are uniform per
 * category (the preference matrix is per category × channel — F11), so the
 * uniformity lives in one place and the tests can enforce it.
 */
const SECURITY = {
  category: "ACCOUNT_SECURITY" as const,
  priority: "CRITICAL" as const,
  // IN_APP only (S5 amendment — see OPS3_S5_PRODUCER_WAVES_INVESTIGATION.md §2):
  // the EMAIL guarantee for security events lives in the OPS-2 security-alert
  // flow (support@, unconditional, outside this system). Routing them through
  // the notification EMAIL channel too would double-email every event.
  // `locked` means the user cannot OVERRIDE these defaults, not "all on".
  defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
  locked: true,
  retention: DEFAULT_RETENTION,
  digestable: false,
  dedupe: "none" as const,
  dedupeKeyTemplate: null,
  status: "VOCABULARY" as const,
};

const SPACES = {
  category: "SPACES" as const,
  priority: "NORMAL" as const,
  defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
  locked: false,
  retention: DEFAULT_RETENTION,
  digestable: false,
  dedupe: "none" as const,
  dedupeKeyTemplate: null,
  status: "VOCABULARY" as const,
};

const FINANCIAL = {
  category: "FINANCIAL" as const,
  locked: false,
  retention: DEFAULT_RETENTION,
  digestable: false,
  status: "VOCABULARY" as const,
};

const AI = {
  category: "AI" as const,
  locked: false,
  retention: DEFAULT_RETENTION,
  status: "VOCABULARY" as const,
};

const PLATFORM = {
  category: "PLATFORM" as const,
  locked: false,
  retention: DEFAULT_RETENTION,
  dedupe: "none" as const,
  dedupeKeyTemplate: null,
  status: "VOCABULARY" as const,
};

// ── The registry ──────────────────────────────────────────────────────────────

export const NOTIFICATION_REGISTRY = {
  // ══ ACCOUNT_SECURITY — CRITICAL · locked · producers: S5 Wave 1 (inline
  //    beside the existing audit + security-alert email calls; those emails
  //    are ceremony-adjacent but stay untouched — F15). All VOCABULARY until
  //    Wave 1 wires them. ACCOUNT_DELETED is deliberately ABSENT: the purge
  //    email has no User row to notify (named bypass #2).
  PASSWORD_CHANGED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/user/password
    id: "PASSWORD_CHANGED",
    icon: "key-round",
    pointerContract: [],
    render: () => ({
      title: "Your password was changed",
      body: "If you didn't make this change, reset your password immediately.",
      href: "/dashboard/settings/security",
    }),
  },
  PASSWORD_RESET: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/auth/reset-password
    id: "PASSWORD_RESET",
    icon: "key-round",
    pointerContract: [],
    render: () => ({
      title: "Your password was reset",
      body: "Your password was reset via a reset link. If this wasn't you, contact support.",
      href: "/dashboard/settings/security",
    }),
  },
  EMAIL_CHANGE_REQUESTED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/user/email/request
    id: "EMAIL_CHANGE_REQUESTED",
    icon: "mail",
    // pendingEmail is display payload (masked at the producer), not a row pointer.
    pointerContract: ["pendingEmail"],
    render: (d) => ({
      title: "Email change requested",
      body: `A change to ${str(d, "pendingEmail", "a new address")} was requested. If this wasn't you, secure your account now.`,
      href: "/dashboard/settings/security",
    }),
  },
  EMAIL_CHANGE_COMPLETED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/user/email/confirm
    id: "EMAIL_CHANGE_COMPLETED",
    icon: "mail-check",
    pointerContract: [],
    render: () => ({
      title: "Your email address was changed",
      body: "All sessions were signed out. Sign in with your new address.",
      href: "/dashboard/settings/security",
    }),
  },
  EMAIL_VERIFIED: {
    ...SECURITY,
    id: "EMAIL_VERIFIED",
    icon: "badge-check",
    pointerContract: [],
    render: () => ({ title: "Email address verified" }),
  },
  TWO_FACTOR_ENABLED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/user/totp/verify
    id: "TWO_FACTOR_ENABLED",
    icon: "shield-check",
    pointerContract: [],
    render: () => ({
      title: "Two-factor authentication enabled",
      href: "/dashboard/settings/security",
    }),
  },
  TWO_FACTOR_DISABLED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/user/totp/disable
    id: "TWO_FACTOR_DISABLED",
    icon: "shield-off",
    pointerContract: [],
    render: () => ({
      title: "Two-factor authentication disabled",
      body: "If you didn't disable 2FA, secure your account immediately.",
      href: "/dashboard/settings/security",
    }),
  },
  TWO_FACTOR_RESET: {
    ...SECURITY,
    id: "TWO_FACTOR_RESET",
    icon: "shield-alert",
    pointerContract: [],
    render: () => ({
      title: "Two-factor authentication was reset",
      href: "/dashboard/settings/security",
    }),
  },
  RECOVERY_CODE_USED: {
    ...SECURITY,
    id: "RECOVERY_CODE_USED",
    icon: "life-buoy",
    pointerContract: [],
    render: () => ({
      title: "A recovery code was used to sign in",
      body: "If this wasn't you, secure your account and regenerate your codes.",
      href: "/dashboard/settings/security",
    }),
  },
  RECOVERY_CODES_REGENERATED: {
    ...SECURITY,
    id: "RECOVERY_CODES_REGENERATED",
    icon: "life-buoy",
    pointerContract: [],
    render: () => ({
      title: "Recovery codes regenerated",
      body: "Your previous unused recovery codes no longer work.",
      href: "/dashboard/settings/security",
    }),
  },
  SESSION_REVOKED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/user/sessions/[sessionId] (single; bulk self-revoke deliberately not wired)
    id: "SESSION_REVOKED",
    icon: "monitor-off",
    // Display payload describing the revoked session (producer-safe strings).
    pointerContract: ["device"],
    render: (d) => ({
      title: "A session was signed out",
      body: `${str(d, "device", "A device")} was signed out of your account.`,
      href: "/dashboard/settings/security",
    }),
  },
  ACCOUNT_DEACTIVATED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/user/deactivate
    id: "ACCOUNT_DEACTIVATED",
    icon: "user-x",
    pointerContract: [],
    render: () => ({
      title: "Your account was deactivated",
      body: "Your data is intact. Sign in again any time to reactivate.",
    }),
  },
  ACCOUNT_REACTIVATED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — lib/auth.ts reactivation leg
    id: "ACCOUNT_REACTIVATED",
    icon: "user-check",
    pointerContract: [],
    render: () => ({ title: "Welcome back — your account was reactivated" }),
  },
  ACCOUNT_DELETION_REQUESTED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/user/delete
    id: "ACCOUNT_DELETION_REQUESTED",
    icon: "trash-2",
    // scheduledFor: ISO date string (display payload).
    pointerContract: ["scheduledFor"],
    render: (d) => ({
      title: "Account deletion scheduled",
      body: `Your account is scheduled for permanent deletion${
        typeof d["scheduledFor"] === "string" ? ` on ${d["scheduledFor"]}` : ""
      }. You can cancel by signing in before then.`,
      href: "/dashboard/settings/security",
    }),
  },
  ACCOUNT_DELETION_CANCELLED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — lib/auth.ts cancel-deletion leg
    id: "ACCOUNT_DELETION_CANCELLED",
    icon: "undo-2",
    pointerContract: [],
    render: () => ({ title: "Account deletion cancelled" }),
  },
  DATA_EXPORTED: {
    ...SECURITY,
    status: "WIRED" as const, // S5 W1 — app/api/user/export
    id: "DATA_EXPORTED",
    icon: "download",
    pointerContract: [],
    render: () => ({
      title: "Your data was exported",
      body: "A copy of your personal data was downloaded. If this wasn't you, secure your account.",
      href: "/dashboard/settings/security",
    }),
  },
  // Platform access changes (owner-approved 2026-10-31). A privilege change is
  // SECURITY-relevant: the grantee must know, so these are locked like every
  // ACCOUNT_SECURITY type, and their EMAIL is the direct security-alert email
  // (lib/notifications/platform-access.ts) — never this system's EMAIL channel
  // (the registry's no-double-email doctrine). Producer: the SYSTEM_ADMIN grant
  // routes (app/api/admin/platform-grants). dedupe none: each audited grant
  // mutation is a distinct fact; the route's own no-op (same area, same level,
  // already ACTIVE) writes no audit row and notifies nobody.
  PLATFORM_ACCESS_GRANTED: {
    ...SECURITY,
    status: "WIRED" as const, // app/api/admin/platform-grants (POST: create / reinstate / level change)
    id: "PLATFORM_ACCESS_GRANTED",
    icon: "shield-check",
    // area: PlatformArea enum value; areaLabel/levelLabel: display copy;
    // change: "granted" | "reinstated" | "level_changed". No grantor identity —
    // only the grantor's ROLE is ever shown (a system administrator).
    pointerContract: ["area", "areaLabel", "level", "levelLabel", "change"],
    render: (d) => {
      const area = str(d, "areaLabel", "a Platform area");
      const level = str(d, "levelLabel", "a new");
      return {
        title: d["change"] === "level_changed" ? `Your ${area} access changed` : `You were given access to ${area}`,
        body: `A system administrator gave you ${level} access to ${area}. If you weren't expecting this, contact support.`,
        href: platformAreaHref(d["area"]),
      };
    },
  },
  PLATFORM_ACCESS_REVOKED: {
    ...SECURITY,
    status: "WIRED" as const, // app/api/admin/platform-grants/[grantId] (PATCH revoke)
    id: "PLATFORM_ACCESS_REVOKED",
    icon: "shield-off",
    pointerContract: ["area", "areaLabel", "level", "levelLabel"],
    render: (d) => ({
      title: `Your access to ${str(d, "areaLabel", "a Platform area")} was removed`,
      body: "A system administrator removed this access. If you weren't expecting this, contact support.",
      href: "/dashboard/settings/security",
    }),
  },

  // ══ SPACES — NORMAL · mutable · producers: S1 (invite) then S5 Wave 2
  //    (EV-1 handlers on MemberInvited / MemberJoined / MemberRemoved /
  //    MemberRoleChanged).
  SPACE_INVITE_RECEIVED: {
    ...SPACES,
    // ONE EMAIL PER INVITATION (2026-10-31): IN_APP only. The invitee's email
    // is the route's dedicated `space-invite` email (app/api/spaces/[id]/
    // invite/route.ts), sent once per invite. This type used to default to
    // EMAIL too, which mailed the invitee a second, generic `notification`
    // email. EXCLUDED, not merely off by default, so a SPACES/EMAIL
    // preference cannot bring the duplicate back (lib/notifications/
    // preferences.ts resolveChannelEnabled) and the retry job closes any
    // legacy failed EMAIL delivery of this type instead of re-sending it.
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    excludedChannels: ["EMAIL"] as const satisfies readonly NotificationChannel[],
    // WIRED (OPS-3 S1): EV-1 handler on MemberInvited
    // (lib/events/handlers/space-invite-notification.ts).
    status: "WIRED" as const,
    id: "SPACE_INVITE_RECEIVED",
    icon: "mail-plus",
    // inviteId → SpaceInvite row; expiry mirrors SpaceInvite.expiresAt via
    // NotificationInput.expiresAt at the producer.
    pointerContract: ["inviteId", "spaceName", "inviterName"],
    render: (d) => ({
      title: `You're invited to ${str(d, "spaceName", "a Space")}`,
      body: `${str(d, "inviterName", "A member")} invited you to join.`,
      href: "/dashboard/spaces",
    }),
  },
  SPACE_INVITE_ACCEPTED: {
    ...SPACES,
    // WIRED (OPS-3 S5 Wave 2): EV-1 handler on MemberJoined
    // (lib/events/handlers/space-member-notifications.ts).
    status: "WIRED" as const,
    id: "SPACE_INVITE_ACCEPTED",
    icon: "user-plus",
    // Notifies the INVITER. spaceId rides the column; names are display payload.
    pointerContract: ["inviteId", "spaceName", "memberName"],
    render: (d) => ({
      title: `${str(d, "memberName", "Your invitee")} joined ${str(d, "spaceName", "your Space")}`,
      href: "/dashboard/spaces",
    }),
  },
  MEMBER_REMOVED: {
    ...SPACES,
    // WIRED (OPS-3 S5 Wave 2): EV-1 handler on MemberRemoved.
    status: "WIRED" as const,
    id: "MEMBER_REMOVED",
    icon: "user-minus",
    // Notifies the REMOVED user. spaceId column carries the Space pointer.
    pointerContract: ["spaceName"],
    render: (d) => ({
      title: `You were removed from ${str(d, "spaceName", "a Space")}`,
    }),
  },
  MEMBER_ROLE_CHANGED: {
    ...SPACES,
    // WIRED (OPS-3 S5 Wave 2): EV-1 handler on MemberRoleChanged.
    status: "WIRED" as const,
    id: "MEMBER_ROLE_CHANGED",
    icon: "users",
    // Notifies the TARGET user.
    pointerContract: ["spaceName", "oldRole", "newRole"],
    render: (d) => ({
      title: `Your role in ${str(d, "spaceName", "a Space")} changed`,
      body: `${str(d, "oldRole", "Previous role")} → ${str(d, "newRole", "new role")}.`,
      href: "/dashboard/spaces",
    }),
  },
  // VOCABULARY, inventory-only: the ownership-transfer FEATURE does not exist
  // (deferred by OPS-2 S7). This entry ships with that feature's producer,
  // not with any OPS-3 wave.
  SPACE_OWNERSHIP_TRANSFERRED: {
    ...SPACES,
    id: "SPACE_OWNERSHIP_TRANSFERRED",
    icon: "crown",
    pointerContract: ["spaceName", "previousOwnerName"],
    render: (d) => ({
      title: `You now own ${str(d, "spaceName", "a Space")}`,
      href: "/dashboard/spaces",
    }),
  },

  // ══ FINANCIAL — producers: S5 Wave 3.
  SYNC_FAILED: {
    ...FINANCIAL,
    // WIRED (OPS-3 S5 Wave 3): produced at every health-classified failure
    // site (sync-banks cron, refresh/sync routes, refreshAllActiveItemsForUser,
    // background history sync) via lib/plaid/sync-notifications.ts; the :open
    // key is retired on recovery (completed sync / Link relink).
    status: "WIRED" as const,
    id: "SYNC_FAILED",
    priority: "HIGH" as const,
    // Actionable (reconnect) → email on by default.
    defaultChannels: ["IN_APP", "EMAIL"] as const satisfies readonly NotificationChannel[],
    // OWNER RULING 2026-10-31 (Comms Center A-2b, O-7): a connection-failure
    // email follows ONLY the FINANCIAL email preference. FINANCIAL in-app off
    // hides the bell but still sends the email (lib/notifications/create.ts).
    emailIndependentOfInApp: true as const,
    // suppress-while-open (F3): one live notification per broken item, however
    // many daily cron runs observe it; the ":open" suffix retires on a
    // successful sync so a NEW outage notifies again.
    dedupe: "suppress" as const,
    dedupeKeyTemplate: "SYNC_FAILED:item:{plaidItemId}:open",
    icon: "triangle-alert",
    // connectionState (lib/notifications/connection-attention.ts) is derived by
    // the producer from the PlaidItem.status the call site just wrote; rows
    // written before it existed (or any unknown value) render the conservative
    // "sync-failed" copy — never "disconnected".
    pointerContract: ["plaidItemId", "institutionName", "connectionState"],
    render: (d) => {
      const copy = connectionAttentionCopy(d.connectionState, str(d, "institutionName", "your institution"));
      return { title: copy.title, body: copy.body, href: "/dashboard/connections", actionLabel: copy.actionLabel };
    },
  },
  // WIRED (reopening the D2-deferred decision consciously): produced ONLY when
  // the FULL deferred pipeline finishes for an item (initial connect or a
  // webhook-triggered re-run — lib/plaid/backgroundHistorySync.runDeferredHistorySync
  // → lib/plaid/sync-notifications.notifyItemSyncComplete), NOT the routine daily
  // cron sync. The original D2 "daily per-item ping is noise" concern is met by
  // suppress-while-open: one live "history ready" per item until the user
  // dismisses it, so repeated pipeline runs during ingestion don't spam. IN_APP
  // only (no email — a completion is informational, not actionable like
  // SYNC_FAILED). One AuditLog row (PLAID_HISTORY_SYNCED) anchors BOTH this bell
  // notification and the Recent-Activity entry, so they can't drift.
  SYNC_COMPLETED: {
    ...FINANCIAL,
    status: "WIRED" as const,
    id: "SYNC_COMPLETED",
    priority: "LOW" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    dedupe: "suppress" as const,
    dedupeKeyTemplate: "SYNC_COMPLETED:item:{plaidItemId}:open",
    icon: "circle-check",
    pointerContract: ["plaidItemId", "institutionName"],
    render: (d) => ({
      title: `${str(d, "institutionName", "A connection")} — history ready`,
      body: "Full transaction history and 30-day balance history are ready.",
      href: "/dashboard/connections",
    }),
  },
  // WIRED (owner-approved 2026-10-31): a crypto wallet that has been failing
  // to sync for a SUSTAINED period (≥ 24 h since the outage's first failure,
  // observed again now) — never one transient blip. Produced by
  // lib/crypto/wallet-sync-notifications.ts from syncWalletByChain's outcome;
  // retired by the next clean successful sync. walletState
  // (lib/notifications/wallet-attention.ts) is "temporary" (provider could not
  // be read — still connected, retrying) or "needs-attention" (invalid
  // address); never "disconnected". Platform-side codes and removed wallets do
  // not notify; a Cost Freeze skip never reaches the producer.
  WALLET_SYNC_FAILED: {
    ...FINANCIAL,
    status: "WIRED" as const,
    id: "WALLET_SYNC_FAILED",
    priority: "HIGH" as const,
    // In-app by default. Email is OPT-IN (the FINANCIAL email preference): a
    // provider outage hits every wallet on that chain at once, so a default-on
    // email would mass-mail for something the user cannot act on.
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    // Owner ruling O-7 (A-2b), as for SYNC_FAILED: an opted-in email follows
    // ONLY the FINANCIAL email preference; FINANCIAL in-app off hides the bell
    // but does not drop that email.
    emailIndependentOfInApp: true as const,
    dedupe: "suppress" as const,
    dedupeKeyTemplate: "WALLET_SYNC_FAILED:account:{financialAccountId}:open",
    icon: "triangle-alert",
    // walletName / network are display payload (the account's own label and the
    // chain's name) — never the address.
    pointerContract: ["financialAccountId", "walletName", "network", "walletState"],
    render: (d) => {
      const copy = walletAttentionCopy(d.walletState, str(d, "walletName", "Your wallet"), str(d, "network", "its network"));
      return { title: copy.title, body: copy.body, href: "/dashboard/connections", actionLabel: copy.actionLabel };
    },
  },
  // VOCABULARY by Wave-3 investigation ruling (repository drift from the
  // original inventory): the ONLY DuplicateAccountCandidate writer today is
  // the automatic-merge path, which creates CONFIRMED_DUPLICATE rows with
  // resolvedAt = detectedAt — no PENDING/review-gap rows exist, so there is
  // nothing actionable to notify about (auto-merges are silent by design).
  // Wire this when a human-review (PENDING) duplicate flow ships.
  DUPLICATE_DETECTED: {
    ...FINANCIAL,
    id: "DUPLICATE_DETECTED",
    priority: "NORMAL" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    // Per-RUN collapse (plan S5 Wave 3): one notification per sync run's
    // findings — candidateIds + count in metadata, never one row per candidate.
    // "refresh" is declared vocabulary (F3: v1 implements suppress only);
    // Wave 3 implements it or falls back to suppress at wave entry.
    dedupe: "refresh" as const,
    dedupeKeyTemplate: "DUPLICATE_DETECTED:user:{userId}:open",
    icon: "copy",
    pointerContract: ["candidateIds", "count"],
    render: () => ({
      title: "Possible duplicate accounts detected",
      body: "Review the detected duplicates to keep your balances accurate.",
      href: "/dashboard/connections",
    }),
  },
  IMPORT_COMPLETED: {
    ...FINANCIAL,
    // WIRED (OPS-3 S5 Wave 3): inline at batch completion
    // (app/api/accounts/[id]/import).
    status: "WIRED" as const,
    id: "IMPORT_COMPLETED",
    priority: "NORMAL" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    dedupe: "none" as const,
    dedupeKeyTemplate: null,
    icon: "file-check",
    pointerContract: ["batchId", "rowCount"],
    render: () => ({
      title: "Import completed",
      body: "Your imported transactions are ready.",
    }),
  },
  // ImportBatchStatus.COMPLETED_WITH_ERRORS surfaces at HIGH (baseline §2.3);
  // a distinct type because priority is registry-static.
  IMPORT_COMPLETED_WITH_ERRORS: {
    ...FINANCIAL,
    // WIRED (OPS-3 S5 Wave 3): inline at batch completion.
    status: "WIRED" as const,
    id: "IMPORT_COMPLETED_WITH_ERRORS",
    priority: "HIGH" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    dedupe: "none" as const,
    dedupeKeyTemplate: null,
    icon: "file-warning",
    pointerContract: ["batchId", "errorCount"],
    render: () => ({
      title: "Import completed with errors",
      body: "Some rows could not be imported. Review the batch for details.",
    }),
  },

  // ══ AI — producers are v2.6b (Ambient Intelligence); ALL VOCABULARY in
  //    OPS-3 (F: "vocabulary ships in S0, exercised then"). Every AI producer
  //    reaches users ONLY via the chokepoint (F12); content stays in its
  //    substrate (AiAdvice etc.) — the notification carries pointers.
  DAILY_BRIEF_READY: {
    ...AI,
    id: "DAILY_BRIEF_READY",
    priority: "LOW" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: true,
    dedupe: "none" as const,
    dedupeKeyTemplate: null,
    icon: "sunrise",
    pointerContract: [],
    render: () => ({ title: "Your Daily Brief is ready", href: "/dashboard" }),
  },
  OPPORTUNITY_FOUND: {
    ...AI,
    id: "OPPORTUNITY_FOUND",
    priority: "NORMAL" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: false,
    dedupe: "none" as const,
    dedupeKeyTemplate: null,
    icon: "lightbulb",
    // adviceId → AiAdvice (content lives there); agentId → AiAgent attribution.
    pointerContract: ["adviceId", "agentId"],
    render: (d) => ({
      title: str(d, "summary", "An opportunity was found"),
      // CLEAN-0 — was "/dashboard/advice" (a standalone page that advertised a
      // "Runs 2× daily" scheduler with no write path; deleted). The live AI
      // surface is /dashboard/analyze, which renders the same cached AiAdvice
      // via AdviceBanner.
      href: "/dashboard/analyze",
    }),
  },
  UNUSUAL_SPENDING: {
    ...AI,
    id: "UNUSUAL_SPENDING",
    priority: "HIGH" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: false,
    dedupe: "none" as const,
    dedupeKeyTemplate: null,
    icon: "activity",
    pointerContract: ["transactionIds", "agentId"],
    render: (d) => ({
      title: str(d, "summary", "Unusual spending detected"),
    }),
  },
  // W2 — GOAL_RISK deleted with the Goals retirement. The registry is PARTIAL
  // (satisfies Record<string, ...>; the DB stores type as a string, not a
  // Prisma enum), so a vocabulary-only entry with no producer and no goal
  // substrate left to point at is simply removed — the S1 chokepoint now
  // rejects the type like any other unregistered string.
  DEBT_ALERT: {
    ...AI,
    id: "DEBT_ALERT",
    priority: "HIGH" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: false,
    dedupe: "suppress" as const,
    dedupeKeyTemplate: "DEBT_ALERT:account:{financialAccountId}:open",
    icon: "credit-card",
    pointerContract: ["financialAccountId", "agentId"],
    render: (d) => ({
      title: str(d, "summary", "A debt needs attention"),
    }),
  },

  // ══ PLATFORM — admin-authored broadcasts; VOCABULARY until the broadcast
  //    producer lands (deferred with OPS-5's admin surface). Baseline names
  //    ("maintenance / new feature / policy update") normalized to the F2
  //    grammar — this registry does not carry noun-phrase ids.
  MAINTENANCE_SCHEDULED: {
    ...PLATFORM,
    id: "MAINTENANCE_SCHEDULED",
    priority: "NORMAL" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: false,
    icon: "wrench",
    // window: display payload; expiry set to the maintenance end via
    // NotificationInput.expiresAt at the producer.
    pointerContract: ["window"],
    render: (d) => ({
      title: "Scheduled maintenance",
      body: `Fourth Meridian will be briefly unavailable${
        typeof d["window"] === "string" ? `: ${d["window"]}` : "."
      }`,
    }),
  },
  FEATURE_RELEASED: {
    ...PLATFORM,
    id: "FEATURE_RELEASED",
    priority: "LOW" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: true,
    icon: "sparkles",
    pointerContract: ["featureName"],
    render: (d) => ({
      title: `New: ${str(d, "featureName", "a feature update")}`,
    }),
  },
  POLICY_UPDATED: {
    ...PLATFORM,
    id: "POLICY_UPDATED",
    priority: "NORMAL" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: false,
    icon: "scale",
    pointerContract: ["policyName"],
    render: (d) => ({
      title: `${str(d, "policyName", "A policy")} was updated`,
    }),
  },
  // WIRED (owner-approved 2026-10-31): the one-time welcome. In-app notice plus
  // the dedicated `welcome` email (lib/notifications/welcome.ts), sent ONCE per
  // account: at registration for an invited (pre-verified) account, after the
  // first successful email verification for an uninvited one — never beside the
  // verification email. Classification: consent SERVICE — not ceremony (holding
  // it back breaks no flow the user started) and not marketing. LOCKED PER TYPE
  // (PER_TYPE_LOCKED_TYPES): no preference can suppress a one-time welcome, but
  // its email is storm-limited like every SERVICE email (lib/email/send.ts).
  // The in-app row is the idempotency anchor: its ":once" key is never released
  // (dedupeNeverReleases), and the email ships only when the row was CREATED.
  ACCOUNT_WELCOME: {
    ...PLATFORM,
    status: "WIRED" as const,
    locked: true,
    id: "ACCOUNT_WELCOME",
    priority: "LOW" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: false,
    dedupe: "suppress" as const,
    dedupeKeyTemplate: "ACCOUNT_WELCOME:user:{userId}:once",
    dedupeNeverReleases: true as const,
    icon: "sparkles",
    pointerContract: [],
    render: () => ({
      title: "Welcome to Fourth Meridian",
      body: "Start by connecting your accounts from Connections. Your Space fills in as they sync.",
      href: "/dashboard/connections",
    }),
  },
  // WIRED (Wave 3 ⑧): the Security Ops in-app bell for a detected auth anomaly,
  // fanned out to every ACTIVE SECURITY_OPS grant holder + SYSTEM_ADMIN from
  // lib/security/anomaly-alerts.ts. Reuses the existing PLATFORM category (this
  // is platform-staff visibility, same audience as the other platform bells —
  // no new category needed) but is LOCKED PER TYPE (Comms Center A-2b, owner
  // decision O-8, AUDIT R-2): no preference — PLATFORM in-app off included —
  // can mute it. The PLATFORM row stays switchable for the customer bells.
  // anomalyKey is a SALTED HASH of the raw identifier / IP
  // (lib/security/identifier-hash.ts, AUDIT R-3); the raw key stays on the
  // AuditLog trip row only. IN_APP ONLY: the two direct security-alert EMAILS
  // (SECURITY_ALERTS_EMAIL + the affected owner, when resolvable) are sent by
  // the orchestrator, NOT this channel — the registry's no-double-email
  // doctrine. suppress-while-open on the anomaly key means one bell per open
  // window per recipient, not one per failed attempt.
  SECURITY_ANOMALY_DETECTED: {
    ...PLATFORM,
    status: "WIRED" as const,
    locked: true,
    id: "SECURITY_ANOMALY_DETECTED",
    priority: "HIGH" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: false,
    dedupe: "suppress" as const,
    dedupeKeyTemplate: "SECURITY_ANOMALY_DETECTED:{anomalyKey}:open",
    icon: "shield-alert",
    pointerContract: ["anomalyKey", "title", "summary"],
    render: (d) => ({
      title: str(d, "title", "Security anomaly detected"),
      body:  str(d, "summary", "Unusual authentication activity was detected."),
      href:  "/dashboard/platform/SECURITY_OPS",
    }),
  },

  // ══ DIGEST — the digest is ITSELF a notification (F13): its email delivery
  //    writes NotificationDelivery rows like any other type, so OPS-5 never
  //    loses digest observability. EMAIL-only by default (no bell self-ping);
  //    its preference surface is the digest-frequency setting (S6), NOT the
  //    category × channel matrix. Folded items record metadata.digestedIn.
  DIGEST_SENT: {
    category: "DIGEST" as const,
    id: "DIGEST_SENT",
    priority: "LOW" as const,
    defaultChannels: ["EMAIL"] as const satisfies readonly NotificationChannel[],
    locked: false,
    retention: DEFAULT_RETENTION,
    digestable: false, // a digest never folds into a digest
    dedupe: "none" as const,
    dedupeKeyTemplate: null,
    icon: "newspaper",
    status: "VOCABULARY" as const,
    pointerContract: ["notificationIds", "periodStart", "periodEnd"],
    render: () => ({ title: "Your Fourth Meridian digest" }),
  },
} satisfies Record<string, NotificationTypeDefinition>;

// ── Derived vocabulary (F1: everything derives from the registry) ────────────

/**
 * Comms Center A-2b (owner decision O-8): the types that are locked although
 * their category is not. Their category's preference rows still exist for the
 * category's other types; resolveChannelEnabled ignores them for these.
 * registry.test.ts pins that every locked type outside ACCOUNT_SECURITY is
 * named here, so a per-type lock is always a deliberate, reviewed decision.
 */
export const PER_TYPE_LOCKED_TYPES = ["SECURITY_ANOMALY_DETECTED", "ACCOUNT_WELCOME"] as const;

/** The registry-derived id union — compile-time exhaustiveness everywhere. */
export type NotificationTypeId = keyof typeof NOTIFICATION_REGISTRY;

/** All ids, for iteration (tests, preference UI, digest job). */
export const NOTIFICATION_TYPE_IDS = Object.keys(
  NOTIFICATION_REGISTRY,
) as NotificationTypeId[];

/** True if a string names a registered notification type. */
export function isNotificationType(id: string): id is NotificationTypeId {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_REGISTRY, id);
}

/** Look up a definition (typed overload for known ids; undefined for unknown strings). */
export function getNotificationDefinition(
  id: string,
): NotificationTypeDefinition | undefined {
  return isNotificationType(id) ? NOTIFICATION_REGISTRY[id] : undefined;
}

/** The category vocabulary present in the registry, for preference-matrix rendering. */
export const NOTIFICATION_CATEGORIES: NotificationCategory[] = [
  ...new Set(Object.values(NOTIFICATION_REGISTRY).map((e) => e.category)),
];

/** Priority values, exported for S1's Prisma-enum parity check. */
export const NOTIFICATION_PRIORITIES: NotificationPriorityValue[] = [
  "LOW",
  "NORMAL",
  "HIGH",
  "CRITICAL",
];
