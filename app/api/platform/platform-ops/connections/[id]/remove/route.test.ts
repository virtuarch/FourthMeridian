/**
 * app/api/platform/platform-ops/connections/[id]/remove/route.test.ts  (PB-5)
 *
 * The operator Remove connection's GATE, through the REAL handler against the
 * in-memory Prisma fake and real sessions (lib/test-support/route-harness):
 *   - no session → 401
 *   - not a SYSTEM_ADMIN (even a PLATFORM_OPS CONTROL grant holder) → 403
 *   - STALE auth: a session revoked after it was cached → 401; an admin demoted
 *     after the cache → 403 (requireFreshSystemAdmin re-reads both live)
 *   - missing / invalid reason or unsafe note → 400, before anything is read
 *   - unknown id → 404; a connection with nothing live → 409, nothing recorded
 * The removal itself (disconnectAccounts, audit, notification) is proved below
 * the route in lib/platform/connections/operator-removal.test.ts.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/platform/platform-ops/connections/[id]/remove/route.test.ts"
 */

import "@/lib/test-support/route-env";

import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";

const t = makeChecker("PB-5 — operator Remove connection: route gate");
const fake = new FakePrisma();

type H = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let POST: H;

let ADMIN = "", CONTROLLER = "", OWNER = "";

async function world() {
  fake.reset();
  freshCache();
  const hash = await bcrypt.hash("pw", 4);
  const u = (email: string, username: string, role = "USER", totp = false) =>
    fake.seed("User", { email, username, passwordHash: hash, emailVerifiedAt: new Date(), role, ...(totp ? { totpEnabled: true, totpSecret: "x" } : {}) });
  ADMIN = u("ops@fm.test", "ops", "SYSTEM_ADMIN", true).id as string;
  // A real operator: CONTROL (the top Platform rank) with TOTP — everything short of the role.
  CONTROLLER = u("ctl@fm.test", "ctl", "USER", true).id as string;
  OWNER = u("owner@fm.test", "owner").id as string;
  fake.seed("PlatformGrant", { userId: CONTROLLER, area: "PLATFORM_OPS", level: "CONTROL", status: "ACTIVE" });
}

const call = (cookie: string | undefined, id: string, body?: unknown) =>
  invoke(POST, request(`/api/platform/platform-ops/connections/${id}/remove`, { method: "POST", cookie, body }), { id });

async function main() {
  await installFakePrisma(fake);
  POST = (await import("./route")).POST as unknown as H;

  t.section("1. who may call it");
  await world();
  {
    const r = await call(undefined, "p1", { reason: "abuse" });
    t.check("no session → 401", r.status === 401, r.status);
    const ctl = (await signIn(fake, CONTROLLER)).cookie;
    const r2 = await call(ctl, "p1", { reason: "abuse" });
    t.check("a PLATFORM_OPS CONTROL grant holder (not SYSTEM_ADMIN) → 403", r2.status === 403, r2.status);
    t.check("…and nothing was read past the gate", fake.callsTo("PlaidItem").length === 0);
  }

  t.section("2. stale authentication is refused (fresh, live re-check)");
  await world();
  {
    const s = await signIn(fake, ADMIN);
    const warm = await call(s.cookie, "p1", {});
    t.check("a live SYSTEM_ADMIN session passes the gate (400: no reason yet)", warm.status === 400, warm);
    // Revoke the session AFTER it was verified (and cached) — no freshCache().
    const row = fake.table("UserSession").find((x) => x.sessionToken === s.sessionToken)!;
    fake.table("UserSession").splice(fake.table("UserSession").indexOf(row), 1);
    const stale = await call(s.cookie, "p1", { reason: "abuse" });
    t.check("the same cookie after its session was revoked → 401 (the 30 s cache is bypassed)", stale.status === 401, stale.status);

    const s2 = await signIn(fake, ADMIN);
    await call(s2.cookie, "p1", {});
    (fake.one("User", { id: ADMIN }) as Record<string, unknown>).role = "USER";
    const demoted = await call(s2.cookie, "p1", { reason: "abuse" });
    t.check("an admin demoted after the cache → 403 (the role is re-read live)", demoted.status === 403, demoted.status);
  }

  t.section("3. the reason is required, before anything is read");
  await world();
  {
    const c = (await signIn(fake, ADMIN)).cookie;
    for (const [label, body] of [["no body", undefined], ["empty body", {}], ["unknown reason", { reason: "fraud" }],
      ["note with an email", { reason: "other", note: "mail me at a@b.co" }], ["note over 280", { reason: "other", note: "x".repeat(281) }]] as const) {
      const r = await call(c, "p1", body);
      t.check(`${label} → 400`, r.status === 400 && typeof (r.body as { error?: unknown })?.error === "string", r);
    }
    t.check("no connection was read for any of them", fake.callsTo("PlaidItem").length === 0 && fake.callsTo("Connection").length === 0);
  }

  t.section("4. unknown / already removed");
  await world();
  {
    const c = (await signIn(fake, ADMIN)).cookie;
    const r = await call(c, "nope", { reason: "customer_request" });
    t.check("unknown id → 404", r.status === 404, r);
    const item = fake.seed("PlaidItem", { userId: OWNER, institutionId: "ins_1", institutionName: "Chase", encryptedToken: "", status: "REVOKED" });
    const r2 = await call(c, item.id as string, { reason: "customer_request" });
    t.check("a connection with no live accounts → 409", r2.status === 409, r2);
    t.check("…and no operator action or notification was written", fake.rows("AuditLog").length === 0 && fake.rows("Notification").length === 0);
  }

  t.section("5. source pins");
  {
    const src = readFileSync("app/api/platform/platform-ops/connections/[id]/remove/route.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    t.check("the gate is requireFreshSystemAdmin(), FIRST", /export async function POST[\s\S]*?\{\s*const \[admin, err\] = await requireFreshSystemAdmin\(\);/.test(src));
    t.check("no Platform-grant gate admits it (a grant is not the authority)", !/requirePlatformAccess|requireFreshPlatformAccess/.test(src));
    t.check("rate-limited per operator (every call emails a customer)", /limitByUser\(admin\.id,/.test(src));
    t.check("the reason is parsed before the connection id is used", src.indexOf("parseRemovalRequest(") < src.indexOf("removeConnectionAsOperator("));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
