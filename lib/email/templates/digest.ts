/**
 * lib/email/templates/digest.ts  (Comms Center — BUILT, SHIPPED OFF)
 *
 * SKELETON of the notification digest email (DIGEST_SENT). Nothing sends it:
 * its only producer (lib/notifications/digest.ts) is gated by DIGEST_ENABLED,
 * a code constant that is false, and no schedule calls the producer. The
 * frequency, content and opt-in default await the owner's digest proposal
 * (O-14); this template exists so the producer, the catalog entry and the
 * preview are real and reviewable, not so a digest can go out.
 *
 * Content is deliberately minimal and POINTER-SHAPED: a count and the titles
 * of the notices the user already received in-app (the registry render copy),
 * never financial figures. One action: open the app, where the notification bell lives.
 *
 * PURE: renders from pre-resolved strings. No env, no DB.
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { cleanText } from "@/lib/email/design/escape";

/** The most items one digest lists; the rest are summarised by count. */
export const DIGEST_MAX_ITEMS = 10;

/** Data the digest template renders from. */
export interface DigestData {
  /** Period label, e.g. "Oct 30 – Oct 31". */
  periodLabel: string;
  /** Rendered titles of the folded notifications (registry render copy). */
  items: string[];
  /** Absolute link to /dashboard (the notification bell lives in the app shell), trusted base. */
  dashboardUrl: string;
  /** Absolute URL of the notification-settings page (trusted base). */
  preferencesUrl?: string;
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export function renderDigest(data: DigestData, opts: { brand?: EmailBrandConfig } = {}): RenderedEmail {
  const period = cleanText(String(data.periodLabel ?? ""), 60);
  const all = (Array.isArray(data.items) ? data.items : []).map((t) => cleanText(String(t ?? ""), 140)).filter((t) => t.length > 0);
  const shown = all.slice(0, DIGEST_MAX_ITEMS);
  const more = all.length - shown.length;
  const count = all.length === 1 ? "1 notification" : `${all.length} notifications`;
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}Your Fourth Meridian digest${period ? `: ${period}` : ""}`,
    preheader: `${count} since your last digest.`,
    blocks: [
      { kind: "hero", heading: "Your digest" },
      { kind: "paragraph", text: `You have ${count}${period ? ` for ${period}` : ""}.` },
      ...(shown.length > 0
        ? [{ kind: "info" as const, items: more > 0 ? [...shown, `and ${more} more`] : shown }]
        : []),
      { kind: "cta", label: "Open Fourth Meridian", url: data.dashboardUrl },
    ],
    footer: {
      reason: "You're receiving this because the email digest is turned on for your Fourth Meridian account.",
      ...(data.preferencesUrl ? { link: { label: "Manage notification settings", url: data.preferencesUrl } } : {}),
    },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const digestTemplate: EmailTemplate<DigestData> = {
  name: "digest",
  sender: "product-notification",
  render(data: DigestData) {
    return renderDigest(data);
  },
};
