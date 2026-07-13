/**
 * lib/email/templates/beta-invite.test.ts  (Wave 1 S3)
 *
 * Pure guards for the beta-invite template. Standalone tsx script:
 *
 *     npx tsx lib/email/templates/beta-invite.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { betaInviteTemplate } from "@/lib/email/templates/beta-invite";
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

const INVITE_URL = "https://app.fourthmeridian.com/register?invite=deadbeef";
const rendered = betaInviteTemplate.render({ inviteUrl: INVITE_URL });

console.log("beta-invite template");

check("subject invites to Fourth Meridian", /invited to fourth meridian/i.test(rendered.subject), rendered.subject);
check("body is plain text (no HTML tags)", !/<[^>]+>/.test(rendered.text));
check("body contains the exact invite URL passed in", rendered.text.includes(INVITE_URL), rendered.text);
check("body communicates the 14-day expiry", /14 days/i.test(rendered.text));
check("body is honest that the invite is email-bound", /tied to this email/i.test(rendered.text));
check(
  "body includes a did-not-request safety line",
  /didn't request|did not request/i.test(rendered.text),
);
check(
  "sends as the beta@ identity",
  resolveSender(betaInviteTemplate.sender).from === "Fourth Meridian Beta <beta@fourthmeridian.com>",
  resolveSender(betaInviteTemplate.sender).from,
);

console.log(
  failures === 0 ? "\nAll beta-invite template checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
