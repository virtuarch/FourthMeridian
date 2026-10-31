/**
 * lib/notifications/channels/email-data.ts
 *
 * Pure: a rendered ChannelMessage + the trusted app base → the data the
 * `notification` email template renders. Split from channels/email.ts (which
 * imports the send chokepoint) so the preview tool and tests build EXACTLY the
 * data the channel sends, with no I/O.
 */

import type { ChannelMessage } from "@/lib/notifications/types";
import type { NotificationEmailData } from "@/lib/email/templates/notification";
import { APP_PATHS } from "@/lib/email/app-link";

/** Build the absolute action URL from the trusted app base + in-app href. */
export function buildActionUrl(appBaseUrl: string | undefined, href: string | null | undefined): string | undefined {
  if (!href || !appBaseUrl) return undefined;
  return `${appBaseUrl.replace(/\/+$/, "")}${href}`;
}

export function buildNotificationEmailData(
  message: Pick<ChannelMessage, "title" | "body" | "href" | "actionLabel" | "category">,
  appBaseUrl: string | undefined,
): NotificationEmailData {
  const actionUrl = message.href ? buildActionUrl(appBaseUrl, message.href) : undefined;
  const preferencesUrl = buildActionUrl(appBaseUrl, APP_PATHS.notificationSettings);
  return {
    title: message.title,
    ...(message.body ? { body: message.body } : {}),
    ...(actionUrl ? { actionUrl } : {}),
    ...(actionUrl && message.actionLabel ? { actionLabel: message.actionLabel } : {}),
    category: message.category,
    ...(preferencesUrl ? { preferencesUrl } : {}),
  };
}
