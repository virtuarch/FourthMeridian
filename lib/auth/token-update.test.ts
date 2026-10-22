/**
 * lib/auth/token-update.test.ts — SEC-001: the jwt callback never accepts a
 * security-relevant claim from a client `update`.
 *
 * PART A — the pure allow-list (executed).
 * PART B — the REAL NextAuth pipeline, driven exactly as the runtime
 *          reproduction did: GET /api/auth/csrf, then
 *          POST /api/auth/session {csrfToken, data:{requireTotpSetup:false}}
 *          with a TOTP-pending SYSTEM_ADMIN's live session cookie. The store is
 *          an in-memory fake (same technique as lib/auth/session-proof.test.ts);
 *          decryption, CSRF, the jwt callback and the session callback are the
 *          real ones from lib/auth.ts.
 *
 * BEFORE SEC-001 the re-issued cookie carried `requireTotpSetup: false` and
 * proxy.ts let /admin render. Now the hint is re-derived from the store.
 *
 *     npx tsx lib/auth/token-update.test.ts
 */

process.env.NEXTAUTH_SECRET = "sec-001-token-update-test-secret-not-a-real-secret";
process.env.NEXTAUTH_URL    = "https://app.fourthmeridian.com";
process.env.DATABASE_URL  ??= "postgresql://none:none@127.0.0.1:1/none"; // never connected: the store is faked below

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { sessionCookieName } from "./session-cookie";
import { clientTokenPatch, CLIENT_UPDATABLE_TOKEN_FIELDS } from "./token-update";

const { AuthHandler } = createRequire(require.resolve("next-auth"))("./core") as {
  AuthHandler: (params: unknown) => Promise<unknown>;
};

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── A. the pure allow-list ────────────────────────────────────────────────────
console.log("token-update (SEC-001)\n\nA. clientTokenPatch");
check("the only client-updatable field is username", JSON.stringify(CLIENT_UPDATABLE_TOKEN_FIELDS) === '["username"]');
check("requireTotpSetup:false is dropped", !("requireTotpSetup" in (clientTokenPatch({ requireTotpSetup: false }) as object)));
check("role / id / sessionToken are dropped",
  JSON.stringify(clientTokenPatch({ role: "SYSTEM_ADMIN", id: "x", sessionToken: "y" })) === "{}");
check("username string is kept", clientTokenPatch({ username: "alice" }).username === "alice");
check("username null is kept (clearing a handle is presentation)", clientTokenPatch({ username: null }).username === null);
check("username of the wrong shape is dropped", !("username" in (clientTokenPatch({ username: 42 }) as object)));
check("non-object payloads yield an empty patch",
  JSON.stringify(clientTokenPatch(undefined)) === "{}" && JSON.stringify(clientTokenPatch("x")) === "{}");

// ── B. the real pipeline ──────────────────────────────────────────────────────
interface Row { userId: string; revokedAt: Date | null; user: { id: string; role: string; totpEnabled: boolean } | null;
                createdAt: Date; lastActiveAt: Date }
const ROWS = new Map<string, Row>();
let lookups = 0;
let failStore = false;
const ADMIN = "cmadmin000000000000000000";
const ADMIN_SESSION = "0b6f2a4e-5c1d-4f8e-9a7b-333333333333";
const now = () => new Date();
function seed(totpEnabled: boolean) {
  ROWS.clear();
  ROWS.set(ADMIN_SESSION, { userId: ADMIN, revokedAt: null, user: { id: ADMIN, role: "SYSTEM_ADMIN", totpEnabled },
    createdAt: now(), lastActiveAt: now() });
}
const fakeUserSession = {
  async findFirst(args: { where: { sessionToken?: unknown } }) {
    lookups++;
    if (failStore) { const e = new Error("pool timeout"); (e as unknown as { code: string }).code = "P2024"; throw e; }
    const t = args?.where?.sessionToken;
    return typeof t === "string" ? (ROWS.get(t) ?? null) : null;
  },
  async updateMany() { return { count: 1 }; },
};
const fakePlatformSetting = { async findUnique() { return { value: "false" }; } };

let authOptions: typeof import("@/lib/auth").authOptions;
let clearAllSessions: typeof import("@/lib/session-cache").clearAllSessions;
let encode: typeof import("next-auth/jwt").encode;
let decode: typeof import("next-auth/jwt").decode;

async function load() {
  ({ authOptions } = await import("@/lib/auth"));
  ({ clearAllSessions } = await import("@/lib/session-cache"));
  ({ encode, decode } = await import("next-auth/jwt"));
  const { authDb } = await import("@/lib/db");
  Object.defineProperty(authDb, "userSession",     { value: fakeUserSession,     configurable: true });
  Object.defineProperty(authDb, "platformSetting", { value: fakePlatformSetting, configurable: true });
}

type Cookie = { name: string; value: string };
interface Res { status?: number; body?: unknown; cookies?: Cookie[] }
const HOST = "https://app.fourthmeridian.com";

async function csrf(): Promise<{ token: string; cookie: Cookie }> {
  const res = (await AuthHandler({
    req: new Request(`${HOST}/api/auth/csrf`, { headers: { host: "app.fourthmeridian.com", "x-forwarded-proto": "https" } }),
    options: authOptions,
  })) as Res;
  const cookie = (res.cookies ?? []).find((c) => c.name.includes("csrf-token"))!;
  return { token: (res.body as { csrfToken: string }).csrfToken, cookie };
}

/** The exact runtime reproduction: POST /api/auth/session with a client-chosen `data`. */
async function clientUpdate(sessionJwt: string, data: unknown): Promise<{ res: Res; token: Record<string, unknown> | null; served: Record<string, unknown> }> {
  const c = await csrf();
  const sessionCookie = sessionCookieName(true);
  const res = (await AuthHandler({
    req: new Request(`${HOST}/api/auth/session`, {
      method: "POST",
      headers: {
        host: "app.fourthmeridian.com", "x-forwarded-proto": "https",
        "content-type": "application/json",
        cookie: `${sessionCookie}=${sessionJwt}; ${c.cookie.name}=${c.cookie.value}`,
      },
      body: JSON.stringify({ csrfToken: c.token, data }),
    }),
    options: authOptions,
  })) as Res;
  const reissued = (res.cookies ?? []).find((k) => k.name === sessionCookie);
  const token = reissued?.value
    ? ((await decode({ token: reissued.value, secret: process.env.NEXTAUTH_SECRET! })) as Record<string, unknown> | null)
    : null;
  return { res, token, served: (res.body ?? {}) as Record<string, unknown> };
}

async function main() {
  await load();
  console.log("\nB. POST /api/auth/session {data:{requireTotpSetup:false}} on a TOTP-pending SYSTEM_ADMIN");
  const pendingJwt = await encode({
    token: { id: ADMIN, role: "SYSTEM_ADMIN", sessionToken: ADMIN_SESSION, requireTotpSetup: true } as never,
    secret: process.env.NEXTAUTH_SECRET!,
  });

  seed(false); clearAllSessions(); lookups = 0;
  const r1 = await clientUpdate(pendingJwt, { requireTotpSetup: false });
  check("the update round-trips (200, a session cookie is re-issued)",
    r1.res.status === undefined || r1.res.status === 200, `status=${r1.res.status}`);
  check("control: the re-issued token exists (else the assertions below are vacuous)", r1.token !== null);
  check("the re-issued token's requireTotpSetup is STILL true (re-derived from the store, not the client)",
    r1.token?.requireTotpSetup === true, JSON.stringify(r1.token));
  check("…and the store was consulted for it", lookups >= 1, `lookups=${lookups}`);
  check("the served session is still pending (the API gate still 403s)",
    r1.served.requireTotpSetup === true && (r1.served.user as { role?: string })?.role === "SYSTEM_ADMIN", JSON.stringify(r1.served));

  seed(false); clearAllSessions();
  const r2 = await clientUpdate(pendingJwt, { requireTotpSetup: false, role: "SYSTEM_ADMIN", id: "cmattacker00000000000000", username: "owner" });
  check("role/id in the payload never reach the token; username (presentation) does",
    r2.token?.id === ADMIN && r2.token?.role === "SYSTEM_ADMIN" && r2.token?.username === "owner" && r2.token?.requireTotpSetup === true,
    JSON.stringify(r2.token));

  // The legitimate path: enrolment completed in the store, then TotpSection's update.
  seed(true); clearAllSessions();
  const r3 = await clientUpdate(pendingJwt, { requireTotpSetup: false });
  check("after REAL enrolment (store: totpEnabled=true) the same update clears the hint",
    r3.token?.requireTotpSetup === false && r3.served.requireTotpSetup === false, JSON.stringify(r3.token));

  // Store failure fails closed: the hint is unchanged.
  seed(true); clearAllSessions(); failStore = true;
  const r4 = await clientUpdate(pendingJwt, { requireTotpSetup: false });
  failStore = false;
  check("store outage during the update → hint unchanged (true), never cleared on request",
    r4.token === null || r4.token.requireTotpSetup === true, JSON.stringify(r4.token));

  // Source pin: the forbidden copy is gone from lib/auth.ts.
  const auth = readFileSync(path.join(process.cwd(), "lib/auth.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("lib/auth.ts no longer copies session.requireTotpSetup onto the token",
    !/token\.requireTotpSetup\s*=\s*session\??\.requireTotpSetup/.test(auth));
  check("lib/auth.ts applies the client payload only through clientTokenPatch",
    auth.includes("clientTokenPatch(session)") && !/token\.username\s*=\s*session\??\.username/.test(auth));

  if (failures > 0) { console.error(`\ntoken-update: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\ntoken-update: all checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
