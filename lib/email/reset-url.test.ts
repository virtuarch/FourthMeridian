/**
 * lib/email/reset-url.test.ts  (OPS-1 S2a)
 *
 * Pure guards for buildResetUrl. Standalone tsx script (house pattern):
 *
 *     npx tsx lib/email/reset-url.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network, no env.
 */

import { buildResetUrl } from "@/lib/email/reset-url";

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

console.log("buildResetUrl");

check(
  "assembles base + /reset-password?token=",
  buildResetUrl("https://app.fourthmeridian.com", TOKEN) ===
    "https://app.fourthmeridian.com/reset-password?token=abc123",
  buildResetUrl("https://app.fourthmeridian.com", TOKEN),
);

check(
  "normalises a trailing slash (no double slash)",
  buildResetUrl("https://app.fourthmeridian.com/", TOKEN) ===
    "https://app.fourthmeridian.com/reset-password?token=abc123",
  buildResetUrl("https://app.fourthmeridian.com/", TOKEN),
);

check(
  "normalises multiple trailing slashes",
  buildResetUrl("http://localhost:3000///", TOKEN) ===
    "http://localhost:3000/reset-password?token=abc123",
  buildResetUrl("http://localhost:3000///", TOKEN),
);

check(
  "URL-encodes the token",
  buildResetUrl("https://x.com", "a b/c&d") ===
    "https://x.com/reset-password?token=a%20b%2Fc%26d",
  buildResetUrl("https://x.com", "a b/c&d"),
);

check(
  "uses ONLY the supplied base (host-injection safety is the caller's trust boundary)",
  buildResetUrl("https://trusted.example", TOKEN).startsWith("https://trusted.example/"),
);

console.log(
  failures === 0 ? "\nAll buildResetUrl checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
