/**
 * lib/notifications/channels/email.ts  (OPS-3 S4)
 *
 * The EMAIL channel adapter — a thin transport mapping over the OPS-1 email
 * chokepoint. This file NEVER touches an email SDK and never builds a second
 * email path: it renders nothing (the message arrives pre-rendered from the
 * registry via createNotification) and delegates delivery to
 * sendEmail("notification", …), returning the EmailResult verbatim as the
 * ChannelResult.
 *
 * DELIVERY BOOKKEEPING IS NOT HERE: the chokepoint (lib/notifications/
 * create.ts) writes the NotificationDelivery row from this adapter's result —
 * bookkeeping stays single-sited so no path can deliver without recording
 * (the OPS-5 invariant).
 *
 * NEVER THROWS: sendEmail is non-throwing by contract; the catch is belt-and-
 * braces for anything upstream of it.
 */

import { sendEmail } from "@/lib/email/send";
import type { ChannelAdapter, ChannelMessage, ChannelResult } from "@/lib/notifications/types";
import { buildActionUrl, buildNotificationEmailData } from "@/lib/notifications/channels/email-data";
import { renderNotificationEmail, type NotificationEmailData } from "@/lib/email/templates/notification";

/**
 * Comms Center B1 — the template data for this message: the PUBLISHED operator
 * content when the chokepoint attached one AND it renders, else the code
 * rendering. A published version that cannot render must never silence the
 * message (contract v1.1 §5.2): the send falls back to the code default, is
 * recorded with no contentVersionId, and one RENDER_FALLBACK line is logged
 * (type and version id only).
 */
export function emailDataFor(message: ChannelMessage, appBaseUrl: string | undefined, log: (line: string) => void = (l) => console.warn(l)):
  { data: NotificationEmailData; contentVersionId: string | null } {
  const base = buildNotificationEmailData(message, appBaseUrl);
  if (!message.emailContent) return { data: base, contentVersionId: null };
  const withContent: NotificationEmailData = { ...base, content: message.emailContent.content };
  try {
    renderNotificationEmail(withContent);
    return { data: withContent, contentVersionId: message.emailContent.versionId };
  } catch {
    log(`[comms-content] RENDER_FALLBACK type=${message.type} version=${message.emailContent.versionId}: the published content did not render; the code default was sent`);
    return { data: base, contentVersionId: null };
  }
}

// Re-exported: callers and tests import buildActionUrl from here.
export { buildActionUrl };

export const emailNotificationAdapter: ChannelAdapter = {
  channel: "EMAIL",
  name: "email",

  async deliver(message: ChannelMessage): Promise<ChannelResult> {
    if (!message.email) {
      // No recipient address resolved — a skip by design, not an error.
      return { status: "skipped", provider: "email" };
    }
    try {
      const { data, contentVersionId } = emailDataFor(message, process.env.NEXT_PUBLIC_APP_URL);
      const result = await sendEmail(
        "notification",
        message.email,
        { ...data },
        // Delivery ledger (A-2a): the registry type id IS the catalog key.
        {
          key: message.type,
          recipientUserId: message.userId,
          // One message across retries: the Notification row it belongs to.
          ...(message.notificationId ? { messageKey: message.notificationId, notificationId: message.notificationId } : {}),
          ...(message.attempt ? { attempt: message.attempt } : {}),
          ...(message.finalAttempt ? { terminalOnError: true } : {}),
          ...(contentVersionId ? { contentVersionId } : {}),
        },
      );
      // EmailResult → ChannelResult, field-for-field (frozen: verbatim).
      return {
        status: result.status,
        ...(result.id ? { id: result.id } : {}),
        provider: result.provider,
        ...(result.error ? { error: result.error } : {}),
      };
    } catch (err) {
      return {
        status: "error",
        provider: "email",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
