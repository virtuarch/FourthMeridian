/**
 * app/api/auth/[...nextauth]/route.test.ts  (TEST-004)
 *
 * SIGN-IN AND SIGN-OUT THROUGH THE REAL NEXTAUTH ROUTE. Every request goes to the
 * exported `GET` / `POST` of this route (so the per-IP callback limiter in
 * `limitedPost` is in the path), exactly as a browser drives it:
 *
 *   GET  /api/auth/csrf                 → csrf cookie + token
 *   POST /api/auth/callback/credentials → lib/auth.ts authorize() → session cookie
 *   POST /api/auth/signout              → events.signOut → session row revoked
 *
 * Nothing in lib/auth.ts is stubbed; the store is the in-memory Prisma fake. A
 * session cookie the flow issues is then presented to REAL API routes to prove
 * what it can (and cannot) reach.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/auth/[...nextauth]/route.test.ts"
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, freshCache } from "@/lib/test-support/route-harness";
import { encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { generateSecret, generateTOTP } from "@/lib/totp";
import { generateRecoveryCodes } from "@/lib/recovery-codes";
import { capturedEmails, clearCapturedEmails } from "@/lib/email/providers/capture";
import { LOGIN_ID_LIMIT } from "@/lib/login-limits";

const t = makeChecker("NextAuth credentials sign-in / sign-out (TEST-004)");
const fake = new FakePrisma();
let GET: typeof import("./route").GET;
let POST: typeof import("./route").POST;
let STATUS: typeof import("@/app/api/user/totp/status/route").GET;
let SESSIONS: typeof import("@/app/api/user/sessions/route").GET;
const env = process.env as Record<string, string | undefined>;
const PW = "the right password";
let ipSeq = 0;
const nextIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;

type Jar = Map<string, string>;
const jarHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function absorb(jar: Jar, res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i), value = pair.slice(i + 1);
    if (/expires=Thu, 01 Jan 1970/i.test(c) || /max-age=0/i.test(c) || value === "") jar.delete(name); else jar.set(name, value);
  }
}
const SESSION_COOKIE = "__Host-next-auth.session-token";

async function csrf(jar: Jar, ip: string): Promise<string> {
  const r = await invoke<{ csrfToken: string }>(GET, request("/api/auth/csrf", { cookie: jarHeader(jar), ip }), { nextauth: ["csrf"] });
  absorb(jar, r.res);
  return r.body.csrfToken;
}

interface Attempt { status: number; url: string; error: string | null; jar: Jar; cookie: string | null }
async function signIn(fields: Record<string, string>, ip = nextIp(), jar: Jar = new Map()): Promise<Attempt> {
  const token = await csrf(jar, ip);
  const form = new URLSearchParams({ csrfToken: token, json: "true", callbackUrl: "/dashboard", ...fields });
  const r = await invoke<{ url: string }>(POST, request("/api/auth/callback/credentials", {
    method: "POST", rawBody: form.toString(), cookie: jarHeader(jar), ip,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }), { nextauth: ["callback", "credentials"] });
  absorb(jar, r.res);
  const url = r.body?.url ?? "";
  const error = url.includes("error=") ? new URL(url).searchParams.get("error") : null;
  const session = jar.get(SESSION_COOKIE);
  return { status: r.status, url, error, jar, cookie: session ? `${SESSION_COOKIE}=${session}` : null };
}
const lastFailure = () => {
  const rows = fake.rows("AuditLog", { action: "LOGIN_FAILED" });
  return rows[rows.length - 1]?.metadata as Record<string, unknown> | undefined;
};
const status = async (cookie: string | null) => { freshCache(); return (await invoke(STATUS, request("/api/user/totp/status", { cookie }))).status; };

let TOTP_SECRET = "";
async function world() {
  fake.reset();
  clearCapturedEmails();
  freshCache();
  const hash = await bcrypt.hash(PW, 4);
  const now = new Date();
  TOTP_SECRET = generateSecret(20);
  const base = { passwordHash: hash, emailVerifiedAt: now };
  const users = {
    ok:     fake.seed("User", { email: "ok@example.test", username: "ok", ...base }),
    unver:  fake.seed("User", { email: "unver@example.test", username: "unver", passwordHash: hash }),
    off:    fake.seed("User", { email: "off@example.test", username: "off", ...base, deactivatedAt: now }),
    gone:   fake.seed("User", { email: "gone@example.test", username: "gone", ...base, deactivatedAt: now, deletionRequestedAt: now, deletionScheduledAt: new Date(Date.now() + 30 * 86_400_000) }),
    mfa:    fake.seed("User", { email: "mfa@example.test", username: "mfa", ...base, totpEnabled: true, totpSecret: encryptWithPurpose(TOTP_SECRET, EncryptionPurpose.TOTP_SECRET) }),
    admin:  fake.seed("User", { email: "admin@example.test", username: "admin", ...base, role: "SYSTEM_ADMIN" }),
    // Its own identifier bucket: the in-memory limiter outlives world(), and section 7 exhausts "ok".
    cap:    fake.seed("User", { email: "cap@example.test", username: "cap", ...base }),
  };
  return users;
}

async function main() {
  await installFakePrisma(fake);
  ({ GET, POST } = await import("./route"));
  ({ GET: STATUS } = await import("@/app/api/user/totp/status/route"));
  ({ GET: SESSIONS } = await import("@/app/api/user/sessions/route"));

  t.section("1. correct password → a session cookie backed by a UserSession row");
  {
    const u = await world();
    const a = await signIn({ identifier: "OK@example.test", password: PW }, "203.0.113.44");
    t.check("200 and a redirect to the callback (no error)", a.status === 200 && a.error === null && a.url.endsWith("/dashboard"), a);
    t.check("a __Host- session cookie is issued", !!a.cookie);
    const rows = fake.rows("UserSession", { userId: u.ok.id });
    t.check("exactly one UserSession row, with the client IP and user agent", rows.length === 1 && rows[0].ipAddress === "203.0.113.44" && typeof rows[0].userAgent === "string");
    const login = fake.one("AuditLog", { action: "LOGIN" })!;
    t.check("LOGIN audit (SUCCESS, mfa: none)", (login.metadata as Record<string, unknown>).mfa === "none");
    t.check("the cookie authenticates a real API route", await status(a.cookie) === 200);
  }

  t.section("2. refusals — each one audited with its reason, no session");
  {
    const u = await world();
    const cases: [string, Record<string, string>, string, string | undefined][] = [
      ["wrong password",       { identifier: "ok", password: "nope" }, "invalid_password", u.ok.id as string],
      ["unknown account",      { identifier: "ghost@example.test", password: PW }, "user_not_found", undefined],
      ["unverified e-mail",    { identifier: "unver", password: PW }, "email_unverified", u.unver.id as string],
      ["deactivated",          { identifier: "off", password: PW }, "account_deactivated", u.off.id as string],
      ["pending deletion",     { identifier: "gone", password: PW }, "pending_deletion", u.gone.id as string],
    ];
    for (const [name, fields, reason, userId] of cases) {
      const before = fake.rows("AuditLog", { action: "LOGIN_FAILED" }).length;
      const a = await signIn(fields);
      const f = lastFailure();
      const row = fake.rows("AuditLog", { action: "LOGIN_FAILED" }).slice(-1)[0];
      t.check(`${name} → 401 CredentialsSignin, no cookie, LOGIN_FAILED reason=${reason}`,
        a.status === 401 && a.error === "CredentialsSignin" && a.cookie === null && f?.reason === reason
        && fake.rows("AuditLog", { action: "LOGIN_FAILED" }).length === before + 1 && (row?.userId ?? undefined) === userId, { a, f });
    }
    t.check("no refusal created a UserSession", fake.rows("UserSession").length === 0);
  }

  t.section("3. deactivated + reactivate=true, pending deletion + cancelDeletion=true");
  {
    const u = await world();
    const r = await signIn({ identifier: "off", password: PW, reactivate: "true" });
    t.check("reactivation signs in", r.status === 200 && !!r.cookie, r);
    t.check("deactivatedAt cleared + ACCOUNT_REACTIVATED audit + security e-mail",
      fake.one("User", { id: u.off.id })!.deactivatedAt === null && fake.rows("AuditLog", { action: "ACCOUNT_REACTIVATED" }).length === 1
      && capturedEmails().some((m) => m.to === "off@example.test"));
    const reactivateGone = await signIn({ identifier: "gone", password: PW, reactivate: "true" });
    t.check("reactivate=true does NOT bypass a pending deletion", reactivateGone.status === 401 && lastFailure()?.reason === "pending_deletion");
    const c = await signIn({ identifier: "gone", password: PW, cancelDeletion: "true" });
    const g = fake.one("User", { id: u.gone.id })!;
    t.check("cancelDeletion=true signs in and clears all three deletion/deactivation fields",
      c.status === 200 && !!c.cookie && g.deletionScheduledAt === null && g.deletionRequestedAt === null && g.deactivatedAt === null, c);
  }

  t.section("4. TOTP — required, rejected, accepted");
  {
    await world();
    const none = await signIn({ identifier: "mfa", password: PW });
    t.check("no code → refused, reason totp_required", none.status === 401 && lastFailure()?.reason === "totp_required");
    const code = generateTOTP(TOTP_SECRET);
    const wrongCode = code === "000000" ? "111111" : "000000";
    const bad = await signIn({ identifier: "mfa", password: PW, totpCode: wrongCode });
    t.check("wrong code → refused, reason totp_invalid", bad.status === 401 && lastFailure()?.reason === "totp_invalid");
    const wrongPwGoodCode = await signIn({ identifier: "mfa", password: "nope", totpCode: code });
    t.check("a valid code never rescues a wrong password", wrongPwGoodCode.status === 401 && lastFailure()?.reason === "invalid_password");
    const ok = await signIn({ identifier: "mfa", password: PW, totpCode: code.slice(0, 3) + " " + code.slice(3) });
    t.check("the current code (spaces tolerated) → signed in, LOGIN mfa: totp",
      ok.status === 200 && !!ok.cookie && (fake.one("AuditLog", { action: "LOGIN" })!.metadata as Record<string, unknown>).mfa === "totp", ok);
  }

  t.section("5. recovery codes — accepted once, then refused");
  {
    const u = await world();
    const codes = await generateRecoveryCodes(fake.txClient() as never, u.mfa.id as string, false);
    const ok = await signIn({ identifier: "mfa", password: PW, recoveryCode: codes[0] });
    t.check("a valid recovery code signs in (mfa: recovery)", ok.status === 200 && !!ok.cookie
      && (fake.one("AuditLog", { action: "LOGIN" })!.metadata as Record<string, unknown>).mfa === "recovery", ok);
    t.check("…and that code is marked used (RECOVERY_CODE_USED audited)", fake.rows("RecoveryCode", { userId: u.mfa.id, usedAt: null }).length === codes.length - 1
      && fake.rows("AuditLog", { action: "RECOVERY_CODE_USED" }).length === 1);
    const again = await signIn({ identifier: "mfa", password: PW, recoveryCode: codes[0] });
    t.check("the SAME code a second time → refused, reason recovery_code_invalid", again.status === 401 && lastFailure()?.reason === "recovery_code_invalid");
    t.check("a made-up code → refused", (await signIn({ identifier: "mfa", password: PW, recoveryCode: "AAAA-BBBB" })).status === 401);

    // Two sign-ins racing on ONE unused code.
    const [x, y] = await Promise.all([
      signIn({ identifier: "mfa", password: PW, recoveryCode: codes[1] }),
      signIn({ identifier: "mfa", password: PW, recoveryCode: codes[1] }),
    ]);
    const wins = [x, y].filter((a) => a.status === 200).length;
    t.known("two CONCURRENT sign-ins with one recovery code → exactly one succeeds (single use under concurrency)",
      wins === 1, `J-D2: lib/recovery-codes.ts verifyRecoveryCode marks used with an unconditional update — ${wins} of 2 succeeded`);
  }

  t.section("6. forced TOTP enrolment — a SYSTEM_ADMIN without 2FA gets a PENDING session");
  {
    await world();
    const a = await signIn({ identifier: "admin", password: PW });
    t.check("the password sign-in succeeds (the session exists)", a.status === 200 && !!a.cookie, a);
    freshCache();
    const enrol = await invoke(STATUS, request("/api/user/totp/status", { cookie: a.cookie }));
    freshCache();
    const other = await invoke(SESSIONS, request("/api/user/sessions", { cookie: a.cookie }));
    t.check("the enrolment flow (allowTotpSetupPending) is reachable: 200", enrol.status === 200, enrol.status);
    t.check("everything else is 403 until enrolled", other.status === 403, other.status);
    env.DISABLE_SYSTEM_ADMIN = "true";
    try {
      const d = await signIn({ identifier: "admin", password: PW });
      t.check("DISABLE_SYSTEM_ADMIN=true → admin sign-in refused, reason system_admin_disabled", d.status === 401 && lastFailure()?.reason === "system_admin_disabled");
    } finally { delete env.DISABLE_SYSTEM_ADMIN; }
    fake.seed("PlatformSetting", { key: "require_totp_all_users", value: "true" });
    const u = await signIn({ identifier: "ok", password: PW });
    freshCache();
    const blocked = await invoke(SESSIONS, request("/api/user/sessions", { cookie: u.cookie }));
    t.check("require_totp_all_users=true puts an un-enrolled USER in the same pending state (403)", u.status === 200 && blocked.status === 403);
  }

  t.section("7. limits — per identifier (authorize) and per IP (the route)");
  {
    await world();
    env.RATE_LIMIT_ENABLED = "true";
    try {
      for (let i = 0; i < LOGIN_ID_LIMIT; i++) await signIn({ identifier: "ok", password: "nope" });
      const locked = await signIn({ identifier: "OK", password: PW });
      t.check(`after ${LOGIN_ID_LIMIT} attempts on one identifier, even the RIGHT password is refused (from fresh IPs)`, locked.status === 401 && !locked.cookie);
      t.check("…the limited attempt never reached the user store", fake.callsTo("User", "findFirst").length === LOGIN_ID_LIMIT);
      t.check("another identifier still signs in", (await signIn({ identifier: "mfa", password: PW, totpCode: generateTOTP(TOTP_SECRET) })).status === 200);
      const ip = "192.0.2.200";
      const s: number[] = [];
      for (let i = 0; i < 21; i++) s.push((await signIn({ identifier: `nobody${i}`, password: "x" }, ip)).status);
      t.check("the 21st credentials POST from one IP is 429 (route-level limiter)", s.slice(0, 20).every((x) => x === 401) && s[20] === 429, s);
    } finally { delete env.RATE_LIMIT_ENABLED; }
  }

  t.section("8. CAPTCHA step-up after repeated failures on an identifier");
  {
    await world();
    env.RATE_LIMIT_ENABLED = "true";
    env.TURNSTILE_SECRET_KEY = "test-secret";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch;
    try {
      for (let i = 0; i < 3; i++) await signIn({ identifier: "cap", password: "nope" });
      t.check("control: the three failures reached the password check", fake.rows("AuditLog", { action: "LOGIN_FAILED" }).length === 3);
      const r = await signIn({ identifier: "cap", password: PW });
      t.check("once over the threshold, the right password WITHOUT a passing CAPTCHA is refused — before the user lookup",
        r.status === 401 && !r.cookie && fake.callsTo("User", "findFirst").length === 3);
      globalThis.fetch = (async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch;
      const pass = await signIn({ identifier: "cap", password: PW, captchaToken: "tok" });
      t.check("…and with a passing CAPTCHA it signs in", pass.status === 200, { pass, f: lastFailure() });
    } finally {
      globalThis.fetch = realFetch;
      delete env.TURNSTILE_SECRET_KEY;
      delete env.RATE_LIMIT_ENABLED;
    }
  }

  t.section("9. FAIL CLOSED — the user store unreachable is 'temporarily unavailable', not a bad password");
  {
    await world();
    fake.on("User", "findFirst", () => { throw new Error("P1001"); }, { once: true });
    const r = await signIn({ identifier: "ok", password: PW });
    t.check("error=TEMPORARILY_UNAVAILABLE, no cookie, no LOGIN_FAILED", r.error === "TEMPORARILY_UNAVAILABLE" && !r.cookie
      && fake.rows("AuditLog", { action: "LOGIN_FAILED" }).length === 0, r);
  }

  t.section("10. sign-out revokes the session row; the cookie stops working");
  {
    const u = await world();
    const a = await signIn({ identifier: "ok", password: PW });
    t.check("control: signed in", await status(a.cookie) === 200);
    const token = await csrf(a.jar, "198.51.100.3");
    const out = await invoke(POST, request("/api/auth/signout", {
      method: "POST", rawBody: new URLSearchParams({ csrfToken: token, json: "true" }).toString(), cookie: jarHeader(a.jar),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }), { nextauth: ["signout"] });
    t.check("signout answers 200", out.status === 200, out.status);
    t.check("the UserSession row is revoked", fake.rows("UserSession", { userId: u.ok.id, revokedAt: null }).length === 0);
    t.check("a LOGOUT audit row is written", fake.rows("AuditLog", { action: "LOGOUT", userId: u.ok.id }).length === 1);
    t.check("REPLAYING the old cookie is refused (401) — revocation is server-side, not just a cleared cookie", await status(a.cookie) === 401);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
