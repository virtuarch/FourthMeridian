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

// ── Shared policy values ──────────────────────────────────────────────────────

/** Default lifecycle: read rows auto-archive at 30 days; archived rows delete at 90 (F9). */
export const DEFAULT_RETENTION: RetentionPolicy = { autoArchiveDays: 30, deleteDays: 90 };

/** Render-data helper: string field with fallback, so render({}) is always safe. */
function str(data: NotificationRenderData, key: string, fallback: string): string {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/**
 * Shared per-category partials. locked/priority/channels are uniform per
 * category (the preference matrix is per category × channel — F11), so the
 * uniformity lives in one place and the tests can enforce it.
 */
const SECURITY = {
  category: "ACCOUNT_SECURITY" as const,
  priority: "CRITICAL" as const,
  // Locked categories keep email on — the OPS-2 security-alert guarantee (F11).
  defaultChannels: ["IN_APP", "EMAIL"] as const satisfies readonly NotificationChannel[],
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
    id: "ACCOUNT_REACTIVATED",
    icon: "user-check",
    pointerContract: [],
    render: () => ({ title: "Welcome back — your account was reactivated" }),
  },
  ACCOUNT_DELETION_REQUESTED: {
    ...SECURITY,
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
    id: "ACCOUNT_DELETION_CANCELLED",
    icon: "undo-2",
    pointerContract: [],
    render: () => ({ title: "Account deletion cancelled" }),
  },
  DATA_EXPORTED: {
    ...SECURITY,
    id: "DATA_EXPORTED",
    icon: "download",
    pointerContract: [],
    render: () => ({
      title: "Your data was exported",
      body: "A copy of your personal data was downloaded. If this wasn't you, secure your account.",
      href: "/dashboard/settings/security",
    }),
  },

  // ══ SPACES — NORMAL · mutable · producers: S1 (invite) then S5 Wave 2
  //    (EV-1 handlers on MemberInvited / MemberJoined / MemberRemoved /
  //    MemberRoleChanged).
  SPACE_INVITE_RECEIVED: {
    ...SPACES,
    // The one type that defaults to email too — it is the product's proto-
    // notification (SpaceInvite.seenAt + the OPS-1 S3 invite email).
    defaultChannels: ["IN_APP", "EMAIL"] as const satisfies readonly NotificationChannel[],
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
    id: "SYNC_FAILED",
    priority: "HIGH" as const,
    // Actionable (reconnect) → email on by default.
    defaultChannels: ["IN_APP", "EMAIL"] as const satisfies readonly NotificationChannel[],
    // suppress-while-open (F3): one live notification per broken item, however
    // many daily cron runs observe it; the ":open" suffix retires on a
    // successful sync so a NEW outage notifies again.
    dedupe: "suppress" as const,
    dedupeKeyTemplate: "SYNC_FAILED:item:{plaidItemId}:open",
    icon: "triangle-alert",
    pointerContract: ["plaidItemId", "institutionName"],
    render: (d) => ({
      title: `${str(d, "institutionName", "A connection")} needs attention`,
      body: "We couldn't sync this institution. Reconnect to resume updates.",
      href: "/dashboard/connections",
    }),
  },
  // VOCABULARY pending open decision D2 (S5 Wave-3 entry): recommendation is
  // to create NO rows for this type — /dashboard/connections already surfaces
  // sync state. Declared so the id is reserved either way; defaultChannels is
  // empty (off everywhere) per the baseline's noise ruling.
  SYNC_COMPLETED: {
    ...FINANCIAL,
    id: "SYNC_COMPLETED",
    priority: "LOW" as const,
    defaultChannels: [] as const satisfies readonly NotificationChannel[],
    dedupe: "none" as const,
    dedupeKeyTemplate: null,
    icon: "refresh-cw",
    pointerContract: ["plaidItemId", "institutionName"],
    render: (d) => ({
      title: `${str(d, "institutionName", "A connection")} synced`,
      href: "/dashboard/connections",
    }),
  },
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
      href: "/dashboard/advice",
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
  GOAL_RISK: {
    ...AI,
    id: "GOAL_RISK",
    priority: "HIGH" as const,
    defaultChannels: ["IN_APP"] as const satisfies readonly NotificationChannel[],
    digestable: false,
    // Condition identity: two producers (agent, job) observing the same
    // at-risk goal compute the same key — dedupe by design, no instance ids.
    dedupe: "suppress" as const,
    dedupeKeyTemplate: "GOAL_RISK:goal:{goalId}:open",
    icon: "target",
    pointerContract: ["goalId", "goalName", "agentId"],
    render: (d) => ({
      title: `${str(d, "goalName", "A goal")} is at risk`,
    }),
  },
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
