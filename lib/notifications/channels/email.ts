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

/** Build the absolute action URL from the trusted app base + in-app href. */
export function buildActionUrl(appBaseUrl: string | undefined, href: string | null | undefined): string | undefined {
  if (!href || !appBaseUrl) return undefined;
  return `${appBaseUrl.replace(/\/+$/, "")}${href}`;
}

export const emailNotificationAdapter: ChannelAdapter = {
  channel: "EMAIL",
  name: "email",

  async deliver(message: ChannelMessage): Promise<ChannelResult> {
    if (!message.email) {
      // No recipient address resolved — a skip by design, not an error.
      return { status: "skipped", provider: "email" };
    }
    try {
      const result = await sendEmail("notification", message.email, {
        title: message.title,
        ...(message.body ? { body: message.body } : {}),
        ...(message.href
          ? { actionUrl: buildActionUrl(process.env.NEXT_PUBLIC_APP_URL, message.href) }
          : {}),
      });
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
