/**
 * lib/alerts/delivery-capture.ts  (OBS-008)
 *
 * The alerting path's own failure, handed to the error monitor.
 *
 * WHY. An alert delivery that returns `error` was a `console.warn` and a
 * `deliveryStatus: "error"` in a JobRun summary — a signal that lives INSIDE the
 * system whose failure it reports, on a surface nobody watches minute to
 * minute. The alerting path is email-only with one mailbox, so when the mail
 * leg breaks the platform is alert-blind and only the ledger knows. This is the
 * second channel: Sentry (the existing monitoring seam, lib/monitoring/capture.ts
 * pattern — @sentry/core, never the @sentry/nextjs entry).
 *
 * SAFE CONTEXT ONLY: the transport name, the status word, the breach COUNT and
 * the provider's error message. Never the destination address, never an alert
 * summary (some name opaque customer refs), never the message body. No-op
 * without a DSN; never throws.
 */

import "server-only";
import * as Sentry from "@sentry/core";

export interface AlertDeliveryCapture {
  tags: Record<string, string>;
  contexts: Record<string, Record<string, unknown>>;
  level: "error";
}

/** Pure — the payload, provable without a Sentry double. */
export function buildAlertDeliveryCapture(result: unknown, breaches: number): AlertDeliveryCapture {
  const r = (result && typeof result === "object" ? result : {}) as { status?: unknown; provider?: unknown; error?: unknown };
  const status = typeof r.status === "string" ? r.status : "threw";
  const provider = typeof r.provider === "string" ? r.provider : "unknown";
  return {
    tags: { area: "alert-delivery", delivery_status: status, transport: provider },
    contexts: {
      alert_delivery: {
        status,
        transport: provider,
        breaches,
        effect: `${breaches} firing breach(es) were NOT delivered; nothing was recorded as fired, so the next evaluation retries`,
      },
    },
    level: "error",
  };
}

/** Capture an alert-delivery failure. `result` is the transport's EmailResult or the thrown error. Never throws. */
export function captureAlertDeliveryFailure(result: unknown, breaches: number): void {
  try {
    const payload = buildAlertDeliveryCapture(result, breaches);
    const error = result instanceof Error
      ? result
      : new Error(`alert delivery ${payload.tags.delivery_status} via ${payload.tags.transport}` +
          (typeof (result as { error?: unknown })?.error === "string" ? `: ${(result as { error: string }).error}` : ""));
    Sentry.captureException(error, payload);
  } catch {
    // Monitoring must never take down the evaluation it is observing.
  }
}
