/**
 * lib/email/beta-invite-url.test.ts  (Wave 1 S3)
 *
 * Pure guards for buildBetaInviteUrl. Standalone tsx script (house pattern):
 *
 *     npx tsx lib/email/beta-invite-url.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network, no env.
 */

import { buildBetaInviteUrl } from "@/lib/email/beta-invite-url";

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

console.log("buildBetaInviteUrl");

check(
  "assembles base + /register?invite=",
  buildBetaInviteUrl("https://app.fourthmeridian.com", TOKEN) ===
    "https://app.fourthmeridian.com/register?invite=abc123",
  buildBetaInviteUrl("https://app.fourthmeridian.com", TOKEN),
);

check(
  "normalises a trailing slash (no double slash)",
  buildBetaInviteUrl("https://app.fourthmeridian.com/", TOKEN) ===
    "https://app.fourthmeridian.com/register?invite=abc123",
  buildBetaInviteUrl("https://app.fourthmeridian.com/", TOKEN),
);

check(
  "normalises multiple trailing slashes",
  buildBetaInviteUrl("http://localhost:3000///", TOKEN) ===
    "http://localhost:3000/register?invite=abc123",
  buildBetaInviteUrl("http://localhost:3000///", TOKEN),
);

check(
  "URL-encodes the token",
  buildBetaInviteUrl("https://x.com", "a b/c&d") ===
    "https://x.com/register?invite=a%20b%2Fc%26d",
  buildBetaInviteUrl("https://x.com", "a b/c&d"),
);

check(
  "uses ONLY the supplied base (host-injection safety is the caller's trust boundary)",
  buildBetaInviteUrl("https://trusted.example", TOKEN).startsWith("https://trusted.example/"),
);

console.log(
  failures === 0 ? "\nAll buildBetaInviteUrl checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
