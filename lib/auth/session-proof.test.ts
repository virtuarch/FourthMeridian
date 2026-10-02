/**
 * lib/auth/session-proof.test.ts — P1: a validly signed NextAuth token is not
 * authentication.
 *
 * Standalone tsx script (house pattern). No database, no network.
 *
 * WHAT IS REAL. Every token below is encrypted with the configured
 * NEXTAUTH_SECRET by next-auth/jwt's own `encode` — exactly what anyone holding
 * the (Preview-shared) secret can produce. Each one is presented as the
 * `__Host-next-auth.session-token` cookie to NextAuth's REAL core handler
 * (`AuthHandler`, GET /api/auth/session) configured with the REAL
 * `authOptions` from lib/auth.ts — so decryption, expiry, the jwt callback and
 * the session callback all run unmodified.
 *
 * WHAT IS A FAKE. Only the session store: `authDb.userSession.findFirst` /
 * `updateMany` are replaced by an in-memory table of rows. The fake returns
 * rows; it decides nothing. It counts its calls, so a refusal that never
 * consulted the store is visible as such.
 *
 * BEFORE/AFTER. This exact file was run against P1's parent (9c46451) in a
 * scratch worktree, with session-proof.ts copied in (pure; unused by the old
 * callback). 23 checks failed there, among them every forged case:
 *   1   {id: Alice, role: USER}, no sessionToken          → served as Alice
 *   2   {role: SYSTEM_ADMIN}, no sessionToken, on Alice's id, on an
 *       attacker-chosen id, and on the real admin's id    → served as SYSTEM_ADMIN
 *   4   Alice's/the admin's id + Bob's live sessionToken  → served as Alice/admin
 *       (including with Bob's session warm in the cache)
 *   5   Alice's own live session + role: SYSTEM_ADMIN     → served as SYSTEM_ADMIN;
 *       a demoted admin stayed SYSTEM_ADMIN; a promotion was invisible
 *   10  a row whose user is gone                          → served
 *   11  sessionToken "" / null                            → served (6 store lookups)
 *   12  an outage + no sessionToken                       → served
 * Cases 3 (invented token), 6 (revoked), 7 (expired) and the cold-outage half
 * of 12 were already refused before P1. All 51 checks pass on P1.
 */

process.env.NEXTAUTH_SECRET = "p1-forged-token-test-secret-not-a-real-secret";
process.env.NEXTAUTH_URL    = "https://app.fourthmeridian.com";
process.env.DATABASE_URL  ??= "postgresql://none:none@127.0.0.1:1/none"; // never connected: the store is faked below

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { SESSION_INDETERMINATE_FLAG } from "./session-outcome";
import type { UserRole as UserRoleT } from "@prisma/client";
import { sessionCookieName } from "./session-cookie";
import { KNOWN_ROLES, factsFromRow, judgeSession, readSessionClaims } from "./session-proof";

// next-auth/core is not an exported subpath; load the real handler relative to
// the package entry (the same technique lib/auth/session-cookie.test.ts uses).
const { AuthHandler } = createRequire(require.resolve("next-auth"))("./core") as {
  AuthHandler: (params: unknown) => Promise<unknown>;
};

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ES imports are hoisted above the env assignments at the top of this file, and
// lib/auth.ts reads NEXTAUTH_SECRET at module load — so everything that reads
// env is imported dynamically in load(), AFTER the env is set.
let authOptions: typeof import("@/lib/auth").authOptions;
let clearAllSessions: typeof import("@/lib/session-cache").clearAllSessions;
let decideAdminApiAccess: typeof import("@/lib/admin-totp-enrollment").decideAdminApiAccess;
let encode: typeof import("next-auth/jwt").encode;
let UserRole: typeof import("@prisma/client").UserRole;

// ── The fake session store ────────────────────────────────────────────────────
interface Row { userId: string; revokedAt: Date | null; user: { id: string; role: string } | null }
const ROWS = new Map<string, Row>();
let lookups = 0;
let failStore = false;

const ALICE = "cmalice00000000000000000a";
const BOB   = "cmbob0000000000000000000b";
const ADMIN = "cmadmin000000000000000000";
const ALICE_SESSION   = "0b6f2a4e-5c1d-4f8e-9a7b-111111111111";
const BOB_SESSION     = "0b6f2a4e-5c1d-4f8e-9a7b-222222222222";
const ADMIN_SESSION   = "0b6f2a4e-5c1d-4f8e-9a7b-333333333333";
const REVOKED_SESSION = "0b6f2a4e-5c1d-4f8e-9a7b-444444444444";
const ORPHAN_SESSION  = "0b6f2a4e-5c1d-4f8e-9a7b-555555555555";

function seed() {
  ROWS.clear();
  ROWS.set(ALICE_SESSION,   { userId: ALICE, revokedAt: null,       user: { id: ALICE, role: "USER" } });
  ROWS.set(BOB_SESSION,     { userId: BOB,   revokedAt: null,       user: { id: BOB,   role: "USER" } });
  ROWS.set(ADMIN_SESSION,   { userId: ADMIN, revokedAt: null,       user: { id: ADMIN, role: "SYSTEM_ADMIN" } });
  ROWS.set(REVOKED_SESSION, { userId: ALICE, revokedAt: new Date(), user: { id: ALICE, role: "USER" } });
  ROWS.set(ORPHAN_SESSION,  { userId: "cmdeleted0000000000000000", revokedAt: null, user: null });
}

const fakeUserSession = {
  // Honours the `where` it is given (sessionToken, and a `revokedAt: null`
  // filter if the caller adds one) so the pre-P1 query is faithfully served too.
  async findFirst(args: { where: { sessionToken?: unknown; revokedAt?: unknown } }) {
    lookups++;
    if (failStore) {
      const e = new Error("Timed out fetching a new connection from the connection pool.");
      (e as unknown as { code: string }).code = "P2024";
      throw e;
    }
    const token = args?.where?.sessionToken;
    const row = typeof token === "string" ? (ROWS.get(token) ?? null) : null;
    if (row && "revokedAt" in (args?.where ?? {}) && args.where.revokedAt === null && row.revokedAt !== null) return null;
    return row;
  },
  async updateMany() { return { count: 1 }; },
};
async function load() {
  ({ authOptions } = await import("@/lib/auth"));
  ({ clearAllSessions } = await import("@/lib/session-cache"));
  ({ decideAdminApiAccess } = await import("@/lib/admin-totp-enrollment"));
  ({ encode } = await import("next-auth/jwt"));
  ({ UserRole } = await import("@prisma/client"));
  const { authDb } = await import("@/lib/db");
  Object.defineProperty(authDb, "userSession", { value: fakeUserSession, configurable: true });
}

// ── Drive the real NextAuth pipeline ─────────────────────────────────────────
type Claims = Record<string, unknown>;
async function forge(claims: Claims, maxAge?: number): Promise<string> {
  return encode({ token: claims as never, secret: process.env.NEXTAUTH_SECRET!, ...(maxAge !== undefined ? { maxAge } : {}) });
}

interface Served { user?: { id?: string; role?: string }; expires?: string; [k: string]: unknown }
async function serve(jwt: string): Promise<Served> {
  clearAllSessions(); // each case is judged on its own, never on another case's cache
  const req = new Request("https://app.fourthmeridian.com/api/auth/session", {
    headers: { cookie: `${sessionCookieName(true)}=${jwt}`, host: "app.fourthmeridian.com", "x-forwarded-proto": "https" },
  });
  const res = (await AuthHandler({ req, options: authOptions })) as { body?: unknown };
  return (res.body ?? {}) as Served;
}
const authenticated = (s: Served) => typeof s.user?.id === "string";

async function main() {
  await load();
  console.log("\n0. the property under test is real");
  check("authOptions.secret is the configured secret (tokens below are genuinely valid)",
    authOptions.secret === process.env.NEXTAUTH_SECRET);
  check("KNOWN_ROLES is exactly Prisma's UserRole", JSON.stringify([...KNOWN_ROLES].sort()) === JSON.stringify(Object.values(UserRole).sort()));
  seed();
  lookups = 0;
  const legit = await serve(await forge({ id: ALICE, role: "USER", sessionToken: ALICE_SESSION }));
  check("control: a legitimate token is served through this harness (else every refusal below is vacuous)",
    legit.user?.id === ALICE && lookups === 1, JSON.stringify(legit));

  // ── 1. Missing sessionToken, real user, USER ───────────────────────────────
  console.log("\n1–2. forged tokens without a sessionToken (pre-P1: AUTHENTICATED, no lookup)");
  seed(); lookups = 0;
  const f1 = await serve(await forge({ id: ALICE, role: "USER" }));
  check("1. missing sessionToken + real user id + USER → refused", !authenticated(f1), JSON.stringify(f1));
  check("   …and refused before touching the store", lookups === 0);

  // ── 2. Missing sessionToken + SYSTEM_ADMIN ─────────────────────────────────
  seed(); lookups = 0;
  const f2a = await serve(await forge({ id: ALICE, role: "SYSTEM_ADMIN" }));
  const f2b = await serve(await forge({ id: "cmattackerchosen000000000", role: "SYSTEM_ADMIN", requireTotpSetup: null }));
  const f2c = await serve(await forge({ id: ADMIN, role: "SYSTEM_ADMIN" }));
  check("2. missing sessionToken + SYSTEM_ADMIN claim on a USER's id → refused", !authenticated(f2a), JSON.stringify(f2a));
  check("2. missing sessionToken + SYSTEM_ADMIN on an attacker-chosen id → refused", !authenticated(f2b), JSON.stringify(f2b));
  check("2. missing sessionToken + the REAL admin's id → refused", !authenticated(f2c), JSON.stringify(f2c));

  // ── 3. Invented sessionToken ───────────────────────────────────────────────
  console.log("\n3–4. sessionTokens that prove nothing");
  seed();
  const f3 = await serve(await forge({ id: ALICE, role: "USER", sessionToken: "0b6f2a4e-5c1d-4f8e-9a7b-999999999999" }));
  check("3. invented sessionToken → refused", !authenticated(f3), JSON.stringify(f3));

  // ── 4. Another user's live sessionToken ────────────────────────────────────
  seed();
  const f4 = await serve(await forge({ id: ALICE, role: "USER", sessionToken: BOB_SESSION }));
  check("4. Alice's id carrying Bob's LIVE sessionToken → refused", !authenticated(f4), JSON.stringify(f4));
  const f4b = await serve(await forge({ id: ADMIN, role: "SYSTEM_ADMIN", sessionToken: BOB_SESSION }));
  check("4. the admin's id carrying Bob's live sessionToken → refused", !authenticated(f4b), JSON.stringify(f4b));
  // Cache path: Bob's session verified and cached, THEN the cross-user token — must
  // still be refused (the cache holds facts; ownership is judged per request).
  seed(); clearAllSessions();
  const bobReq = async (jwt: string): Promise<Served> => {
    const res = (await AuthHandler({
      req: new Request("https://app.fourthmeridian.com/api/auth/session", { headers: { cookie: `${sessionCookieName(true)}=${jwt}` } }),
      options: authOptions,
    })) as { body?: unknown };
    return (res.body ?? {}) as Served; // deliberately NOT clearing the cache between these two
  };
  const bobOk = await bobReq(await forge({ id: BOB, role: "USER", sessionToken: BOB_SESSION }));
  lookups = 0;
  const crossCached = await bobReq(await forge({ id: ALICE, role: "USER", sessionToken: BOB_SESSION }));
  check("4. with Bob's session warm in the cache, the cross-user token is still refused",
    bobOk.user?.id === BOB && !crossCached.user && lookups === 0, `bob=${JSON.stringify(bobOk)} cross=${JSON.stringify(crossCached)} lookups=${lookups}`);

  // ── 5. Role escalation ────────────────────────────────────────────────────
  console.log("\n5. the role acted on is the store's CURRENT role, never the token's claim");
  seed();
  const f5 = await serve(await forge({ id: ALICE, role: "SYSTEM_ADMIN", sessionToken: ALICE_SESSION }));
  check("5. Alice's own live session + SYSTEM_ADMIN claim → served as USER (pre-P1: SYSTEM_ADMIN)",
    f5.user?.id === ALICE && f5.user?.role === "USER", JSON.stringify(f5));
  check("   …and the admin-access authority therefore denies it",
    decideAdminApiAccess({ role: f5.user?.role as UserRoleT, requireTotpSetup: false, systemAdminDisabled: false }) !== "ALLOW");
  // Demotion after issuance: the store now says USER for the admin.
  seed();
  ROWS.set(ADMIN_SESSION, { userId: ADMIN, revokedAt: null, user: { id: ADMIN, role: "USER" } });
  const demoted = await serve(await forge({ id: ADMIN, role: "SYSTEM_ADMIN", sessionToken: ADMIN_SESSION }));
  check("5. an admin demoted after login is served with the CURRENT role (USER)", demoted.user?.role === "USER", JSON.stringify(demoted));
  // Unknown role in the store → refused, never defaulted.
  seed();
  ROWS.set(ALICE_SESSION, { userId: ALICE, revokedAt: null, user: { id: ALICE, role: "ROOT" } });
  const unknownRole = await serve(await forge({ id: ALICE, role: "USER", sessionToken: ALICE_SESSION }));
  check("5. a role the application does not know → refused", !authenticated(unknownRole), JSON.stringify(unknownRole));

  // ── 6. Revoked ─────────────────────────────────────────────────────────────
  console.log("\n6–7. revoked and expired");
  seed();
  const f6 = await serve(await forge({ id: ALICE, role: "USER", sessionToken: REVOKED_SESSION }));
  check("6. revoked session → refused", !authenticated(f6), JSON.stringify(f6));

  // ── 7. Expired ─────────────────────────────────────────────────────────────
  seed(); lookups = 0;
  const f7 = await serve(await forge({ id: ALICE, role: "USER", sessionToken: ALICE_SESSION }, -60));
  check("7. expired JWT (exp in the past) on a LIVE row → refused", !authenticated(f7), JSON.stringify(f7));
  check("   …by NextAuth's decode, before any store lookup", lookups === 0);

  // ── 8–9. Legitimate sessions ──────────────────────────────────────────────
  console.log("\n8–9. legitimate sessions still work");
  seed(); lookups = 0;
  const ok = await serve(await forge({ id: ALICE, role: "USER", sessionToken: ALICE_SESSION, username: "alice" }));
  check("8. valid, owned, live session → accepted as USER", ok.user?.id === ALICE && ok.user?.role === "USER", JSON.stringify(ok));
  check("   …after exactly one store lookup", lookups === 1);
  check("   …carrying the sessionToken the guards' fresh checks need", (ok as { sessionToken?: string }).sessionToken === ALICE_SESSION);
  seed();
  const admin = await serve(await forge({ id: ADMIN, role: "SYSTEM_ADMIN", sessionToken: ADMIN_SESSION }));
  check("9. valid SYSTEM_ADMIN session whose store role is SYSTEM_ADMIN → accepted as SYSTEM_ADMIN",
    admin.user?.id === ADMIN && admin.user?.role === "SYSTEM_ADMIN", JSON.stringify(admin));
  seed();
  ROWS.set(ALICE_SESSION, { userId: ALICE, revokedAt: null, user: { id: ALICE, role: "SYSTEM_ADMIN" } });
  const promoted = await serve(await forge({ id: ALICE, role: "USER", sessionToken: ALICE_SESSION }));
  check("9. a user promoted after login is served with the CURRENT role", promoted.user?.role === "SYSTEM_ADMIN", JSON.stringify(promoted));

  // ── 10. Deleted / missing user ────────────────────────────────────────────
  console.log("\n10–11. missing users and malformed tokens");
  seed();
  const f10 = await serve(await forge({ id: "cmdeleted0000000000000000", role: "USER", sessionToken: ORPHAN_SESSION }));
  check("10. session row whose user no longer exists → refused", !authenticated(f10), JSON.stringify(f10));
  seed(); ROWS.delete(ALICE_SESSION); // ON DELETE CASCADE removed the row with the user
  const f10b = await serve(await forge({ id: ALICE, role: "USER", sessionToken: ALICE_SESSION }));
  check("10. deleted user (row cascaded away) → refused", !authenticated(f10b), JSON.stringify(f10b));

  // ── 11. Malformed sessionToken ─────────────────────────────────────────────
  seed(); lookups = 0;
  const malformed: unknown[] = ["", "short", "x".repeat(4096), "'; DROP TABLE \"UserSession\"; --", { $ne: null }, ["a"], 42, null];
  for (const m of malformed) {
    const r = await serve(await forge({ id: ALICE, role: "USER", sessionToken: m }));
    check(`11. malformed sessionToken ${JSON.stringify(m)?.slice(0, 40)} → refused`, !authenticated(r), JSON.stringify(r));
  }
  check("   …none of them reached the store", lookups === 0, `lookups=${lookups}`);
  const badId = await serve(await forge({ id: { $ne: null }, role: "USER", sessionToken: ALICE_SESSION }));
  check("11. malformed id claim → refused", !authenticated(badId), JSON.stringify(badId));

  // ── 12. Store failure fails closed ───────────────────────────────────────
  console.log("\n12. the store cannot answer ⇒ never authenticated");
  seed(); failStore = true;
  const f12 = await serve(await forge({ id: ALICE, role: "USER", sessionToken: ALICE_SESSION }));
  failStore = false;
  check("12. store throws (P2024) on a cold cache → NOT authenticated", !authenticated(f12), JSON.stringify(f12));
  check("   …reported as indeterminate (cookie kept, request denied), not trusted",
    f12[SESSION_INDETERMINATE_FLAG] === true, JSON.stringify(f12));
  const f12b = await serve(await forge({ id: ALICE, role: "SYSTEM_ADMIN" })); // and no sessionToken during an outage
  check("12. during an outage a token without a sessionToken is still refused", !authenticated(f12b));

  // ── 13. Pure-function edges ──────────────────────────────────────────────
  console.log("\n13. pure judgement edges");
  check("factsFromRow(revokedAt missing) → null (malformed is not 'not revoked')",
    factsFromRow({ userId: ALICE, user: { id: ALICE, role: "USER" } }) === null);
  check("factsFromRow(user.id ≠ row.userId) → null",
    factsFromRow({ userId: ALICE, revokedAt: null, user: { id: BOB, role: "USER" } }) === null);
  check("judgeSession(stale verified facts of ANOTHER user) → refused",
    judgeSession({ userId: ALICE, sessionToken: BOB_SESSION }, { valid: true, facts: { userId: BOB, role: "USER" }, disposition: "STALE_HIT" }).kind === "refused");
  check("judgeSession(valid without facts) → refused, never authenticated",
    judgeSession({ userId: ALICE, sessionToken: ALICE_SESSION }, { valid: true, disposition: "LIVE" }).kind === "refused");
  check("readSessionClaims rejects a numeric id", readSessionClaims({ id: 7, sessionToken: ALICE_SESSION }) === null);

  // ── 14. Source pins ───────────────────────────────────────────────────────
  console.log("\n14. no path skips the proof");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
  const auth = strip(readFileSync(path.join(process.cwd(), "lib/auth.ts"), "utf8"));
  const sess = strip(readFileSync(path.join(process.cwd(), "lib/session.ts"), "utf8"));
  const cb = auth.slice(auth.indexOf("async session({"), auth.indexOf("events:"));
  check("the session callback is located (pins below are not vacuous)", cb.length > 500);
  check("the session callback no longer gates the lookup on `if (sessionToken)`", !/if\s*\(\s*sessionToken\s*\)/.test(cb));
  check("the session callback refuses when claims are absent", /if\s*\(\s*!claims\s*\)\s*return refusedSession\(session\)/.test(cb));
  check("the session callback never assigns token.role to the session", !/session\.user\.role\s*=\s*token\.role/.test(cb));
  check("the session callback judges every outcome with judgeSession()", auth.includes("judgeSession(claims, outcome)"));
  check("the fresh re-check proves ownership and refreshes the cache with facts",
    sess.includes("facts.userId !== user.id") && /setCachedRevocation\(user\.sessionToken, live\.facts\)/.test(sess));
  check("requireFreshSystemAdmin re-judges admin access on the freshly read role",
    /adminApiAccess\(\{\s*\.\.\.user,\s*role:\s*live\.facts\.role/.test(sess));
}

main()
  .catch((e) => { failures++; console.error("  ✗ threw —", e); })
  .finally(() => {
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll P1 session-proof checks passed.");
    process.exit(0);
  });
