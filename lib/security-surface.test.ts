/**
 * lib/security-surface.test.ts  (OPS-1 S4/S6)
 *
 * Standalone tsx script (house pattern) — a SOURCE-SCAN test, like the
 * single-SDK-import-site guards: reads route/module source as text and
 * asserts the security floor cannot silently regress. Deterministic, no
 * runtime, no DB.
 *
 * Covers:
 *   1. The REAL credentials login callback is rate-limited (both halves:
 *      per-IP in the NextAuth route wrapper, per-identifier in authorize()).
 *   2. Every sensitive path carries its rate-limit call: TOTP
 *      setup/verify/disable/recovery-codes, password change, email-change
 *      request, export, Plaid link/exchange/refresh/sync.
 *   3. instrumentation.ts runs validateEnv() at boot and does NOT start any
 *      in-process scheduler (background dispatch is cron-driven via
 *      app/api/jobs/dispatch since OPS-4 S2 — never a boot side effect).
 *   4. /api/health exposes no env secrets.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("1. Login callback path is rate-limited");
const nextauthRoute = src("app/api/auth/[...nextauth]/route.ts");
check(
  "route wrapper scopes a per-IP limit to callback/credentials",
  nextauthRoute.includes("callback/credentials") &&
    nextauthRoute.includes('limitByIp(req, "login-callback"'),
);
const auth = src("lib/auth.ts");
const authorizeBody = auth.slice(auth.indexOf("async authorize"));
check(
  "authorize() applies a per-identifier limit",
  authorizeBody.includes('limitByKey(identifier, "login-id"'),
);
check(
  "identifier limit runs BEFORE the user lookup",
  authorizeBody.indexOf('limitByKey(identifier, "login-id"') <
    authorizeBody.indexOf("db.user.findFirst"),
);

console.log("2. Sensitive paths carry rate-limit calls");
const surfaces: [string, string][] = [
  ["app/api/user/totp/setup/route.ts",          'limitByUser(user.id, "totp-setup"'],
  ["app/api/user/totp/verify/route.ts",         'limitByUser(user.id, "totp-verify"'],
  ["app/api/user/totp/disable/route.ts",        'limitByUser(user.id, "totp-disable"'],
  ["app/api/user/totp/recovery-codes/route.ts", 'limitByUser(user.id, "totp-recovery-codes"'],
  ["app/api/user/password/route.ts",            'limitByUser(user.id, "password-change"'],
  ["app/api/user/email/request/route.ts",       'limitByUser(user.id, "email-change-request"'],
  ["app/api/user/email/request/route.ts",       'limitByIp(req, "email-change-request"'],
  ["app/api/user/export/route.ts",              'limitByUser(user.id, "data-export"'],
  ["app/api/plaid/link-token/route.ts",         'limitByUser(user.id, "plaid-link-token"'],
  ["app/api/plaid/exchange-token/route.ts",     'limitByUser(userId, "plaid-exchange-token"'],
  ["app/api/plaid/refresh/route.ts",            'limitByUser(user.id, "plaid-refresh"'],
  ["app/api/plaid/sync/route.ts",               'limitByUser(user.id, "plaid-sync"'],
  ["app/api/auth/pre-login/route.ts",           'limitByIp(req, "pre-login"'],
  ["app/api/health/route.ts",                   'limitByIp(req, "health"'],
];
for (const [file, needle] of surfaces) {
  check(`${file} → ${needle.split("(")[0]}(${needle.split('"')[1]})`, src(file).includes(needle));
}

console.log("3. instrumentation.ts boots validateEnv, never the scheduler");
const inst = src("instrumentation.ts");
// Strip comments first: the file header deliberately DOCUMENTS that
// startScheduler stays un-invoked, which must not trip the code scan.
const instCode = inst.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("validateEnv() invoked at boot", /validateEnv\(\)/.test(instCode));
check("no in-process scheduler at boot (dispatch is cron-driven, OPS-4 S2)", !instCode.includes("startScheduler"));
check("no scheduler module import at boot", !instCode.includes("jobs/scheduler"));

console.log("4. Health endpoint leaks no secrets");
const health = src("app/api/health/route.ts");
for (const secret of [
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "ENCRYPTION_KEY",
  "RESEND_API_KEY",
  "CRON_SECRET",
  "PLAID_SECRET",
  "OPENAI_API_KEY",
]) {
  check(`does not reference ${secret}`, !health.includes(secret));
}
check(
  "only whitelisted env read is the commit sha",
  (health.match(/process\.env\.(\w+)/g) ?? []).every((m) => m === "process.env.VERCEL_GIT_COMMIT_SHA"),
);

console.log("5. SEC-1 — audit-vocabulary single source of truth");
// The admin audit quick-filter consumes the canon-derived view, not a local
// literal array.
const adminAudit = src("app/api/admin/audit/route.ts");
check(
  "admin/audit imports ADMIN_SECURITY_FILTER_ACTIONS from the canon",
  adminAudit.includes('ADMIN_SECURITY_FILTER_ACTIONS') &&
    adminAudit.includes('from "@/lib/audit-actions"'),
);
check(
  "admin/audit no longer declares a local SECURITY_ACTIONS literal array",
  !/const\s+SECURITY_ACTIONS\s*=/.test(adminAudit),
);
// The security-event writers reference AuditAction constants, not raw strings.
const writerSurfaces: [string, string][] = [
  ["app/api/auth/forgot-password/route.ts", "AuditAction.PASSWORD_RESET_REQUESTED"],
  ["app/api/auth/reset-password/route.ts",  "AuditAction.PASSWORD_RESET_COMPLETE"],
  ["app/api/user/password/route.ts",        "AuditAction.PASSWORD_CHANGE_FAILED"],
  ["app/api/user/password/route.ts",        "AuditAction.PASSWORD_CHANGED"],
  ["app/api/auth/register/route.ts",        "AuditAction.REGISTER"],
];
for (const [file, needle] of writerSurfaces) {
  const s = src(file);
  // The constant is present, and no `action:` line still assigns the bare
  // string literal for it (whitespace-tolerant).
  const literal = needle.split(".")[1];
  const rawAssign = new RegExp(`action:\\s*"${literal}"`);
  check(`${file} writes ${needle} (not the raw literal)`, s.includes(needle) && !rawAssign.test(s));
}

console.log(failures === 0 ? "\nAll security-surface scans passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
