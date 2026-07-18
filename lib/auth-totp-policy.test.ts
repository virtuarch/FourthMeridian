/**
 * lib/auth-totp-policy.test.ts
 *
 * Unit tests for the PO-1 mandatory-MFA rule. Pure — no DB, no session.
 * Locks the invariant "no password-only path to admin power" and proves
 * customer authentication is unchanged.
 */

import { UserRole } from "@prisma/client";
import { requiresTotpEnrollment } from "@/lib/auth-totp-policy";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

console.log("auth-totp-policy — mandatory MFA for SYSTEM_ADMIN (PO-1)");

// ── SYSTEM_ADMIN: mandatory, independent of settings ──────────────────────────
check(
  "un-enrolled SYSTEM_ADMIN is forced into enrolment even when all settings off",
  requiresTotpEnrollment({ role: UserRole.SYSTEM_ADMIN, totpEnabled: false, requireTotpAllUsers: false }) === true,
);
check(
  "un-enrolled SYSTEM_ADMIN is forced into enrolment when all-users is on too",
  requiresTotpEnrollment({ role: UserRole.SYSTEM_ADMIN, totpEnabled: false, requireTotpAllUsers: true }) === true,
);
check(
  "ENROLLED SYSTEM_ADMIN is NOT re-forced (the live TOTP challenge handles them)",
  requiresTotpEnrollment({ role: UserRole.SYSTEM_ADMIN, totpEnabled: true, requireTotpAllUsers: false }) === false,
);

// ── Ordinary USER: opt-in only, unchanged ─────────────────────────────────────
check(
  "un-enrolled USER is NOT forced when require_totp_all_users is off (default — customer auth unchanged)",
  requiresTotpEnrollment({ role: UserRole.USER, totpEnabled: false, requireTotpAllUsers: false }) === false,
);
check(
  "un-enrolled USER IS forced when the operator turns on require_totp_all_users",
  requiresTotpEnrollment({ role: UserRole.USER, totpEnabled: false, requireTotpAllUsers: true }) === true,
);
check(
  "enrolled USER is never forced",
  requiresTotpEnrollment({ role: UserRole.USER, totpEnabled: true, requireTotpAllUsers: true }) === false,
);

if (failures > 0) {
  console.error(`\nauth-totp-policy: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nauth-totp-policy: all checks passed.");
