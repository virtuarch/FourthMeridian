/**
 * app/api/user/sessions/route.test.ts  (TEST-004)
 *
 * GET/DELETE /api/user/sessions and DELETE /api/user/sessions/[sessionId] — REAL
 * exported handlers, real session cookies, in-memory Prisma fake. A user sees and
 * revokes THEIR OWN sessions only; a revoked session stops authenticating at once.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/user/sessions/route.test.ts
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";

const t = makeChecker("/api/user/sessions + /[sessionId] (TEST-004)");
const fake = new FakePrisma();
let LIST: typeof import("./route").GET;
let REVOKE_OTHERS: typeof import("./route").DELETE;
let REVOKE_ONE: typeof import("./[sessionId]/route").DELETE;
let STATUS: typeof import("@/app/api/user/totp/status/route").GET;
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const alive = async (cookie: string) => (await invoke(STATUS, request("/api/user/totp/status", { cookie }))).status === 200;

async function world() {
  fake.reset();
  freshCache();
  const alice = fake.seed("User", { email: "alice@example.test", username: "alice", passwordHash: "x", emailVerifiedAt: new Date() });
  const bob = fake.seed("User", { email: "bob@example.test", username: "bob", passwordHash: "x", emailVerifiedAt: new Date() });
  const a1 = await signIn(fake, alice.id as string, { userAgent: SAFARI, createdAt: new Date(Date.now() - 3 * 60_000) });
  const a2 = await signIn(fake, alice.id as string, { userAgent: "curl/8", createdAt: new Date(Date.now() - 2 * 60_000) });
  const a3 = await signIn(fake, alice.id as string, { createdAt: new Date(Date.now() - 60_000) });
  const b1 = await signIn(fake, bob.id as string);
  return { alice, bob, a1, a2, a3, b1 };
}

async function main() {
  await installFakePrisma(fake);
  ({ GET: LIST, DELETE: REVOKE_OTHERS } = await import("./route"));
  ({ DELETE: REVOKE_ONE } = await import("./[sessionId]/route"));
  ({ GET: STATUS } = await import("@/app/api/user/totp/status/route"));

  t.section("1. GET — own sessions only, newest first, no token material");
  {
    const w = await world();
    const r = await invoke<{ sessions: Record<string, unknown>[] }>(LIST, request("/api/user/sessions", { cookie: w.a1.cookie }));
    const ids = r.body.sessions.map((s) => s.id);
    t.check("200 with alice's three sessions", r.status === 200 && ids.length === 3, ids);
    t.check("bob's session is not listed", !ids.includes(w.b1.sessionId));
    t.check("newest first", ids[0] === w.a3.sessionId && ids[2] === w.a1.sessionId);
    t.check("exactly the calling session is isCurrent", r.body.sessions.filter((s) => s.isCurrent).map((s) => s.id).join() === w.a1.sessionId);
    t.check("P1b — no sessionToken (or any token value) leaves the server",
      r.body.sessions.every((s) => !("sessionToken" in s)) && ![w.a1, w.a2, w.a3].some((x) => r.text.includes(x.sessionToken)));
    const parsed = r.body.sessions.find((s) => s.id === w.a1.sessionId)!.parsed as Record<string, unknown>;
    t.check("the user agent is parsed for display", String(parsed.browser).startsWith("Safari") && String(parsed.os).startsWith("macOS"), parsed);
    t.check("anonymous → 401", (await invoke(LIST, request("/api/user/sessions"))).status === 401);
    const pending = await signIn(fake, w.alice.id as string, { requireTotpSetup: true });
    fake.seed("PlatformSetting", { key: "require_totp_all_users", value: "true" });
    freshCache();
    t.check("a TOTP-pending session → 403", (await invoke(LIST, request("/api/user/sessions", { cookie: pending.cookie }))).status === 403);
  }

  t.section("2. DELETE /[sessionId] — revoke one of your OTHER sessions");
  {
    const w = await world();
    t.check("control: a2 authenticates", await alive(w.a2.cookie));
    const r = await invoke(REVOKE_ONE, request(`/api/user/sessions/${w.a2.sessionId}`, { method: "DELETE", cookie: w.a1.cookie }), { sessionId: w.a2.sessionId });
    t.check("200 { success, isCurrent: false }", r.status === 200 && r.body.success === true && r.body.isCurrent === false, r.body);
    t.check("a2 is revoked in the store", fake.one("UserSession", { id: w.a2.sessionId })!.revokedAt instanceof Date);
    t.check("a2's cookie is refused IMMEDIATELY (cache invalidated, no 30 s window)", !(await alive(w.a2.cookie)));
    t.check("a1 (the caller) still works", await alive(w.a1.cookie));
    t.check("SESSION_REVOKED audit + a SESSION_REVOKED notification naming the device",
      fake.rows("AuditLog", { action: "SESSION_REVOKED", userId: w.alice.id }).length === 1
      && fake.rows("Notification", { userId: w.alice.id }).length === 1);
    const again = await invoke(REVOKE_ONE, request(`/api/user/sessions/${w.a2.sessionId}`, { method: "DELETE", cookie: w.a1.cookie }), { sessionId: w.a2.sessionId });
    t.check("revoking it again → 400 already revoked", again.status === 400);
  }

  t.section("3. you cannot revoke ANOTHER user's session");
  {
    const w = await world();
    const r = await invoke(REVOKE_ONE, request(`/api/user/sessions/${w.b1.sessionId}`, { method: "DELETE", cookie: w.a1.cookie }), { sessionId: w.b1.sessionId });
    t.check("bob's session id from alice → 404 (existence not disclosed)", r.status === 404, r);
    t.check("bob's session is untouched and still authenticates", fake.one("UserSession", { id: w.b1.sessionId })!.revokedAt === null && await alive(w.b1.cookie));
    t.check("no audit row was written", fake.rows("AuditLog").length === 0);
    t.check("an unknown id → 404", (await invoke(REVOKE_ONE, request("/api/user/sessions/nope", { method: "DELETE", cookie: w.a1.cookie }), { sessionId: "nope" })).status === 404);
  }

  t.section("4. revoking the CURRENT session needs confirmSelf=true");
  {
    const w = await world();
    const r = await invoke(REVOKE_ONE, request(`/api/user/sessions/${w.a1.sessionId}`, { method: "DELETE", cookie: w.a1.cookie }), { sessionId: w.a1.sessionId });
    t.check("without confirmSelf → 400 { isCurrent: true }, nothing revoked", r.status === 400 && r.body.isCurrent === true
      && fake.one("UserSession", { id: w.a1.sessionId })!.revokedAt === null);
    const ok = await invoke(REVOKE_ONE, request(`/api/user/sessions/${w.a1.sessionId}?confirmSelf=true`, { method: "DELETE", cookie: w.a1.cookie }), { sessionId: w.a1.sessionId });
    t.check("with confirmSelf=true → 200 isCurrent: true", ok.status === 200 && ok.body.isCurrent === true);
    t.check("…and the caller's own cookie stops working", !(await alive(w.a1.cookie)));
    t.check("no 'your session was revoked' notification for revoking yourself", fake.rows("Notification").length === 0);
  }

  t.section("5. DELETE /api/user/sessions — sign out everywhere else");
  {
    const w = await world();
    const r = await invoke(REVOKE_OTHERS, request("/api/user/sessions", { method: "DELETE", cookie: w.a1.cookie }));
    t.check("200 { success, count: 2 }", r.status === 200 && r.body.count === 2, r.body);
    t.check("a2 and a3 revoked, a1 kept", fake.one("UserSession", { id: w.a1.sessionId })!.revokedAt === null
      && fake.rows("UserSession", { userId: w.alice.id, revokedAt: { not: null } }).length === 2);
    t.check("the revoked cookies are refused; the caller still works", !(await alive(w.a2.cookie)) && !(await alive(w.a3.cookie)) && await alive(w.a1.cookie));
    t.check("bob's session is untouched", fake.one("UserSession", { id: w.b1.sessionId })!.revokedAt === null && await alive(w.b1.cookie));
    const audit = fake.one("AuditLog", { action: "SESSION_REVOKED" })!;
    t.check("audit { revokedAll, exceptCurrent, count: 2 }", JSON.stringify(audit.metadata) === JSON.stringify({ revokedAll: true, exceptCurrent: true, count: 2 }));
  }

  t.section("6. both DELETEs demand a FRESH session (a revoked-but-cached cookie is refused)");
  {
    const w = await world();
    await alive(w.a1.cookie); // warm the cache for a1
    fake.one("UserSession", { id: w.a1.sessionId })!.revokedAt = new Date();
    t.check("control: the cached read still serves it", await alive(w.a1.cookie));
    const one = await invoke(REVOKE_ONE, request(`/api/user/sessions/${w.a2.sessionId}`, { method: "DELETE", cookie: w.a1.cookie }), { sessionId: w.a2.sessionId });
    const all = await invoke(REVOKE_OTHERS, request("/api/user/sessions", { method: "DELETE", cookie: w.a1.cookie }));
    t.check("revoke-one → 401, revoke-all → 401", one.status === 401 && all.status === 401, [one.status, all.status]);
    t.check("…and nothing was revoked by the dead session", fake.rows("UserSession", { revokedAt: { not: null } }).length === 1);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
