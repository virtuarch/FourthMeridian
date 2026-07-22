/**
 * lib/email/templates/beta-invite.ts  (Wave 1 S3)
 *
 * The beta-access invitation email. Text-first, sends as the `beta-invite`
 * identity (beta@fourthmeridian.com — see lib/email/senders.ts).
 *
 * TOKEN LINK: unlike the space-invite notification, this carries a single-use
 * invite the register route redeems. The CTA link is built by
 * lib/email/beta-invite-url.ts and passed in — this template is PURE: it does
 * not build the URL, read env, or know about tokens.
 */

import type { EmailTemplate } from "@/lib/email/types";

/** Data the beta-invite template renders from. */
export interface BetaInviteData {
  /** Absolute, ready-to-click registration URL carrying the invite token. */
  inviteUrl: string;
}

/** How long the invite is valid — mirrors the 14-day TTL the approve step sets. */
const EXPIRY_LABEL = "14 days";

export const betaInviteTemplate: EmailTemplate<BetaInviteData> = {
  name: "beta-invite",
  sender: "beta-invite",
  render(data: BetaInviteData) {
    return {
      subject: "You're invited to Fourth Meridian",
      text:
        `You've been approved for early access to Fourth Meridian.\n\n` +
        `Create your account using the link below:\n` +
        `${data.inviteUrl}\n\n` +
        `This invitation is tied to this email address and expires in ` +
        `${EXPIRY_LABEL}.\n\n` +
        `If you didn't request access to Fourth Meridian, you can safely ignore ` +
        `this email.\n`,
    };
  },
};
