/**
 * lib/notifications/action-label.ts
 *
 * Recompute a notification's email CTA label from what is ALREADY persisted —
 * the row's `type` and `metadata` (the createNotification input data) — through
 * the SAME registry render that produced it at create time. The label is
 * email-only and never persisted (RenderedNotification.actionLabel), so the
 * retry job (jobs/retry-notifications.ts) needs this to resend the state CTA
 * ("Reconnect Chase") rather than the generic default.
 *
 * SYNC_FAILED: a row written before connectionState existed (or with any
 * unknown value) renders the conservative "Review connection"
 * (lib/notifications/connection-attention.ts). An unknown type, non-object
 * metadata or a render failure yields undefined → the email template's
 * generic default. Pure: no I/O.
 */

import { getNotificationDefinition } from "@/lib/notifications/registry";

export function recomputeActionLabel(type: string, metadata: unknown): string | undefined {
  const def = getNotificationDefinition(type);
  if (!def) return undefined;
  const data =
    metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  try {
    return def.render(data).actionLabel;
  } catch {
    return undefined;
  }
}
