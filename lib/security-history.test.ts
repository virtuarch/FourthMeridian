/**
 * lib/security-history.test.ts  (OPS-2 S1)
 *
 * Pure guards for the Security History allowlist + labels. Standalone tsx
 * script (house pattern):
 *
 *     npx tsx lib/security-history.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import {
  SECURITY_HISTORY_ACTIONS,
  isSecurityHistoryAction,
  securityHistoryLabel,
} from "@/lib/security-history";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("security-history allowlist");

// 1. Every surfaced security event is present, including the free-string ones.
const MUST_INCLUDE = [
  "REGISTER", "LOGIN", "LOGIN_FAILED", "LOGOUT",
  "PASSWORD_CHANGED", "PASSWORD_CHANGE_FAILED", "PASSWORD_RESET",
  "PASSWORD_RESET_REQUESTED", "PASSWORD_RESET_COMPLETE",
  "EMAIL_VERIFIED", "EMAIL_VERIFICATION_RESENT",
  "TWO_FACTOR_SETUP_STARTED", "TWO_FACTOR_ENABLED", "TWO_FACTOR_DISABLED", "TWO_FACTOR_RESET",
  "RECOVERY_CODE_USED", "RECOVERY_CODES_GENERATED", "RECOVERY_CODES_REGENERATED",
  "SESSION_REVOKED",
  "EMAIL_CHANGE_REQUESTED",
  "EMAIL_CHANGE_COMPLETED",
];
for (const a of MUST_INCLUDE) {
  check(`allowlist includes ${a}`, isSecurityHistoryAction(a));
}

// 2. Non-security / noisy actions must NEVER be surfaced.
const MUST_EXCLUDE = [
  "SPACE_SWITCH", "SPACE_CREATE", "GOAL_CREATED", "ACCOUNT_SHARED",
  "MEMBER_INVITED", "PLAID_SYNC", "IMPORT_BATCH_ROLLED_BACK",
  "AI_CONTEXT_ASSEMBLED", "ADMIN_SESSION_REVOKED",
];
for (const a of MUST_EXCLUDE) {
  check(`allowlist excludes ${a}`, !isSecurityHistoryAction(a), a);
}

// 3. The exported array and the membership check agree.
check(
  "SECURITY_HISTORY_ACTIONS matches isSecurityHistoryAction",
  SECURITY_HISTORY_ACTIONS.every(isSecurityHistoryAction) &&
    SECURITY_HISTORY_ACTIONS.length === MUST_INCLUDE.length,
  `count=${SECURITY_HISTORY_ACTIONS.length}`,
);

// 4. Labels: mapped actions get friendly text; unknown falls back to raw.
check("LOGIN label is friendly", securityHistoryLabel("LOGIN") === "Signed in");
check("LOGIN_FAILED label is friendly", securityHistoryLabel("LOGIN_FAILED") === "Failed sign-in attempt");
check("unknown action falls back to raw", securityHistoryLabel("NOPE_XYZ") === "NOPE_XYZ");
check("every allowlisted action has a non-raw label",
  SECURITY_HISTORY_ACTIONS.every((a) => securityHistoryLabel(a) !== a));

console.log(
  failures === 0 ? "\nAll security-history checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
