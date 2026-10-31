/**
 * lib/notifications/catalog/types.ts  (Comms Center Phase A-1)
 *
 * The vocabulary of the unified notification CATALOG: the contract types of
 * docs/plans/COMMS-CENTER-API-CONTRACT-v1-2026-10-31.md §1, §2, §2.1 and §5.1–§5.3,
 * transcribed. Pure types plus the closed value lists the routes validate
 * against. No I/O.
 *
 * The catalog is a LAYER ON the existing notification registry
 * (lib/notifications/registry.ts), not a parallel one: an in-app definition
 * references its registry entry by id, and its category, priority, channels,
 * lock and dedupe are DERIVED from that entry (lib/notifications/catalog/
 * definitions.ts). The direct-send messages (ceremony, security email,
 * operator, beta) and the read-only banners gain catalog entries here for the
 * first time. Nothing in this layer changes how a notification is sent.
 */

import type { NotificationCategory } from "@/lib/notifications/types";
import type { NotificationTypeId } from "@/lib/notifications/registry";
import type { EmailTemplateName } from "@/lib/email/types";
import type * as SecurityAlerts from "@/lib/email/security-alerts";

/** §1 — Comms-level channels: the two delivery channels plus two READ-ONLY surfaces. */
export type CommsChannel = "IN_APP" | "EMAIL" | "OPERATOR_EMAIL" | "BANNER";
export const COMMS_CHANNELS = ["IN_APP", "EMAIL", "OPERATOR_EMAIL", "BANNER"] as const satisfies readonly CommsChannel[];

/** §1 — Preview renditions (the GET /catalog/[key]/preview ?channel= values). */
export const PREVIEW_CHANNELS = ["email-html", "email-text", "in-app", "operator", "banner"] as const;
export type PreviewChannel = (typeof PREVIEW_CHANNELS)[number];

/** §1 — what may suppress a message. Orthogonal to the preference category. */
export type ConsentClass = "SECURITY_CRITICAL" | "CEREMONY" | "SERVICE" | "AWARENESS" | "MARKETING" | "OPERATOR";
export const CONSENT_CLASSES = ["SECURITY_CRITICAL", "CEREMONY", "SERVICE", "AWARENESS", "MARKETING", "OPERATOR"] as const satisfies readonly ConsentClass[];

export type Audience = "ACCOUNT_HOLDER" | "SPACE_MEMBER" | "APPLICANT" | "OPERATOR_INBOX" | "PLATFORM_STAFF";
export const AUDIENCES = ["ACCOUNT_HOLDER", "SPACE_MEMBER", "APPLICANT", "OPERATOR_INBOX", "PLATFORM_STAFF"] as const satisfies readonly Audience[];

export type Severity = "info" | "notice" | "warning" | "critical";

/** §1 — lifecycle of a CATALOG item (not of a send). */
export type DefinitionStatus =
  | "ENABLED" | "BUILD" | "BUILD_OFF" | "PROPOSED" | "VOCABULARY" | "NONE_BY_DESIGN" | "RETIRED";
/** §4.2 (C7c) — the default sort order of `status`. */
export const DEFINITION_STATUS_ORDER = [
  "ENABLED", "BUILD", "BUILD_OFF", "PROPOSED", "VOCABULARY", "NONE_BY_DESIGN", "RETIRED",
] as const satisfies readonly DefinitionStatus[];

/** §2 — the catalog's category: a registry category, or one of the two catalog-only ones. */
export type CatalogCategory = NotificationCategory | "OPERATOR" | "CEREMONY";
export const CATALOG_CATEGORIES = [
  "ACCOUNT_SECURITY", "SPACES", "FINANCIAL", "AI", "PLATFORM", "DIGEST", "OPERATOR", "CEREMONY",
] as const satisfies readonly CatalogCategory[];

export type SupportedAction =
  | "PREVIEW" | "TEST_SEND" | "VIEW_DELIVERY" | "AUTOMATE" | "PAUSE_AUTOMATION" | "ACTIVATE_AUTOMATION" | "LINK_OUT";

export type OwnerArea = "PLATFORM_OPS" | "GROWTH_REVENUE" | "SECURITY_OPS" | "CUSTOMER_SUCCESS";

/** §5.1 — the controlled trigger catalog's keys (typed events only). */
export const TRIGGER_KEYS = [
  // AVAILABLE (an emitter exists today)
  "space.member.invited", "space.member.joined", "space.member.removed", "space.member.role_changed",
  "plaid.item.sync_failed", "plaid.item.history_ready",
  "import.batch.completed",
  // Owner-approved BUILD keys, emitters added 2026-10-31
  "plaid.item.webhook_needs_reauth", "plaid.item.webhook_revoked",
  "wallet.sync.failed",
  "account.registered",
  "platform.grant.created", "platform.grant.reinstated", "platform.grant.level_changed", "platform.grant.revoked",
  // PROPOSED (no emitter; listed so the vocabulary is stable)
  "plaid.item.webhook_pending_expiration",
  "beta.invitation.expiring", "beta.program.status_changed",
  "wallet.import.completed", "platform.maintenance.scheduled", "provider.incident.opened",
  "schedule.daily",
] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];

/** §5.2 — the closed predicate set. `EligibilityPredicate` is the op name. */
export const ELIGIBILITY_PREDICATES = [
  "recipient.has_verified_email",
  "recipient.account_age_days",
  "recipient.cohort_in",
  "recipient.lifecycle_stage_in",
  "recipient.has_platform_grant",
  "event.field_equals",
  "event.count_in_window",
  "connection.status_in",
  "connection.removed_by_user",
] as const;
export type EligibilityPredicate = (typeof ELIGIBILITY_PREDICATES)[number];

/** §5.3 — recipient resolvers. Env NAMES only, never values. */
export type RecipientResolver =
  | { kind: "EVENT_SUBJECT_USER" }
  | { kind: "EVENT_ACTOR_USER" }
  | { kind: "SPACE_ROLE"; roles: Array<"OWNER" | "ADMIN" | "MEMBER"> }
  | { kind: "PLATFORM_AREA_STAFF"; area: "SECURITY_OPS" | "PLATFORM_OPS" | "CUSTOMER_SUCCESS" | "GROWTH_REVENUE"; includeSystemAdmin: boolean }
  | { kind: "OPERATOR_INBOX"; env: "PLATFORM_ALERTS_EMAIL" | "SECURITY_ALERTS_EMAIL" | "BETA_REQUESTS_EMAIL" };

/** A security-alert builder name (lib/email/security-alerts.ts) — the call sites' own copy functions. */
export type SecurityAlertBuilder = {
  [K in keyof typeof SecurityAlerts]: K extends `${string}Alert` ? K : never;
}[keyof typeof SecurityAlerts];

export interface PayloadField {
  name: string;
  /** LINK = a ceremony URL (never persisted). */
  kind: "POINTER" | "DISPLAY" | "LINK";
  type: "string" | "number" | "boolean" | "iso-date" | "string[]";
  required: boolean;
  /** True when the value can identify a person (address, login identifier, IP, name). */
  pii: boolean;
}

/** One delivery leg (§2 `channels[number]`), plus the catalog-internal wiring facts. */
export interface ChannelLeg {
  channel: CommsChannel;
  defaultOn: boolean;
  /** Email template + its own version; for IN_APP the registry render is the template. */
  template: { id: string; version: number } | null;
  /** How this leg is delivered today. DIRECT = sendEmail() outside createNotification. */
  path: "REGISTRY" | "DIRECT" | "READ_ONLY_SURFACE";
  /**
   * INTERNAL (never in a DTO): the sendEmail template this leg sends, and for
   * the generic security-alert template the builder that writes its copy. The
   * completeness test maps every grepped send site onto exactly one leg by these.
   */
  email?: { template: EmailTemplateName; builder?: SecurityAlertBuilder };
  /** INTERNAL: lib/email/preview.ts case slugs that render this leg (email / operator legs). */
  previewSlugs?: readonly string[];
}

/** §2 — the definition. Code-defined; versions live in code. */
export interface CommsDefinition {
  key: string;
  definitionVersion: number;
  displayName: string;
  description: string;
  status: DefinitionStatus;
  category: CatalogCategory;
  audience: Audience;
  consentClass: ConsentClass;
  severity: Severity;
  notificationTypeId: NotificationTypeId | null;
  channels: readonly ChannelLeg[];
  trigger: {
    kind: "TRIGGER" | "CALL_SITE";
    triggerKey: TriggerKey | null;
    /** Repo-relative producer file(s). Paths, not line numbers: lines drift with every edit. */
    sources: readonly string[];
  };
  payload: readonly PayloadField[];
  eligibility: readonly EligibilityPredicate[];
  preference: {
    category: NotificationCategory | null;
    userSuppressible: boolean;
    suppressibleChannels: readonly CommsChannel[];
  };
  dedupe: { strategy: "none" | "suppress" | "window"; keyTemplate: string | null; windowMinutes: number | null };
  frequencyCap: { max: number; perHours: number } | null;
  protected: boolean;
  editable: boolean;
  supportedActions: readonly SupportedAction[];
  ownerSurface: { area: OwnerArea; href: string } | null;
  /** In-app retention from the registry entry; null when there is no in-app leg. */
  retention: { inAppArchiveDays: number | null; inAppDeleteDays: number | null };
}

/** §4.5 — one controlled trigger. */
export interface TriggerItem {
  key: TriggerKey;
  displayName: string;
  description: string;
  source: "DOMAIN_EVENT" | "HEALTH_TRANSITION" | "JOB_OUTCOME" | "LIFECYCLE" | "SCHEDULE";
  payload: Array<{ name: string; type: string; pii: boolean }>;
  resolvers: RecipientResolver[];
  /** PROPOSED = event not emitted yet. */
  status: "AVAILABLE" | "PROPOSED";
}

// ── DTOs (§2.1, §3.1, §4.2, §4.4) ─────────────────────────────────────────────

export interface CatalogItem {
  key: string;
  definitionVersion: number;
  displayName: string;
  description: string;
  status: DefinitionStatus;
  category: CatalogCategory;
  audience: Audience;
  consentClass: ConsentClass;
  severity: Severity;
  channels: Array<{ channel: CommsChannel; defaultOn: boolean; templateVersion: number | null; path: ChannelLeg["path"] }>;
  userSuppressible: boolean;
  protected: boolean;
  editable: boolean;
  supportedActions: SupportedAction[];
  ownerSurface: { area: string; href: string } | null;
  automations: { draft: number; active: number; paused: number };
}

/** C1 — null = NOT OBSERVED (no ledger coverage), never 0. */
export type Count = number | null;

/**
 * C1 — a scalar aggregate: `withheld: true` = observed but suppressed as a small
 * cell (1–4; people counts only, §4.12/§4.14) with `value` null; `withheld:
 * false` + `value: null` = not observed. Delivery counts are never withheld.
 */
export type Aggregate = { value: number | null; withheld: boolean };

/** One DaySeries cell: `count` null + `withheld` absent = not observed; `withheld: true` = small cell. */
export type DayCell = DaySeries["days"][number];

// ── The delivery read API (A-2a) — THE stable export path for the UI ─────────
// Type-only re-exports (erased at runtime): importing this module pulls no
// database, no next/server, nothing but types.
export type {
  CustomerDeliveryItem,
  DeliveryAnalytics,
  DeliveryErrorCode,
  DeliveryResponse,
  DeliveryStatus,
  DeliveryWindow,
  LedgerChannel,
  LedgerEnvironment,
  ReasonCounts,
  SeriesKey,
  StatusCounts,
  SuppressionReason,
} from "@/lib/notifications/delivery/types";
export { DELIVERY_STATUSES, SUPPRESSION_REASONS, DELIVERY_ERROR_CODES } from "@/lib/notifications/delivery/types";

export interface DaySeries {
  window: "7d" | "30d" | "90d";
  from: string;
  to: string;
  days: Array<{ day: string; count: Count; withheld?: true }>;
  floor: boolean;
}

export interface CatalogDetail extends CatalogItem {
  trigger: CommsDefinition["trigger"];
  payload: PayloadField[];
  eligibility: EligibilityPredicate[];
  dedupe: CommsDefinition["dedupe"];
  frequencyCap: CommsDefinition["frequencyCap"];
  retention: { inAppArchiveDays: number | null; inAppDeleteDays: number | null; deliveryDays: number };
  recent: DaySeries;
}

export interface ListEnvelope<T> {
  items: T[];
  checkedAt: string;
  nextCursor: string | null;
  limit: number;
  floor: boolean;
  capped: boolean;
}

export type CatalogResponse = ListEnvelope<CatalogItem> & { totals: Record<DefinitionStatus, number> };
export type TriggersResponse = ListEnvelope<TriggerItem>;

export interface PreviewResponse {
  key: string;
  definitionVersion: number;
  templateVersion: number | null;
  channel: PreviewChannel;
  synthetic: true;
  subject: string | null;
  html: string | null;
  text: string | null;
  inApp: { title: string; body: string | null; href: string | null; icon: string } | null;
  variants: string[];
  checkedAt: string;
}
