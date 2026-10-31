/**
 * lib/email/templates/notification.ts  (OPS-3 S4 → email design system)
 *
 * The ONE generic product-notification email. Sends as the
 * `product-notification` identity (notifications@fourthmeridian.com).
 *
 * Deliberately GENERIC: every notification type renders through this single
 * template from its registry copy (lib/notifications/registry.ts render()), so
 * adding a notification type never adds an email template. Ceremony emails
 * (reset/verify/invite/security-alert) keep their own templates and their
 * support@ identity — this template is for AWARENESS only (the F12
 * ceremony/awareness doctrine).
 *
 * The footer keeps the preference provenance: which category this is, that
 * email is on for it, and a link to the real notification-settings page
 * (app/(shell)/dashboard/settings/notifications) when the channel supplies it.
 *
 * PURE: renders from pre-resolved strings. No env, no DB — the email channel
 * (lib/notifications/channels/email-data.ts) resolves actionUrl and
 * preferencesUrl from the trusted app base before calling sendEmail.
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBlock } from "@/lib/email/design/blocks";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import type { NotificationCategory } from "@/lib/notifications/types";

/** Data the notification template renders from. */
export interface NotificationEmailData {
  /** The notification's rendered title, also used as the subject. */
  title: string;
  /** The notification's rendered body, when the type has one. */
  body?: string;
  /** Absolute in-app destination (trusted base + href), when the type has one. */
  actionUrl?: string;
  /** CTA label for actionUrl (registry actionLabel); defaults to DEFAULT_NOTIFICATION_ACTION_LABEL. */
  actionLabel?: string;
  /** The type's preference category — names the footer's provenance line. */
  category?: NotificationCategory;
  /** Absolute URL of the notification-settings page (trusted base). */
  preferencesUrl?: string;
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export const DEFAULT_NOTIFICATION_ACTION_LABEL = "View in Fourth Meridian";

/** Category titles as Settings → Notifications shows them (components/settings/NotificationSettings.tsx). */
const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  ACCOUNT_SECURITY: "Account & Security",
  SPACES:           "Spaces",
  FINANCIAL:        "Financial",
  AI:               "Intelligence",
  PLATFORM:         "Platform",
  DIGEST:           "Digest",
};

/** Why this recipient got this email — the preference provenance line. */
export function notificationFooterReason(category: NotificationCategory | undefined): string {
  const label = category ? CATEGORY_LABEL[category] : undefined;
  if (!label) return "You're receiving this because email notifications are turned on for your Fourth Meridian account.";
  if (category === "FINANCIAL") {
    return `You're receiving this connection notification because email is turned on for ${label} notifications. You can change this in notification settings.`;
  }
  return `You're receiving this because email is turned on for ${label} notifications. You can change this in notification settings.`;
}

export function renderNotificationEmail(
  data: NotificationEmailData,
  opts: { brand?: EmailBrandConfig } = {},
): RenderedEmail {
  const blocks: EmailBlock[] = [{ kind: "hero", heading: data.title }];
  if (data.body) blocks.push({ kind: "paragraph", text: data.body });
  if (data.actionUrl) {
    blocks.push({ kind: "cta", label: data.actionLabel || DEFAULT_NOTIFICATION_ACTION_LABEL, url: data.actionUrl });
  }
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}${data.title}`,
    preheader: data.body ?? data.title,
    blocks,
    footer: {
      reason: notificationFooterReason(data.category),
      ...(data.preferencesUrl ? { link: { label: "Manage notification settings", url: data.preferencesUrl } } : {}),
    },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const notificationTemplate: EmailTemplate<NotificationEmailData> = {
  name: "notification",
  sender: "product-notification",
  render(data: NotificationEmailData) {
    return renderNotificationEmail(data);
  },
};
