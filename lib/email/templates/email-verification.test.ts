/**
 * lib/email/templates/email-verification.test.ts  (OPS-1 S2b)
 *
 * Pure guards for the email-verification template. Standalone tsx script:
 *
 *     npx tsx lib/email/templates/email-verification.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { emailVerificationTemplate } from "@/lib/email/templates/email-verification";
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

const VERIFY_URL = "https://app.fourthmeridian.com/verify-email?token=deadbeef";
const rendered = emailVerificationTemplate.render({ verifyUrl: VERIFY_URL });

console.log("email-verification template");

check(
  "subject is the fixed verify line",
  rendered.subject === "Verify your Fourth Meridian email",
  rendered.subject,
);

check("body is plain text (no HTML tags)", !/<[^>]+>/.test(rendered.text));

check(
  "body contains the exact verify URL passed in",
  rendered.text.includes(VERIFY_URL),
  rendered.text,
);

check("body communicates the expiry", /expires in 1 hour/i.test(rendered.text));

check(
  "body includes a did-not-sign-up safety line",
  /didn't create|did not create/i.test(rendered.text),
);

check(
  "sends as the support@ identity",
  resolveSender(emailVerificationTemplate.sender).from ===
    "Fourth Meridian <support@fourthmeridian.com>",
  resolveSender(emailVerificationTemplate.sender).from,
);

console.log(
  failures === 0 ? "\nAll email-verification template checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
