/**
 * lib/platform/email-health.test.ts  (OBS-008 / UI-011)
 *
 * The direct-send coverage declaration is configuration-derived and names the
 * transport the chokepoint would select; the vocabulary never says "delivered".
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/email-health.test.ts
 */

import { DIRECT_SEND_TEMPLATES, EMAIL_STAGE_WORD, describeDirectSendCoverage } from "./email-health";

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("direct-send coverage");
{
  const noKey = describeDirectSendCoverage({ NODE_ENV: "production", RESEND_API_KEY: undefined });
  check("no key ⇒ capture, not real, says 'reach nobody'", noKey.transport === "capture" && !noKey.real && /reach nobody/.test(noKey.note));
  const key = describeDirectSendCoverage({ NODE_ENV: "production", RESEND_API_KEY: "re_x" });
  check("key ⇒ resend, real", key.transport === "resend" && key.real);
  const test = describeDirectSendCoverage({ NODE_ENV: "test", RESEND_API_KEY: "re_x" });
  check("test mode ⇒ capture even with a key (mirrors send.ts)", test.transport === "capture");
  check("the platform-alert and security-alert families are declared", DIRECT_SEND_TEMPLATES.includes("platform-alert") && DIRECT_SEND_TEMPLATES.includes("security-alert"));
  check("no note claims delivery", !/delivered/i.test(noKey.note) && !/delivered/i.test(key.note));

  // Non-production recipient guard — reported as configuration, count only.
  const prod = describeDirectSendCoverage({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", RESEND_API_KEY: "re_x" });
  check("Production ⇒ guard inactive, note says nothing about capture", !prod.recipientGuard.active && prod.recipientGuard.environment === "production" && !/captured/.test(prod.note));
  const previewEmpty = describeDirectSendCoverage({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production", RESEND_API_KEY: "re_x" });
  check("Preview, no allowlist ⇒ guard active, 0 addresses, every recipient captured", previewEmpty.recipientGuard.active && previewEmpty.recipientGuard.allowlistCount === 0 && /every recipient is captured/.test(previewEmpty.note));
  const previewList = describeDirectSendCoverage({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production", RESEND_API_KEY: "re_x", EMAIL_NONPROD_ALLOWLIST: "a@example.test, B@example.test ,," });
  check("Preview with allowlist ⇒ count only, never the addresses", previewList.recipientGuard.allowlistCount === 2 && !JSON.stringify(previewList).includes("example.test"));
  check("'key ⇒ resend' off Vercel is NOT Production for email (guard active)", key.recipientGuard.active && key.recipientGuard.environment === "unknown");
  check("captured is its own stage, not a failure", EMAIL_STAGE_WORD.captured !== EMAIL_STAGE_WORD.failed && /not sent to any provider/.test(EMAIL_STAGE_WORD.captured));
}

console.log("vocabulary");
{
  check("'sent' is worded as accepted by the provider, never delivered", /accepted by the provider/.test(EMAIL_STAGE_WORD.accepted) && !Object.values(EMAIL_STAGE_WORD).some((w) => /delivered/.test(w)));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
