/**
 * app/api/user/totp/totp-routes.test.ts  (TEST-004)
 *
 * The five 2FA routes — setup, verify, status, disable, recovery-codes — invoked
 * through their REAL exported handlers with real NextAuth session cookies
 * (lib/test-support/route-harness.ts) against the in-memory Prisma fake.
 *
 * The rule under test: a TOTP-PENDING session (forced enrolment) may reach
 * exactly setup / verify / status and nothing else; disable and recovery-codes
 * demand a FRESH (live-checked, not cached) fully-authenticated session.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/user/totp/totp-routes.test.ts
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { decryptWithPurpose, encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { generateSecret, generateTOTP } from "@/lib/totp";
import { generateRecoveryCodes, verifyRecoveryCode } from "@/lib/recovery-codes";

const t = makeChecker("/api/user/totp/{setup,verify,status,disable,recovery-codes} (TEST-004)");
const fake = new FakePrisma();
type H = (req: never, ctx: never) => Promise<Response>;
let SETUP: H, VERIFY: H, STATUS: H, DISABLE: H, CODES: H, SESSIONS: H;
const PW = "the right password";
const call = async (h: H, path: string, cookie: string | null, body?: unknown) => {
  freshCache();
  return invoke(h, request(path, { cookie, body, method: body === undefined && h !== STATUS && h !== SESSIONS ? "POST" : undefined }));
};
const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

async function world() {
  fake.reset();
  freshCache();
  const hash = await bcrypt.hash(PW, 4);
  const secret = generateSecret(20);
  const admin = fake.seed("User", { email: "admin@example.test", username: "admin", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN" });
  const user = fake.seed("User", { email: "u@example.test", username: "u", passwordHash: hash, emailVerifiedAt: new Date() });
  const enrolled = fake.seed("User", { email: "e@example.test", username: "e", passwordHash: hash, emailVerifiedAt: new Date(),
    totpEnabled: true, totpSecret: encryptWithPurpose(secret, EncryptionPurpose.TOTP_SECRET) });
  return { admin, user, enrolled, secret };
}

async function main() {
  await installFakePrisma(fake);
  ({ POST: SETUP } = await import("./setup/route") as unknown as { POST: H });
  ({ POST: VERIFY } = await import("./verify/route") as unknown as { POST: H });
  ({ GET: STATUS } = await import("./status/route") as unknown as { GET: H });
  ({ POST: DISABLE } = await import("./disable/route") as unknown as { POST: H });
  ({ POST: CODES } = await import("./recovery-codes/route") as unknown as { POST: H });
  ({ GET: SESSIONS } = await import("@/app/api/user/sessions/route") as unknown as { GET: H });

  t.section("1. anonymous → 401 everywhere");
  {
    await world();
    const r = await Promise.all([
      call(SETUP, "/api/user/totp/setup", null), call(VERIFY, "/api/user/totp/verify", null, { code: "123456" }),
      call(STATUS, "/api/user/totp/status", null), call(DISABLE, "/api/user/totp/disable", null, { password: PW }),
      call(CODES, "/api/user/totp/recovery-codes", null, { totpCode: "123456" }),
    ]);
    t.check("all five → 401", r.every((x) => x.status === 401), r.map((x) => x.status));
    t.check("no store write", fake.calls.every((c) => c.model === "UserSession" || c.op.startsWith("find")));
  }

  t.section("2. forced enrolment end to end — a PENDING admin session: setup → verify → full access");
  {
    const w = await world();
    const s = await signIn(fake, w.admin.id as string, { requireTotpSetup: true });
    t.check("control: the pending session is refused by an ordinary route (403)", (await call(SESSIONS, "/api/user/sessions", s.cookie)).status === 403);
    t.check("status is reachable while pending", (await call(STATUS, "/api/user/totp/status", s.cookie)).status === 200);
    t.check("disable is NOT reachable while pending (403)", (await call(DISABLE, "/api/user/totp/disable", s.cookie, { password: PW })).status === 403);
    t.check("recovery-codes is NOT reachable while pending (403)", (await call(CODES, "/api/user/totp/recovery-codes", s.cookie, { totpCode: "123456" })).status === 403);

    const setup = await call(SETUP, "/api/user/totp/setup", s.cookie);
    t.check("setup → 200 with a QR data URL and the manual key", setup.status === 200 && String(setup.body.qrCodeDataUrl).startsWith("data:image/png")
      && typeof setup.body.manualKey === "string", setup.status);
    const stored = fake.one("User", { id: w.admin.id })!;
    t.check("the secret is stored ENCRYPTED (decrypts to the manual key; never plaintext)",
      typeof stored.totpSecret === "string" && stored.totpSecret !== setup.body.manualKey
      && decryptWithPurpose(stored.totpSecret as string, EncryptionPurpose.TOTP_SECRET) === setup.body.manualKey);
    t.check("2FA is not yet ENABLED by setup alone", stored.totpEnabled === false);
    t.check("TWO_FACTOR_SETUP_STARTED audited", fake.rows("AuditLog", { action: "TWO_FACTOR_SETUP_STARTED", userId: w.admin.id }).length === 1);
    const st = await call(STATUS, "/api/user/totp/status", s.cookie);
    t.check("status: configured but not enabled", st.body.totpConfigured === true && st.body.totpEnabled === false && st.body.recoveryCodesRemaining === 0, st.body);

    const code = generateTOTP(setup.body.manualKey as string);
    t.check("verify with a non-6-digit code → 400", (await call(VERIFY, "/api/user/totp/verify", s.cookie, { code: "12345" })).status === 400);
    const bad = await call(VERIFY, "/api/user/totp/verify", s.cookie, { code: wrong(code) });
    t.check("verify with a wrong code → 400, still not enabled", bad.status === 400 && fake.one("User", { id: w.admin.id })!.totpEnabled === false);
    const ok = await call(VERIFY, "/api/user/totp/verify", s.cookie, { code });
    const codes = ok.body.recoveryCodes as string[];
    t.check("verify with the current code → 200, ten recovery codes shown once", ok.status === 200 && ok.body.ok === true && Array.isArray(codes) && codes.length === 10, ok.body);
    t.check("2FA is now enabled", fake.one("User", { id: w.admin.id })!.totpEnabled === true);
    const rows = fake.rows("RecoveryCode", { userId: w.admin.id });
    t.check("recovery codes are stored as bcrypt hashes, never the plaintext",
      rows.length === 10 && rows.every((r) => !codes.includes(r.codeHash as string))
      && (await Promise.all(rows.map((r) => bcrypt.compare(codes[0], r.codeHash as string)))).filter(Boolean).length === 1);
    t.check("TWO_FACTOR_ENABLED audited + notification", fake.rows("AuditLog", { action: "TWO_FACTOR_ENABLED" }).length === 1
      && fake.rows("Notification", { userId: w.admin.id }).length >= 1);
    t.check("the SAME session cookie now has full access — the pending hint is re-derived from the store",
      (await call(SESSIONS, "/api/user/sessions", s.cookie)).status === 200);
    t.check("verify again → 400 already enabled", (await call(VERIFY, "/api/user/totp/verify", s.cookie, { code })).status === 400);
    t.check("setup again → 400 'Disable it first' (secret not overwritten)", await (async () => {
      const before = fake.one("User", { id: w.admin.id })!.totpSecret;
      const r = await call(SETUP, "/api/user/totp/setup", s.cookie);
      return r.status === 400 && fake.one("User", { id: w.admin.id })!.totpSecret === before;
    })());
  }

  t.section("3. verify without setup, and the per-user verify limit (non-admins)");
  {
    const w = await world();
    const s = await signIn(fake, w.user.id as string);
    t.check("no setup in progress → 400", (await call(VERIFY, "/api/user/totp/verify", s.cookie, { code: "123456" })).status === 400);
    process.env.RATE_LIMIT_ENABLED = "true";
    try {
      const st: number[] = [];
      for (let i = 0; i < 6; i++) st.push((await call(VERIFY, "/api/user/totp/verify", s.cookie, { code: "123456" })).status);
      t.check("a USER gets 5 verify attempts per 15 min, the 6th is 429", st.slice(0, 5).every((x) => x === 400) && st[5] === 429, st);
      const sv: number[] = [];
      for (let i = 0; i < 6; i++) sv.push((await call(SETUP, "/api/user/totp/setup", s.cookie)).status);
      t.check("setup is limited to 5 per 15 min too", sv.slice(0, 5).every((x) => x === 200) && sv[5] === 429, sv);
    } finally { delete process.env.RATE_LIMIT_ENABLED; }
  }

  t.section("4. disable — fresh session + a fresh code, or (lost device) recovery code + password; never the password alone (B4)");
  {
    const w = await world();
    await generateRecoveryCodes(fake.txClient() as never, w.enrolled.id as string, false);
    const s = await signIn(fake, w.enrolled.id as string);
    const codes = fake.rows("RecoveryCode", { userId: w.enrolled.id }).length;
    t.check("neither code nor password → 400", (await call(DISABLE, "/api/user/totp/disable", s.cookie, {})).status === 400);
    const pwOnly = await call(DISABLE, "/api/user/totp/disable", s.cookie, { password: PW });
    t.check("B4: the CORRECT password alone → 400, 2FA stays on", pwOnly.status === 400
      && fake.one("User", { id: w.enrolled.id })!.totpEnabled === true, pwOnly.body);
    t.check("wrong password → 400, still enabled", (await call(DISABLE, "/api/user/totp/disable", s.cookie, { password: "nope" })).status === 400
      && fake.one("User", { id: w.enrolled.id })!.totpEnabled === true);
    t.check("wrong code → 400", (await call(DISABLE, "/api/user/totp/disable", s.cookie, { totpCode: wrong(generateTOTP(w.secret)) })).status === 400);

    // A revoked session: the cached proof would still say "valid" for 30 s; disable re-checks live.
    const stale = await signIn(fake, w.enrolled.id as string);
    await invoke(STATUS, request("/api/user/totp/status", { cookie: stale.cookie })); // warm the cache
    fake.one("UserSession", { id: stale.sessionId })!.revokedAt = new Date();
    const cached = await invoke(STATUS, request("/api/user/totp/status", { cookie: stale.cookie }));
    const fresh = await invoke(DISABLE, request("/api/user/totp/disable", { cookie: stale.cookie, body: { password: PW } }));
    t.check("control: a cached read still serves the just-revoked session (200)", cached.status === 200, cached.status);
    t.check("…but disable re-checks the store and refuses it (401) — requireFreshUser", fresh.status === 401, fresh.status);

    // Replay: a code whose 30 s step was already claimed for this action is refused.
    const now = generateTOTP(w.secret);
    fake.seed("RateLimit", { key: `user:totp-disable-step:${w.enrolled.id}`, windowStart: new Date(Math.floor(Date.now() / 30_000) * 30_000), count: 1 });
    const replay = await call(DISABLE, "/api/user/totp/disable", s.cookie, { totpCode: now });
    t.check("B4 replay: a code from an already-claimed step → 400, 2FA stays on", replay.status === 400
      && /already used/i.test(String(replay.body.error)) && fake.one("User", { id: w.enrolled.id })!.totpEnabled === true, replay.body);
    t.check("no recovery code was consumed by any refused attempt", fake.rows("RecoveryCode", { userId: w.enrolled.id }).filter((c) => !c.usedAt).length === codes);

    // A code from the NEXT step (inside the ±1 window) is a different, unclaimed step.
    const realNow = Date.now;
    Date.now = () => realNow() + 30_000;
    const nextCode = generateTOTP(w.secret);
    Date.now = realNow;
    const ok = await call(DISABLE, "/api/user/totp/disable", s.cookie, { totpCode: nextCode });
    const u = fake.one("User", { id: w.enrolled.id })!;
    t.check("the current code → 200; 2FA off and the secret erased", ok.status === 200 && u.totpEnabled === false && u.totpSecret === null, ok.body);
    t.check("every recovery code is deleted", fake.rows("RecoveryCode", { userId: w.enrolled.id }).length === 0);
    t.check("TWO_FACTOR_DISABLED audited", fake.rows("AuditLog", { action: "TWO_FACTOR_DISABLED" }).length === 1);
    t.check("disable again → 400 not enabled", (await call(DISABLE, "/api/user/totp/disable", s.cookie, { password: PW })).status === 400);
    t.check("both claimed steps are recorded under the user-scoped key", fake.rows("RateLimit", { key: `user:totp-disable-step:${w.enrolled.id}` }).length === 2);

    // Lost device: recovery code + password.
    const w2 = await world();
    const rc = await generateRecoveryCodes(fake.txClient() as never, w2.enrolled.id as string, false);
    const s2 = await signIn(fake, w2.enrolled.id as string);
    t.check("recovery code alone (no password) → 400", (await call(DISABLE, "/api/user/totp/disable", s2.cookie, { recoveryCode: rc[0] })).status === 400);
    t.check("recovery code + WRONG password → 400, code NOT consumed", (await call(DISABLE, "/api/user/totp/disable", s2.cookie, { recoveryCode: rc[0], password: "nope" })).status === 400
      && fake.rows("RecoveryCode", { userId: w2.enrolled.id }).every((c) => !c.usedAt));
    t.check("unknown recovery code + right password → 400", (await call(DISABLE, "/api/user/totp/disable", s2.cookie, { recoveryCode: "zzzz-zzzz", password: PW })).status === 400
      && fake.one("User", { id: w2.enrolled.id })!.totpEnabled === true);
    const rec = await call(DISABLE, "/api/user/totp/disable", s2.cookie, { recoveryCode: rc[0], password: PW });
    t.check("recovery code + right password → 200, 2FA off, RECOVERY_CODE_USED audited", rec.status === 200
      && fake.one("User", { id: w2.enrolled.id })!.totpEnabled === false
      && fake.rows("AuditLog", { action: "RECOVERY_CODE_USED", userId: w2.enrolled.id }).length === 1, rec.body);

    // Authorization: another user's session cannot act on this account; anonymous is 401.
    const w3 = await world();
    const anon = await invoke(DISABLE, request("/api/user/totp/disable", { body: { totpCode: generateTOTP(w3.secret) } }));
    t.check("anonymous → 401", anon.status === 401, anon.status);
    const other = await signIn(fake, w3.user.id as string);
    const cross = await call(DISABLE, "/api/user/totp/disable", other.cookie, { totpCode: generateTOTP(w3.secret) });
    t.check("another user's session presenting THIS account's code acts only on itself (not enabled → 400); target stays on", cross.status === 400
      && fake.one("User", { id: w3.enrolled.id })!.totpEnabled === true, cross.body);
  }

  t.section("5. recovery-codes regeneration — fresh session + current code; old codes die");
  {
    const w = await world();
    const old = await generateRecoveryCodes(fake.txClient() as never, w.enrolled.id as string, false);
    const s = await signIn(fake, w.enrolled.id as string);
    t.check("a non-6-digit code → 400", (await call(CODES, "/api/user/totp/recovery-codes", s.cookie, { totpCode: "abc" })).status === 400);
    t.check("a wrong code → 400", (await call(CODES, "/api/user/totp/recovery-codes", s.cookie, { totpCode: wrong(generateTOTP(w.secret)) })).status === 400);
    const ok = await call(CODES, "/api/user/totp/recovery-codes", s.cookie, { totpCode: generateTOTP(w.secret) });
    const fresh = ok.body.recoveryCodes as string[];
    t.check("the current code → 200 with ten NEW codes", ok.status === 200 && fresh.length === 10 && fresh.every((c) => !old.includes(c)));
    t.check("an OLD code no longer verifies", !(await verifyRecoveryCode(fake.txClient() as never, w.enrolled.id as string, old[0])));
    t.check("a NEW code does", await verifyRecoveryCode(fake.txClient() as never, w.enrolled.id as string, fresh[0]));
    t.check("RECOVERY_CODES_REGENERATED audited", fake.rows("AuditLog", { action: "RECOVERY_CODES_REGENERATED" }).length === 1);
    const plain = await signIn(fake, w.user.id as string);
    t.check("an account without 2FA → 400", (await call(CODES, "/api/user/totp/recovery-codes", plain.cookie, { totpCode: "123456" })).status === 400);
    process.env.RATE_LIMIT_ENABLED = "true";
    try {
      const st: number[] = [];
      for (let i = 0; i < 4; i++) st.push((await call(CODES, "/api/user/totp/recovery-codes", plain.cookie, { totpCode: "123456" })).status);
      t.check("3 per 15 min, the 4th is 429", st.slice(0, 3).every((x) => x === 400) && st[3] === 429, st);
    } finally { delete process.env.RATE_LIMIT_ENABLED; }
  }

  t.section("6. status reflects the enrolled account");
  {
    const w = await world();
    await generateRecoveryCodes(fake.txClient() as never, w.enrolled.id as string, false);
    fake.rows("RecoveryCode", { userId: w.enrolled.id })[0].usedAt = new Date();
    const s = await signIn(fake, w.enrolled.id as string);
    const r = await call(STATUS, "/api/user/totp/status", s.cookie);
    t.check("{ totpEnabled: true, totpConfigured: true, recoveryCodesRemaining: 9 }",
      r.body.totpEnabled === true && r.body.totpConfigured === true && r.body.recoveryCodesRemaining === 9, r.body);
    t.check("the status body never carries the secret", !JSON.stringify(r.body).includes(w.secret));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
