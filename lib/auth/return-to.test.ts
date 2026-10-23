/**
 * lib/auth/return-to.test.ts — adversarial pins for the post-login return-target
 * validator (lib/auth/return-to.ts), plus source pins that every consumer goes
 * through it.
 *
 * Standalone tsx script (house pattern). Pure: no DB, no network.
 *
 * Each REJECT case is a value an attacker can put in `?callbackUrl=`. Section 2
 * proves the rejection is not vacuous: the same values, fed to the OLD guard
 * (`startsWith("/")`), would have been ACCEPTED — so this file pins the fix,
 * not a tautology.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  validateReturnTo,
  safeReturnTo,
  loginUrlFor,
  DEFAULT_RETURN_TO,
  MAX_RETURN_TO_LENGTH,
} from "./return-to";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. ACCEPT — internal paths survive unchanged, query and fragment included ──
console.log("\n1. internal paths are accepted verbatim");
const ACCEPT = [
  "/",
  "/dashboard",
  "/dashboard/brief",
  "/investments",
  "/transactions?range=30d",
  "/dashboard/spaces?tab=members&space=abc",
  "/dashboard?perspective=net-worth&asof=2026-09-30#holdings",
  "/dashboard/accounts/acc_123?q=a%20b%2Fc",           // encoded bytes in the QUERY are deep-link state
  "/dashboard?next=%2F%2Fevil.com",                      // …even when they spell a URL: the query cannot move the origin
  "/admin/security?setup2fa=true",
  "/dashboard/my%20space",                               // encoded space in a path is a path byte
];
for (const v of ACCEPT) {
  check(`accept ${JSON.stringify(v)}`, validateReturnTo(v) === v, `got ${JSON.stringify(validateReturnTo(v))}`);
}

// ── 2. REJECT — every external / malformed / loop target falls back ───────────
console.log("\n2. external, malformed and looping targets are refused");
const REJECT: Array<[string, unknown]> = [
  ["https absolute",                "https://evil.com"],
  ["http absolute",                 "http://evil.com"],
  ["https absolute, our own host",  "https://fourthmeridian.com/dashboard"], // absolute is refused even when same-host: paths only
  ["protocol-relative",             "//evil.com"],
  ["protocol-relative with path",   "//evil.com/dashboard"],
  ["triple slash",                  "///evil.com"],
  ["double backslash",              "\\\\evil.com"],
  ["slash-backslash",               "/\\evil.com"],
  ["backslash-slash",               "\\/evil.com"],
  ["encoded slash-slash",           "/%2F%2Fevil.com"],
  ["encoded slash-slash, lower",    "/%2f%2fevil.com"],
  ["encoded second slash",          "/%2Fevil.com"],
  ["encoded backslash",             "/%5Cevil.com"],
  ["encoded backslash, lower",      "/%5cevil.com"],
  ["double-encoded slash",          "/%252F%252Fevil.com"],
  ["double-encoded backslash",      "/%255Cevil.com"],
  ["triple-encoded slash",          "/%25252F%25252Fevil.com"],
  ["javascript: scheme",            "javascript:alert(1)"],
  ["javascript: upper",             "JaVaScRiPt:alert(1)"],
  ["data: scheme",                  "data:text/html,<script>alert(1)</script>"],
  ["vbscript: scheme",              "vbscript:msgbox(1)"],
  ["mailto: scheme",                "mailto:a@evil.com"],
  ["leading tab before //",         "\t//evil.com"],
  ["leading space before //",       " //evil.com"],
  ["embedded tab in //",            "/\t/evil.com"],
  ["embedded newline in //",        "/\n/evil.com"],
  ["encoded tab in //",             "/%09/evil.com"],
  ["encoded newline",               "/%0A/evil.com"],
  ["encoded NUL",                   "/dashboard%00"],
  ["malformed percent",             "/dashboard%E0%A4%A"],
  ["lone percent",                  "/%"],
  ["relative, no slash",            "dashboard"],
  ["dot-relative",                  "./dashboard"],
  ["host-like relative",            "evil.com"],
  ["empty",                         ""],
  ["over-long",                     "/" + "a".repeat(MAX_RETURN_TO_LENGTH)],
  ["loop: /login",                  "/login"],
  ["loop: /login with query",       "/login?callbackUrl=%2Fdashboard"],
  ["loop: /login/",                 "/login/"],
  ["loop: case-folded /Login",      "/Login"],
  ["loop: encoded /%6Cogin",        "/%6Cogin"],
  ["loop: /register",               "/register"],
  ["loop: /reset-password",         "/reset-password?token=x"],
  ["non-string: number",            42],
  ["non-string: array",             ["/dashboard"]],
  ["non-string: null",              null],
  ["non-string: undefined",         undefined],
];
for (const [name, v] of REJECT) {
  check(`refuse ${name}`, validateReturnTo(v) === null, `got ${JSON.stringify(validateReturnTo(v))}`);
}

// The refusal is not vacuous: the guard this replaces accepted the dangerous
// ones. (Only the string cases that begin with "/" are a fair comparison.)
console.log("\n2b. the old `startsWith(\"/\")` guard would have ACCEPTED the dangerous cases");
const oldGuard = (v: unknown) => typeof v === "string" && v.startsWith("/");
for (const v of ["//evil.com", "/\\evil.com", "/%2F%2Fevil.com", "///evil.com", "/%5Cevil.com"]) {
  check(`old guard accepted ${JSON.stringify(v)} (new one does not)`, oldGuard(v) && validateReturnTo(v) === null);
}

// A browser really does treat these as off-origin — the threat is not theoretical.
console.log("\n2c. WHATWG URL resolution confirms the protocol-relative forms leave the origin");
const base = "https://app.example";
for (const v of ["//evil.com", "/\\evil.com", "\\\\evil.com"]) {
  check(`new URL(${JSON.stringify(v)}, base) is off-origin`, new URL(v, base).origin !== base);
}

// ── 3. safeReturnTo / loginUrlFor ──────────────────────────────────────────────
console.log("\n3. fallbacks and login URL construction");
check("default fallback is the authenticated landing route", safeReturnTo("//evil.com") === DEFAULT_RETURN_TO);
check("DEFAULT_RETURN_TO is /dashboard/brief", DEFAULT_RETURN_TO === "/dashboard/brief");
check("absent → fallback", safeReturnTo(null) === DEFAULT_RETURN_TO);
check("custom fallback honoured", safeReturnTo("https://evil.com", "/x") === "/x");
check("safe value passes through", safeReturnTo("/dashboard?tab=a") === "/dashboard?tab=a");
check("loginUrlFor(safe) carries an encoded callbackUrl",
  loginUrlFor("/dashboard/spaces?tab=x") === "/login?callbackUrl=%2Fdashboard%2Fspaces%3Ftab%3Dx");
check("loginUrlFor(unsafe) drops the target", loginUrlFor("//evil.com") === "/login");
check("loginUrlFor(absent) is bare /login", loginUrlFor(undefined) === "/login");
check("loginUrlFor round-trips through URLSearchParams",
  new URL(loginUrlFor("/dashboard?a=1&b=2"), base).searchParams.get("callbackUrl") === "/dashboard?a=1&b=2");

// ── 4. consumers — the ONLY decision point ─────────────────────────────────────
console.log("\n4. every consumer routes through the validator");
const ROOT = process.cwd();
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
const src = (rel: string) => strip(readFileSync(path.join(ROOT, rel), "utf8"));
const loginPage = src("app/(auth)/login/page.tsx");
const loginForm = src("app/(auth)/login/LoginForm.tsx");
check("login page (server) validates with safeReturnTo", loginPage.includes("safeReturnTo("));
check("login form navigates to the server-validated returnTo prop", /router\.push\(\s*returnTo\s*\)/.test(loginForm));
check("login form no longer reads callbackUrl itself", !loginForm.includes('"callbackUrl"'));
check("signed-in /login redirects to the VALIDATED target (redirect(returnTo))", /redirect\(\s*returnTo\s*\)/.test(loginPage));
check("signed-in check uses getServerSession (revocation-aware), not getToken",
  loginPage.includes("getServerSession(") && !loginPage.includes("getToken("));
check("a failing session read renders the form (wrapped in try/catch, returns false)",
  /try\s*{[\s\S]*getServerSession[\s\S]*}\s*catch\s*{\s*return false;/.test(loginPage));
check("no `startsWith(\"/\")` return-target guard survives in the login surface",
  !/callbackUrl[^;\n]*startsWith\(\s*["']\/["']\s*\)/.test(loginPage + loginForm));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll return-to checks passed.");
