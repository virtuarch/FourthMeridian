/**
 * app/api/user/presence/route.test.ts  (PB-10 — the heartbeat route, for real)
 *
 * The REAL exported POST handler, real session cookies through the real
 * NextAuth session callback, the in-memory Prisma fake (the real schema). The
 * fake's `$executeRaw` applies the two statements a request can run — the
 * session TOUCH (lastActiveAt) and the presence BEAT — to the store with the
 * database clock simulated server-side.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/user/presence/route.test.ts
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { parsePresenceBody, presenceLimitKey } from "@/lib/presence/heartbeat-request";

const t = makeChecker("PB-10 — POST /api/user/presence");
const fake = new FakePrisma();
type H = (req: never) => Promise<Response>;

let touches = 0;
let beats: unknown[][] = [];
/** The server clock the fake "database" stamps with. Never read from the request. */
let dbNow = new Date("2026-11-03T12:00:00.000Z");

function emulate(sql: string, values: unknown[]): number {
  if (/SET "lastActiveAt"/.test(sql)) { touches++; return 0; }
  if (/SET "lastPresenceAt"/.test(sql)) {
    beats.push(values);
    const [interacted, sessionToken, userId] = values as [boolean, string, string];
    const row = fake.rows("UserSession").find((r) => r.sessionToken === sessionToken && r.userId === userId && r.revokedAt === null);
    if (!row) return 0;
    row.lastPresenceAt = dbNow;
    if (interacted) row.lastInteractionAt = dbNow;
    return 1;
  }
  return 1;
}

async function main() {
  await installFakePrisma(fake);
  const { POST } = await import("./route") as unknown as { POST: H };
  fake.reset();
  fake.executeRaw = emulate;
  fake.seed("PlatformSetting", { key: "require_totp_all_users", value: "false" });
  const u = fake.seed("User", { email: "p@example.test", username: "presence", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  const userId = u.id as string;
  const s = await signIn(fake, userId);
  const row = () => fake.rows("UserSession").find((r) => r.sessionToken === s.sessionToken)!;
  const beat = (body: unknown, cookie: string | null = s.cookie) => {
    freshCache(); // every call is a LIVE revocation check — the case that would touch
    return invoke(POST, request("/api/user/presence", { method: "POST", cookie, rawBody: typeof body === "string" ? body : JSON.stringify(body) }));
  };
  const reset = () => { touches = 0; beats = []; };

  t.section("auth");
  reset();
  t.check("no session ⇒ 401, nothing written", (await beat({ interacted: true }, null)).status === 401 && beats.length === 0);

  t.section("a beat");
  const lastActiveBefore = (row().lastActiveAt as Date).getTime();
  reset();
  const r1 = await beat({ interacted: false });
  t.check("204 on a valid beat", r1.status === 204, r1.status);
  t.check("one presence statement, bound to THIS session's token and user", beats.length === 1
    && beats[0][1] === s.sessionToken && beats[0][2] === userId, JSON.stringify(beats));
  t.check("presence stamped from the server clock; interaction untouched when interacted=false",
    (row().lastPresenceAt as Date).getTime() === dbNow.getTime() && (row().lastInteractionAt ?? null) === null);
  t.check("the heartbeat request did NOT touch lastActiveAt (SEC-010 clock)", touches === 0, `touches=${touches}`);
  t.check("Cache-Control: no-store", r1.headers.get("cache-control") === "no-store");

  t.section("N beats never move lastActiveAt");
  reset();
  for (let i = 0; i < 5; i++) { await beat({ interacted: true }); }
  t.check("5 heartbeat requests (LIVE checks) ⇒ 0 touches", touches === 0, `touches=${touches}`);
  t.check("lastActiveAt is byte-identical", (row().lastActiveAt as Date).getTime() === lastActiveBefore);

  t.section("client time and identity are never accepted");
  reset();
  for (const bad of [
    { interacted: true, at: "2030-01-01T00:00:00Z" },
    { interacted: true, userId: "someone-else" },
    { interacted: true, sessionToken: "x" },
    { interacted: "yes" },
    {},
    "not json",
    JSON.stringify({ interacted: true, pad: "x".repeat(200) }),
  ]) {
    const r = await beat(bad);
    t.check(`refused (400) and nothing written: ${typeof bad === "string" ? bad.slice(0, 24) : JSON.stringify(bad).slice(0, 48)}`, r.status === 400 && beats.length === 0, r.status);
  }
  t.check("the presence statement takes only the boolean, the token and the user — no time is bound",
    parsePresenceBody('{"interacted":true}')?.interacted === true && parsePresenceBody('{"interacted":true,"at":1}') === null);

  t.section("rate limit — its own per-session bucket; a 429 writes nothing");
  process.env.RATE_LIMIT_ENABLED = "true";
  {
    const u2 = fake.seed("User", { email: "q@example.test", username: "presence2", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
    const s2 = await signIn(fake, u2.id as string);
    reset();
    const a = await beat({ interacted: true }, s2.cookie);
    const b = await beat({ interacted: true }, s2.cookie);
    t.check("first beat in the window passes", a.status === 204, a.status);
    t.check("second beat in the same window ⇒ 429", b.status === 429, b.status);
    t.check("…and the 429 wrote nothing (one beat total)", beats.length === 1, beats.length);
    const c = await beat({ interacted: true }, s.cookie);
    t.check("another session has its own bucket (not starved)", c.status === 204, c.status);
    t.check("the bucket key is a digest, never the token", !presenceLimitKey(s2.sessionToken).includes(s2.sessionToken) && /^[0-9a-f]{32}$/.test(presenceLimitKey(s2.sessionToken)));
  }
  process.env.RATE_LIMIT_ENABLED = "";

  t.section("refused sessions write nothing");
  {
    const u3 = fake.seed("User", { email: "r@example.test", username: "presence3", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
    const s3 = await signIn(fake, u3.id as string);
    fake.rows("UserSession").find((r) => r.sessionToken === s3.sessionToken)!.revokedAt = new Date();
    reset();
    const r = await beat({ interacted: true }, s3.cookie);
    t.check("revoked session ⇒ 401, no beat, no touch", r.status === 401 && beats.length === 0 && touches === 0, r.status);

    const u4 = fake.seed("User", { email: "s@example.test", username: "presence4", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER", totpEnabled: false });
    const s4 = await signIn(fake, u4.id as string);
    fake.rows("PlatformSetting", { key: "require_totp_all_users" })[0].value = "true";
    reset();
    const p = await beat({ interacted: true }, s4.cookie);
    t.check("pending TOTP ⇒ 403, no beat", p.status === 403 && beats.length === 0, p.status);
    fake.rows("PlatformSetting", { key: "require_totp_all_users" })[0].value = "false";
  }

  t.section("multi-tab: two tabs on one session share one row; the newest beat wins");
  {
    reset();
    dbNow = new Date("2026-11-03T12:10:00.000Z");
    await beat({ interacted: false });            // tab A (visible, idle)
    dbNow = new Date("2026-11-03T12:10:30.000Z");
    await beat({ interacted: true });             // tab B (visible, clicked)
    t.check("presence = the newest beat of any tab", (row().lastPresenceAt as Date).toISOString() === "2026-11-03T12:10:30.000Z");
    t.check("interaction = the newest interacted beat", (row().lastInteractionAt as Date).toISOString() === "2026-11-03T12:10:30.000Z");
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
