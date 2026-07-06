/**
 * lib/email/verify-url.test.ts  (OPS-1 S2b)
 *
 * Pure guards for buildVerifyUrl. Standalone tsx script (house pattern):
 *
 *     npx tsx lib/email/verify-url.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network, no env.
 */

import { buildVerifyUrl } from "@/lib/email/verify-url";

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

console.log("buildVerifyUrl");

check(
  "assembles base + /verify-email?token=",
  buildVerifyUrl("https://app.fourthmeridian.com", TOKEN) ===
    "https://app.fourthmeridian.com/verify-email?token=abc123",
  buildVerifyUrl("https://app.fourthmeridian.com", TOKEN),
);

check(
  "normalises trailing slashes (no double slash)",
  buildVerifyUrl("http://localhost:3000///", TOKEN) ===
    "http://localhost:3000/verify-email?token=abc123",
  buildVerifyUrl("http://localhost:3000///", TOKEN),
);

check(
  "URL-encodes the token",
  buildVerifyUrl("https://x.com", "a b/c&d") ===
    "https://x.com/verify-email?token=a%20b%2Fc%26d",
  buildVerifyUrl("https://x.com", "a b/c&d"),
);

check(
  "uses ONLY the supplied base (host-injection safety is the caller's trust boundary)",
  buildVerifyUrl("https://trusted.example", TOKEN).startsWith("https://trusted.example/"),
);

console.log(
  failures === 0 ? "\nAll buildVerifyUrl checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
