/**
 * lib/email/templates/email-change.test.ts  (OPS-2 S3a)
 *
 * Pure guards for the email-change template. Standalone tsx script:
 *
 *     npx tsx lib/email/templates/email-change.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { emailChangeTemplate } from "@/lib/email/templates/email-change";
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

const CONFIRM_URL = "https://app.fourthmeridian.com/confirm-email-change?token=deadbeef";
const rendered = emailChangeTemplate.render({ confirmUrl: CONFIRM_URL });

console.log("email-change template");

check(
  "subject asks to confirm the new email",
  rendered.subject === "Confirm your new Fourth Meridian email",
  rendered.subject,
);

check("body is plain text (no HTML tags)", !/<[^>]+>/.test(rendered.text));

check(
  "body contains the exact confirm URL",
  rendered.text.includes(CONFIRM_URL),
  rendered.text,
);

check("body communicates the expiry", /expires in 1 hour/i.test(rendered.text));

check(
  "body states the change isn't applied until confirmed",
  /will not change until you confirm/i.test(rendered.text),
);

check(
  "sends as the support@ verification identity",
  resolveSender(emailChangeTemplate.sender).from ===
    "Fourth Meridian <support@fourthmeridian.com>",
  resolveSender(emailChangeTemplate.sender).from,
);

console.log(
  failures === 0 ? "\nAll email-change template checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
