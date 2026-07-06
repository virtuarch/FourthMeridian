/**
 * lib/email/invite-url.test.ts  (OPS-1 S3)
 *
 * Pure guards for buildInviteUrl. Standalone tsx script (house pattern):
 *
 *     npx tsx lib/email/invite-url.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network, no env.
 */

import { buildInviteUrl } from "@/lib/email/invite-url";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("buildInviteUrl");

check(
  "points at the in-app /dashboard/spaces surface",
  buildInviteUrl("https://app.fourthmeridian.com") ===
    "https://app.fourthmeridian.com/dashboard/spaces",
  buildInviteUrl("https://app.fourthmeridian.com"),
);

check(
  "normalises trailing slashes (no double slash)",
  buildInviteUrl("http://localhost:3000///") === "http://localhost:3000/dashboard/spaces",
  buildInviteUrl("http://localhost:3000///"),
);

check(
  "carries no token or query string",
  !buildInviteUrl("https://x.com").includes("?") && !buildInviteUrl("https://x.com").includes("token"),
  buildInviteUrl("https://x.com"),
);

check(
  "uses ONLY the supplied trusted base",
  buildInviteUrl("https://trusted.example").startsWith("https://trusted.example/"),
);

console.log(
  failures === 0 ? "\nAll buildInviteUrl checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
