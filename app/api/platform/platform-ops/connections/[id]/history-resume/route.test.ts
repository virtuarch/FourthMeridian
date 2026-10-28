/**
 * app/api/platform/platform-ops/connections/[id]/history-resume/route.test.ts
 *
 * The REAL exported GET/POST handlers, real session cookies, in-memory Prisma
 * fake (lib/test-support/route-harness.ts). Authorization is exercised through
 * the unmodified chain — session → requireFreshPlatformAccess → the
 * PlatformGrant row — never stubbed.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/platform/platform-ops/connections/[id]/history-resume/route.test.ts"
 *
 * The pass itself (target checks, budget, lock, audit) is proven offline in
 * lib/platform/wallet-history-recovery.test.ts; here: who may reach it, and
 * that a refusal before any wallet exists writes nothing.
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";

const t = makeChecker("/api/platform/platform-ops/connections/[id]/history-resume");
const fake = new FakePrisma();
let GET: typeof import("./route").GET;
let POST: typeof import("./route").POST;

const PATH = (id: string) => `/api/platform/platform-ops/connections/${id}/history-resume`;
const BODY = { reason: { code: "SUPPORT_REQUEST", note: "customer reports missing history" } };

async function operator(name: string, grant: { area: string; level: string; status?: string } | null) {
  const u = fake.seed("User", { email: `${name}@example.test`, username: name, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  if (grant) fake.seed("PlatformGrant", { userId: u.id, area: grant.area, level: grant.level, status: grant.status ?? "ACTIVE" });
  return signIn(fake, u.id as string);
}

async function main() {
  await installFakePrisma(fake);
  ({ GET, POST } = await import("./route"));
  fake.reset();
  freshCache();
  const read = await operator("reader", { area: "PLATFORM_OPS", level: "READ" });
  const write = await operator("writer", { area: "PLATFORM_OPS", level: "WRITE" });
  const otherArea = await operator("cs", { area: "CUSTOMER_SUCCESS", level: "CONTROL" });
  const revoked = await operator("revoked", { area: "PLATFORM_OPS", level: "CONTROL", status: "REVOKED" });
  const customer = await operator("customer", null);
  const control = await operator("controller", { area: "PLATFORM_OPS", level: "CONTROL" });
  const audits = () => fake.rows("AuditLog", { action: "WALLET_HISTORY_RESUMED" }).length;

  t.section("1. who may reach it — both verbs");
  for (const [verb, h] of [["GET", GET], ["POST", POST]] as const) {
    const call = (cookie?: string) => invoke(h, request(PATH("conn_x"), { method: verb, cookie, ...(verb === "POST" ? { body: BODY } : {}) }), { id: "conn_x" });
    t.check(`${verb}: anonymous → 401`, (await call()).status === 401);
    t.check(`${verb}: a customer with no grant → 403`, (await call(customer.cookie)).status === 403);
    t.check(`${verb}: PLATFORM_OPS READ → 403`, (await call(read.cookie)).status === 403);
    t.check(`${verb}: PLATFORM_OPS WRITE → 403 (CONTROL is a rank above)`, (await call(write.cookie)).status === 403);
    t.check(`${verb}: CONTROL in another area → 403`, (await call(otherArea.cookie)).status === 403);
    t.check(`${verb}: a REVOKED CONTROL grant → 403 (fresh check)`, (await call(revoked.cookie)).status === 403);
    t.check(`${verb}: PLATFORM_OPS CONTROL passes the gate (an unknown id is 404)`, (await call(control.cookie)).status === 404);
  }
  t.check("no refusal above wrote a WALLET_HISTORY_RESUMED row", audits() === 0);

  t.section("2. the body is validated before anything is read");
  {
    const post = (body: unknown) => invoke(POST, request(PATH("conn_x"), { method: "POST", cookie: control.cookie, body }), { id: "conn_x" });
    const noReason = await post({});
    t.check("no reason → 400", noReason.status === 400, noReason.body);
    const noNote = await post({ reason: { code: "SUPPORT_REQUEST" } });
    t.check("a reason code without a note → 400 (the note is required)", noNote.status === 400 && /note/i.test(String((noNote.body as { error?: string }).error)), noNote.body);
    const unsafe = await post({ reason: { code: "SUPPORT_REQUEST", note: "card 4111111111111111" } });
    t.check("an unsafe note (long digit run) → 400", unsafe.status === 400);
    const long = await post({ reason: { code: "SUPPORT_REQUEST", note: "x".repeat(281) } });
    t.check("a note over 280 characters → 400", long.status === 400);
    t.check("…and none of them wrote an audit row", audits() === 0);
  }

  t.section("3. a non-existent target is 404 and writes NO audit row");
  {
    const r = await invoke(POST, request(PATH("not-a-connection"), { method: "POST", cookie: control.cookie, body: BODY }), { id: "not-a-connection" });
    t.check("POST unknown id → 404 NOT_FOUND", r.status === 404 && (r.body as { code?: string }).code === "NOT_FOUND", r.body);
    t.check("…no audit row for an arbitrary path id", audits() === 0);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
