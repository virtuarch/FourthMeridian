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
import {
  USER_SECURITY_HISTORY_ACTIONS,
  ADMIN_SECURITY_FILTER_ACTIONS,
  AuditAction,
} from "@/lib/audit-actions";

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
  "ACCOUNT_DEACTIVATED",
  "ACCOUNT_REACTIVATED",
  "DATA_EXPORTED",
  "ACCOUNT_DELETION_REQUESTED",
  "ACCOUNT_DELETION_CANCELLED",
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

// 5. SEC-1 — the allowlist is DERIVED from the single canonical view, not a
//    parallel hand-typed list. The two must be identical, in order.
check(
  "SECURITY_HISTORY_ACTIONS is derived from canon USER_SECURITY_HISTORY_ACTIONS",
  SECURITY_HISTORY_ACTIONS.length === USER_SECURITY_HISTORY_ACTIONS.length &&
    SECURITY_HISTORY_ACTIONS.every((a, i) => a === USER_SECURITY_HISTORY_ACTIONS[i]),
);

// 6. SEC-1 — the previously free-string password events are now first-class
//    AuditAction constants (folded into the canon).
check("PASSWORD_RESET_REQUESTED is a canon constant", AuditAction.PASSWORD_RESET_REQUESTED === "PASSWORD_RESET_REQUESTED");
check("PASSWORD_RESET_COMPLETE is a canon constant",  AuditAction.PASSWORD_RESET_COMPLETE === "PASSWORD_RESET_COMPLETE");
check("PASSWORD_CHANGE_FAILED is a canon constant",   AuditAction.PASSWORD_CHANGE_FAILED === "PASSWORD_CHANGE_FAILED");

// 7. SEC-1 — the two security-event VIEWS diverge intentionally: the admin
//    filter carries the admin-only session revoke that the user surface hides,
//    and the user surface carries account-lifecycle events the admin filter
//    omits. This codifies why they are two derived views, not one shared list.
check(
  "admin filter includes ADMIN_SESSION_REVOKED",
  ADMIN_SECURITY_FILTER_ACTIONS.includes(AuditAction.ADMIN_SESSION_REVOKED),
);
check(
  "user history excludes ADMIN_SESSION_REVOKED",
  !USER_SECURITY_HISTORY_ACTIONS.includes(AuditAction.ADMIN_SESSION_REVOKED),
);
check(
  "user history includes account-lifecycle events the admin filter omits",
  USER_SECURITY_HISTORY_ACTIONS.includes(AuditAction.DATA_EXPORTED) &&
    !ADMIN_SECURITY_FILTER_ACTIONS.includes(AuditAction.DATA_EXPORTED),
);

console.log(
  failures === 0 ? "\nAll security-history checks passed." : `\n${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
