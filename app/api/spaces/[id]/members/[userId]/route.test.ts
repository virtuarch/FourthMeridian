/**
 * app/api/spaces/[id]/members/[userId]/route.test.ts  (TEST-002)
 *
 * PATCH (change a member's role) and DELETE (leave / remove) — the REAL exported
 * handlers, real session cookies, the in-memory Prisma fake, a two-tenant world
 * (lib/test-support/space-world.ts). Authority comes from the real
 * requireSpaceRole; the IDEMP-010 guard from the real decideMemberRemoval.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/spaces/[id]/members/[userId]/route.test.ts"
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { spaceWorld, type Person, type SpaceWorld } from "@/lib/test-support/space-world";

const t = makeChecker("PATCH/DELETE /api/spaces/[id]/members/[userId] (TEST-002)");
const fake = new FakePrisma();
let PATCH: typeof import("./route").PATCH;
let DELETE: typeof import("./route").DELETE;
let w: SpaceWorld;

const patch = (by: Person, spaceId: string, target: Person | string, role: unknown) => {
  const userId = target in w.ids ? w.ids[target as Person] : target;
  return invoke(PATCH, request(`/api/spaces/${spaceId}/members/${userId}`, { method: "PATCH", cookie: w.as[by].cookie, body: { role } }), { id: spaceId, userId });
};
const remove = (by: Person | null, spaceId: string, target: Person) =>
  invoke(DELETE, request(`/api/spaces/${spaceId}/members/${w.ids[target]}`, { method: "DELETE", cookie: by ? w.as[by].cookie : null }),
    { id: spaceId, userId: w.ids[target] });
const m = (spaceId: string, who: Person) => fake.one("SpaceMember", { spaceId, userId: w.ids[who] })!;
const share = (spaceId: string, who: Person, n: number) => {
  for (let i = 0; i < n; i++) fake.seed("SpaceAccountLink", { spaceId, financialAccountId: `fa-${who}-${spaceId}-${i}`, kind: "SHARED", addedByUserId: w.ids[who] });
};

async function main() {
  await installFakePrisma(fake);
  ({ PATCH, DELETE } = await import("./route"));

  t.section("1. PATCH — only the OWNER changes roles");
  {
    w = await spaceWorld(fake);
    const r = await patch("owner", w.S, "member", "ADMIN");
    t.check("OWNER promotes MEMBER → ADMIN: 200 with the updated row", r.status === 200 && r.body.role === "ADMIN" && m(w.S, "member").role === "ADMIN", r.body);
    const audit = fake.one("AuditLog", { action: "MEMBER_ROLE_CHANGED" })!;
    const meta = audit.metadata as Record<string, unknown>;
    t.check("MEMBER_ROLE_CHANGED audit {targetUserId, targetName, oldRole, newRole}",
      audit.spaceId === w.S && audit.userId === w.ids.owner && meta.oldRole === "MEMBER" && meta.newRole === "ADMIN" && meta.targetName === "Member Test", meta);
    t.check("the target is notified", fake.rows("Notification", { userId: w.ids.member }).length === 1);
    for (const by of ["admin", "member", "viewer"] as const) {
      const before = m(w.S, "viewer").role;
      const x = await patch(by, w.S, "viewer", "ADMIN");
      t.check(`${by.toUpperCase()} → 403, role unchanged`, x.status === 403 && m(w.S, "viewer").role === before, x.status);
    }
    t.check("a former (LEFT) member → 403", (await patch("former", w.S, "viewer", "ADMIN")).status === 403);
    t.check("anonymous → 401", (await invoke(PATCH, request(`/api/spaces/${w.S}/members/${w.ids.viewer}`, { method: "PATCH", body: { role: "ADMIN" } }), { id: w.S, userId: w.ids.viewer })).status === 401);
  }

  t.section("2. PATCH — no path to OWNER, no touching the owner, no ghosts");
  {
    w = await spaceWorld(fake);
    const o = await patch("owner", w.S, "member", "OWNER");
    t.check("promotion to OWNER → 400 (transfer is not a role change)", o.status === 400 && m(w.S, "member").role === "MEMBER", o.body);
    t.check("an unknown role → 400", (await patch("owner", w.S, "member", "SUPERUSER")).status === 400);
    t.check("a missing role → 400", (await patch("owner", w.S, "member", undefined)).status === 400);
    fake.seed("SpaceMember", { spaceId: w.S, userId: w.ids.loner, role: "OWNER" });
    t.check("changing another OWNER's role → 400", (await patch("owner", w.S, "loner", "VIEWER")).status === 400 && m(w.S, "loner").role === "OWNER");
    t.check("a LEFT member → 404", (await patch("owner", w.S, "former", "ADMIN")).status === 404 && m(w.S, "former").role === "MEMBER");
    t.check("a non-member → 404", (await patch("owner", w.S, "stranger", "ADMIN")).status === 404);
    t.check("a PERSONAL Space → 400", (await patch("owner", w.P, "member", "ADMIN")).status === 400);
    t.check("no audit row for any refusal", fake.rows("AuditLog").length === 0);
  }

  t.section("3. PATCH — cross-tenant");
  {
    w = await spaceWorld(fake);
    const a = await patch("owner", w.T, "strangerMember", "ADMIN");
    t.check("S's OWNER cannot change a role in T (403)", a.status === 403 && m(w.T, "strangerMember").role === "MEMBER", a.status);
    const b = await patch("stranger", w.S, "member", "ADMIN");
    t.check("T's OWNER cannot change a role in S (403)", b.status === 403 && m(w.S, "member").role === "MEMBER");
  }

  t.section("4. DELETE — self-leave");
  {
    w = await spaceWorld(fake);
    share(w.S, "member", 2); share(w.S, "admin", 1); share(w.T, "strangerMember", 1);
    const r = await remove("member", w.S, "member");
    t.check("a MEMBER leaves: 200", r.status === 200 && r.body.ok === true, r);
    const row = m(w.S, "member");
    t.check("status LEFT, revokedAt set, revokedById null (nobody removed them)", row.status === "LEFT" && row.revokedAt instanceof Date && row.revokedById === null);
    t.check("their 2 ACTIVE share links in S are REVOKED, by themselves",
      fake.rows("SpaceAccountLink", { spaceId: w.S, addedByUserId: w.ids.member, status: "REVOKED", revokedByUserId: w.ids.member }).length === 2);
    t.check("other members' links, and links in other Spaces, are untouched",
      fake.rows("SpaceAccountLink", { addedByUserId: w.ids.admin, status: "ACTIVE" }).length === 1
      && fake.rows("SpaceAccountLink", { spaceId: w.T, status: "ACTIVE" }).length === 1);
    t.check("SPACE_LEAVE audit (MemberLeft)", fake.rows("AuditLog", { action: "SPACE_LEAVE", spaceId: w.S }).length === 1);
    t.check("a VIEWER may leave too", (await remove("viewer", w.S, "viewer")).status === 200 && m(w.S, "viewer").status === "LEFT");
    t.check("leaving twice → 403 (no longer an ACTIVE member, so no authority at all)", (await remove("member", w.S, "member")).status === 403);
  }

  t.section("5. DELETE — removal by others");
  {
    w = await spaceWorld(fake);
    const r = await remove("admin", w.S, "member");
    const row = m(w.S, "member");
    t.check("an ADMIN removes a MEMBER: 200, status REMOVED, revokedById = the admin",
      r.status === 200 && row.status === "REMOVED" && row.revokedById === w.ids.admin, r.body);
    t.check("MEMBER_REMOVED audit + the removed member is notified",
      fake.rows("AuditLog", { action: "MEMBER_REMOVED" }).length === 1 && fake.rows("Notification", { userId: w.ids.member }).length === 1);
    const v = await remove("member", w.S, "viewer");
    t.check("a MEMBER (or lower) cannot remove anyone else", v.status === 403 && m(w.S, "viewer").status === "ACTIVE");
    const o = await remove("admin", w.S, "owner");
    t.check("an ADMIN cannot remove the OWNER (403)", o.status === 403 && m(w.S, "owner").status === "ACTIVE" && String(o.body.error).includes("owner"));
    t.check("the OWNER removes the ADMIN", (await remove("owner", w.S, "admin")).status === 200 && m(w.S, "admin").status === "REMOVED");
    t.check("a non-member target → 404", (await remove("owner", w.S, "stranger")).status === 404);
    t.check("anonymous → 401", (await remove(null, w.S, "viewer")).status === 401);
  }

  t.section("6. DELETE — IDEMP-010: the last owner cannot leave; PERSONAL cannot be left");
  {
    w = await spaceWorld(fake);
    const last = await remove("owner", w.S, "owner");
    t.check("the sole OWNER leaving → 409, still ACTIVE OWNER", last.status === 409 && m(w.S, "owner").status === "ACTIVE" && String(last.body.error).includes("last owner"), last.body);
    fake.seed("SpaceMember", { spaceId: w.S, userId: w.ids.loner, role: "OWNER", status: "LEFT" });
    t.check("…a LEFT co-owner does not count (still 409)", (await remove("owner", w.S, "owner")).status === 409);
    fake.one("SpaceMember", { spaceId: w.S, userId: w.ids.loner })!.status = "ACTIVE";
    t.check("with another ACTIVE owner, the owner may leave (200 LEFT)", (await remove("owner", w.S, "owner")).status === 200 && m(w.S, "owner").status === "LEFT");
    const p = await remove("owner", w.P, "owner");
    t.check("leaving your PERSONAL Space → 400", p.status === 400 && m(w.P, "owner").status === "ACTIVE" && String(p.body.error).includes("Personal"));
  }

  t.section("7. DELETE — cross-tenant and the role floor");
  {
    w = await spaceWorld(fake);
    const x = await remove("stranger", w.S, "member");
    t.check("T's OWNER removing a member of S → 403, nothing changes", x.status === 403 && m(w.S, "member").status === "ACTIVE");
    const y = await remove("owner", w.T, "strangerMember");
    t.check("S's OWNER removing a member of T → 403", y.status === 403 && m(w.T, "strangerMember").status === "ACTIVE");
    t.check("a former member cannot act (403)", (await remove("former", w.S, "viewer")).status === 403);
    t.check("no audit row from any refusal", fake.rows("AuditLog").length === 0);
  }

  t.section("8. DELETE is atomic — a partial link revocation rolls the membership change back");
  {
    w = await spaceWorld(fake);
    share(w.S, "member", 3);
    // The policy layer silently refuses one row: the update matches 2 of the 3 observed.
    fake.on("SpaceAccountLink", "updateMany", () => ({ count: 2 }), { once: true });
    const r = await remove("admin", w.S, "member");
    t.check("→ 500 (withApiHandler), not a silent partial success", r.status === 500, r);
    t.check("the member is still ACTIVE and every link still ACTIVE (rolled back)",
      m(w.S, "member").status === "ACTIVE" && fake.rows("SpaceAccountLink", { status: "ACTIVE" }).length === 3);
    t.check("no MEMBER_REMOVED audit was written", fake.rows("AuditLog", { action: "MEMBER_REMOVED" }).length === 0);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
