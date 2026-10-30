/**
 * lib/platform/operator-mfa.test.ts  (SEC-PLAT-1 — mandatory TOTP for Platform operators)
 *
 * Owner ruling P-2 (2026-10-27): every ACTIVE Platform access holder must have
 * TOTP, regardless of level. This INVERTS the discovery-branch
 * characterization (operator-mfa-gap.characterization.test.ts, G1–G5):
 *
 *   G2' the shared guard refuses a grant holder without TOTP (fresh read, every request)
 *   G4' an ACTIVE grant holder cannot turn 2FA off
 *   G5' the unenforced require_totp_admins switch is gone
 *   +   refusals are recorded, pages route to the existing enrolment screen,
 *       SYSTEM_ADMIN and customer (non-operator) authentication are unchanged.
 *
 * G1/G3 (login + session re-derivation stay grant-blind) are DELIBERATE in this
 * phase: enforcement lives at the guard so nobody is locked out of their own
 * account (see the rollout plan). Pure + source scans; no DB.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";
import { operatorTotpMissing, requiresTotpEnrollment } from "@/lib/auth-totp-policy";
import { PlatformSettingKey } from "@/lib/platform-settings";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("rule (pure)");
check("a USER grant holder without TOTP is refused", operatorTotpMissing({ role: UserRole.USER, totpEnabled: false }) === true);
check("a USER grant holder with TOTP is admitted", operatorTotpMissing({ role: UserRole.USER, totpEnabled: true }) === false);
check("SYSTEM_ADMIN is out of scope here (already MFA-bound at login)", operatorTotpMissing({ role: UserRole.SYSTEM_ADMIN, totpEnabled: false }) === false);
check("customer authentication unchanged: an un-enrolled USER is still not forced at login by default",
  requiresTotpEnrollment({ role: UserRole.USER, totpEnabled: false, requireTotpAllUsers: false }) === false);
check("SYSTEM_ADMIN enrolment still mandatory", requiresTotpEnrollment({ role: UserRole.SYSTEM_ADMIN, totpEnabled: false, requireTotpAllUsers: false }) === true);

console.log("G2' — the shared guard enforces it on every request");
{
  const a = code("lib/platform/authorize.ts");
  check("the grant read also reads the holder's totpEnabled (one fresh query)",
    /platformGrant\.findUnique\(\{[\s\S]*?select: \{ area: true, level: true, status: true, user: \{ select: \{ totpEnabled: true \} \} \}/.test(a));
  check("MFA is decided AFTER the grant (no MFA disclosure to a caller without access)",
    // PLATFORM-SEC-1: the first forbidden() is now the break-glass refusal; the
    // ordering that matters is grant refusal ("insufficient") before the MFA decision.
    a.indexOf('"insufficient"') > -1 && a.indexOf('"insufficient"') < a.indexOf("decideOperatorTotpRefusal({ role: user.role"));
  check("the refusal is recorded as mfa_required", /grant: "mfa_required"/.test(a));
  check("both entry points (cached + fresh) share the one resolver",
    (a.match(/return resolvePlatformAccess\(user, area, needed\)/g) ?? []).length === 2);
  check("the refusal carries the page-readable denial header", /\[PLATFORM_DENIAL_HEADER\]: OPERATOR_TOTP_REQUIRED/.test(a));
  for (const f of ["app/(shell)/dashboard/platform/[area]/page.tsx", "app/merchant-ops/page.tsx"]) {
    const p = code(f);
    check(`${f}: an MFA refusal routes to the existing enrolment screen`,
      /isOperatorTotpRefusal\(err\)\) redirect\(OPERATOR_TOTP_ENROLMENT_PATH\)/.test(p));
  }
  check("the enrolment path is the existing USER enrolment surface",
    /OPERATOR_TOTP_ENROLMENT_PATH = "\/dashboard\/settings\/security\?setup2fa=true"/.test(a));
}

console.log("G4' — (PLATFORM-SEC-1 review) 2FA disable stays self-service; the guard is the control");
{
  // #78 refused 2FA disable for grant holders. That blocked the only lost-device
  // path (disable with a recovery code + password, then re-enrol) and added
  // nothing: with totpEnabled false the shared guard already refuses Platform.
  const d = code("app/api/user/totp/disable/route.ts");
  check("the disable route does not consult Platform grants", !/platformGrant/.test(d));
  check("…and the guard refuses an operator whose 2FA is off (read fresh with the grant)",
    /user: \{ select: \{ totpEnabled: true \} \}/.test(code("lib/platform/authorize.ts")));
}

console.log("G5' — the unenforced switch is gone");
{
  check("not a registered setting", !Object.values(PlatformSettingKey).includes("require_totp_admins" as never));
  const consumers: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(path.join(ROOT, dir))) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const rel = path.join(dir, n);
      if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) && /require_totp_admins|REQUIRE_TOTP_ADMINS/.test(code(rel))) consumers.push(rel);
    }
  };
  for (const d of ["lib", "app", "components"]) walk(d);
  check("no code (outside comments) references it", consumers.length === 0, consumers.join(", "));
  const ui = code("components/admin/AdminSecurityConsole.tsx");
  // PLATFORM-SEC-1 — the line states the deployment's real rollout state.
  check("the admin console states the operator-TOTP rollout state read-only",
    /Require TOTP for Platform operators/.test(ui) && /adminStatus\?\.operatorTotpEnforced === true/.test(ui)
      && /"Enforced"/.test(ui) && /"Not enforced yet"/.test(ui));
}

console.log("grant issuance warns");
check("the grant matrix flags a holder without 2FA", /u\.totpEnabled === false/.test(code("app/admin/platform-access/page.tsx")));

if (failures > 0) {
  console.error(`\noperator-mfa: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\noperator-mfa: all checks passed.");
