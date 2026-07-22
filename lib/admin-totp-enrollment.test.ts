/**
 * lib/admin-totp-enrollment.test.ts
 *
 * PO-1A — unit tests for the forced-enrolment rules. Pure: no DB, no session,
 * no browser.
 *
 * These prove the four required behaviours at the level where the decision is
 * actually made. requireSystemAdmin() / requireFreshSystemAdmin() delegate to
 * decideAdminApiAccess(), and app/admin/security/page.tsx branches on
 * resolveAdminTotpPhase(), so what is asserted here is what production runs —
 * the source-scan companion (admin-totp-enrollment-surface.test.ts) locks that
 * delegation in place.
 */

import { UserRole } from "@prisma/client";
import {
  decideAdminApiAccess,
  resolveAdminTotpPhase,
  totpEnrollmentPathFor,
  ADMIN_TOTP_ENROLLMENT_PATH,
  USER_TOTP_ENROLLMENT_PATH,
} from "@/lib/admin-totp-enrollment";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

console.log("admin-totp-enrollment — forced enrolment rules (PO-1A)");

// ── A pending SYSTEM_ADMIN cannot reach the admin security APIs ───────────────
console.log("\n1. Pending SYSTEM_ADMIN is denied the admin APIs");
check(
  "pending SYSTEM_ADMIN is FORBIDDEN_PENDING (not ALLOW)",
  decideAdminApiAccess({ role: UserRole.SYSTEM_ADMIN, requireTotpSetup: true }) === "FORBIDDEN_PENDING",
);
check(
  "the enrolment gate is what rejects — not the role check",
  decideAdminApiAccess({ role: UserRole.SYSTEM_ADMIN, requireTotpSetup: true }) !== "FORBIDDEN_ROLE",
);

// ── A completed SYSTEM_ADMIN CAN reach them ──────────────────────────────────
console.log("\n2. Enrolled SYSTEM_ADMIN is allowed");
check(
  "enrolled SYSTEM_ADMIN is ALLOW",
  decideAdminApiAccess({ role: UserRole.SYSTEM_ADMIN, requireTotpSetup: false }) === "ALLOW",
);

// ── Non-admins are rejected on role, pending or not ──────────────────────────
// UserRole has exactly two members (USER, SYSTEM_ADMIN) — enumerate the enum
// rather than a hand-written list so a future role cannot be added without this
// test being confronted with it.
const NON_ADMIN_ROLES = Object.values(UserRole).filter((r) => r !== UserRole.SYSTEM_ADMIN);

console.log("\n3. Non-admins are rejected on role first");
check(
  "the role enum is fully covered by this test",
  NON_ADMIN_ROLES.length === Object.values(UserRole).length - 1 &&
    NON_ADMIN_ROLES.length > 0,
);
for (const role of NON_ADMIN_ROLES) {
  check(
    `${role} is FORBIDDEN_ROLE when enrolled`,
    decideAdminApiAccess({ role, requireTotpSetup: false }) === "FORBIDDEN_ROLE",
  );
  check(
    `${role} is FORBIDDEN_ROLE when pending (role precedes enrolment — leaks nothing)`,
    decideAdminApiAccess({ role, requireTotpSetup: true }) === "FORBIDDEN_ROLE",
  );
}
check(
  "no input combination yields ALLOW for a non-admin",
  NON_ADMIN_ROLES.every((role) =>
    [true, false].every((requireTotpSetup) =>
      decideAdminApiAccess({ role, requireTotpSetup }) !== "ALLOW")),
);

// ── V25-FINAL-2: DISABLE_SYSTEM_ADMIN kill switch binds the runtime decision ──
console.log("\n3b. DISABLE_SYSTEM_ADMIN denies even an enrolled SYSTEM_ADMIN");
check(
  "kill switch ON ⇒ enrolled SYSTEM_ADMIN is FORBIDDEN_DISABLED (not ALLOW)",
  decideAdminApiAccess({ role: UserRole.SYSTEM_ADMIN, requireTotpSetup: false, systemAdminDisabled: true }) === "FORBIDDEN_DISABLED",
);
check(
  "kill switch ON ⇒ still ALLOW is impossible for a SYSTEM_ADMIN in any enrolment state",
  [true, false].every((requireTotpSetup) =>
    decideAdminApiAccess({ role: UserRole.SYSTEM_ADMIN, requireTotpSetup, systemAdminDisabled: true }) !== "ALLOW"),
);
check(
  "kill switch is checked AFTER role — a non-admin is still FORBIDDEN_ROLE, not FORBIDDEN_DISABLED (leaks nothing)",
  NON_ADMIN_ROLES.every((role) =>
    decideAdminApiAccess({ role, requireTotpSetup: false, systemAdminDisabled: true }) === "FORBIDDEN_ROLE"),
);
check(
  "kill switch OFF/absent ⇒ prior behavior byte-for-byte (enrolled admin ALLOW)",
  decideAdminApiAccess({ role: UserRole.SYSTEM_ADMIN, requireTotpSetup: false, systemAdminDisabled: false }) === "ALLOW" &&
  decideAdminApiAccess({ role: UserRole.SYSTEM_ADMIN, requireTotpSetup: false }) === "ALLOW",
);
check(
  "kill switch precedes the enrolment gate (emergency lockout is not evadable via enrolment state)",
  decideAdminApiAccess({ role: UserRole.SYSTEM_ADMIN, requireTotpSetup: true, systemAdminDisabled: true }) === "FORBIDDEN_DISABLED",
);

// ── The surface choice agrees with the API decision ──────────────────────────
console.log("\n4. The rendered surface agrees with the API decision");
check(
  "pending session renders ENROLLING",
  resolveAdminTotpPhase({ requireTotpSetup: true }) === "ENROLLING",
);
check(
  "enrolled session renders ENROLLED",
  resolveAdminTotpPhase({ requireTotpSetup: false }) === "ENROLLED",
);
// The dead-end was precisely a disagreement here: the console rendered while
// every fetch it owned 403'd. Lock the two rules to the same input.
check(
  "the console is NEVER rendered in a phase where the admin APIs would 403",
  [true, false].every((requireTotpSetup) => {
    const phase   = resolveAdminTotpPhase({ requireTotpSetup });
    const apiOpen = decideAdminApiAccess({ role: UserRole.SYSTEM_ADMIN, requireTotpSetup }) === "ALLOW";
    return (phase === "ENROLLED") === apiOpen;
  }),
);

// ── Enrolment surfaces ───────────────────────────────────────────────────────
console.log("\n5. Enrolment surfaces");
check(
  "SYSTEM_ADMIN enrols at the admin security page",
  totpEnrollmentPathFor(UserRole.SYSTEM_ADMIN) === ADMIN_TOTP_ENROLLMENT_PATH,
);
check(
  "every non-admin role enrols at the settings security SECTION",
  NON_ADMIN_ROLES.every((role) => totpEnrollmentPathFor(role) === USER_TOTP_ENROLLMENT_PATH),
);
check(
  "both surfaces request enforced mode",
  [ADMIN_TOTP_ENROLLMENT_PATH, USER_TOTP_ENROLLMENT_PATH]
    .every((p) => p.includes("setup2fa=true")),
);
// Regression guard: the user path pointed at the settings INDEX, which is a
// server redirect to …/account and drops the query string — the param never
// survived to the page that renders the widget.
check(
  "the user surface is NOT the settings index (its redirect drops the query string)",
  !/\/dashboard\/settings\?/.test(USER_TOTP_ENROLLMENT_PATH) &&
  USER_TOTP_ENROLLMENT_PATH.startsWith("/dashboard/settings/security"),
);

if (failures > 0) {
  console.error(`\nadmin-totp-enrollment: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nadmin-totp-enrollment: all checks passed.");
