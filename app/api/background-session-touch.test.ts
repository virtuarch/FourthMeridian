/**
 * app/api/background-session-touch.test.ts  (PB-10 F3 — background reads never extend SEC-010)
 *
 * On Preview an UNTOUCHED tab still moved UserSession.lastActiveAt (and wrote
 * SESSION_ACTIVE_DAY) through three background reads that hit the session
 * callback: the bell's 60 s poll, the notice rail's focus re-read, and the
 * SessionProvider's focus refetch of GET /api/auth/session. They now run the
 * full guard with the touch off (lib/auth/presence-scope.ts allowlist).
 *
 * The REAL handlers, real session cookies through the real NextAuth session
 * callback, the in-memory Prisma fake; the fake's `$executeRaw` counts the
 * session touch (the only statement that writes lastActiveAt).
 *
 *   A. N cycles of every background read ⇒ 0 touches, lastActiveAt unchanged.
 *   D. A session hit ONLY by background reads idles out at the same deadline:
 *      live just inside it (and still untouched), refused just past it.
 *   P. Parity: revoked / unknown session ⇒ the same refusal the normal guard
 *      gives; pending TOTP ⇒ 403 from the wrapped requireUser routes.
 *   C. Controls: an ordinary route still touches; NextAuth's POST
 *      /api/auth/session (client update()) and every other NextAuth GET action
 *      run OUTSIDE the exemption.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/background-session-touch.test.ts
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { SESSION_IDLE_TIMEOUT_MS } from "@/lib/auth/session-proof";
import { isSessionTouchSuppressed } from "@/lib/auth/presence-scope";

const t = makeChecker("PB-10 F3 — background reads do not touch the session");
const fake = new FakePrisma();
type H = (req: never, ctx?: never) => Promise<Response>;

let touches = 0;
function emulate(sql: string): number {
  if (/SET "lastActiveAt"/.test(sql)) { touches++; return 0; }
  return 1;
}

async function main() {
  await installFakePrisma(fake);
  const { GET: UNREAD } = await import("./notifications/unread-count/route") as unknown as { GET: H };
  const { GET: NOTICES } = await import("./status/notices/route") as unknown as { GET: H };
  const NA = await import("./auth/[...nextauth]/route") as unknown as { GET: H; POST: H };
  const { GET: SESSIONS } = await import("./user/sessions/route") as unknown as { GET: H };
  fake.reset();
  fake.executeRaw = emulate;
  fake.seed("PlatformSetting", { key: "require_totp_all_users", value: "false" });

  const mkUser = (n: string, extra: Record<string, unknown> = {}) =>
    fake.seed("User", { email: `${n}@example.test`, username: n, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER", totpEnabled: true, ...extra });

  type Bg = { name: string; call: (cookie: string | null) => Promise<{ status: number; body: unknown }> };
  const BACKGROUND: Bg[] = [
    { name: "GET /api/notifications/unread-count", call: (cookie) => { freshCache(); return invoke(UNREAD, request("/api/notifications/unread-count", { cookie })); } },
    { name: "GET /api/status/notices",             call: (cookie) => { freshCache(); return invoke(NOTICES, request("/api/status/notices", { cookie })); } },
    { name: "GET /api/auth/session",               call: (cookie) => { freshCache(); return invoke(NA.GET, request("/api/auth/session", { cookie }), { nextauth: ["session"] }); } },
  ];
  const authed = (b: Bg, r: { status: number; body: unknown }) =>
    b.name === "GET /api/auth/session" ? r.status === 200 && JSON.stringify(r.body).includes('"id"') : r.status === 200;

  t.section("A. N cycles of background reads ⇒ zero touches");
  {
    const u = mkUser("bg-a");
    const s = await signIn(fake, u.id as string);
    const row = fake.rows("UserSession").find((r) => r.sessionToken === s.sessionToken)!;
    const before = (row.lastActiveAt as Date).getTime();
    for (const b of BACKGROUND) {
      touches = 0;
      let ok = true;
      for (let i = 0; i < 10; i++) { const r = await b.call(s.cookie); ok &&= authed(b, r); }
      t.check(`${b.name}: 10 LIVE checks served`, ok);
      t.check(`${b.name}: 0 touches`, touches === 0, `touches=${touches}`);
    }
    t.check("lastActiveAt byte-identical after 30 background reads", (row.lastActiveAt as Date).getTime() === before);
  }

  t.section("D. background-only session idles out at the SAME SEC-010 deadline");
  for (const b of BACKGROUND) {
    const u = mkUser(`bg-d-${BACKGROUND.indexOf(b)}`);
    const s = await signIn(fake, u.id as string);
    const row = fake.rows("UserSession").find((r) => r.sessionToken === s.sessionToken)!;
    row.lastActiveAt = new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS + 60_000); // one minute left
    const pinned = (row.lastActiveAt as Date).getTime();
    touches = 0;
    let ok = true;
    for (let i = 0; i < 10; i++) { const r = await b.call(s.cookie); ok &&= authed(b, r); }
    t.check(`${b.name}: live inside the deadline`, ok);
    t.check(`${b.name}: …and the deadline did not move (lastActiveAt unchanged, 0 touches)`, (row.lastActiveAt as Date).getTime() === pinned && touches === 0);
    row.lastActiveAt = new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 1_000); // the same deadline, now passed
    const r = await b.call(s.cookie);
    t.check(`${b.name}: refused just past it`, !authed(b, r), `${r.status} ${JSON.stringify(r.body)}`);
  }

  t.section("P. parity — the wrapped guard refuses exactly as the normal one");
  {
    const u = mkUser("bg-p");
    const s = await signIn(fake, u.id as string);
    fake.rows("UserSession").find((r) => r.sessionToken === s.sessionToken)!.revokedAt = new Date();
    const normal = await (async () => { freshCache(); return invoke(SESSIONS, request("/api/user/sessions", { cookie: s.cookie })); })();
    for (const b of BACKGROUND.slice(0, 2)) {
      const r = await b.call(s.cookie);
      t.check(`${b.name}: revoked ⇒ ${normal.status}, as the normal guard`, r.status === normal.status && r.status === 401, `${r.status} vs ${normal.status}`);
      const none = await b.call(null);
      t.check(`${b.name}: no session ⇒ 401`, none.status === 401);
    }
    const sess = await BACKGROUND[2].call(s.cookie);
    t.check("GET /api/auth/session: revoked ⇒ no user served", !JSON.stringify(sess.body).includes('"id"'), JSON.stringify(sess.body));

    const pu = mkUser("bg-totp", { totpEnabled: false });
    const ps = await signIn(fake, pu.id as string);
    fake.rows("PlatformSetting", { key: "require_totp_all_users" })[0].value = "true";
    const normalT = await (async () => { freshCache(); return invoke(SESSIONS, request("/api/user/sessions", { cookie: ps.cookie })); })();
    for (const b of BACKGROUND.slice(0, 2)) {
      const r = await b.call(ps.cookie);
      t.check(`${b.name}: pending TOTP ⇒ ${normalT.status}, as the normal guard`, r.status === normalT.status && r.status === 403, `${r.status} vs ${normalT.status}`);
    }
    const st = await BACKGROUND[2].call(ps.cookie);
    t.check("GET /api/auth/session: pending TOTP still carried to the tab", JSON.stringify(st.body).includes('"requireTotpSetup":true'), JSON.stringify(st.body));
    fake.rows("PlatformSetting", { key: "require_totp_all_users" })[0].value = "false";
  }

  t.section("C. controls — human-initiated requests still touch");
  {
    const u = mkUser("bg-c");
    const s = await signIn(fake, u.id as string);
    touches = 0; freshCache();
    const r = await invoke(SESSIONS, request("/api/user/sessions", { cookie: s.cookie }));
    t.check("an ordinary authenticated route still touches once", r.status === 200 && touches === 1, `status=${r.status} touches=${touches}`);

    // NextAuth POST /api/auth/session (the client update()) — csrf first, through the route's own GET.
    freshCache();
    const csrf = await invoke<{ csrfToken: string }>(NA.GET, request("/api/auth/csrf", { cookie: s.cookie }), { nextauth: ["csrf"] });
    const setCookie = csrf.headers.get("set-cookie") ?? "";
    const csrfCookie = /((?:__Host-)?next-auth\.csrf-token=[^;]+)/.exec(setCookie)?.[1];
    t.check("control: csrf issued", csrf.status === 200 && typeof csrf.body?.csrfToken === "string" && !!csrfCookie, `${csrf.status} ${setCookie.slice(0, 80)}`);
    // update() never reached the touch even before PB-10: its jwt callback re-derives the
    // facts and pre-warms the revocation cache (lib/auth.ts rederiveTotpHint), so the session
    // callback that follows is a FRESH_HIT. What F3 must guarantee is that the POST is NOT
    // inside the exemption — observed directly, at the session-store read.
    const seen: boolean[] = [];
    fake.on("UserSession", "findFirst", () => { seen.push(isSessionTouchSuppressed()); return undefined; });
    freshCache();
    const upd = await invoke(NA.POST, request("/api/auth/session", {
      method: "POST", cookie: `${s.cookie}; ${csrfCookie}`, body: { csrfToken: csrf.body?.csrfToken, data: {} },
    }), { nextauth: ["session"] });
    t.check("POST /api/auth/session (client update()) runs OUTSIDE the exemption", upd.status === 200 && seen.length > 0 && seen.every((x) => x === false), JSON.stringify(seen));
    seen.length = 0;
    await BACKGROUND[2].call(s.cookie);
    t.check("…while GET /api/auth/session runs inside it", seen.length > 0 && seen.every((x) => x === true), JSON.stringify(seen));
    seen.length = 0;
    freshCache();
    await invoke(NA.GET, request("/api/auth/session/extra", { cookie: s.cookie }), { nextauth: ["session", "extra"] });
    await invoke(NA.GET, request("/api/auth/providers", { cookie: s.cookie }), { nextauth: ["providers"] });
    t.check("no other NextAuth GET action (session/extra, providers) reads the store inside the exemption", seen.every((x) => x === false), JSON.stringify(seen));
    fake.clearHooks();
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
