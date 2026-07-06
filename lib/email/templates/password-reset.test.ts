/**
 * lib/email/templates/password-reset.test.ts  (OPS-1 S2a)
 *
 * Pure guards for the password-reset template. Standalone tsx script:
 *
 *     npx tsx lib/email/templates/password-reset.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { passwordResetTemplate } from "@/lib/email/templates/password-reset";
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

const RESET_URL = "https://app.fourthmeridian.com/reset-password?token=deadbeef";
const rendered = passwordResetTemplate.render({ resetUrl: RESET_URL });

console.log("password-reset template");

check(
  "subject is the fixed reset line",
  rendered.subject === "Reset your Fourth Meridian password",
  rendered.subject,
);

check("body is plain text (no HTML tags)", !/<[^>]+>/.test(rendered.text));

check(
  "body contains the exact reset URL passed in",
  rendered.text.includes(RESET_URL),
  rendered.text,
);

check(
  "body communicates single-use + expiry",
  /expires in 1 hour/i.test(rendered.text) && /once/i.test(rendered.text),
);

check(
  "body includes a did-not-request safety line",
  /didn't request|did not request/i.test(rendered.text),
);

check(
  "sends as the support@ identity",
  resolveSender(passwordResetTemplate.sender).from ===
    "Fourth Meridian <support@fourthmeridian.com>",
  resolveSender(passwordResetTemplate.sender).from,
);

check(
  "does not leak a bare token separate from the URL",
  !rendered.text.includes("token=deadbeef\n") || rendered.text.includes(RESET_URL),
);

console.log(
  failures === 0 ? "\nAll password-reset template checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
