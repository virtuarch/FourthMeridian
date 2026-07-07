/**
 * lib/email/email-change-confirm.test.ts  (OPS-2 UX fix)
 *
 * Pure guards for the idempotent change-email confirm predicate. Standalone
 * tsx script:
 *
 *     npx tsx lib/email/email-change-confirm.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

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

console.log("email-change-confirm");

// Non-email tokens on purpose — the predicate is a pure lowercase string
// compare, and this keeps the distinct "old" vs "new" values distinct.

// First confirm: email still differs from pendingEmail → NOT yet applied → swap.
check(
  "pre-swap (email != pendingEmail) → not applied",
  isEmailChangeAlreadyApplied({ email: "old-address", pendingEmail: "new-address" }) === false,
);

// Repeat confirm after the swap: email now equals pendingEmail → applied → idempotent success.
check(
  "post-swap (email == pendingEmail) → already applied",
  isEmailChangeAlreadyApplied({ email: "new-address", pendingEmail: "new-address" }) === true,
);

// Case-insensitive (defense-in-depth; both columns are normalized lowercase).
check(
  "case-insensitive match → already applied",
  isEmailChangeAlreadyApplied({ email: "New-Address", pendingEmail: "new-address" }) === true,
);

// No pending change at all → not applied (route returns "invalid" upstream on null pending).
check(
  "no pendingEmail → not applied",
  isEmailChangeAlreadyApplied({ email: "old-address", pendingEmail: null }) === false,
);

console.log(failures === 0 ? "\nAll email-change-confirm checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
