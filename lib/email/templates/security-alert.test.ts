/**
 * lib/email/templates/security-alert.test.ts  (OPS-2 S2)
 *
 * Pure guards for the generic security-alert template. Standalone tsx script:
 *
 *     npx tsx lib/email/templates/security-alert.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { securityAlertTemplate } from "@/lib/email/templates/security-alert";
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

const rendered = securityAlertTemplate.render({
  title:   "Your password was changed",
  message: "Your Fourth Meridian password was changed on Jan 1, 2026, 12:00 PM.",
});

console.log("security-alert template");

check(
  "subject includes the title",
  rendered.subject === "Fourth Meridian security alert: Your password was changed",
  rendered.subject,
);

check("body is plain text (no HTML tags)", !/<[^>]+>/.test(rendered.text));

check(
  "body contains the message",
  rendered.text.includes("Your Fourth Meridian password was changed on"),
  rendered.text,
);

check(
  "body includes a what-to-do-if-not-you line",
  /don't recognize|reset your password/i.test(rendered.text),
);

check(
  "sends as the support@ security identity",
  resolveSender(securityAlertTemplate.sender).from ===
    "Fourth Meridian <support@fourthmeridian.com>",
  resolveSender(securityAlertTemplate.sender).from,
);

console.log(
  failures === 0 ? "\nAll security-alert template checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
