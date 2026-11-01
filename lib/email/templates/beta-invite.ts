/**
 * lib/email/templates/beta-invite.ts  (Wave 1 S3 → email design system)
 *
 * The beta-access approval invitation. Sends as the `beta-invite` identity
 * (beta@fourthmeridian.com — see lib/email/senders.ts) and is built on the
 * shared design system (lib/email/design), so the HTML and plain-text parts come
 * from one block list.
 *
 * EXPIRY IS DATA, NOT COPY. The caller passes the `issuedAt` / `expiresAt` it
 * just wrote to the invite row; the validity ("N days") is computed from the two
 * and the absolute expiry is printed in UTC with the zone label. Nothing here
 * assumes 7 or 14 days.
 *
 * TOKEN LINK: the CTA carries the single-use invite the register route redeems.
 * The URL is built by lib/email/beta-invite-url.ts and passed in — this template
 * is PURE: it does not build the URL, read the DB, or know about tokens.
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { cleanText } from "@/lib/email/design/escape";
import { daysPhrase, formatUtcDateTimeLabelled, wholeDaysBetween } from "@/lib/email/design/datetime";

/** Data the beta-invite template renders from. */
export interface BetaInviteData {
  /** Recipient's name when known. BetaAccessRequest stores none, so usually absent. */
  recipientName?: string | null;
  /** Absolute, ready-to-click registration URL carrying the invite token. */
  inviteUrl: string;
  /** When this invite was issued (the `invitedAt` the route wrote). */
  issuedAt: Date;
  /** When it stops working (the `inviteExpiresAt` the route wrote). */
  expiresAt: Date;
  /**
   * Why this person is being invited:
   *   "request" — they asked for access (approve, or a resend of an approval);
   *   "direct"  — an operator invited them with no request behind it.
   * The copy differs: a direct invitee never "requested access".
   */
  origin: BetaInviteOrigin;
  /** Preview tool only (scripts/email-preview.ts): prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export type BetaInviteOrigin = "request" | "direct";

export const BETA_INVITE_SUBJECT = "Your Fourth Meridian beta access is approved";
export const BETA_DIRECT_INVITE_SUBJECT = "You're invited to the Fourth Meridian beta";

/** The origin-specific lines. Everything else (expiry, CTA, next steps, footer) is shared. */
const COPY: Record<BetaInviteOrigin, { subject: string; heading: string; lead: string; ignore: string }> = {
  request: {
    subject: BETA_INVITE_SUBJECT,
    heading: "Beta access approved",
    lead:    "Your Fourth Meridian beta access is approved.",
    ignore:  "If you didn't request access, you can ignore this email; the link expires on its own.",
  },
  direct: {
    subject: BETA_DIRECT_INVITE_SUBJECT,
    heading: BETA_DIRECT_INVITE_SUBJECT,
    lead:    "You've been invited to join the Fourth Meridian beta.",
    ignore:  "If you weren't expecting this invitation, you can ignore this email; the link expires on its own.",
  },
};

function asDate(value: unknown, field: string): Date {
  const d = value instanceof Date ? value : new Date(value as string);
  if (!Number.isFinite(d.getTime())) throw new Error(`beta-invite: ${field} is not a valid date`);
  return d;
}

/** Render the invitation. `brand` is injectable for tests and previews. */
export function renderBetaInvite(
  data: BetaInviteData,
  opts: { brand?: EmailBrandConfig } = {},
): RenderedEmail {
  const issuedAt = asDate(data.issuedAt, "issuedAt");
  const expiresAt = asDate(data.expiresAt, "expiresAt");
  if (expiresAt.getTime() <= issuedAt.getTime()) throw new Error("beta-invite: expiresAt must follow issuedAt");

  const days = wholeDaysBetween(issuedAt, expiresAt);
  const expiresLabel = formatUtcDateTimeLabelled(expiresAt);
  const name = data.recipientName ? cleanText(data.recipientName) : "";
  const greeting = name ? `Hi ${name},` : "Hello,";
  // Anything but an explicit "direct" gets the request copy (the historical default).
  const copy = COPY[data.origin === "direct" ? "direct" : "request"];

  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}${copy.subject}`,
    preheader: `Create your account within ${daysPhrase(days)}. Your invitation expires ${expiresLabel}.`,
    blocks: [
      { kind: "hero", heading: copy.heading, greeting },
      { kind: "paragraph", text: copy.lead },
      {
        kind: "expiry",
        headline: `You have ${daysPhrase(days)} to redeem your invitation.`,
        detail: `It expires on ${expiresLabel}.`,
      },
      { kind: "cta", label: "Get Started", url: data.inviteUrl },
      {
        kind: "info",
        title: "What happens next",
        ordered: true,
        items: [
          "Create your account using this email address. The invitation works only for the address it was sent to.",
          "Connect your accounts to start using Fourth Meridian.",
        ],
      },
      {
        kind: "security",
        text: copy.ignore,
      },
    ],
    footer: {
      reason: "You're receiving this email because a Fourth Meridian beta invitation was issued to this address.",
    },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const betaInviteTemplate: EmailTemplate<BetaInviteData> = {
  name: "beta-invite",
  sender: "beta-invite",
  render(data: BetaInviteData) {
    return renderBetaInvite(data);
  },
};
