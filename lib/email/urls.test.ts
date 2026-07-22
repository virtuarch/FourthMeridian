/**
 * lib/email/urls.test.ts
 *
 * Consolidated pure guards for every transactional-email URL builder plus the
 * idempotent change-email confirm predicate. Standalone tsx script (house
 * pattern):
 *
 *     npx tsx lib/email/urls.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network, no env.
 *
 * TEST-2 consolidation: replaces the per-builder micro-suites
 *   beta-invite-url · email-change-url · invite-url · reset-url · verify-url
 *   · email-change-confirm
 * with one table-driven suite. Every builder is checked for base assembly,
 * trailing-slash normalization (single AND multiple — the union of what the
 * originals covered, applied to all), token URL-encoding, and the
 * trusted-base-only trust boundary.
 */

import { buildBetaInviteUrl } from "@/lib/email/beta-invite-url";
import { buildEmailChangeUrl } from "@/lib/email/email-change-url";
import { buildInviteUrl } from "@/lib/email/invite-url";
import { buildResetUrl } from "@/lib/email/reset-url";
import { buildVerifyUrl } from "@/lib/email/verify-url";
import { isEmailChangeAlreadyApplied } from "@/lib/email/email-change-confirm";

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

// ── Token-carrying URL builders (base, token) → base + path?param=token ──────
// Each row is the builder's identity: the path it targets and the query param
// name it uses. buildInviteUrl carries no token and is exercised separately.
const TOKEN_BUILDERS: {
  name: string;
  fn: (base: string, token: string) => string;
  path: string;
  param: string;
}[] = [
  { name: "buildBetaInviteUrl", fn: buildBetaInviteUrl, path: "/register", param: "invite" },
  { name: "buildEmailChangeUrl", fn: buildEmailChangeUrl, path: "/confirm-email-change", param: "token" },
  { name: "buildResetUrl", fn: buildResetUrl, path: "/reset-password", param: "token" },
  { name: "buildVerifyUrl", fn: buildVerifyUrl, path: "/verify-email", param: "token" },
];

for (const { name, fn, path, param } of TOKEN_BUILDERS) {
  console.log(name);
  const expect = (host: string, token: string) => `${host}${path}?${param}=${token}`;

  check(
    `assembles base + ${path}?${param}=`,
    fn("https://app.fourthmeridian.com", TOKEN) === expect("https://app.fourthmeridian.com", "abc123"),
    fn("https://app.fourthmeridian.com", TOKEN),
  );
  check(
    "normalises a single trailing slash (no double slash)",
    fn("https://app.fourthmeridian.com/", TOKEN) === expect("https://app.fourthmeridian.com", "abc123"),
    fn("https://app.fourthmeridian.com/", TOKEN),
  );
  check(
    "normalises multiple trailing slashes",
    fn("http://localhost:3000///", TOKEN) === expect("http://localhost:3000", "abc123"),
    fn("http://localhost:3000///", TOKEN),
  );
  check(
    "URL-encodes the token",
    fn("https://x.com", "a b/c&d") === expect("https://x.com", "a%20b%2Fc%26d"),
    fn("https://x.com", "a b/c&d"),
  );
  check(
    "uses ONLY the supplied base (host-injection safety is the caller's trust boundary)",
    fn("https://trusted.example", TOKEN).startsWith("https://trusted.example/"),
  );
}

// ── buildInviteUrl — no token, points at the in-app spaces surface ───────────
console.log("buildInviteUrl");
check(
  "points at the in-app /dashboard/spaces surface",
  buildInviteUrl("https://app.fourthmeridian.com") === "https://app.fourthmeridian.com/dashboard/spaces",
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

// ── isEmailChangeAlreadyApplied — idempotent confirm predicate ───────────────
// Non-email tokens on purpose — the predicate is a pure lowercase string
// compare, and this keeps the distinct "old" vs "new" values distinct.
console.log("isEmailChangeAlreadyApplied");
check(
  "pre-swap (email != pendingEmail) → not applied",
  isEmailChangeAlreadyApplied({ email: "old-address", pendingEmail: "new-address" }) === false,
);
check(
  "post-swap (email == pendingEmail) → already applied",
  isEmailChangeAlreadyApplied({ email: "new-address", pendingEmail: "new-address" }) === true,
);
check(
  "case-insensitive match → already applied",
  isEmailChangeAlreadyApplied({ email: "New-Address", pendingEmail: "new-address" }) === true,
);
check(
  "no pendingEmail → not applied",
  isEmailChangeAlreadyApplied({ email: "old-address", pendingEmail: null }) === false,
);

console.log(failures === 0 ? "\nAll email URL builder checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
