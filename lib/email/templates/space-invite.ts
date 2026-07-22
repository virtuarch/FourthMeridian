/**
 * lib/email/templates/space-invite.ts  (OPS-1 S3)
 *
 * The Space-invitation notification email. Text-first, sends as the
 * `space-invite` identity (support@fourthmeridian.com — see lib/email/senders.ts).
 *
 * NOTIFICATION, not a token link: the invitee already has an account and
 * accepts in-app. This email points them at /dashboard/spaces (built by
 * lib/email/invite-url.ts); it grants nothing on its own.
 *
 * PURE: renders subject + text from pre-resolved data. It does not build the
 * URL, read env, or query the DB — the invite route passes everything in.
 */

import type { EmailTemplate } from "@/lib/email/types";

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
}

export const spaceInviteTemplate: EmailTemplate<SpaceInviteData> = {
  name: "space-invite",
  sender: "space-invite",
  render(data: SpaceInviteData) {
    const roleLabel = data.role.toLowerCase();
    return {
      subject: `You've been invited to ${data.spaceName} on Fourth Meridian`,
      text:
        `${data.inviterName} invited you to join the Space "${data.spaceName}" ` +
        `on Fourth Meridian as a ${roleLabel}.\n\n` +
        `Sign in to review and accept the invitation:\n` +
        `${data.inviteUrl}\n\n` +
        `If you haven't verified your email yet, you'll need to do that before ` +
        `signing in. If you weren't expecting this invitation, you can ignore ` +
        `this email.\n`,
    };
  },
};
