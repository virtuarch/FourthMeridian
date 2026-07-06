/**
 * lib/email/email-change-url.test.ts  (OPS-2 S3a)
 *
 * Pure guards for buildEmailChangeUrl. Standalone tsx script:
 *
 *     npx tsx lib/email/email-change-url.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network, no env.
 */

import { buildEmailChangeUrl } from "@/lib/email/email-change-url";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TOKEN = "abc123";

console.log("buildEmailChangeUrl");

check(
  "points at /confirm-email-change with the token",
  buildEmailChangeUrl("https://app.fourthmeridian.com", TOKEN) ===
    "https://app.fourthmeridian.com/confirm-email-change?token=abc123",
  buildEmailChangeUrl("https://app.fourthmeridian.com", TOKEN),
);

check(
  "normalises trailing slashes (no double slash)",
  buildEmailChangeUrl("http://localhost:3000///", TOKEN) ===
    "http://localhost:3000/confirm-email-change?token=abc123",
  buildEmailChangeUrl("http://localhost:3000///", TOKEN),
);

check(
  "URL-encodes the token",
  buildEmailChangeUrl("https://x.com", "a b/c&d") ===
    "https://x.com/confirm-email-change?token=a%20b%2Fc%26d",
  buildEmailChangeUrl("https://x.com", "a b/c&d"),
);

check(
  "uses ONLY the supplied trusted base",
  buildEmailChangeUrl("https://trusted.example", TOKEN).startsWith("https://trusted.example/"),
);

console.log(
  failures === 0 ? "\nAll buildEmailChangeUrl checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
