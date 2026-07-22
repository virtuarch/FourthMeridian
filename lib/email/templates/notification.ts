/**
 * lib/email/templates/notification.ts  (OPS-3 S4)
 *
 * The ONE generic product-notification email. Text-first, sends as the
 * `product-notification` identity (notifications@fourthmeridian.com — the
 * sender reserved unused in lib/email/senders.ts since OPS-1 S0, for exactly
 * this).
 *
 * Deliberately GENERIC ({ title, body?, actionUrl? }) — the security-alert
 * precedent: every notification type renders through this single template
 * from its registry copy (lib/notifications/registry.ts render()), so adding
 * a notification type never adds an email template. Ceremony emails
 * (reset/verify/invite/security-alert) keep their own templates and their
 * support@ identity — this template is for AWARENESS only (the F12
 * ceremony/awareness doctrine).
 *
 * PURE: renders subject + text from pre-resolved strings. No env, no DB —
 * the email channel resolves actionUrl (app base + Notification.href) before
 * calling sendEmail.
 */

import type { EmailTemplate } from "@/lib/email/types";

/** Data the notification template renders from. */
export interface NotificationEmailData {
  /** The notification's rendered title, also used as the subject. */
  title: string;
  /** The notification's rendered body, when the type has one. */
  body?: string;
  /** Absolute in-app destination (trusted base + href), when the type has one. */
  actionUrl?: string;
}

export const notificationTemplate: EmailTemplate<NotificationEmailData> = {
  name: "notification",
  sender: "product-notification",
  render(data: NotificationEmailData) {
    const parts: string[] = [];
    if (data.body) parts.push(data.body);
    if (data.actionUrl) parts.push(`View in Fourth Meridian: ${data.actionUrl}`);
    parts.push(
      `You're receiving this because notifications for this category are ` +
        `enabled in Settings → Notifications.`,
    );
    return {
      subject: data.title,
      text: parts.join("\n\n") + "\n",
    };
  },
};
