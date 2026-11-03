/**
 * lib/auth/presence-scope.test.ts  (PB-10 — the heartbeat never touches, and never skips a check)
 *
 * Drives the REAL NextAuth pipeline (GET /api/auth/session through AuthHandler:
 * JWT decode + expiry, then lib/auth.ts's session callback with the revocation
 * cache, ownership, SEC-010 lifetime, current role and TOTP requirement) with an
 * in-memory session store — the technique of lib/auth/token-update.test.ts.
 *
 *   A. Identical refusals: every negative case gives the SAME served session on
 *      the normal path and inside runWithoutSessionTouch (the heartbeat's path).
 *   B. The touch: a normal LIVE check touches lastActiveAt once; the heartbeat
 *      scope touches zero times, over N beats.
 *   C. No leakage: a normal request that runs WHILE a heartbeat is in flight
 *      (same process, interleaved) still touches.
 *   D. SEC-010 unchanged: a heartbeat-only session idles out at the same
 *      deadline — lastPresenceAt / lastInteractionAt are not lifetime inputs.
 *   E. Confinement: only the heartbeat route imports runWithoutSessionTouch,
 *      only lib/auth.ts reads isSessionTouchSuppressed.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/auth/presence-scope.test.ts
 */

process.env.NEXTAUTH_SECRET = "pb10-presence-scope-test-secret-not-a-real-secret";
process.env.NEXTAUTH_URL    = "https://app.fourthmeridian.com";
process.env.DATABASE_URL  ??= "postgresql://none:none@127.0.0.1:1/none"; // never connected: the store is faked below

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { sessionCookieName } from "./session-cookie";
import { runWithoutSessionTouch, isSessionTouchSuppressed } from "./presence-scope";
import { judgeSessionLifetime, SESSION_IDLE_TIMEOUT_MS } from "./session-proof";

const { AuthHandler } = createRequire(require.resolve("next-auth"))("./core") as {
  AuthHandler: (params: unknown) => Promise<unknown>;
};

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── the in-memory store ───────────────────────────────────────────────────────
interface Row {
  userId: string; revokedAt: Date | null; createdAt: Date; lastActiveAt: Date;
  user: { id: string; role: string; totpEnabled: boolean } | null;
}
const ROWS = new Map<string, Row>();
const gates = new Map<string, Promise<void>>();
let touches = 0;
let requireTotpAll = false;

const fakeUserSession = {
  async findFirst(args: { where: { sessionToken?: unknown } }) {
    const t = args?.where?.sessionToken;
    if (typeof t !== "string") return null;
    const gate = gates.get(t);
    if (gate) await gate;
    return ROWS.get(t) ?? null;
  },
  async updateMany() { return { count: 1 }; },
};
const fakePlatformSetting = { async findUnique() { return { value: requireTotpAll ? "true" : "false" }; } };
/** The touch is the only raw statement the session callback runs. */
async function fakeExecuteRaw(query: TemplateStringsArray): Promise<number> {
  if (query.join("?").includes('"lastActiveAt" = (now()')) touches++;
  return 0;
}

let authOptions: typeof import("@/lib/auth").authOptions;
let clearAllSessions: typeof import("@/lib/session-cache").clearAllSessions;
let encode: typeof import("next-auth/jwt").encode;

async function load() {
  ({ authOptions } = await import("@/lib/auth"));
  ({ clearAllSessions } = await import("@/lib/session-cache"));
  ({ encode } = await import("next-auth/jwt"));
  const { authDb } = await import("@/lib/db");
  Object.defineProperty(authDb, "userSession",     { value: fakeUserSession,     configurable: true });
  Object.defineProperty(authDb, "platformSetting", { value: fakePlatformSetting, configurable: true });
  Object.defineProperty(authDb, "$executeRaw",     { value: fakeExecuteRaw,      configurable: true });
}

const HOST = "https://app.fourthmeridian.com";
interface Res { status?: number; body?: unknown }

async function served(jwt: string): Promise<{ status: number; body: string }> {
  const res = (await AuthHandler({
    req: new Request(`${HOST}/api/auth/session`, {
      headers: { host: "app.fourthmeridian.com", "x-forwarded-proto": "https", cookie: `${sessionCookieName(true)}=${jwt}` },
    }),
    options: authOptions,
  })) as Res;
  const body = { ...((res.body ?? {}) as Record<string, unknown>) };
  delete body.expires; // re-issue clock, not a verdict
  return { status: res.status ?? 200, body: JSON.stringify(body) };
}

const USER = "cmuser0000000000000000001";
const OTHER = "cmuser0000000000000000002";
const DAY = 86_400_000;
let seq = 0;
const tok = () => `0b6f2a4e-5c1d-4f8e-9a7b-${String(++seq).padStart(12, "0")}`;

function live(over: Partial<Row> = {}): Row {
  return { userId: USER, revokedAt: null, createdAt: new Date(Date.now() - DAY), lastActiveAt: new Date(Date.now() - 120_000),
    user: { id: USER, role: "USER", totpEnabled: false }, ...over };
}

async function jwtFor(sessionToken: string, over: Record<string, unknown> = {}, maxAge?: number): Promise<string> {
  return encode({ token: { id: USER, role: "USER", sessionToken, ...over } as never, secret: process.env.NEXTAUTH_SECRET!, ...(maxAge !== undefined ? { maxAge } : {}) });
}

async function main() {
  await load();

  console.log("PB-10 — presence scope\n\nA. identical refusals, normal path vs heartbeat path");
  type Case = { name: string; row: Row | null; jwt?: (t: string) => Promise<string>; totpAll?: boolean };
  const cases: Case[] = [
    { name: "revoked session", row: live({ revokedAt: new Date() }) },
    { name: "deactivated user (deactivation revokes every session — app/api/user/deactivate)", row: live({ revokedAt: new Date() }) },
    { name: "deletion-pending user (deletion request revokes every session — app/api/user/delete)", row: live({ revokedAt: new Date() }) },
    { name: "unknown session token (no row)", row: null },
    { name: "SEC-010 idle-expired row", row: live({ lastActiveAt: new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - DAY) }) },
    { name: "SEC-010 absolute-expired row", row: live({ createdAt: new Date(Date.now() - 91 * DAY) }) },
    { name: "row owned by someone else", row: live({ userId: OTHER, user: { id: OTHER, role: "USER", totpEnabled: false } }) },
    { name: "expired JWT", row: live(), jwt: (t) => jwtFor(t, {}, -60) },
    { name: "malformed claims (no sessionToken)", row: live(), jwt: () => encode({ token: { id: USER, role: "USER" } as never, secret: process.env.NEXTAUTH_SECRET! }) },
    { name: "pending TOTP (served with requireTotpSetup ⇒ requireUser 403s)", row: live(), totpAll: true },
    { name: "control: a live session", row: live() },
  ];
  for (const c of cases) {
    const normalTok = tok(); const beatTok = tok();
    requireTotpAll = c.totpAll === true;
    if (c.row) { ROWS.set(normalTok, c.row); ROWS.set(beatTok, c.row); }
    const nJwt = c.jwt ? await c.jwt(normalTok) : await jwtFor(normalTok);
    const bJwt = c.jwt ? await c.jwt(beatTok) : await jwtFor(beatTok);
    clearAllSessions();
    const normal = await served(nJwt);
    clearAllSessions();
    const beat = await runWithoutSessionTouch(() => served(bJwt));
    check(`${c.name}: identical outcome`, normal.status === beat.status && normal.body === beat.body, `${normal.body} vs ${beat.body}`);
    if (c.name.startsWith("control")) check("control: the live session IS authenticated (else the matrix is vacuous)", /"id":"cmuser0000000000000000001"/.test(normal.body), normal.body);
    else if (c.totpAll) check("pending TOTP is carried on both paths", /"requireTotpSetup":true/.test(beat.body), beat.body);
    else check(`${c.name}: refused (no user) on the heartbeat path`, !/"id":"cmuser/.test(beat.body), beat.body);
  }
  requireTotpAll = false;

  console.log("\nB. the touch");
  {
    const t = tok(); ROWS.set(t, live()); const jwt = await jwtFor(t);
    touches = 0; clearAllSessions(); await served(jwt);
    check("a normal LIVE session check touches lastActiveAt once", touches === 1, `touches=${touches}`);
    touches = 0;
    for (let i = 0; i < 10; i++) { clearAllSessions(); await runWithoutSessionTouch(() => served(jwt)); }
    check("10 heartbeat-scope checks (each a LIVE miss) touch lastActiveAt ZERO times", touches === 0, `touches=${touches}`);
    check("outside the scope the flag is off", isSessionTouchSuppressed() === false);
    check("inside the scope the flag is on", await runWithoutSessionTouch(async () => isSessionTouchSuppressed()));
  }

  console.log("\nC. no leakage into a concurrent request");
  {
    const beatTok = tok(); const normalTok = tok();
    ROWS.set(beatTok, live()); ROWS.set(normalTok, live());
    let release!: () => void;
    gates.set(beatTok, new Promise<void>((r) => { release = r; }));
    const beatJwt = await jwtFor(beatTok); const normalJwt = await jwtFor(normalTok);
    touches = 0; clearAllSessions();
    const inflight = runWithoutSessionTouch(() => served(beatJwt));
    // the heartbeat is now parked inside its revocation lookup
    await new Promise((r) => setTimeout(r, 10));
    await served(normalJwt);
    check("a normal request served while a heartbeat is in flight still touches", touches === 1, `touches=${touches}`);
    release();
    await inflight;
    check("…and the heartbeat, resumed afterwards, still does not", touches === 1, `touches=${touches}`);
    gates.clear();
  }

  console.log("\nD. SEC-010 — a heartbeat-only session idles out at the same deadline");
  {
    const created = Date.UTC(2026, 9, 1);
    const lastActiveAt = new Date(created + DAY);
    const deadline = lastActiveAt.getTime() + SESSION_IDLE_TIMEOUT_MS;
    // a tab that beat every minute until the very end: fresh presence AND interaction
    const row = { createdAt: new Date(created), lastActiveAt, lastPresenceAt: new Date(deadline + 1), lastInteractionAt: new Date(deadline + 1) };
    check("live at the deadline", judgeSessionLifetime(row, { now: () => deadline }) === "LIVE");
    check("IDLE_EXPIRED one ms after — the presence clocks do not extend it",
      judgeSessionLifetime(row, { now: () => deadline + 1 }) === "IDLE_EXPIRED");
    const proof = readFileSync(path.join(process.cwd(), "lib/auth/session-proof.ts"), "utf8");
    check("the session-proof select and lifetime rule never read the presence clocks",
      !/lastPresenceAt|lastInteractionAt/.test(proof));
  }

  console.log("\nE. confinement (static)");
  {
    const ROOT = process.cwd();
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(path.join(ROOT, d))) {
        if (e === "node_modules" || e.startsWith(".")) continue;
        const rel = path.join(d, e);
        if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e) && !/\.test\.tsx?$/.test(e)) files.push(rel);
      }
    };
    for (const d of ["app", "lib", "components", "scripts", "jobs", "context", "hooks"]) {
      try { if (statSync(path.join(ROOT, d)).isDirectory()) walk(d); } catch { /* absent */ }
    }
    for (const f of ["proxy.ts", "middleware.ts", "instrumentation.ts"]) { try { statSync(path.join(ROOT, f)); files.push(f); } catch { /* absent */ } }
    const users = (name: string) => files.filter((f) => f !== "lib/auth/presence-scope.ts" && new RegExp(`\\b${name}\\b`).test(readFileSync(path.join(ROOT, f), "utf8")));
    const run = users("runWithoutSessionTouch");
    const read = users("isSessionTouchSuppressed");
    check("runWithoutSessionTouch is used ONLY by the heartbeat route", JSON.stringify(run) === '["app/api/user/presence/route.ts"]', JSON.stringify(run));
    check("isSessionTouchSuppressed is read ONLY by lib/auth.ts", JSON.stringify(read) === '["lib/auth.ts"]', JSON.stringify(read));
    check("nothing re-exports presence-scope (no barrel can widen it)",
      files.filter((f) => /export\s+(\*|\{[^}]*\})\s+from\s+["']@?\/?(lib\/auth\/)?\.?\/?presence-scope["']/.test(readFileSync(path.join(ROOT, f), "utf8"))).length === 0);
    const route = readFileSync(path.join(ROOT, "app/api/user/presence/route.ts"), "utf8");
    check("the route wraps the NORMAL guard, with no options (pending TOTP ⇒ 403)",
      /runWithoutSessionTouch\(\(\) => requireUser\(\)\)/.test(route));
  }
}

main().then(() => {
  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log("\nAll presence-scope checks passed.");
}, (e) => { console.error(e); process.exit(1); });
