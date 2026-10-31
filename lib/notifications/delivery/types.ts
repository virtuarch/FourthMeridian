/**
 * lib/notifications/delivery/types.ts  (Comms Center Phase A-2a)
 *
 * The delivery-ledger vocabulary (contract §3.3) and the shape of one ledger
 * row. Pure types plus closed value lists. No I/O.
 *
 * "ACCEPTED" is the strongest claim the platform makes until Phase C: the
 * provider (Resend) or the in-app inbox (the Notification row) accepted the
 * message. "DELIVERED" / "BOUNCED" / "COMPLAINED" exist in the vocabulary so
 * every status vector has a stable shape, but nothing writes them until a
 * signature-verified provider event exists. Opens and clicks are never
 * measured (owner decision O-13): there is no field for them.
 */

import type { CommsChannel } from "@/lib/notifications/catalog/types";

/** §3.3 — every delivery status, in the order status vectors are reported. */
export const DELIVERY_STATUSES = [
  "QUEUED", "SCHEDULED", "SUPPRESSED", "CANCELLED", "CAPTURED", "ACCEPTED",
  "FAILED", "DEAD", "DELIVERED", "BOUNCED", "COMPLAINED",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** The statuses Phase A-2a writes. The rest are reported as 0 until their phase. */
export const WRITTEN_STATUSES = ["ACCEPTED", "CAPTURED", "FAILED", "DEAD", "SUPPRESSED"] as const satisfies readonly DeliveryStatus[];

/** §3.3 — why a message was not sent. */
export const SUPPRESSION_REASONS = [
  "PREFERENCE_OFF", "NO_RECIPIENT", "OBSOLETE",
  "DEDUPE_OPEN", "FREQUENCY_CAP", "ELIGIBILITY_FAILED",
  "ADMISSION_REFUSED", "ACCOUNT_RESTRICTED",
  "BETA_LIFECYCLE", "ENTITLEMENT", "PROVIDER_FREEZE",
  "ENVIRONMENT_GUARD",
  "AUTOMATION_PAUSED", "STORM_BREAKER",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * The closed error-code set (contract §6.1, narrowed to what the transports can
 * actually tell apart: Resend returns a message, not an HTTP class, so 4xx vs 5xx
 * is one PROVIDER code; STORE = the in-app row could not be written). The
 * provider's error TEXT is never stored — it can echo an address.
 */
export const DELIVERY_ERROR_CODES = ["RENDER", "TIMEOUT", "NO_TRANSPORT", "PROVIDER", "STORE"] as const;
export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[number];

/** The ledger channels: the two delivery channels (BANNER is a read-only surface, never a send). */
export type LedgerChannel = Exclude<CommsChannel, "BANNER">;

export type LedgerEnvironment = "production" | "preview" | "development";

/** One CommsDelivery row, exactly as written. Nothing else is ever persisted. */
export interface CommsDeliveryRow {
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
}

/** The single write the ledger performs. Injected so tests never need a database. */
export type LedgerWriter = (row: CommsDeliveryRow) => Promise<unknown>;
