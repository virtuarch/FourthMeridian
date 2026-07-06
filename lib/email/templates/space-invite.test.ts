/**
 * lib/email/templates/space-invite.test.ts  (OPS-1 S3)
 *
 * Pure guards for the space-invite template. Standalone tsx script:
 *
 *     npx tsx lib/email/templates/space-invite.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { spaceInviteTemplate } from "@/lib/email/templates/space-invite";
import { resolveSender } from "@/lib/email/senders";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const INVITE_URL = "https://app.fourthmeridian.com/dashboard/spaces";
const rendered = spaceInviteTemplate.render({
  spaceName:   "Hogan Household",
  inviterName: "Chris",
  role:        "MEMBER",
  inviteUrl:   INVITE_URL,
});

console.log("space-invite template");

check(
  "subject names the Space",
  rendered.subject === "You've been invited to Hogan Household on Fourth Meridian",
  rendered.subject,
);

check("body is plain text (no HTML tags)", !/<[^>]+>/.test(rendered.text));

check("body names the inviter", rendered.text.includes("Chris"), rendered.text);
check("body names the Space", rendered.text.includes("Hogan Household"));
check("body states the role (lowercased)", rendered.text.includes("member"));
check("body contains the exact CTA link", rendered.text.includes(INVITE_URL));

check(
  "body carries no token (identity-gated acceptance)",
  !rendered.text.includes("token="),
);

check(
  "sends as the support@ identity",
  resolveSender(spaceInviteTemplate.sender).from ===
    "Fourth Meridian <support@fourthmeridian.com>",
  resolveSender(spaceInviteTemplate.sender).from,
);

console.log(
  failures === 0 ? "\nAll space-invite template checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
