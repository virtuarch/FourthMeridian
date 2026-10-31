/**
 * lib/email/templates/welcome.ts  (owner-approved 2026-10-31)
 *
 * The one-time welcome email, sent once per account by
 * lib/notifications/welcome.ts: at registration for an invited (pre-verified)
 * account, after the first successful email verification for an uninvited one.
 * Sends as the `product-notification` identity (notifications@).
 *
 * Copy rules: warm and short; ONE action ("Open Fourth Meridian" → /dashboard);
 * next steps name only features that exist today — Connections (banks via
 * Plaid, crypto wallets) and shared Spaces, whose invitations go to an existing
 * Fourth Meridian username (app/api/spaces/[id]/invite). No marketing, no
 * offers. The footer says why the email was sent; there is no preference line:
 * the welcome is not preference-suppressible (consent SERVICE, locked per type).
 *
 * PURE: renders from pre-resolved strings. No env, no DB — the caller builds
 * dashboardUrl from the trusted app base (buildAppLink).
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { cleanText } from "@/lib/email/design/escape";

/** Data the welcome template renders from. */
export interface WelcomeData {
  /** The account holder's first name; omitted or blank ⇒ an unnamed greeting. */
  firstName?: string | null;
  /** Absolute link to /dashboard on the trusted app base. */
  dashboardUrl: string;
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export const WELCOME_SUBJECT = "Welcome to Fourth Meridian";
export const WELCOME_ACTION_LABEL = "Open Fourth Meridian";

export function renderWelcome(data: WelcomeData, opts: { brand?: EmailBrandConfig } = {}): RenderedEmail {
  const name = cleanText(String(data.firstName ?? ""), 60);
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}${WELCOME_SUBJECT}`,
    preheader: "Your account is ready. Here's how to get started.",
    blocks: [
      { kind: "hero", heading: name ? `Welcome, ${name}` : "Welcome to Fourth Meridian" },
      { kind: "paragraph", text: "Your Fourth Meridian account is ready. We're glad you're here." },
      {
        kind: "info",
        title: "A good place to start",
        ordered: true,
        items: [
          "Connect your bank accounts and crypto wallets from Connections. Your Space fills in as they sync.",
          "Planning with family? Create a shared Space and invite them by their Fourth Meridian username.",
        ],
      },
      { kind: "cta", label: WELCOME_ACTION_LABEL, url: data.dashboardUrl },
    ],
    footer: { reason: "You're receiving this one-time email because you created a Fourth Meridian account with this address." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const welcomeTemplate: EmailTemplate<WelcomeData> = {
  name: "welcome",
  sender: "product-notification",
  render(data: WelcomeData) {
    return renderWelcome(data);
  },
};
