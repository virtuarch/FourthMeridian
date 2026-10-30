/**
 * lib/platform/platform-sec-1.test.ts — PLATFORM-SEC-1 (2026-10-30) regression suite.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/platform-sec-1.test.ts
 *
 * Three controls, one shared guard (lib/platform/authorize.ts):
 *   A. the SYSTEM_ADMIN break-glass bypass obeys the DISABLE_SYSTEM_ADMIN kill
 *      switch and pending TOTP enrolment — the SAME rule as /api/admin;
 *   B. mandatory operator TOTP (SEC-PLAT-1, from draft #78), behind the rollout
 *      switch OPERATOR_TOTP_ENFORCEMENT=enforce (Preview first);
 *   C. a fleet-wide Manual operations run needs CONTROL + a structured reason.
 * Pure decision tables plus source pins on the guard and routes (house pattern).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";
import { decideAdminApiAccess } from "@/lib/admin-totp-enrollment";
import { requiresTotpEnrollment } from "@/lib/auth-totp-policy";
import { decideBreakGlass, decideOperatorTotpRefusal } from "@/lib/platform/authorize";
import { listOperationCommands, operationRequirement } from "@/lib/platform/operations/registry";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const AUTHORIZE = code("lib/platform/authorize.ts");
const SA = UserRole.SYSTEM_ADMIN;
const USER = UserRole.USER;

console.log("A. break-glass obeys the kill switch (pure)");
{
  check("SYSTEM_ADMIN, switch off, enrolled → ALLOW",
    decideBreakGlass({ role: SA, requireTotpSetup: false, systemAdminDisabled: false }) === "ALLOW");
  check("SYSTEM_ADMIN, kill switch ON → refused (FORBIDDEN_DISABLED)",
    decideBreakGlass({ role: SA, requireTotpSetup: false, systemAdminDisabled: true }) === "FORBIDDEN_DISABLED");
  check("SYSTEM_ADMIN, TOTP enrolment pending → refused (FORBIDDEN_PENDING)",
    decideBreakGlass({ role: SA, requireTotpSetup: true, systemAdminDisabled: false }) === "FORBIDDEN_PENDING");
  // One rule, two consoles: every input combination agrees with /api/admin.
  for (const requireTotpSetup of [false, true]) for (const systemAdminDisabled of [false, true]) {
    const input = { role: SA, requireTotpSetup, systemAdminDisabled };
    check(`agrees with /api/admin (pending=${requireTotpSetup}, disabled=${systemAdminDisabled})`,
      decideBreakGlass(input) === decideAdminApiAccess(input));
  }
}

console.log("A. break-glass obeys the kill switch (guard wiring)");
{
  const saBranch = AUTHORIZE.slice(AUTHORIZE.indexOf("if (user.role === UserRole.SYSTEM_ADMIN) {"), AUTHORIZE.indexOf("const row = await db.platformGrant.findUnique"));
  check("the SYSTEM_ADMIN branch decides before returning the bypass",
    /decideBreakGlass\(\{[\s\S]*systemAdminDisabled: env\.isSystemAdminDisabled[\s\S]*\}\);[\s\S]*if \(verdict !== "ALLOW"\)[\s\S]*return \[null, forbidden\(\)\];[\s\S]*return \[\{ user, grant: null \}, null\];/.test(saBranch), saBranch.slice(0, 200));
  check("the pending-enrolment flag comes from the session user", /requireTotpSetup: user\.requireTotpSetup/.test(saBranch));
  check("a refused break-glass call is recorded like any other denial", /grant: "break_glass_refused"/.test(saBranch));
  check("no unconditional SYSTEM_ADMIN bypass remains",
    !/if \(user\.role === UserRole\.SYSTEM_ADMIN\) \{\s*return \[\{ user, grant: null \}, null\];/.test(AUTHORIZE));
  check("both entry points (cached + fresh) go through the one resolver",
    (AUTHORIZE.match(/return resolvePlatformAccess\(user, area, needed\);/g) ?? []).length === 2);
  check("/api/admin reads the same switch through the same rule",
    /systemAdminDisabled: env\.isSystemAdminDisabled/.test(code("lib/session.ts")) && /decideAdminApiAccess\(/.test(code("lib/session.ts")));
}

console.log("B. operator TOTP — decision table (pure)");
{
  const t = (role: UserRole, totpEnabled: boolean, enforced: boolean) => decideOperatorTotpRefusal({ role, totpEnabled, enforced });
  check("enforced + operator without TOTP → refused", t(USER, false, true) === true);
  check("enforced + operator with TOTP → admitted", t(USER, true, true) === false);
  check("not enforced (rollout pending) → behaviour unchanged", t(USER, false, false) === false);
  check("SYSTEM_ADMIN never takes this path (covered by A + login enrolment)", t(SA, false, true) === false);
  check("customer 2FA stays optional (login enrolment not forced on a USER)",
    requiresTotpEnrollment({ role: USER, totpEnabled: false, requireTotpAllUsers: false }) === false);
}

console.log("B. operator TOTP — stale sessions, resets, new grants (guard wiring)");
{
  check("totpEnabled is read FRESH with the grant on every request (never from the session claim)",
    /platformGrant\.findUnique\(\{[\s\S]*?select: \{ area: true, level: true, status: true, user: \{ select: \{ totpEnabled: true \} \} \}/.test(AUTHORIZE)
      && !/user\.totpEnabled/.test(AUTHORIZE.replace(/row!\.user\.totpEnabled/g, "")));
  check("the decision uses the rollout switch", /decideOperatorTotpRefusal\(\{ role: user\.role, totpEnabled: row!\.user\.totpEnabled === true, enforced: env\.isOperatorTotpEnforced \}\)/.test(AUTHORIZE));
  check("MFA is decided only after the grant check (a caller without access learns nothing)",
    AUTHORIZE.indexOf('"insufficient"') < AUTHORIZE.indexOf("decideOperatorTotpRefusal({ role: user.role"));
  check("the env switch accepts only the exact word \"enforce\"",
    /get isOperatorTotpEnforced\(\) \{ return _e\.OPERATOR_TOTP_ENFORCEMENT === "enforce"; \}/.test(code("lib/env.ts")));
  check("every Platform page entry redirects an un-enrolled operator to enrolment",
    /isOperatorTotpRefusal\(err\)\) redirect\(OPERATOR_TOTP_ENROLMENT_PATH\)/.test(code("app/(shell)/dashboard/platform/[area]/page.tsx"))
      && /isOperatorTotpRefusal\(err\)\) redirect\(OPERATOR_TOTP_ENROLMENT_PATH\)/.test(code("app/merchant-ops/page.tsx"))
      && /env\.isOperatorTotpEnforced && !\(await operatorHasTotp\(session\.user\.id\)\)\) redirect\(OPERATOR_TOTP_ENROLMENT_PATH\)/.test(code("app/(shell)/dashboard/platform/page.tsx")));
}

console.log("B. operator TOTP — enrolment and recovery stay open (no lockout)");
{
  check("the enrolment destination is the personal Security settings page", /OPERATOR_TOTP_ENROLMENT_PATH = "\/dashboard\/settings\/security\?setup2fa=true"/.test(AUTHORIZE));
  check("that page is not behind the Platform guard", !/platform\/authorize/.test(code("app/(shell)/dashboard/settings/security/page.tsx")));
  check("TOTP setup + verify run on the personal session (pending setup allowed), not the Platform guard",
    ["app/api/user/totp/setup/route.ts", "app/api/user/totp/verify/route.ts"].every((f) =>
      /requireUser\(\{ allowTotpSetupPending: true \}\)/.test(code(f)) && !/platform\/authorize/.test(code(f))));
  check("a SYSTEM_ADMIN can still reset an operator's 2FA (recovery), behind fresh SYSTEM_ADMIN",
    /requireFreshSystemAdmin\(/.test(code("app/api/admin/security/users/[userId]/2fa-reset/route.ts")));
  // Review fix: the lost-device path (disable with a recovery code, then re-enrol)
  // stays self-service for operators. The guard is the control: with 2FA off,
  // Platform access is refused until they enrol again.
  const disable = code("app/api/user/totp/disable/route.ts");
  check("2FA disable is NOT blocked for grant holders (self-service recovery; the guard refuses Platform instead)",
    !/platformGrant/.test(disable) && !/OPERATOR_TOTP_REQUIRED/.test(disable));
  check("a fresh check acts on the LIVE role and enrolment state, never the cached claim",
    /return \[\{ \.\.\.user, role: live\.facts\.role as SessionUser\["role"\], requireTotpSetup: live\.facts\.requireTotpSetup \}, null\];/.test(code("lib/session.ts")));
}

console.log("C. fleet-wide operations need CONTROL + reason (pure)");
{
  check("mutating fleet run → CONTROL + reason", JSON.stringify(operationRequirement(true, true)) === JSON.stringify({ level: "CONTROL", reason: true }));
  check("mutating single-scope run → WRITE, no reason", JSON.stringify(operationRequirement(true, false)) === JSON.stringify({ level: "WRITE", reason: false }));
  check("a dry run never escalates (it executes nothing)", operationRequirement(false, true).level === "WRITE" && operationRequirement(false, false).level === "WRITE");
  const cmds = listOperationCommands();
  const elevated = cmds.filter((c) => c.requires.level === "CONTROL").map((c) => c.id).sort();
  check("exactly the three fleet Run Nows are elevated",
    JSON.stringify(elevated) === JSON.stringify(["run-now:sol-history-backfill", "run-now:sync-banks", "run-now:sync-crypto"]), elevated.join(", "));
  check("every elevated command also requires a reason", cmds.filter((c) => c.requires.level === "CONTROL").every((c) => c.requires.reason));
  check("every other command stays WRITE without a reason", cmds.filter((c) => c.requires.level !== "CONTROL").every((c) => c.requires.level === "WRITE" && !c.requires.reason));
}

console.log("C. fleet-wide operations need CONTROL + reason (route ordering)");
{
  const route = code("app/api/platform/platform-ops/operations/route.ts");
  const post = route.slice(route.indexOf("export const POST"));
  const i = (needle: string) => post.indexOf(needle);
  check("WRITE is checked before the command is looked up (no command-id oracle)",
    i('requireFreshPlatformAccess("PLATFORM_OPS", "WRITE")') > -1 && i('requireFreshPlatformAccess("PLATFORM_OPS", "WRITE")') < i("getOperationCommand(commandId)"));
  check("CONTROL is re-checked fresh BEFORE anything runs",
    i('requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL")') > i("getOperationCommand(commandId)") && i('requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL")') < i("runOperation("));
  check("the reason is parsed BEFORE anything runs (no run without a reason)",
    i("parseOperatorReason(body?.reason)") > -1 && i("parseOperatorReason(body?.reason)") < i("runOperation("));
  check("the fleet intent (actor + reason) is recorded BEFORE anything runs",
    i("AuditAction.PLATFORM_OPERATION_REQUESTED") > -1 && i("AuditAction.PLATFORM_OPERATION_REQUESTED") < i("runOperation("));
  check("a missing / invalid reason is a 400 that runs nothing", /catch \(e\) \{\s*return NextResponse\.json\([\s\S]{0,200}\{ status: 400 \}/.test(post));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nplatform-sec-1: all checks passed.");
