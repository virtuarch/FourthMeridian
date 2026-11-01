/**
 * app/api/auth/register/route.test.ts  (TEST-004)
 *
 * POST /api/auth/register — the REAL exported handler, invoked with a NextRequest,
 * against the in-memory Prisma fake (lib/test-support/fake-prisma.ts). Nothing in
 * the route is stubbed: the registration-mode read, the invite validator and
 * redeemer, bcrypt, the verification token, the capture e-mail transport and the
 * in-memory rate limiter are the production modules.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/auth/register/route.test.ts
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma, knownError } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { hashResetToken } from "@/lib/password-reset-token";
import { auditEmailHash } from "@/lib/audit";
import { capturedEmails, clearCapturedEmails } from "@/lib/email/providers/capture";
import { getTemplateForCategory } from "@/lib/space-templates/registry";
import { planTemplateApplication } from "@/lib/space-templates/apply";

const t = makeChecker("POST /api/auth/register (TEST-004)");
let POST: typeof import("./route").POST;
const fake = new FakePrisma();

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq}`;
const form = (over: Record<string, unknown> = {}) => ({
  email: "New.Person@Example.test", username: "New_Person", password: "correct horse battery",
  firstName: "New", lastName: "Person", acceptedTerms: true, ...over,
});
const register = (body: unknown, ip = nextIp()) => invoke(POST, request("/api/auth/register", { body, ip }));
function world(mode: string | null) {
  fake.reset();
  clearCapturedEmails();
  if (mode) fake.seed("PlatformSetting", { key: "registration_mode", value: mode });
}
function invite(email: string, over: Record<string, unknown> = {}) {
  const raw = `invite-${Math.random().toString(36).slice(2)}`;
  const row = fake.seed("BetaAccessRequest", {
    email, status: "APPROVED", inviteTokenHash: hashResetToken(raw), inviteExpiresAt: new Date(Date.now() + 86_400_000), ...over,
  });
  return { raw, row };
}

async function main() {
  await installFakePrisma(fake);
  ({ POST } = await import("./route"));

  t.section("1. SEC-008 — no registration_mode row ⇒ invite_only (fail closed)");
  {
    world(null);
    const r = await register(form());
    t.check("an uninvited sign-up on a fresh database is 403", r.status === 403, r);
    t.check("…with the invite-required message", String(r.body.error).includes("invite is required"));
    t.check("no User was created", fake.rows("User").length === 0);
    t.check("an unrecognised mode value also fails closed (403)", await (async () => {
      world("OPEN "); return (await register(form())).status === 403 && fake.rows("User").length === 0;
    })());
  }

  t.section("2. closed mode");
  {
    world("closed");
    const r = await register(form({ email: "not-an-email" }));
    t.check("403 before any field validation (no oracle on which fields fail)", r.status === 403 && r.body.error === "Registration is currently closed.", r);
    t.check("no rows written", fake.rows("User").length === 0 && fake.rows("Space").length === 0);
  }

  t.section("3. consent + field validation (open mode)");
  {
    world("open");
    const terms = await register(form({ acceptedTerms: "yes" }));
    t.check("acceptedTerms must be literally true → 400", terms.status === 400 && String(terms.body.error).includes("Terms"));
    t.check("invalid email → 400", (await register(form({ email: "nope" }))).status === 400);
    t.check("username with a space → 400", (await register(form({ username: "has space" }))).status === 400);
    t.check("username of 2 chars → 400", (await register(form({ username: "ab" }))).status === 400);
    fake.seed("PlatformSetting", { key: "min_password_length", value: "14" });
    const short = await register(form({ password: "thirteen-char" }));
    t.check("password below the ADMIN-CONFIGURED minimum (14) → 400 naming it", short.status === 400 && String(short.body.error).includes("14"), short.body);
    t.check("blank first name → 400", (await register(form({ firstName: "  " }))).status === 400);
    t.check("credit score 900 → 400", (await register(form({ creditScore: 900 }))).status === 400);
    t.check("credit score as a string → 400", (await register(form({ creditScore: "700" }))).status === 400);
    t.check("nothing was written by any refusal", fake.rows("User").length === 0);
  }

  t.section("4. open mode — the happy path writes the whole account atomically");
  {
    world("open");
    const r = await register(form({ creditScore: 712, dateOfBirth: "1990-04-01" }));
    t.check("201 { success, userId, verificationRequired: true }", r.status === 201 && r.body.success === true
      && typeof r.body.userId === "string" && r.body.verificationRequired === true, r);
    const u = fake.one("User", { id: r.body.userId })!;
    t.check("email and username are normalised to lower case", u.email === "new.person@example.test" && u.username === "new_person");
    t.check("the password is stored as a bcrypt hash, never plaintext",
      typeof u.passwordHash === "string" && u.passwordHash !== "correct horse battery" && await bcrypt.compare("correct horse battery", u.passwordHash as string));
    t.check("date of birth is encrypted at rest", typeof u.dateOfBirthEncrypted === "string" && !(u.dateOfBirthEncrypted as string).includes("1990"));
    t.check("uninvited ⇒ unverified, with a hashed token and a ~1h expiry", u.emailVerifiedAt === null
      && typeof u.emailVerificationToken === "string"
      && Math.abs((u.emailVerificationExpiry as Date).getTime() - Date.now() - 3_600_000) < 60_000);
    t.check("consent recorded with a version", u.acceptedTermsAt instanceof Date && typeof u.acceptedTermsVersion === "string");
    const space = fake.one("Space", { id: u.preferredSpaceId })!;
    t.check("a PERSONAL Space is created and set as the landing Space", space?.type === "PERSONAL" && space.name === "New’s Space" || space?.name === "New's Space", space?.name);
    const planned = planTemplateApplication(getTemplateForCategory("PERSONAL")!, new Set<string>()).sectionsToCreate.length;
    t.check("…template-backed: exactly the planner's sections are materialised", fake.rows("SpaceDashboardSection", { spaceId: space.id }).length === planned);
    t.check("the registrant is its ACTIVE OWNER", fake.rows("SpaceMember", { spaceId: space.id, userId: u.id, role: "OWNER", status: "ACTIVE" }).length === 1);
    t.check("an AI agent, a credit-score seed and the default policy group exist",
      fake.rows("AiAgent", { spaceId: space.id }).length === 1 && fake.rows("CreditScore", { userId: u.id, score: 712 }).length === 1
      && fake.rows("CustomerPolicyAssignment", { userId: u.id }).length === 1);
    t.check("an open-mode signup joins NO cohort", fake.rows("CustomerCohort").length === 0);
    const audit = fake.one("AuditLog", { action: "REGISTER" })!;
    t.check("REGISTER audit carries the e-mail DIGEST, never the address (PRIV-002 / BETA A7)",
      (audit.metadata as Record<string, unknown>).emailHash === auditEmailHash("new.person@example.test")
      && !JSON.stringify(audit).includes("example.test"));
    const mail = capturedEmails();
    t.check("exactly one verification e-mail, to the normalised address", mail.length === 1 && mail[0].to === "new.person@example.test");
    // 2026-10-31: the welcome waits for verification — never beside the verification e-mail.
    t.check("uninvited: NO welcome at registration (no e-mail, no ACCOUNT_WELCOME row)",
      !mail.some((m) => /Welcome to Fourth Meridian/.test(m.subject)) && fake.rows("Notification", { type: "ACCOUNT_WELCOME" }).length === 0);
    const m = /token=([0-9a-f]{64})/.exec(mail[0]?.text ?? "");
    t.check("the link carries the RAW token whose hash is what was stored", !!m && hashResetToken(m[1]) === u.emailVerificationToken);
    t.check("the raw token is not what was stored", !!m && m[1] !== u.emailVerificationToken);
  }

  t.section("5. duplicates → 409, nothing written");
  {
    world("open");
    await register(form());
    const users = fake.rows("User").length;
    const e = await register(form({ username: "someone_else", email: "NEW.PERSON@example.test" }));
    t.check("duplicate e-mail (any case) → 409", e.status === 409 && String(e.body.error).includes("email"), e.body);
    const u = await register(form({ email: "other@example.test", username: "NEW_PERSON" }));
    t.check("duplicate username (any case) → 409", u.status === 409 && String(u.body.error).includes("username"), u.body);
    t.check("no extra user, Space or membership", fake.rows("User").length === users && fake.rows("Space").length === 1 && fake.rows("SpaceMember").length === 1);
  }

  t.section("6. IDEMP-011 — two concurrent registrations of one identity: one 201, one 409 (P2002), no orphan");
  {
    world("open");
    const [a, b] = await Promise.all([register(form()), register(form())]);
    const statuses = [a.status, b.status].sort();
    t.check("both passed the read-side uniqueness check (control: the race was real)",
      fake.callsTo("User", "findUnique").length === 4, fake.callsTo("User", "findUnique").length);
    t.check("exactly one 201 and one 409", statuses[0] === 201 && statuses[1] === 409, statuses);
    const loser = a.status === 409 ? a : b;
    t.check("the loser gets the honest 409, not a 500", String(loser.body.error).includes("already exists"));
    t.check("exactly one User, one Space, one membership, one agent — the loser's transaction rolled back",
      fake.rows("User").length === 1 && fake.rows("Space").length === 1 && fake.rows("SpaceMember").length === 1 && fake.rows("AiAgent").length === 1,
      { users: fake.rows("User").length, spaces: fake.rows("Space").length });
    world("open");
    fake.on("SpaceMember", "create", () => { throw knownError("P2002", "boom"); }, { once: true });
    const late = await register(form());
    t.check("a P2002 raised LATE in the transaction is also 409 and leaves no User/Space", late.status === 409
      && fake.rows("User").length === 0 && fake.rows("Space").length === 0);
    world("open");
    fake.on("AiAgent", "create", () => { throw new Error("db down"); }, { once: true });
    const crash = await register(form());
    t.check("any other failure → generic 500, everything rolled back, no e-mail sent",
      crash.status === 500 && crash.body.error === "Registration failed. Please try again." && fake.rows("User").length === 0 && capturedEmails().length === 0);
  }

  t.section("7. invite_only — the invite is required, e-mail-bound, single-use");
  {
    world("invite_only");
    const inv = invite("new.person@example.test");
    t.check("no invite token → 403", (await register(form())).status === 403);
    t.check("an unknown token → 403", (await register(form({ inviteToken: "made-up" }))).status === 403);
    const other = await register(form({ inviteToken: inv.raw, email: "someone@example.test" }));
    t.check("a valid invite used by a DIFFERENT e-mail → 403", other.status === 403 && String(other.body.error).includes("different email"));
    const ok = await register(form({ inviteToken: inv.raw }));
    t.check("the invited address registers → 201, verificationRequired: false", ok.status === 201 && ok.body.verificationRequired === false, ok);
    const u = fake.one("User", { id: ok.body.userId })!;
    t.check("invited ⇒ pre-verified, no verification token stored", u.emailVerifiedAt instanceof Date && u.emailVerificationToken === null);
    // 2026-10-31: the invited account is usable now, so its ONE email is the welcome (never a verification email).
    t.check("no verification e-mail; exactly one e-mail, the welcome",
      capturedEmails().length === 1 && capturedEmails()[0].subject === "Welcome to Fourth Meridian" && !/token=/.test(capturedEmails()[0].text),
      capturedEmails().map((m) => m.subject));
    const req = fake.one("BetaAccessRequest", { id: inv.row.id })!;
    t.check("the invite is REDEEMED to this user and its token hash nulled", req.status === "REDEEMED" && req.redeemedUserId === u.id && req.inviteTokenHash === null);
    t.check("the account joins the invite cohort", fake.rows("CustomerCohort", { userId: u.id, source: "INVITE" }).length === 1);
    const red = fake.one("AuditLog", { action: "BETA_ACCESS_REDEEMED" });
    t.check("BETA_ACCESS_REDEEMED audit, by digest", !!red && !JSON.stringify(red).includes("example.test"));
    // Remove the account so the e-mail uniqueness check cannot answer first: the invite alone must refuse.
    fake.table("User").splice(0);
    const again = await register(form({ inviteToken: inv.raw, username: "second_go" }));
    t.check("reusing the redeemed invite → 403 'invalid or has expired' (it no longer resolves)",
      again.status === 403 && String(again.body.error).includes("invalid or has expired"), again.body);

    world("invite_only");
    const old = invite("late@example.test", { inviteExpiresAt: new Date(Date.now() - 1000) });
    t.check("an expired invite → 403", (await register(form({ email: "late@example.test", inviteToken: old.raw }))).status === 403);
    const pending = invite("pending@example.test", { status: "PENDING" });
    t.check("an invite that is not APPROVED → 403", (await register(form({ email: "pending@example.test", inviteToken: pending.raw }))).status === 403);
  }

  t.section("8. RLS-C-S6 — an invite that cannot be consumed aborts the whole registration (409)");
  {
    world("invite_only");
    const inv = invite("new.person@example.test");
    // The conditional redemption matches 0 rows — a concurrent redemption won, or a policy refused it.
    fake.on("BetaAccessRequest", "updateMany", () => ({ count: 0 }), { once: true });
    const r = await register(form({ inviteToken: inv.raw }));
    t.check("409 with the 'could not be redeemed' message", r.status === 409 && String(r.body.error).includes("could not be redeemed"), r);
    t.check("no User, Space, membership, cohort or audit survives (transaction rolled back)",
      fake.rows("User").length === 0 && fake.rows("Space").length === 0 && fake.rows("SpaceMember").length === 0
      && fake.rows("CustomerCohort").length === 0 && fake.rows("AuditLog").length === 0);
    t.check("the invite is still APPROVED and still redeemable", fake.one("BetaAccessRequest", { id: inv.row.id })!.status === "APPROVED"
      && (await register(form({ inviteToken: inv.raw }))).status === 201);
  }

  t.section("8b. WELCOME (owner-approved 2026-10-31) — invited: once, at registration, idempotent");
  {
    world("invite_only");
    const inv = invite("new.person@example.test");
    const ok = await register(form({ inviteToken: inv.raw }));
    const userId = ok.body.userId as string;
    const mail = capturedEmails();
    t.check("201, and exactly one e-mail: the welcome, to the normalised address",
      ok.status === 201 && mail.length === 1 && mail[0].to === "new.person@example.test" && mail[0].subject === "Welcome to Fourth Meridian");
    t.check("…greets by first name, ONE action 'Open Fourth Meridian' → /dashboard, with the legal footer",
      /Welcome, New/.test(mail[0].text) && (mail[0].html ?? "").split("Open Fourth Meridian").length - 1 === 1
        && /\/dashboard(?![\w/])/.test(mail[0].text) && /Privacy/i.test(mail[0].text) && /Terms/i.test(mail[0].text));
    const rows = fake.rows("Notification", { userId, type: "ACCOUNT_WELCOME" });
    t.check("one ACCOUNT_WELCOME in-app row, holding the one-time key",
      rows.length === 1 && rows[0].dedupeKey === `ACCOUNT_WELCOME:user:${userId}:once`, rows.map((r) => r.dedupeKey));
    // Ledger keys (ACCOUNT_WELCOME on both legs) are proven in lib/notifications/new-notifications.test.ts:
    // the production ledger writer records nothing under NODE_ENV=test.
    const { sendWelcome } = await import("@/lib/notifications/welcome");
    const again = await sendWelcome({ userId, email: "new.person@example.test", firstName: "New" });
    t.check("a second welcome for the same account is a duplicate: no e-mail, no row", again === "duplicate"
      && capturedEmails().length === 1 && fake.rows("Notification", { userId, type: "ACCOUNT_WELCOME" }).length === 1);
    fake.table("Notification").forEach((r) => { if (r.type === "ACCOUNT_WELCOME") r.archivedAt = new Date(); });
    const afterDismiss = await sendWelcome({ userId, email: "new.person@example.test", firstName: "New" });
    t.check("…even after the user dismissed (archived) the welcome: the one-time key is never released",
      afterDismiss === "duplicate" && capturedEmails().length === 1);
  }

  t.section("9. CAPTCHA (configured) — a rejected token stops before any DB work");
  {
    world("open");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const realFetch = globalThis.fetch;
    let siteverify = 0;
    globalThis.fetch = (async () => { siteverify++; return new Response(JSON.stringify({ success: false }), { status: 200 }); }) as typeof fetch;
    try {
      const r = await register(form({ captchaToken: "bad" }));
      t.check("Cloudflare says no → 400", r.status === 400 && String(r.body.error).includes("CAPTCHA"), r);
      t.check("siteverify was consulted once, and no user lookup happened", siteverify === 1 && fake.callsTo("User").length === 0);
      t.check("a missing token with CAPTCHA configured → 400 without a network call",
        (await register(form())).status === 400 && siteverify === 1);
      // R2 — Cloudflare unreachable → honest 503 (fail-closed), never a pass.
      globalThis.fetch = (async () => { siteverify++; return new Response("down", { status: 502 }); }) as typeof fetch;
      const origErr = console.error; console.error = () => {};
      const down = await register(form({ captchaToken: "tok" })).finally(() => { console.error = origErr; });
      t.check("siteverify 502 → 503 'temporarily unavailable' with Retry-After, nothing written",
        down.status === 503 && String(down.body.error).includes("temporarily unavailable") && !!down.headers.get("retry-after")
        && fake.callsTo("User").length === 0, down);
      // Strict siteverify — success:true for another surface's action is a failed challenge.
      globalThis.fetch = (async () => { siteverify++; return new Response(JSON.stringify({ success: true, hostname: "localhost", action: "access_request", challenge_ts: new Date().toISOString() }), { status: 200 }); }) as typeof fetch;
      const origWarn = console.warn; console.warn = () => {};
      const wrong = await register(form({ captchaToken: "tok" })).finally(() => { console.warn = origWarn; });
      t.check("success:true with action 'access_request' at registration → 400, no user lookup", wrong.status === 400 && fake.callsTo("User").length === 0, wrong);
      // Production with the secret MISSING → 503 (fail closed), Cloudflare never consulted.
      const savedVercelEnv = process.env.VERCEL_ENV;
      const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;
      process.env.VERCEL_ENV = "production";
      process.env.NEXT_PUBLIC_APP_URL = "https://app.fourthmeridian.com";
      delete process.env.TURNSTILE_SECRET_KEY;
      const calls = siteverify;
      console.error = () => {};
      const prodMissing = await register(form({ captchaToken: "tok" })).finally(() => {
        console.error = origErr;
        if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedVercelEnv;
        if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
      });
      t.check("Production + no Turnstile keys → 503 with Retry-After, nothing written, Cloudflare not called",
        prodMissing.status === 503 && !!prodMissing.headers.get("retry-after") && siteverify === calls && fake.callsTo("User").length === 0, prodMissing);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.TURNSTILE_SECRET_KEY;
    }
  }

  t.section("10. per-IP rate limit — 5 per 15 min");
  {
    world("closed");
    process.env.RATE_LIMIT_ENABLED = "true";
    try {
      const ip = "192.0.2.77";
      const first5 = [];
      for (let i = 0; i < 5; i++) first5.push((await register(form(), ip)).status);
      const sixth = await register(form(), ip);
      t.check("the first five reach the handler (403 closed)", first5.every((s) => s === 403), first5);
      t.check("the sixth is 429 with a Retry-After", sixth.status === 429 && Number(sixth.headers.get("retry-after")) > 0);
      t.check("the limiter answers before the registration-mode read",
        fake.callsTo("PlatformSetting").length === 5, fake.callsTo("PlatformSetting").length);
      t.check("another IP is unaffected", (await register(form(), "192.0.2.78")).status === 403);
    } finally {
      delete process.env.RATE_LIMIT_ENABLED;
    }
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
