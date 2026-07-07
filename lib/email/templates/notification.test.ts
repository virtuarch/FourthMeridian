/**
 * lib/email/templates/notification.test.ts  (OPS-3 S4)
 *
 * Pure guards for the generic product-notification template. Standalone tsx
 * script (house pattern): npx tsx lib/email/templates/notification.test.ts —
 * exits 0/1. No DB, no network.
 */

import { notificationTemplate } from "@/lib/email/templates/notification";
import { getTemplate } from "@/lib/email/templates";
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

console.log("notification email template");

// Registry wiring.
check("registered under the 'notification' key", getTemplate("notification") === (notificationTemplate as never));
check("sends as the product-notification purpose", notificationTemplate.sender === "product-notification");
check(
  "product-notification resolves to notifications@ (the OPS-1 S0 reserved identity)",
  resolveSender("product-notification").from.includes("notifications@fourthmeridian.com"),
);

// Full render: title + body + action link + the why-am-I-getting-this line.
{
  const { subject, text } = notificationTemplate.render({
    title: "Chase needs attention",
    body: "We couldn't sync this institution. Reconnect to resume updates.",
    actionUrl: "https://app.fourthmeridian.com/dashboard/connections",
  });
  check("subject is the notification title", subject === "Chase needs attention");
  check("text carries the body", text.includes("We couldn't sync this institution."));
  check("text carries the action link", text.includes("View in Fourth Meridian: https://app.fourthmeridian.com/dashboard/connections"));
  check("text explains the preference provenance", text.includes("Settings → Notifications"));
}

// Minimal render: title only — no dangling link line, no empty paragraphs.
{
  const { subject, text } = notificationTemplate.render({ title: "Recovery codes regenerated" });
  check("title-only render works", subject === "Recovery codes regenerated");
  check("no action-link line when no actionUrl", !text.includes("View in Fourth Meridian"));
  check("no empty paragraphs", !text.includes("\n\n\n"));
}

if (failures > 0) {
  console.error(`\nnotification template tests: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nnotification template tests: all passed");
process.exit(0);
