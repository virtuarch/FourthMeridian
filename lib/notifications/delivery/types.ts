/**
 * lib/notifications/delivery/types.ts  (Comms Center Phase A-2a)
 *
 * The delivery-ledger vocabulary (contract §3.3) and the shape of one ledger
 * row. Pure types plus closed value lists. No I/O.
 *
 * "ACCEPTED" means the provider (Resend) or the in-app inbox (the Notification
 * row) accepted the message — never that it was delivered. "DELIVERED" /
 * "BOUNCED" / "COMPLAINED" are written ONLY from a signature-verified provider
 * event (Phase C, lib/notifications/delivery/provider-events.ts), as an
 * APPENDED row of the same message. Opens and clicks are never measured (owner
 * decision O-13): there is no field for them.
 */

import type { CommsChannel, DaySeries } from "@/lib/notifications/catalog/types";

/** §3.3 — every delivery status, in the order status vectors are reported. */
export const DELIVERY_STATUSES = [
  "QUEUED", "SCHEDULED", "SUPPRESSED", "CANCELLED", "CAPTURED", "ACCEPTED",
  "FAILED", "DEAD", "DELIVERED", "BOUNCED", "COMPLAINED",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** The statuses a send writes (Phase A-2a). */
export const WRITTEN_STATUSES = ["ACCEPTED", "CAPTURED", "FAILED", "DEAD", "SUPPRESSED"] as const satisfies readonly DeliveryStatus[];

/** Phase C — the statuses ONLY a signature-verified provider event writes (an appended row). */
export const PROVIDER_EVENT_STATUSES = ["DELIVERED", "BOUNCED", "COMPLAINED"] as const satisfies readonly DeliveryStatus[];

/** §3.3 — why a message was not sent. */
export const SUPPRESSION_REASONS = [
  "PREFERENCE_OFF", "NO_RECIPIENT", "OBSOLETE",
  "DEDUPE_OPEN", "FREQUENCY_CAP", "ELIGIBILITY_FAILED",
  "ADMISSION_REFUSED", "ACCOUNT_RESTRICTED",
  "BETA_LIFECYCLE", "ENTITLEMENT", "PROVIDER_FREEZE",
  "ENVIRONMENT_GUARD",
  "AUTOMATION_PAUSED", "STORM_BREAKER",
  // Comms Center A-2b (O-10): the per-recipient email storm limit
  // (lib/notifications/delivery/storm.ts) — over the limit, or the count unreadable.
  "RATE_LIMITED", "RATE_LIMIT_UNVERIFIED",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * The closed error-code set (contract §6.1, narrowed to what the transports can
 * actually tell apart: Resend returns a message, not an HTTP class, so 4xx vs 5xx
 * is one PROVIDER code; STORE = the in-app row could not be written;
 * PREFERENCE_READ / RECIPIENT_LOOKUP = createNotification could not read the
 * user's preferences / address, so the leg was never attempted). The
 * provider's error TEXT is never stored — it can echo an address.
 */
export const DELIVERY_ERROR_CODES = ["RENDER", "TIMEOUT", "NO_TRANSPORT", "PROVIDER", "STORE", "PREFERENCE_READ", "RECIPIENT_LOOKUP"] as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];

/** The ledger channels: the two delivery channels (BANNER is a read-only surface, never a send). */
export type LedgerChannel = Exclude<CommsChannel, "BANNER">;

export type LedgerEnvironment = "production" | "preview" | "development";

/** One CommsDelivery row, exactly as written. Nothing else is ever persisted. */
export interface CommsDeliveryRow {
  /**
   * The MESSAGE this attempt belongs to (contract v1.0.2): the Notification id
   * for a registry leg — stable across retries — or a generated send id for a
   * direct send. A message is (channel, messageKey); its outcome is the row
   * with the highest `attempt`.
   */
  messageKey: string;
  definitionKey: string;
  definitionVersion: number;
  templateVersion: number | null;
  channel: LedgerChannel;
  status: DeliveryStatus;
  reason: SuppressionReason | null;
  provider: string | null;
  providerMessageId: string | null;
  attempt: number;
  errorCode: DeliveryErrorCode | null;
  recipientUserId: string | null;
  recipientHash: string | null;
  notificationId: string | null;
  environment: LedgerEnvironment;
  acceptedAt: Date | null;
  /**
   * Comms Center B1 — the operator content version (CommsTemplateVersion.id)
   * this send rendered. Absent / null = the code default. Set only on the rows
   * of a leg that actually rendered published content.
   */
  contentVersionId?: string | null;
  /** Comms Center B2 — "TEST" for an operator test send (excluded from analytics by default); absent = LIVE. */
  mode?: "LIVE" | "TEST";
  /** Comms Center B2 — the AutomationRunItem this send belongs to (soft ref; = messageKey). */
  automationRunItemId?: string | null;
  /**
   * Comms Center C — the provider's delivery instant. Set ONLY on a row
   * appended from a verified `email.delivered` event (and carried onto a later
   * COMPLAINED / BOUNCED row of the same message); a send never sets it.
   */
  deliveredAt?: Date | null;
}

/** The single write the ledger performs. Injected so tests never need a database. */
export type LedgerWriter = (row: CommsDeliveryRow) => Promise<unknown>;

// ── The delivery read API (contract §4.11, §4.13, v1.0.2) ───────────────────
// Pure types, no runtime. The UI imports them through
// lib/notifications/catalog/types.ts (the stable export path).

export type DeliveryWindow = "7d" | "30d" | "90d";

/** C4 — the six fixed series keys. */
export type SeriesKey = "accepted" | "failed" | "dead" | "suppressed" | "captured" | "cancelled";
/** Phase C — the optional verified-event series keys (present only when measured.delivered). */
export type ProviderSeriesKey = "delivered" | "bounced" | "complained";

/** C3 — every DeliveryStatus key, with a number (0 allowed). Counts MESSAGES by final status (v1.0.2). */
export type StatusCounts = Record<DeliveryStatus, number>;
/** Every SuppressionReason key, with a number (SUPPRESSED messages only). */
export type ReasonCounts = Record<SuppressionReason, number>;

/** GET /api/platform/customer-success/notifications/delivery (§4.11). */
export interface DeliveryAnalytics {
  window: DeliveryWindow;
  /** C2 — YYYY-MM-DD UTC bounds of the window. */
  from: string;
  to: string;
  filters: { channel: CommsChannel | null; status: DeliveryStatus | null; template: string | null };
  /** C3 — null AS A WHOLE when coverage.ledgerSince is null. */
  totals: StatusCounts | null;
  suppressedByReason: ReasonCounts | null;
  byKey: Array<{ key: string; counts: StatusCounts }> | null;
  /**
   * C4 — always all six; each a dense DaySeries (C1/C2: null = not observed; `withheld` never set here).
   * Phase C (v1.2): `delivered` / `bounced` / `complained` are OPTIONAL keys, present only when
   * `measured.delivered` is true (a verified-event count is meaningless before then).
   */
  series: Record<SeriesKey, DaySeries> & Partial<Record<ProviderSeriesKey, DaySeries>>;
  /**
   * Phase C (contract v1.2): `delivered` is true only when the webhook secret is
   * configured AND at least one signature-verified provider event exists — only
   * then can a DELIVERED count mean anything. Opens and clicks: never (O-13).
   */
  measured: { delivered: boolean; opens: false; clicks: false };
  coverage: { ledgerSince: string | null; directSendsCovered: boolean; environment: LedgerEnvironment };
  providerHealth: { href: "/dashboard/platform/PLATFORM_OPS?workspace=platform-providers"; source: "GET /api/platform/platform-ops/email-health" };
  floor: boolean;
  capped: boolean;
  checkedAt: string;
}

/** The contract name for the §4.11 payload. */
export type DeliveryResponse = DeliveryAnalytics;

/**
 * §4.13 per-delivery row (customers/[userId]/deliveries — a later phase), one
 * per MESSAGE (v1.0.2): `attempts` = its highest attempt, `lastAttemptAt` =
 * that attempt's time, `status` / `reason` = that attempt's. No address, title or body.
 */
export interface CustomerDeliveryItem {
  deliveryId: string;
  key: string;
  channel: CommsChannel;
  status: DeliveryStatus;
  /** Set when status ∈ SUPPRESSED | CANCELLED (and CAPTURED by the guard: ENVIRONMENT_GUARD); null otherwise. */
  reason: SuppressionReason | null;
  attempts: number;
  createdAt: string;
  acceptedAt: string | null;
  lastAttemptAt: string | null;
}
