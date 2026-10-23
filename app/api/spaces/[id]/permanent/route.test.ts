/**
 * app/api/spaces/[id]/permanent/route.test.ts  (TEST-002)
 *
 * DELETE /api/spaces/[id]/permanent — REAL exported handler, real session
 * cookies, in-memory Prisma fake, two-tenant world. Fresh authentication, OWNER,
 * a trashed SHARED Space that owns no accounts — or nothing happens.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/spaces/[id]/permanent/route.test.ts"
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { spaceWorld, type Person, type SpaceWorld } from "@/lib/test-support/space-world";

const t = makeChecker("DELETE /api/spaces/[id]/permanent (TEST-002)");
const fake = new FakePrisma();
let DELETE: typeof import("./route").DELETE;
let STATUS: typeof import("@/app/api/user/totp/status/route").GET;
let w: SpaceWorld;
const purge = (by: Person | null, spaceId: string) =>
  invoke(DELETE, request(`/api/spaces/${spaceId}/permanent`, { method: "DELETE", cookie: by ? w.as[by].cookie : null, ip: "203.0.113.99" }), { id: spaceId });
const space = (id: string) => fake.one("Space", { id });
const trash = (id: string) => { space(id)!.deletedAt = new Date(); };

async function main() {
  await installFakePrisma(fake);
  ({ DELETE } = await import("./route"));
  ({ GET: STATUS } = await import("@/app/api/user/totp/status/route"));

  t.section("1. the OWNER permanently deletes a trashed SHARED Space");
  {
    w = await spaceWorld(fake);
    trash(w.S);
    const r = await purge("owner", w.S);
    t.check("200 { ok: true }", r.status === 200 && r.body.ok === true, r);
    t.check("the Space row is gone", !space(w.S));
    const audit = fake.one("AuditLog", { action: "SPACE_PERMANENT_DELETE" })!;
    t.check("SPACE_PERMANENT_DELETE audit written BEFORE the delete, with name/type/category and the client IP",
      !!audit && (audit.metadata as Record<string, unknown>).name === "Household" && audit.ipAddress === "203.0.113.99"
      && fake.calls.findIndex((c) => c.model === "AuditLog" && c.op === "create") < fake.calls.findIndex((c) => c.model === "Space" && c.op === "delete"));
    t.check("the other tenant's Space is untouched", !!space(w.T));
  }

  t.section("2. refusals — nothing is deleted");
  {
    w = await spaceWorld(fake);
    const notTrashed = await purge("owner", w.S);
    t.check("not in the trash → 400 'Move Space to trash'", notTrashed.status === 400 && String(notTrashed.body.error).includes("trash"));
    trash(w.S); trash(w.P);
    t.check("PERSONAL (even trashed) → 400", (await purge("owner", w.P)).status === 400 && !!space(w.P));
    for (const by of ["admin", "member", "viewer", "former", "stranger"] as const) {
      t.check(`${by} → 403`, (await purge(by, w.S)).status === 403 && !!space(w.S));
    }
    t.check("anonymous → 401", (await purge(null, w.S)).status === 401);
    fake.seed("FinancialAccount", { ownerUserId: w.ids.owner, ownerSpaceId: w.S, name: "Joint", type: "checking" });
    fake.seed("FinancialAccount", { ownerUserId: w.ids.owner, ownerSpaceId: w.S, name: "Joint 2", type: "savings" });
    const owned = await purge("owner", w.S);
    t.check("a Space that still OWNS accounts → 400 with ownedAccountCount: 2", owned.status === 400 && owned.body.ownedAccountCount === 2, owned.body);
    t.check("no deletion and no audit from any refusal", !!space(w.S) && fake.rows("AuditLog").length === 0);
  }

  t.section("3. fresh authentication — a revoked session the cache still trusts is refused");
  {
    w = await spaceWorld(fake);
    trash(w.S);
    await invoke(STATUS, request("/api/user/totp/status", { cookie: w.as.owner.cookie })); // warm the cache
    fake.one("UserSession", { id: w.as.owner.sessionId })!.revokedAt = new Date();
    const r = await purge("owner", w.S);
    t.check("→ 401 and the Space survives", r.status === 401 && !!space(w.S), r.status);
    w = await spaceWorld(fake);
    trash(w.S);
    fake.seed("PlatformSetting", { key: "require_totp_all_users", value: "true" });
    t.check("a TOTP-pending OWNER → 403", (await purge("owner", w.S)).status === 403 && !!space(w.S));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
