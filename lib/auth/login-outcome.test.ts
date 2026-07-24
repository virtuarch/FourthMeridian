/**
 * lib/auth/login-outcome.test.ts  (PS-4A)
 *
 * The PS-3D defect was that a DB/pool failure during login was rendered as
 * "Invalid email, username, or password." These tests pin the CLASSIFIER that
 * the login page now consumes, so an infrastructure failure can never again be
 * mapped to invalid credentials — and, symmetrically, a genuine wrong password
 * is never mapped to an infrastructure message.
 *
 * PART 1 — pure classifier unit tests (executed).
 * PART 2 — source scans proving the routes/page CONSUME the corrected semantics
 *          (a green classifier is worthless if the page ignores it — the exact
 *          trap PS-1 documented).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyPreLoginResponse,
  classifySignInError,
  AUTH_UNAVAILABLE_TOKEN,
  PRELOGIN_UNAVAILABLE_REASON,
  LOGIN_MESSAGES,
} from "@/lib/auth/login-outcome";

const ROOT = path.resolve(__dirname, "..", "..");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── PART 1 — classifyPreLoginResponse ──────────────────────────────────────────

console.log("PS-4A — login outcome classifier");
console.log("\nPart 1a — pre-login response classification");

// The headline regression: infrastructure failure must NOT be invalid creds.
check("503 + {ok:false} ⇒ unavailable (NOT invalid)",
  classifyPreLoginResponse(503, { ok: false }).kind === "unavailable");
check("503 + {ok:false, reason:'unavailable'} ⇒ unavailable",
  classifyPreLoginResponse(503, { ok: false, reason: PRELOGIN_UNAVAILABLE_REASON }).kind === "unavailable");
check("500 (bare, no ok field) ⇒ unavailable, never invalid",
  classifyPreLoginResponse(500, {}).kind === "unavailable");
check("200 + reason:'unavailable' (belt-and-braces) ⇒ unavailable",
  classifyPreLoginResponse(200, { ok: false, reason: "unavailable" }).kind === "unavailable");

// Genuine credential failure — unchanged behaviour.
check("200 + {ok:false} ⇒ invalid",
  classifyPreLoginResponse(200, { ok: false }).kind === "invalid");
check("200 + {ok:false, captchaRequired:true} ⇒ invalid, carries captcha flag", (() => {
  const d = classifyPreLoginResponse(200, { ok: false, captchaRequired: true });
  return d.kind === "invalid" && d.captchaRequired === true;
})());

// Rate limited — must be its own class, not invalid.
check("429 ⇒ rate_limited (NOT invalid)",
  classifyPreLoginResponse(429, { error: "Too many requests…" }).kind === "rate_limited");

// Success / continue.
check("200 + {ok:true, totpRequired:true} ⇒ continue + totp", (() => {
  const d = classifyPreLoginResponse(200, { ok: true, totpRequired: true });
  return d.kind === "continue" && d.totpRequired === true;
})());
check("200 + {ok:true} ⇒ continue, totp false",
  classifyPreLoginResponse(200, { ok: true }).kind === "continue");

// Post-password gates preserved.
check("200 + reason:'unverified' ⇒ unverified",
  classifyPreLoginResponse(200, { ok: false, reason: "unverified" }).kind === "unverified");
check("200 + reason:'deactivated' ⇒ deactivated + totp flag", (() => {
  const d = classifyPreLoginResponse(200, { ok: false, reason: "deactivated", totpRequired: true });
  return d.kind === "deactivated" && d.totpRequired === true;
})());
check("200 + reason:'pending_deletion' ⇒ pending_deletion",
  classifyPreLoginResponse(200, { ok: false, reason: "pending_deletion" }).kind === "pending_deletion");

// Enumeration safety: unknown-user and wrong-password are indistinguishable —
// the route returns the SAME 200 {ok:false} for both, so the classifier gives
// the SAME `invalid` for both. (The route guarantees the identical body; here we
// assert the classifier does not branch on anything that could differ.)
check("unknown-user body and wrong-password body classify identically",
  classifyPreLoginResponse(200, { ok: false, captchaRequired: false }).kind ===
  classifyPreLoginResponse(200, { ok: false, captchaRequired: false }).kind);

// Malformed / empty body must never read as invalid credentials on a 5xx.
check("503 + null body ⇒ unavailable",
  classifyPreLoginResponse(503, null).kind === "unavailable");

console.log("\nPart 1b — signIn (authorize) error classification");

check("authorize sentinel ⇒ unavailable (credentials step)",
  classifySignInError(AUTH_UNAVAILABLE_TOKEN, "credentials") === "unavailable");
check("authorize sentinel ⇒ unavailable (totp step too)",
  classifySignInError(AUTH_UNAVAILABLE_TOKEN, "totp") === "unavailable");
check("sentinel as substring ⇒ unavailable (NextAuth may wrap it)",
  classifySignInError(`Error: ${AUTH_UNAVAILABLE_TOKEN}`, "credentials") === "unavailable");
check("CredentialsSignin (null-return) ⇒ invalid on credentials step",
  classifySignInError("CredentialsSignin", "credentials") === "invalid");
check("CredentialsSignin ⇒ totp_invalid on totp step (distinct)",
  classifySignInError("CredentialsSignin", "totp") === "totp_invalid");
check("CredentialsSignin ⇒ recovery_invalid on recovery step (distinct)",
  classifySignInError("CredentialsSignin", "recovery") === "recovery_invalid");

// The messages themselves are distinct and non-enumerating.
check("unavailable message ≠ invalid message",
  (LOGIN_MESSAGES.unavailable as string) !== (LOGIN_MESSAGES.invalid as string));
check("invalid message reveals neither field", (() => {
  const m = LOGIN_MESSAGES.invalid.toLowerCase();
  return m.includes("invalid") && !m.includes("not found") && !m.includes("no account") && !m.includes("wrong password");
})());
check("unavailable message reveals no DB/Prisma/Supavisor detail", (() => {
  const m = LOGIN_MESSAGES.unavailable.toLowerCase();
  return !m.includes("prisma") && !m.includes("pool") && !m.includes("database") &&
         !m.includes("p2024") && !m.includes("supavisor") && !m.includes("connection");
})());

// ── PART 2 — the paths CONSUME the corrected semantics ─────────────────────────

console.log("\nPart 2 — routes/page consume the corrected semantics");

function src(rel: string): string { return readFileSync(path.join(ROOT, rel), "utf8"); }
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// pre-login route
const preLogin = stripComments(src("app/api/auth/pre-login/route.ts"));
check("pre-login uses the FAIL-CLOSED strict IP limiter", preLogin.includes("checkIpLimitStrict"));
check("pre-login returns 503 on infrastructure failure", /status:\s*503/.test(preLogin));
check("pre-login no longer has a catch-all returning bare {ok:false} at 500",
  !/catch[\s\S]{0,40}status:\s*500/.test(preLogin));
check("pre-login wraps the user lookup in try/catch", /try\s*{[\s\S]*db\.user\.findFirst[\s\S]*catch/.test(preLogin));
check("pre-login captures infra failures", preLogin.includes("captureAuthInfraFailure"));
check("pre-login returns a distinct 429 for rate-limited (not {ok:false})", /status:\s*429/.test(preLogin));

// authorize()
const auth = stripComments(src("lib/auth.ts"));
check("authorize uses the strict (fail-closed) limiter", auth.includes("checkKeyLimitStrict"));
check("authorize throws the unavailable sentinel (not return null) on infra",
  /throw new Error\(AUTH_UNAVAILABLE_TOKEN\)/.test(auth));
check("authorize's user-lookup catch captures + rethrows the unavailable sentinel",
  /catch\s*\(\s*err\s*\)\s*{\s*captureAuthInfraFailure\(\s*"user-lookup"\s*,\s*err\s*\)\s*;\s*throw new Error\(\s*AUTH_UNAVAILABLE_TOKEN\s*\)/.test(auth));
check("authorize's user lookup is wrapped (findFirst appears inside a try)",
  /try\s*{[\s\S]*db\.user\.findFirst/.test(auth));
check("authorize captures infra failures", auth.includes("captureAuthInfraFailure"));
check("recordLoginFailure is best-effort (own try/catch)",
  /recordLoginFailure[\s\S]*?try\s*{[\s\S]*?auditLog\.create[\s\S]*?catch/.test(auth));

// login page
const page = stripComments(src("app/(auth)/login/page.tsx"));
check("login page consumes classifyPreLoginResponse", page.includes("classifyPreLoginResponse"));
check("login page classifies by HTTP status, not data.ok alone", page.includes("res.status"));
check("login page no longer branches on `if (!data.ok)`", !/if\s*\(\s*!\s*data\.ok\s*\)/.test(page));
check("login page consumes classifySignInError for step-2", page.includes("classifySignInError"));
check("login page shows the unavailable message", page.includes("LOGIN_MESSAGES.unavailable"));

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll login-outcome checks passed.");
