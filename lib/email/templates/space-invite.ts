/**
 * lib/email/templates/space-invite.ts  (OPS-1 S3 → email design system)
 *
 * The Space-invitation notification email. Sends as the `space-invite` identity
 * (support@fourthmeridian.com — see lib/email/senders.ts), standard variant.
 *
 * NOTIFICATION, not a token link: the invitee already has an account and
 * accepts in-app. This email points them at /dashboard/spaces (built by
 * lib/email/invite-url.ts); it grants nothing on its own.
 *
 * PURE: renders from pre-resolved data. It does not build the URL, read env, or
 * query the DB — the invite route passes everything in. Space and inviter
 * names are user-chosen: cleanText() collapses them to one line and the design
 * system escapes them in the HTML part.
 */

import type { EmailTemplate } from "@/lib/email/types";
import { renderEmail, type RenderedEmail } from "@/lib/email/design/render";
import type { EmailBrandConfig } from "@/lib/email/design/config";
import { cleanText } from "@/lib/email/design/escape";

/** Data the space-invite template renders from. */
export interface SpaceInviteData {
  /** Name of the Space the recipient was invited to. */
  spaceName: string;
  /** Display name/handle of the person who sent the invite. */
  inviterName: string;
  /** Role the invite grants (OWNER | ADMIN | MEMBER | VIEWER). */
  role: string;
  /** Absolute CTA link to the in-app invites surface (built via buildInviteUrl). */
  inviteUrl: string;
  /** Preview tool only: prefixes the subject "[PREVIEW] ". */
  preview?: boolean;
}

export function renderSpaceInvite(data: SpaceInviteData, opts: { brand?: EmailBrandConfig } = {}): RenderedEmail {
  const space = cleanText(String(data.spaceName ?? ""), 120);
  const inviter = cleanText(String(data.inviterName ?? ""), 80);
  const roleLabel = String(data.role ?? "").toLowerCase();
  return renderEmail({
    subject: `${data.preview === true ? "[PREVIEW] " : ""}You've been invited to ${space} on Fourth Meridian`,
    preheader: `${inviter} invited you to join ${space} as a ${roleLabel}.`,
    blocks: [
      { kind: "hero", heading: `You've been invited to ${space}` },
      { kind: "paragraph", text: `${inviter} invited you to join the Space "${space}" on Fourth Meridian as a ${roleLabel}.` },
      { kind: "cta", label: "Review invitation", url: data.inviteUrl },
      { kind: "paragraph", text: "Sign in to review and accept the invitation. If you haven't verified your email yet, you'll need to do that before signing in." },
      { kind: "security", text: "If you weren't expecting this invitation, you can ignore this email." },
    ],
    footer: { reason: "You're receiving this email because a member of a Fourth Meridian Space invited your account." },
    ...(opts.brand ? { brand: opts.brand } : {}),
  });
}

export const spaceInviteTemplate: EmailTemplate<SpaceInviteData> = {
  name: "space-invite",
  sender: "space-invite",
  render(data: SpaceInviteData) {
    return renderSpaceInvite(data);
  },
};
