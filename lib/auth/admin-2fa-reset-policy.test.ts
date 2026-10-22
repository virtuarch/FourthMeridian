/**
 * lib/auth/admin-2fa-reset-policy.test.ts — SEC-006: an admin 2FA reset
 * requires the actor's LIVE TOTP code and never targets a SYSTEM_ADMIN.
 *
 * PART A — the pure rule, executed with real TOTP codes (generateTOTP /
 *          verifyTOTP are the same HMAC pair login uses).
 * PART B — source pins on the route: it decides through the rule, bounds code
 *          guesses per actor, revokes the target's sessions, notifies the
 *          target, and writes no raw e-mail into AuditLog.metadata.
 *
 *     npx tsx lib/auth/admin-2fa-reset-policy.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { generateSecret, generateTOTP } from "@/lib/totp";
import {
  ADMIN_TWO_FACTOR_RESET_STATUS,
  decideAdminTwoFactorReset,
  type AdminTwoFactorResetInput,
} from "./admin-2fa-reset-policy";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("admin-2fa-reset-policy (SEC-006)\n\nA. the rule");
const secret = generateSecret();
const live   = generateTOTP(secret);
const base: AdminTwoFactorResetInput = {
  actorId: "admin-1", targetId: "user-1", targetRole: "USER",
  confirmToken: "RESET", actorTotpEnabled: true, actorTotpSecret: secret, adminTotpCode: live,
};
const d = (patch: Partial<AdminTwoFactorResetInput>) => decideAdminTwoFactorReset({ ...base, ...patch });

check("control: confirm + USER target + live actor code → ALLOW", d({}) === "ALLOW");
check("self-target → SELF (even with a live code)", d({ targetId: "admin-1" }) === "SELF");
check("confirm token absent / wrong → CONFIRM_TOKEN",
  d({ confirmToken: undefined }) === "CONFIRM_TOKEN" && d({ confirmToken: "reset" }) === "CONFIRM_TOKEN");
check("SYSTEM_ADMIN target → TARGET_IS_SYSTEM_ADMIN, even with a live code",
  d({ targetRole: "SYSTEM_ADMIN" }) === "TARGET_IS_SYSTEM_ADMIN");
check("actor not enrolled (no secret) → ACTOR_NOT_ENROLLED (never waved through)",
  d({ actorTotpSecret: null }) === "ACTOR_NOT_ENROLLED" && d({ actorTotpEnabled: false }) === "ACTOR_NOT_ENROLLED");
check("code missing / empty / non-string → TOTP_CODE_MISSING",
  d({ adminTotpCode: undefined }) === "TOTP_CODE_MISSING" && d({ adminTotpCode: "  " }) === "TOTP_CODE_MISSING" &&
  d({ adminTotpCode: 123456 }) === "TOTP_CODE_MISSING");
const wrong = String((Number(live) + 1) % 1_000_000).padStart(6, "0");
check("a wrong code → TOTP_CODE_INVALID (the pre-fix behaviour was ALLOW)", d({ adminTotpCode: wrong }) === "TOTP_CODE_INVALID");
check("a code for a DIFFERENT secret → TOTP_CODE_INVALID", d({ adminTotpCode: generateTOTP(generateSecret()) }) === "TOTP_CODE_INVALID");
check("whitespace inside a live code is tolerated (as login does)",
  d({ adminTotpCode: `${live.slice(0, 3)} ${live.slice(3)}` }) === "ALLOW");
check("order: SYSTEM_ADMIN target is refused BEFORE the code is examined (no oracle on a missing code)",
  d({ targetRole: "SYSTEM_ADMIN", adminTotpCode: undefined }) === "TARGET_IS_SYSTEM_ADMIN");
check("every refusal maps to a 4xx status, none to 200",
  Object.values(ADMIN_TWO_FACTOR_RESET_STATUS).every((s) => s >= 400 && s < 500) &&
  ADMIN_TWO_FACTOR_RESET_STATUS.TOTP_CODE_INVALID === 403 && ADMIN_TWO_FACTOR_RESET_STATUS.TARGET_IS_SYSTEM_ADMIN === 403);

console.log("\nB. the route wires the rule");
const ROUTE = "app/api/admin/security/users/[userId]/2fa-reset/route.ts";
const code = readFileSync(path.join(process.cwd(), ROUTE), "utf8")
  .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
check("route decides through decideAdminTwoFactorReset", code.includes("decideAdminTwoFactorReset({"));
check("route refuses every non-ALLOW decision with the shared status map",
  /if \(decision !== "ALLOW"\)[\s\S]{0,200}ADMIN_TWO_FACTOR_RESET_STATUS\[decision\]/.test(code));
check("route verifies against the actor's DECRYPTED secret (login's decrypt pair)",
  code.includes("decryptWithPurpose(actor.totpSecret, EncryptionPurpose.TOTP_SECRET)"));
check("route still requires a FRESH SYSTEM_ADMIN", code.includes("requireFreshSystemAdmin()"));
check("route bounds code guesses per actor (limitByUser) before any verification",
  code.indexOf('limitByUser(adminId, "admin-2fa-reset"') !== -1 &&
  code.indexOf('limitByUser(adminId, "admin-2fa-reset"') < code.indexOf("decideAdminTwoFactorReset({"));
check("the decision precedes the reset transaction", code.indexOf("decideAdminTwoFactorReset({") < code.indexOf("db.$transaction("));
check("route revokes the target's sessions after the reset", code.includes("revokeAllUserSessions(userId)"));
check("route notifies the target (security-alert to target.email)", code.includes('sendEmail("security-alert", target.email'));
check("audit metadata carries an e-mail DIGEST, never the raw address (PRIV-002)",
  code.includes("auditEmailHash(target.email)") && !/targetEmail:\s*target\.email/.test(code));
check("the old commented-out guard is gone (no dead 'future' verification)", !code.includes("Uncomment after"));

if (failures > 0) { console.error(`\nadmin-2fa-reset-policy: ${failures} check(s) failed.`); process.exit(1); }
console.log("\nadmin-2fa-reset-policy: all checks passed.");
