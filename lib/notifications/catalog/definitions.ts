/**
 * lib/notifications/catalog/definitions.ts  (Comms Center Phase A-1)
 *
 * THE unified notification catalog: one definition per message the platform
 * sends or shows (contract §2, §8). It EXTENDS the notification registry
 * instead of duplicating it:
 *
 *   - REGISTRY_CATALOG is keyed by NotificationTypeId and typed
 *     `{ [K in NotificationTypeId]: … }`, so a registry type with no catalog
 *     entry (or a catalog entry for a type that does not exist) is a COMPILE
 *     error. Category, severity (from priority), the IN_APP/EMAIL legs, the
 *     lock, retention and dedupe are DERIVED from NOTIFICATION_REGISTRY; only
 *     what the registry does not know (display name, description, audience,
 *     consent class, typed payload, trigger, direct email legs) is authored here.
 *   - STANDALONE_CATALOG is keyed by the closed STANDALONE_KEYS tuple
 *     (`Record<StandaloneKey, …>`, same compile-time exhaustiveness) and holds
 *     the direct-send messages, read-only banners and the BUILD / PROPOSED /
 *     NONE_BY_DESIGN keys.
 *
 * DESCRIPTIVE ONLY. Nothing here is read by createNotification, sendEmail,
 * the preference layer or any job: channels, defaults, dedupe and preferences
 * behave exactly as before. `userSuppressible` states what the CURRENT code
 * does (resolveChannelEnabled + the settings surface), not what the contract
 * would like it to do — the known gap is pinned in KNOWN_SUPPRESSIBILITY_GAPS.
 *
 * Pure config — no DB, no I/O.
 */

import {
  NOTIFICATION_REGISTRY,
  NOTIFICATION_TYPE_IDS,
  type NotificationTypeId,
} from "@/lib/notifications/registry";
import type {
  NotificationCategory,
  NotificationPriorityValue,
  NotificationTypeDefinition,
} from "@/lib/notifications/types";
import type { EmailTemplateName } from "@/lib/email/types";
import type {
  Audience,
  CatalogCategory,
  ChannelLeg,
  CommsChannel,
  CommsDefinition,
  ConsentClass,
  DefinitionStatus,
  EligibilityPredicate,
  OwnerArea,
  PayloadField,
  SecurityAlertBuilder,
  Severity,
  SupportedAction,
  TriggerKey,
} from "@/lib/notifications/catalog/types";

// ── Versions ──────────────────────────────────────────────────────────────────

/**
 * §2.2 — template versions. There was no template version anywhere before
 * (AUDIT §1.2), so every template starts at 1. Bump on any change to rendered
 * copy, layout or CTA. Exhaustive over EmailTemplateName.
 */
export const EMAIL_TEMPLATE_VERSIONS: Record<EmailTemplateName, number> = {
  smoke: 1,
  "password-reset": 1,
  "email-verification": 1,
  "space-invite": 1,
  "security-alert": 1,
  "email-change": 1,
  notification: 1,
  "beta-invite": 1,
  "beta-request": 1,
  "platform-alert": 1,
};
/** The registry render is the IN_APP template; one version for all of them at v1. */
export const IN_APP_TEMPLATE_VERSION = 1;
/** The client notice copy (components/notices/notice-model.ts) is the BANNER template. */
export const BANNER_TEMPLATE_VERSION = 1;

/** §2 — registry priority → catalog severity. */
export const PRIORITY_SEVERITY: Record<NotificationPriorityValue, Severity> = {
  LOW: "info",
  NORMAL: "notice",
  HIGH: "warning",
  CRITICAL: "critical",
};

/**
 * The preference categories the settings surface lets a user change
 * (lib/notifications/preferences.ts PREFERENCE_CATEGORIES: every registry
 * category except DIGEST). Mirrored, not imported, so this module stays free
 * of the DB client; catalog.test.ts asserts the two lists are identical.
 */
export const MATRIX_CATEGORIES: readonly NotificationCategory[] = [
  ...new Set(Object.values(NOTIFICATION_REGISTRY).map((e) => e.category)),
].filter((c) => c !== "DIGEST");

/** Email template that no production caller sends (lib/email/catalog.test.ts, EMAIL-CATALOG §3). */
export const NON_CATALOG_TEMPLATES: Partial<Record<EmailTemplateName, string>> = {
  smoke: "pipeline check only: no production caller, not a message to anyone",
};

/**
 * Known gaps between the contract's consent rules and today's behaviour.
 * Reported, NOT fixed (Phase A-1 changes no behaviour). Tests pin this list
 * so it can only shrink.
 *   SECURITY_ANOMALY_DETECTED — AUDIT R-2 / OWNER DECISION O-8: the Security Ops
 *     bell sits in the UNLOCKED PLATFORM category, so a staff recipient can turn
 *     it off (PLATFORM IN_APP off ⇒ createNotification returns skipped).
 */
export const KNOWN_SUPPRESSIBILITY_GAPS: Readonly<Record<string, string>> = {
  SECURITY_ANOMALY_DETECTED: "AUDIT R-2 / O-8: unlocked PLATFORM category; staff can mute the security bell",
};

/**
 * Known dedupe templates that embed a PII payload field (contract §2
 * invariant; AUDIT R-3 / O-8). Pinned so no NEW definition can add one.
 */
export const KNOWN_PII_DEDUPE_KEYS: Readonly<Record<string, string>> = {
  SECURITY_ANOMALY_DETECTED: "AUDIT R-3 / O-8: anomalyKey carries the raw login identifier or IP",
};

// ── Owner surfaces ────────────────────────────────────────────────────────────

const OWNER = {
  platformAlerts: { area: "PLATFORM_OPS", href: "/dashboard/platform/PLATFORM_OPS?workspace=platform-policies&view=alerts" },
  platformEmergency: { area: "PLATFORM_OPS", href: "/dashboard/platform/PLATFORM_OPS?workspace=platform-policies&view=emergency" },
  growth: { area: "GROWTH_REVENUE", href: "/dashboard/platform/GROWTH_REVENUE" },
  securityOps: { area: "SECURITY_OPS", href: "/dashboard/platform/SECURITY_OPS" },
} as const satisfies Record<string, { area: OwnerArea; href: string }>;

// ── Authoring helpers ─────────────────────────────────────────────────────────

type FieldSpec = Omit<PayloadField, "name">;
const ptr = (type: PayloadField["type"] = "string", pii = false): FieldSpec => ({ kind: "POINTER", type, required: true, pii });
const disp = (type: PayloadField["type"] = "string", pii = false, required = true): FieldSpec => ({ kind: "DISPLAY", type, required, pii });
const link = (): FieldSpec => ({ kind: "LINK", type: "string", required: true, pii: false });
const fields = (spec: Record<string, FieldSpec>): PayloadField[] => Object.entries(spec).map(([name, f]) => ({ name, ...f }));

/** A direct security-alert email leg (sendEmail("security-alert", …) outside the registry). */
function securityEmail(builder: SecurityAlertBuilder, slug: string): ChannelLeg {
  return {
    channel: "EMAIL",
    defaultOn: true,
    template: { id: "security-alert", version: EMAIL_TEMPLATE_VERSIONS["security-alert"] },
    path: "DIRECT",
    email: { template: "security-alert", builder },
    previewSlugs: [`security-alert--${slug}`],
  };
}

/** A direct (non-security-alert) email leg. */
function directEmail(template: EmailTemplateName, previewSlugs: readonly string[], channel: "EMAIL" | "OPERATOR_EMAIL" = "EMAIL", builder?: SecurityAlertBuilder): ChannelLeg {
  return {
    channel,
    defaultOn: true,
    template: { id: template, version: EMAIL_TEMPLATE_VERSIONS[template] },
    path: "DIRECT",
    email: builder ? { template, builder } : { template },
    previewSlugs,
  };
}

/** A read-only banner (client notice copy; the writer lives in Platform Ops). */
function banner(id: string): ChannelLeg {
  return { channel: "BANNER", defaultOn: true, template: { id, version: BANNER_TEMPLATE_VERSION }, path: "READ_ONLY_SURFACE" };
}

/** A planned leg of a BUILD / PROPOSED definition: nothing delivers it yet, no template exists. */
function planned(channel: CommsChannel, defaultOn = true): ChannelLeg {
  return { channel, defaultOn, template: null, path: channel === "BANNER" ? "READ_ONLY_SURFACE" : "REGISTRY" };
}

// ── Layer 1: the registry types (one entry per NotificationTypeId) ────────────

interface RegistryCatalogMeta {
  displayName: string;
  description: string;
  audience: Audience;
  consentClass: ConsentClass;
  /** Override of the derived status (WIRED→ENABLED, VOCABULARY→VOCABULARY), per contract §8. */
  status?: DefinitionStatus;
  /** Typed payload, keyed by the registry pointerContract (catalog.test.ts asserts the key sets match). */
  payload: Record<string, FieldSpec>;
  trigger: { kind: "TRIGGER" | "CALL_SITE"; triggerKey: TriggerKey | null; sources: readonly string[] };
  /** Direct email legs that accompany this type today (security-alert, the duplicate Space invite). */
  directLegs?: readonly ChannelLeg[];
  /** Preview slugs (lib/email/preview.ts) for the registry EMAIL leg, when one exists. */
  registryEmailPreviewSlugs?: readonly string[];
  eligibility?: readonly EligibilityPredicate[];
  ownerSurface?: { area: OwnerArea; href: string } | null;
}

const ACCT = { audience: "ACCOUNT_HOLDER", consentClass: "SECURITY_CRITICAL" } as const;
const VOCAB_TRIGGER = { kind: "CALL_SITE", triggerKey: null, sources: [] } as const;
const site = (...sources: string[]) => ({ kind: "CALL_SITE" as const, triggerKey: null, sources });
const event = (triggerKey: TriggerKey, ...sources: string[]) => ({ kind: "TRIGGER" as const, triggerKey, sources });

export const REGISTRY_CATALOG: { readonly [K in NotificationTypeId]: RegistryCatalogMeta } = {
  // ══ ACCOUNT_SECURITY — locked; the email legs are the direct security-alert sends.
  PASSWORD_CHANGED: {
    ...ACCT, displayName: "Password changed",
    description: "Sent when a signed-in user changes their password: an in-app notice plus a security-alert email.",
    payload: {}, trigger: site("app/api/user/password/route.ts"),
    directLegs: [securityEmail("passwordChangedAlert", "password-changed")],
  },
  PASSWORD_RESET: {
    ...ACCT, displayName: "Password reset completed",
    description: "Sent after a password-reset link is redeemed: an in-app notice plus a security-alert email.",
    payload: {}, trigger: site("app/api/auth/reset-password/route.ts"),
    directLegs: [securityEmail("passwordResetCompletedAlert", "password-reset-completed")],
  },
  EMAIL_CHANGE_REQUESTED: {
    ...ACCT, displayName: "Email change requested",
    description: "Sent when an email change is requested: an in-app notice plus a security-alert email to the current (old) address.",
    payload: { pendingEmail: disp("string", true) }, trigger: site("app/api/user/email/request/route.ts"),
    directLegs: [securityEmail("emailChangeRequestedAlert", "email-change-old-address")],
  },
  EMAIL_CHANGE_COMPLETED: {
    ...ACCT, displayName: "Email address changed",
    description: "In-app notice after an email change is confirmed from the new address; every session is signed out.",
    payload: {}, trigger: site("app/api/user/email/confirm/route.ts"),
  },
  EMAIL_VERIFIED: {
    ...ACCT, displayName: "Email address verified",
    description: "Declared only: no producer emits it.", payload: {}, trigger: VOCAB_TRIGGER,
  },
  TWO_FACTOR_ENABLED: {
    ...ACCT, displayName: "Two-factor authentication enabled",
    description: "In-app notice when a user turns on two-factor authentication. No email.",
    payload: {}, trigger: site("app/api/user/totp/verify/route.ts"),
  },
  TWO_FACTOR_DISABLED: {
    ...ACCT, displayName: "Two-factor authentication disabled",
    description: "In-app notice when a user turns off two-factor authentication. No email.",
    payload: {}, trigger: site("app/api/user/totp/disable/route.ts"),
  },
  TWO_FACTOR_RESET: {
    ...ACCT, displayName: "Two-factor authentication reset (in-app)",
    description: "Declared only: the admin 2FA reset sends an email (TWO_FACTOR_RESET_BY_ADMIN) but no in-app notice.",
    payload: {}, trigger: VOCAB_TRIGGER,
  },
  RECOVERY_CODE_USED: {
    ...ACCT, displayName: "Recovery code used",
    description: "Declared only: no producer emits it.", payload: {}, trigger: VOCAB_TRIGGER,
  },
  RECOVERY_CODES_REGENERATED: {
    ...ACCT, displayName: "Recovery codes regenerated",
    description: "Declared only: no producer emits it.", payload: {}, trigger: VOCAB_TRIGGER,
  },
  SESSION_REVOKED: {
    ...ACCT, displayName: "Session signed out",
    description: "In-app notice when a user signs out one of their other sessions. No email.",
    payload: { device: disp() }, trigger: site("app/api/user/sessions/[sessionId]/route.ts"),
  },
  ACCOUNT_DEACTIVATED: {
    ...ACCT, displayName: "Account deactivated",
    description: "Sent when a user deactivates their account: an in-app notice plus a security-alert email.",
    payload: {}, trigger: site("app/api/user/deactivate/route.ts"),
    directLegs: [securityEmail("accountDeactivatedAlert", "account-deactivated")],
  },
  ACCOUNT_REACTIVATED: {
    ...ACCT, displayName: "Account reactivated",
    description: "Sent when signing in reactivates a deactivated account: an in-app notice plus a security-alert email.",
    payload: {}, trigger: site("lib/auth.ts"),
    directLegs: [securityEmail("accountReactivatedAlert", "account-reactivated")],
  },
  ACCOUNT_DELETION_REQUESTED: {
    ...ACCT, displayName: "Account deletion scheduled",
    description: "Sent when a user schedules account deletion: an in-app notice plus a security-alert email naming the date.",
    payload: { scheduledFor: disp("iso-date") }, trigger: site("app/api/user/delete/route.ts"),
    directLegs: [securityEmail("accountDeletionScheduledAlert", "account-deletion-scheduled")],
  },
  ACCOUNT_DELETION_CANCELLED: {
    ...ACCT, displayName: "Account deletion cancelled",
    description: "Sent when signing in cancels a scheduled deletion: an in-app notice plus a security-alert email.",
    payload: {}, trigger: site("lib/auth.ts"),
    directLegs: [securityEmail("accountDeletionCancelledAlert", "account-deletion-cancelled")],
  },
  DATA_EXPORTED: {
    ...ACCT, displayName: "Data exported",
    description: "Sent when a user exports their data: an in-app notice plus a security-alert email that carries none of the data.",
    payload: {}, trigger: site("app/api/user/export/route.ts"),
    directLegs: [securityEmail("dataExportedAlert", "data-exported")],
  },

  // ══ SPACES — unlocked; the user's SPACES × channel preference applies to the registry legs.
  SPACE_INVITE_RECEIVED: {
    audience: "SPACE_MEMBER", consentClass: "AWARENESS", displayName: "Space invitation received",
    description:
      "Sent to an existing user invited to a Space. Today the invitee gets TWO emails: the direct space-invite email " +
      "and the registry notification email (AUDIT D-1, OWNER DECISION O-6).",
    payload: { inviteId: ptr(), spaceName: disp(), inviterName: disp("string", true) },
    trigger: event("space.member.invited", "lib/events/handlers/space-invite-notification.ts", "app/api/spaces/[id]/invite/route.ts"),
    directLegs: [directEmail("space-invite", ["space-invite"])],
    registryEmailPreviewSlugs: ["notification--space-invite-received"],
  },
  SPACE_INVITE_ACCEPTED: {
    audience: "SPACE_MEMBER", consentClass: "AWARENESS", displayName: "Space invitation accepted",
    description: "In-app notice to the inviter when an invitee joins the Space.",
    payload: { inviteId: ptr(), spaceName: disp(), memberName: disp("string", true) },
    trigger: event("space.member.joined", "lib/events/handlers/space-member-notifications.ts"),
  },
  MEMBER_REMOVED: {
    audience: "SPACE_MEMBER", consentClass: "AWARENESS", displayName: "Removed from a Space",
    description: "In-app notice to a member removed from a Space by an owner or admin.",
    payload: { spaceName: disp() },
    trigger: event("space.member.removed", "lib/events/handlers/space-member-notifications.ts"),
  },
  MEMBER_ROLE_CHANGED: {
    audience: "SPACE_MEMBER", consentClass: "AWARENESS", displayName: "Space role changed",
    description: "In-app notice to a member whose role in a Space changed.",
    payload: { spaceName: disp(), oldRole: disp(), newRole: disp() },
    trigger: event("space.member.role_changed", "lib/events/handlers/space-member-notifications.ts"),
  },
  SPACE_OWNERSHIP_TRANSFERRED: {
    audience: "SPACE_MEMBER", consentClass: "AWARENESS", displayName: "Space ownership transferred",
    description: "Declared only: the ownership-transfer feature does not exist.",
    payload: { spaceName: disp(), previousOwnerName: disp("string", true) }, trigger: VOCAB_TRIGGER,
  },

  // ══ FINANCIAL
  SYNC_FAILED: {
    audience: "ACCOUNT_HOLDER", consentClass: "SERVICE", displayName: "Institution needs attention",
    description:
      "Sent when a bank sync fails with a health-classified error: in-app plus email, one live notice per item until it " +
      "recovers. Suppressed when the user removed the connection themselves.",
    payload: { plaidItemId: ptr(), institutionName: disp(), connectionState: disp() },
    trigger: event("plaid.item.sync_failed", "lib/plaid/sync-notifications.ts"),
    eligibility: ["connection.removed_by_user"],
    registryEmailPreviewSlugs: [
      "notification--connection-sync-failed",
      "notification--connection-reauth-required",
      "notification--connection-disconnected",
      "notification--connection-legacy-no-state",
    ],
  },
  SYNC_COMPLETED: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "Connection history ready",
    description: "In-app notice when the full deferred history pipeline finishes for a connection.",
    payload: { plaidItemId: ptr(), institutionName: disp() },
    trigger: event("plaid.item.history_ready", "lib/plaid/sync-notifications.ts"),
  },
  DUPLICATE_DETECTED: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "Possible duplicate accounts",
    description: "Declared only: no human-review duplicate flow exists, so nothing produces it.",
    payload: { candidateIds: ptr("string[]"), count: disp("number") }, trigger: VOCAB_TRIGGER,
  },
  IMPORT_COMPLETED: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "Import completed",
    description: "In-app notice when a CSV import batch completes.",
    payload: { batchId: ptr(), rowCount: disp("number") },
    trigger: event("import.batch.completed", "app/api/accounts/[id]/import/route.ts"),
  },
  IMPORT_COMPLETED_WITH_ERRORS: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "Import completed with errors",
    description: "In-app notice when a CSV import batch completes with rows that could not be imported.",
    payload: { batchId: ptr(), errorCount: disp("number") },
    trigger: event("import.batch.completed", "app/api/accounts/[id]/import/route.ts"),
  },

  // ══ AI — all declared only.
  DAILY_BRIEF_READY: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "Daily Brief ready",
    description: "Declared only: no producer emits it.", payload: {}, trigger: VOCAB_TRIGGER,
  },
  OPPORTUNITY_FOUND: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "Opportunity found",
    description: "Declared only: no producer emits it.", payload: { adviceId: ptr(), agentId: ptr() }, trigger: VOCAB_TRIGGER,
  },
  UNUSUAL_SPENDING: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "Unusual spending",
    description: "Declared only: no producer emits it.", payload: { transactionIds: ptr("string[]"), agentId: ptr() }, trigger: VOCAB_TRIGGER,
  },
  DEBT_ALERT: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "Debt needs attention",
    description: "Declared only: no producer emits it.", payload: { financialAccountId: ptr(), agentId: ptr() }, trigger: VOCAB_TRIGGER,
  },

  // ══ PLATFORM
  MAINTENANCE_SCHEDULED: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", status: "PROPOSED", displayName: "Scheduled maintenance",
    description: "Proposed broadcast announcing a maintenance window. Not in v1: a broadcast to many recipients needs CONTROL (O-2).",
    payload: { window: disp() }, trigger: { kind: "TRIGGER", triggerKey: "platform.maintenance.scheduled", sources: [] },
  },
  FEATURE_RELEASED: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "New feature released",
    description: "Declared only: no broadcast producer exists.", payload: { featureName: disp() }, trigger: VOCAB_TRIGGER,
  },
  POLICY_UPDATED: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", displayName: "Policy updated",
    description: "Declared only: no broadcast producer exists.", payload: { policyName: disp() }, trigger: VOCAB_TRIGGER,
  },
  SECURITY_ANOMALY_DETECTED: {
    audience: "PLATFORM_STAFF", consentClass: "OPERATOR", displayName: "Security anomaly (staff bell)",
    description:
      "In-app bell to every ACTIVE Security Ops grant holder and SYSTEM_ADMIN when an authentication anomaly is detected. " +
      "Today it sits in the unlocked PLATFORM category, so a recipient can mute it (AUDIT R-2, O-8).",
    payload: { anomalyKey: ptr("string", true), title: disp(), summary: disp() },
    trigger: site("lib/security/anomaly-alerts.ts"),
    ownerSurface: OWNER.securityOps,
  },

  // ══ DIGEST
  DIGEST_SENT: {
    audience: "ACCOUNT_HOLDER", consentClass: "AWARENESS", status: "BUILD_OFF", displayName: "Notification digest",
    description: "To be built but shipped disabled, pending the owner's digest proposal (O-14). No producer today.",
    payload: { notificationIds: ptr("string[]"), periodStart: disp("iso-date"), periodEnd: disp("iso-date") },
    trigger: { kind: "TRIGGER", triggerKey: "schedule.daily", sources: [] },
  },
};

// ── Layer 2: messages with no registry entry ──────────────────────────────────

export const STANDALONE_KEYS = [
  // Ceremony (direct sends)
  "PASSWORD_RESET_LINK_SENT", "EMAIL_VERIFICATION_SENT", "EMAIL_CHANGE_CONFIRMATION_SENT",
  // Security alerts with no registry pair
  "TWO_FACTOR_RESET_BY_ADMIN", "ACCOUNT_DELETED", "SIGN_IN_ANOMALY_OWNER",
  // Beta
  "BETA_INVITATION_ISSUED",
  // Operator
  "BETA_REQUEST_RECEIVED", "PLATFORM_ALERT", "SECURITY_ANOMALY_INBOX",
  // Banners (read-only)
  "MAINTENANCE_NOTICE", "TWO_FACTOR_REMINDER", "CONNECT_INVITATION",
  // BUILD (owner-approved, not wired)
  "PLAID_ITEM_REAUTH_REQUIRED", "PLAID_ITEM_REVOKED", "WALLET_SYNC_FAILED", "ACCOUNT_WELCOME", "PLATFORM_ACCESS_GRANTED",
  // PROPOSED (never send)
  "BETA_INVITATION_EXPIRING", "BETA_PROGRAM_STATUS_CHANGED", "WALLET_IMPORT_COMPLETED", "PROVIDER_INCIDENT_NOTICE",
  // NONE_BY_DESIGN
  "BETA_REQUEST_DENIED",
] as const;
export type StandaloneKey = (typeof STANDALONE_KEYS)[number];

/** Compile-time: a standalone key may never shadow a registry id. */
type _NoOverlap = Extract<StandaloneKey, NotificationTypeId> extends never ? true : never;
const _noOverlap: _NoOverlap = true;
void _noOverlap;

export type CatalogKey = NotificationTypeId | StandaloneKey;

interface StandaloneSpec {
  displayName: string;
  description: string;
  status: DefinitionStatus;
  category: CatalogCategory;
  audience: Audience;
  consentClass: ConsentClass;
  severity: Severity;
  channels: readonly ChannelLeg[];
  payload: Record<string, FieldSpec>;
  trigger: { kind: "TRIGGER" | "CALL_SITE"; triggerKey: TriggerKey | null; sources: readonly string[] };
  eligibility?: readonly EligibilityPredicate[];
  /** For BUILD / PROPOSED definitions that will reach a user preference; omitted ⇒ not suppressible. */
  preference?: CommsDefinition["preference"];
  dedupe?: CommsDefinition["dedupe"];
  frequencyCap?: CommsDefinition["frequencyCap"];
  ownerSurface?: { area: OwnerArea; href: string } | null;
}

const NOT_SUPPRESSIBLE: CommsDefinition["preference"] = { category: null, userSuppressible: false, suppressibleChannels: [] };

const BETA_INVITE_SLUGS = (["request", "direct"] as const).flatMap((origin) =>
  [1, 7, 14, 30].flatMap((d) => (["unnamed", "named"] as const).map((n) => `beta-invite--${origin}--${n}--${d}d`)),
);

export const STANDALONE_CATALOG: Record<StandaloneKey, StandaloneSpec> = {
  // ── Ceremony: part of a flow the user started; never suppressible.
  PASSWORD_RESET_LINK_SENT: {
    displayName: "Password reset link", status: "ENABLED", category: "CEREMONY", audience: "ACCOUNT_HOLDER",
    consentClass: "CEREMONY", severity: "notice",
    description: "The single-use password-reset link, sent when a user asks to reset their password (1 h validity).",
    channels: [directEmail("password-reset", ["password-reset"])],
    payload: { resetUrl: link() }, trigger: site("app/api/auth/forgot-password/route.ts"),
  },
  EMAIL_VERIFICATION_SENT: {
    displayName: "Email verification link", status: "ENABLED", category: "CEREMONY", audience: "ACCOUNT_HOLDER",
    consentClass: "CEREMONY", severity: "notice",
    description: "The email-verification link, sent on uninvited registration and on a resend request (1 h validity).",
    channels: [directEmail("email-verification", ["email-verification"])],
    payload: { verifyUrl: link() }, trigger: site("app/api/auth/register/route.ts", "lib/email/verification.ts"),
  },
  EMAIL_CHANGE_CONFIRMATION_SENT: {
    displayName: "Email change confirmation link", status: "ENABLED", category: "CEREMONY", audience: "ACCOUNT_HOLDER",
    consentClass: "CEREMONY", severity: "notice",
    description: "The confirmation link sent to the NEW address when a user requests an email change (1 h validity).",
    channels: [directEmail("email-change", ["email-change--confirm-new-address"])],
    payload: { confirmUrl: link() }, trigger: site("app/api/user/email/request/route.ts"),
  },

  // ── Security alerts with no in-app pair.
  TWO_FACTOR_RESET_BY_ADMIN: {
    displayName: "Two-factor reset by an administrator", status: "ENABLED", category: "ACCOUNT_SECURITY",
    audience: "ACCOUNT_HOLDER", consentClass: "SECURITY_CRITICAL", severity: "critical",
    description: "Security-alert email to a user whose two-factor authentication an administrator reset. No in-app notice.",
    channels: [securityEmail("twoFactorResetAlert", "two-factor-reset")],
    payload: {}, trigger: site("app/api/admin/security/users/[userId]/2fa-reset/route.ts"),
  },
  ACCOUNT_DELETED: {
    displayName: "Account deleted", status: "ENABLED", category: "ACCOUNT_SECURITY",
    audience: "ACCOUNT_HOLDER", consentClass: "SECURITY_CRITICAL", severity: "critical",
    description: "The final security-alert email after an account is purged. No in-app notice: the user row no longer exists.",
    channels: [securityEmail("accountDeletedAlert", "account-deleted")],
    payload: {}, trigger: site("lib/account-deletion/purge.ts"),
  },
  SIGN_IN_ANOMALY_OWNER: {
    displayName: "Unusual sign-in activity (account owner)", status: "ENABLED", category: "ACCOUNT_SECURITY",
    audience: "ACCOUNT_HOLDER", consentClass: "SECURITY_CRITICAL", severity: "critical",
    description: "Security-alert email to the resolved owner of an account with a burst of failed sign-ins. Email only.",
    channels: [securityEmail("ownerSignInAnomalyAlert", "owner-sign-in-anomaly")],
    payload: {}, trigger: site("lib/security/anomaly-alerts.ts"),
  },

  // ── Beta.
  BETA_INVITATION_ISSUED: {
    displayName: "Beta invitation", status: "ENABLED", category: "CEREMONY", audience: "APPLICANT",
    consentClass: "CEREMONY", severity: "notice",
    description: "The beta invitation with its single-use registration link, from an approved request or a direct invite. Managed in Growth.",
    channels: [directEmail("beta-invite", BETA_INVITE_SLUGS)],
    payload: { inviteUrl: link(), issuedAt: disp("iso-date"), expiresAt: disp("iso-date"), origin: disp() },
    trigger: site("lib/platform/growth/invitation-issue.ts"),
    ownerSurface: OWNER.growth,
  },

  // ── Operator: env-named inboxes; governed by configuration, not customer preferences.
  BETA_REQUEST_RECEIVED: {
    displayName: "Beta request received (operator inbox)", status: "ENABLED", category: "OPERATOR", audience: "OPERATOR_INBOX",
    consentClass: "OPERATOR", severity: "info",
    description: "Email to the beta-requests inbox on every beta access request. Skipped when that inbox is not configured.",
    channels: [directEmail("beta-request", ["beta-request--with-note", "beta-request--no-note"], "OPERATOR_EMAIL")],
    payload: { applicantEmail: disp("string", true), note: disp("string", true, false), queueUrl: link() },
    trigger: site("app/api/access-request/route.ts"),
    ownerSurface: OWNER.growth,
  },
  PLATFORM_ALERT: {
    displayName: "Platform alert (operator inbox)", status: "ENABLED", category: "OPERATOR", audience: "OPERATOR_INBOX",
    consentClass: "OPERATOR", severity: "warning",
    description: "One email to the platform-alerts inbox per alert evaluation that fires. Rules and muting live in Platform Ops.",
    channels: [directEmail("platform-alert", ["platform-alert"], "OPERATOR_EMAIL")],
    payload: { evaluatedAtISO: disp("iso-date"), alerts: disp("string[]") },
    trigger: site("lib/alerts/run.ts"),
    ownerSurface: OWNER.platformAlerts,
  },
  SECURITY_ANOMALY_INBOX: {
    displayName: "Security anomaly (Security Ops inbox)", status: "ENABLED", category: "OPERATOR", audience: "OPERATOR_INBOX",
    consentClass: "OPERATOR", severity: "critical",
    description: "Internal security-alert email to the Security Ops inbox when an authentication anomaly is detected. The identifier is withheld.",
    channels: [directEmail("security-alert", ["security-alert--security-ops-anomaly"], "OPERATOR_EMAIL", "securityOpsAnomalyAlert")],
    payload: { title: disp(), message: disp(), count: disp("number"), windowMinutes: disp("number"), threshold: disp("number") },
    trigger: site("lib/security/anomaly-alerts.ts"),
    ownerSurface: OWNER.securityOps,
  },

  // ── Banners: read-only here; the writer is Platform Ops.
  MAINTENANCE_NOTICE: {
    displayName: "Maintenance banner", status: "ENABLED", category: "PLATFORM", audience: "ACCOUNT_HOLDER",
    consentClass: "SERVICE", severity: "warning",
    description: "The in-app banner shown while maintenance mode is on. Collapsible, never dismissible. Switched on in Platform Ops (CONTROL).",
    channels: [banner("notice:maintenance")],
    payload: {}, trigger: site("lib/platform/notices/maintenance-notice.ts", "components/notices/notice-model.ts"),
    ownerSurface: OWNER.platformEmergency,
  },
  TWO_FACTOR_REMINDER: {
    displayName: "Two-factor reminder banner", status: "ENABLED", category: "ACCOUNT_SECURITY", audience: "ACCOUNT_HOLDER",
    consentClass: "SERVICE", severity: "info",
    description: "The in-app banner asking a user without two-factor authentication to enable it. Dismissible for the browser session.",
    channels: [banner("notice:two-factor")],
    // Derived per user from their 2FA state: there is no operator writer to link to.
    payload: {}, trigger: site("lib/platform/notices/app-notice-status.ts", "components/notices/notice-model.ts"),
  },
  CONNECT_INVITATION: {
    displayName: "Add-your-first-account banner", status: "ENABLED", category: "FINANCIAL", audience: "ACCOUNT_HOLDER",
    consentClass: "SERVICE", severity: "info",
    description: "The in-app banner inviting a user with no live source to connect an account. Dismissal persists.",
    channels: [banner("notice:connect")],
    // Derived per user from their connections: there is no operator writer to link to.
    payload: {}, trigger: site("lib/platform/notices/app-notice-status.ts", "components/notices/notice-model.ts"),
  },

  // ── BUILD: owner-approved, not wired. Nothing sends these.
  PLAID_ITEM_REAUTH_REQUIRED: {
    displayName: "Institution needs sign-in (webhook)", status: "BUILD", category: "FINANCIAL", audience: "ACCOUNT_HOLDER",
    consentClass: "SERVICE", severity: "warning",
    description: "Planned: notify when the Plaid webhook moves an item to NEEDS_REAUTH. Shares the SYNC_FAILED open key so the cron and the webhook never double-notify.",
    channels: [planned("IN_APP"), planned("EMAIL")],
    payload: { plaidItemId: ptr(), institutionName: disp() },
    trigger: { kind: "TRIGGER", triggerKey: "plaid.item.webhook_needs_reauth", sources: [] },
    eligibility: ["connection.removed_by_user"],
    preference: { category: "FINANCIAL", userSuppressible: true, suppressibleChannels: ["EMAIL"] },
    dedupe: { strategy: "suppress", keyTemplate: "SYNC_FAILED:item:{plaidItemId}:open", windowMinutes: null },
  },
  PLAID_ITEM_REVOKED: {
    displayName: "Institution disconnected (webhook)", status: "BUILD", category: "FINANCIAL", audience: "ACCOUNT_HOLDER",
    consentClass: "SERVICE", severity: "warning",
    description: "Planned: notify when the Plaid webhook reports a provider-side revocation. Honours the removed-by-user suppression.",
    channels: [planned("IN_APP"), planned("EMAIL")],
    payload: { plaidItemId: ptr(), institutionName: disp() },
    trigger: { kind: "TRIGGER", triggerKey: "plaid.item.webhook_revoked", sources: [] },
    eligibility: ["connection.removed_by_user"],
    preference: { category: "FINANCIAL", userSuppressible: true, suppressibleChannels: ["EMAIL"] },
    dedupe: { strategy: "suppress", keyTemplate: "PLAID_ITEM_REVOKED:item:{plaidItemId}:open", windowMinutes: null },
  },
  WALLET_SYNC_FAILED: {
    displayName: "Wallet sync failed", status: "BUILD", category: "FINANCIAL", audience: "ACCOUNT_HOLDER",
    consentClass: "SERVICE", severity: "warning",
    description: "Planned: notify when a wallet sync fails (today only a SyncIssue row is written). Email per O-7.",
    channels: [planned("IN_APP"), planned("EMAIL", false)],
    payload: { financialAccountId: ptr(), network: disp() },
    trigger: { kind: "TRIGGER", triggerKey: "wallet.sync.failed", sources: [] },
    preference: { category: "FINANCIAL", userSuppressible: true, suppressibleChannels: ["EMAIL"] },
    dedupe: { strategy: "suppress", keyTemplate: "WALLET_SYNC_FAILED:account:{financialAccountId}:open", windowMinutes: null },
  },
  ACCOUNT_WELCOME: {
    displayName: "Welcome email", status: "BUILD", category: "PLATFORM", audience: "ACCOUNT_HOLDER",
    consentClass: "AWARENESS", severity: "info",
    description: "Planned: a one-time welcome email after registration (consent class pending O-5).",
    channels: [planned("EMAIL")],
    payload: {},
    trigger: { kind: "TRIGGER", triggerKey: "account.registered", sources: [] },
    preference: { category: "PLATFORM", userSuppressible: true, suppressibleChannels: ["EMAIL"] },
    dedupe: { strategy: "suppress", keyTemplate: "ACCOUNT_WELCOME:user:{userId}", windowMinutes: null },
  },
  PLATFORM_ACCESS_GRANTED: {
    displayName: "Platform access granted", status: "BUILD", category: "ACCOUNT_SECURITY", audience: "ACCOUNT_HOLDER",
    consentClass: "SECURITY_CRITICAL", severity: "critical",
    description: "Planned: tell the grantee when a Platform grant is created or reinstated (a privilege change).",
    channels: [planned("IN_APP"), planned("EMAIL")],
    payload: { area: disp(), level: disp() },
    trigger: { kind: "TRIGGER", triggerKey: "platform.grant.created", sources: [] },
  },

  // ── PROPOSED: candidates; not approved; never send.
  BETA_INVITATION_EXPIRING: {
    displayName: "Beta invitation expiring", status: "PROPOSED", category: "PLATFORM", audience: "APPLICANT",
    consentClass: "SERVICE", severity: "info",
    description: "Proposed: remind an applicant that their beta invitation is about to expire.",
    channels: [planned("EMAIL")], payload: { expiresAt: disp("iso-date") },
    trigger: { kind: "TRIGGER", triggerKey: "beta.invitation.expiring", sources: [] },
    ownerSurface: OWNER.growth,
  },
  BETA_PROGRAM_STATUS_CHANGED: {
    displayName: "Beta program status changed", status: "PROPOSED", category: "PLATFORM", audience: "ACCOUNT_HOLDER",
    consentClass: "SERVICE", severity: "notice",
    description: "Proposed: tell beta users the program was paused or ended. Many recipients, so CONTROL (O-2).",
    channels: [planned("IN_APP"), planned("EMAIL")], payload: { status: disp() },
    trigger: { kind: "TRIGGER", triggerKey: "beta.program.status_changed", sources: [] },
  },
  WALLET_IMPORT_COMPLETED: {
    displayName: "Wallet import completed", status: "PROPOSED", category: "FINANCIAL", audience: "ACCOUNT_HOLDER",
    consentClass: "AWARENESS", severity: "info",
    description: "Proposed: in-app notice when a crypto wallet import completes.",
    channels: [planned("IN_APP")], payload: { financialAccountId: ptr(), network: disp() },
    trigger: { kind: "TRIGGER", triggerKey: "wallet.import.completed", sources: [] },
    preference: { category: "FINANCIAL", userSuppressible: true, suppressibleChannels: ["IN_APP"] },
  },
  PROVIDER_INCIDENT_NOTICE: {
    displayName: "Provider incident notice", status: "PROPOSED", category: "PLATFORM", audience: "ACCOUNT_HOLDER",
    consentClass: "SERVICE", severity: "warning",
    description: "Proposed: tell affected users about a provider incident. Many recipients, so CONTROL (O-2).",
    channels: [planned("IN_APP")], payload: { provider: disp() },
    trigger: { kind: "TRIGGER", triggerKey: "provider.incident.opened", sources: [] },
  },

  // ── NONE_BY_DESIGN
  BETA_REQUEST_DENIED: {
    displayName: "Beta request denied", status: "NONE_BY_DESIGN", category: "PLATFORM", audience: "APPLICANT",
    consentClass: "SERVICE", severity: "info",
    description: "Deliberately no message: a denied beta request is silent. Listed so the absence is a decision, not a gap.",
    channels: [], payload: {},
    trigger: site("app/api/platform/growth-revenue/requests/[id]/deny/route.ts"),
    ownerSurface: OWNER.growth,
  },
};

// ── Derivation ────────────────────────────────────────────────────────────────

const ALWAYS_PROTECTED: ReadonlySet<ConsentClass> = new Set(["SECURITY_CRITICAL", "CEREMONY", "OPERATOR"]);
const EDITABLE_STATUSES: ReadonlySet<DefinitionStatus> = new Set(["ENABLED", "BUILD"]);

/** True when the preview endpoint can render this leg with synthetic data. */
export function isPreviewableLeg(leg: ChannelLeg, hasRegistryEntry: boolean): boolean {
  if (leg.channel === "IN_APP") return hasRegistryEntry;
  if (leg.channel === "BANNER") return leg.template !== null;
  if (leg.path === "REGISTRY") return hasRegistryEntry; // generic notification email from the registry render
  return (leg.previewSlugs?.length ?? 0) > 0;
}

function deriveOperatorSide(d: Omit<CommsDefinition, "protected" | "editable" | "supportedActions">): Pick<CommsDefinition, "protected" | "editable" | "supportedActions"> {
  const readOnlyOnly = d.channels.length > 0 && d.channels.every((c) => c.path === "READ_ONLY_SURFACE");
  const isProtected = ALWAYS_PROTECTED.has(d.consentClass) || d.status === "NONE_BY_DESIGN" || readOnlyOnly;
  const delivers = d.channels.some((c) => c.channel === "IN_APP" || c.channel === "EMAIL");
  const editable = !isProtected && EDITABLE_STATUSES.has(d.status) && delivers;
  const actions: SupportedAction[] = [];
  if (d.channels.some((c) => isPreviewableLeg(c, d.notificationTypeId !== null))) actions.push("PREVIEW");
  if (d.status === "ENABLED" && delivers && d.audience !== "OPERATOR_INBOX" && d.audience !== "PLATFORM_STAFF") actions.push("TEST_SEND");
  if (d.status === "ENABLED" && d.channels.some((c) => c.channel !== "BANNER")) actions.push("VIEW_DELIVERY");
  if (editable) actions.push("AUTOMATE", "PAUSE_AUTOMATION", "ACTIVATE_AUTOMATION");
  if (d.ownerSurface) actions.push("LINK_OUT");
  return { protected: isProtected, editable, supportedActions: actions };
}

function registryStatus(def: NotificationTypeDefinition): DefinitionStatus {
  return def.status === "WIRED" ? "ENABLED" : "VOCABULARY"; // §2.2 rule 6
}

/** The IN_APP / EMAIL legs the registry delivers for a type, exactly as createNotification resolves them. */
function registryLegs(def: NotificationTypeDefinition, emailPreviewSlugs: readonly string[] | undefined): ChannelLeg[] {
  const defaults = def.defaultChannels as readonly string[];
  // A locked category uses its defaults only; DIGEST has no settings row. Every
  // other category's EMAIL/IN_APP can be switched on by an override row
  // (resolveChannelEnabled), so the leg exists with defaultOn = the registry default.
  const optable = !def.locked && MATRIX_CATEGORIES.includes(def.category);
  const legs: ChannelLeg[] = [];
  if (defaults.includes("IN_APP") || optable) {
    legs.push({
      channel: "IN_APP", defaultOn: defaults.includes("IN_APP"),
      template: { id: `registry:${def.id}`, version: IN_APP_TEMPLATE_VERSION }, path: "REGISTRY",
    });
  }
  if (defaults.includes("EMAIL") || optable) {
    legs.push({
      channel: "EMAIL", defaultOn: defaults.includes("EMAIL"),
      template: { id: "notification", version: EMAIL_TEMPLATE_VERSIONS.notification }, path: "REGISTRY",
      email: { template: "notification" },
      ...(emailPreviewSlugs ? { previewSlugs: emailPreviewSlugs } : {}),
    });
  }
  return legs;
}

function fromRegistry(id: NotificationTypeId): CommsDefinition {
  const def: NotificationTypeDefinition = NOTIFICATION_REGISTRY[id];
  const meta = REGISTRY_CATALOG[id];
  const legs = [...registryLegs(def, meta.registryEmailPreviewSlugs), ...(meta.directLegs ?? [])];
  const userSuppressible = !def.locked && MATRIX_CATEGORIES.includes(def.category);
  const base = {
    key: id,
    definitionVersion: 1,
    displayName: meta.displayName,
    description: meta.description,
    status: meta.status ?? registryStatus(def),
    category: def.category,
    audience: meta.audience,
    consentClass: meta.consentClass,
    severity: PRIORITY_SEVERITY[def.priority],
    notificationTypeId: id,
    channels: legs,
    trigger: meta.trigger,
    payload: fields(meta.payload),
    eligibility: meta.eligibility ?? [],
    preference: {
      category: userSuppressible ? def.category : null,
      userSuppressible,
      suppressibleChannels: userSuppressible ? legs.filter((l) => l.path === "REGISTRY").map((l) => l.channel) : [],
    },
    dedupe: {
      // "refresh" is declared vocabulary that createNotification treats as suppress (create.ts, F3 v1).
      strategy: def.dedupe === "none" ? "none" : "suppress",
      keyTemplate: def.dedupeKeyTemplate,
      windowMinutes: null,
    },
    frequencyCap: null,
    ownerSurface: meta.ownerSurface ?? null,
    retention: { inAppArchiveDays: def.retention.autoArchiveDays, inAppDeleteDays: def.retention.deleteDays },
  } satisfies Omit<CommsDefinition, "protected" | "editable" | "supportedActions">;
  return { ...base, ...deriveOperatorSide(base) };
}

function fromStandalone(key: StandaloneKey): CommsDefinition {
  const s = STANDALONE_CATALOG[key];
  const base = {
    key,
    definitionVersion: 1,
    displayName: s.displayName,
    description: s.description,
    status: s.status,
    category: s.category,
    audience: s.audience,
    consentClass: s.consentClass,
    severity: s.severity,
    notificationTypeId: null,
    channels: s.channels,
    trigger: s.trigger,
    payload: fields(s.payload),
    eligibility: s.eligibility ?? [],
    preference: s.preference ?? NOT_SUPPRESSIBLE,
    dedupe: s.dedupe ?? { strategy: "none", keyTemplate: null, windowMinutes: null },
    frequencyCap: s.frequencyCap ?? null,
    ownerSurface: s.ownerSurface ?? null,
    retention: { inAppArchiveDays: null, inAppDeleteDays: null },
  } satisfies Omit<CommsDefinition, "protected" | "editable" | "supportedActions">;
  return { ...base, ...deriveOperatorSide(base) };
}

/** THE catalog: every key, exhaustively typed. Built once at module load (pure). */
export const COMMS_CATALOG: Readonly<Record<CatalogKey, CommsDefinition>> = Object.freeze({
  ...(Object.fromEntries(NOTIFICATION_TYPE_IDS.map((id) => [id, fromRegistry(id)])) as Record<NotificationTypeId, CommsDefinition>),
  ...(Object.fromEntries(STANDALONE_KEYS.map((k) => [k, fromStandalone(k)])) as Record<StandaloneKey, CommsDefinition>),
});

export const CATALOG_KEYS = Object.keys(COMMS_CATALOG) as CatalogKey[];

export function isCatalogKey(key: string): key is CatalogKey {
  return Object.prototype.hasOwnProperty.call(COMMS_CATALOG, key);
}

export function getCatalogDefinition(key: string): CommsDefinition | undefined {
  return isCatalogKey(key) ? COMMS_CATALOG[key] : undefined;
}
