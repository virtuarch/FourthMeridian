/**
 * app/api/spaces/[id]/invites/[inviteId]/route.test.ts  (TEST-002)
 *
 * PATCH (accept / decline — the invitee only) and DELETE (revoke — ADMIN+) on a
 * Space invite. REAL exported handlers, real session cookies, in-memory Prisma
 * fake, two-tenant world.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/spaces/[id]/invites/[inviteId]/route.test.ts"
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { spaceWorld, type Person, type SpaceWorld } from "@/lib/test-support/space-world";

const t = makeChecker("PATCH/DELETE /api/spaces/[id]/invites/[inviteId] (TEST-002)");
const fake = new FakePrisma();
let PATCH: typeof import("./route").PATCH;
let DELETE: typeof import("./route").DELETE;
let w: SpaceWorld;

const respond = (by: Person | null, spaceId: string, inviteId: string, action: unknown) =>
  invoke(PATCH, request(`/api/spaces/${spaceId}/invites/${inviteId}`, { method: "PATCH", cookie: by ? w.as[by].cookie : null, body: { action } }), { id: spaceId, inviteId });
const revoke = (by: Person | null, spaceId: string, inviteId: string) =>
  invoke(DELETE, request(`/api/spaces/${spaceId}/invites/${inviteId}`, { method: "DELETE", cookie: by ? w.as[by].cookie : null }), { id: spaceId, inviteId });
const inviteFor = (spaceId: string, who: Person, over: Record<string, unknown> = {}) =>
  fake.seed("SpaceInvite", { spaceId, invitedById: w.ids.owner, invitedUserId: w.ids[who], role: "MEMBER", ...over }).id as string;
const membership = (spaceId: string, who: Person) => fake.one("SpaceMember", { spaceId, userId: w.ids[who] });

async function main() {
  await installFakePrisma(fake);
  ({ PATCH, DELETE } = await import("./route"));

  t.section("1. the invitee accepts");
  {
    w = await spaceWorld(fake);
    const id = inviteFor(w.S, "loner", { role: "VIEWER" });
    const r = await respond("loner", w.S, id, "accept");
    t.check("200 { ok, joined: true }", r.status === 200 && r.body.joined === true, r.body);
    const m = membership(w.S, "loner")!;
    t.check("an ACTIVE membership with the INVITE's role", m.status === "ACTIVE" && m.role === "VIEWER");
    t.check("the invite is ACCEPTED", fake.one("SpaceInvite", { id })!.status === "ACCEPTED");
    t.check("MEMBER_JOINED audit in S", fake.rows("AuditLog", { action: "MEMBER_JOINED", spaceId: w.S, userId: w.ids.loner }).length === 1);
    t.check("accepting again → 409 (no longer pending)", (await respond("loner", w.S, id, "accept")).status === 409);
  }

  t.section("2. only the invitee — never another member, another tenant, or an admin");
  {
    w = await spaceWorld(fake);
    const id = inviteFor(w.S, "loner");
    for (const by of ["owner", "admin", "member", "stranger"] as const) {
      const r = await respond(by, w.S, id, "accept");
      t.check(`${by} accepting loner's invite → 403`, r.status === 403, r.status);
    }
    t.check("…and nobody joined, invite still PENDING", !membership(w.S, "loner") && fake.one("SpaceInvite", { id })!.status === "PENDING");
    t.check("anonymous → 401", (await respond(null, w.S, id, "accept")).status === 401);
    t.check("the right invite id under the WRONG Space id → 404", (await respond("loner", w.T, id, "accept")).status === 404 && !membership(w.T, "loner"));
    t.check("an unknown invite id → 404", (await respond("loner", w.S, "nope", "accept")).status === 404);
  }

  t.section("3. decline, invalid action, non-pending");
  {
    w = await spaceWorld(fake);
    const id = inviteFor(w.S, "loner");
    t.check("an unknown action → 400", (await respond("loner", w.S, id, "maybe")).status === 400 && fake.one("SpaceInvite", { id })!.status === "PENDING");
    const d = await respond("loner", w.S, id, "decline");
    t.check("decline → 200 { joined: false }, DECLINED, no membership", d.status === 200 && d.body.joined === false
      && fake.one("SpaceInvite", { id })!.status === "DECLINED" && !membership(w.S, "loner"));
    t.check("accept after decline → 409", (await respond("loner", w.S, id, "accept")).status === 409 && !membership(w.S, "loner"));
  }

  t.section("4. accept guards: a legacy OWNER-role invite and a PERSONAL Space never grant membership");
  {
    w = await spaceWorld(fake);
    const legacy = inviteFor(w.S, "loner", { role: "OWNER" });
    const r = await respond("loner", w.S, legacy, "accept");
    t.check("an invite carrying OWNER → 400, no membership, still PENDING", r.status === 400 && !membership(w.S, "loner")
      && fake.one("SpaceInvite", { id: legacy })!.status === "PENDING", r.body);
    const p = inviteFor(w.P, "loner");
    t.check("an invite into a PERSONAL Space → 400, no membership", (await respond("loner", w.P, p, "accept")).status === 400 && !membership(w.P, "loner"));
  }

  t.section("5. a former member rejoins through a fresh invite (upsert re-activates the row)");
  {
    w = await spaceWorld(fake);
    const m = membership(w.S, "former")!;
    m.revokedAt = new Date(); m.revokedById = w.ids.owner;
    const id = inviteFor(w.S, "former", { role: "ADMIN" });
    const r = await respond("former", w.S, id, "accept");
    const after = membership(w.S, "former")!;
    t.check("200, the SAME row ACTIVE again with the invite's role and revocation cleared",
      r.status === 200 && after.id === m.id && after.status === "ACTIVE" && after.role === "ADMIN" && after.revokedAt === null && after.revokedById === null, after);
  }

  t.section("6. the accept is atomic — membership and invite commit together");
  {
    w = await spaceWorld(fake);
    const id = inviteFor(w.S, "loner");
    fake.on("SpaceInvite", "update", () => { throw new Error("db down"); }, { once: true });
    let threw = false;
    try { await respond("loner", w.S, id, "accept"); } catch { threw = true; }
    t.check("a failure on the invite update leaves NO membership behind", !membership(w.S, "loner") && fake.one("SpaceInvite", { id })!.status === "PENDING", { threw });
  }

  t.section("7. DELETE — revoke by ADMIN+, scoped to the Space");
  {
    w = await spaceWorld(fake);
    const id = inviteFor(w.S, "loner");
    t.check("MEMBER → 403", (await revoke("member", w.S, id)).status === 403);
    t.check("VIEWER → 403", (await revoke("viewer", w.S, id)).status === 403);
    t.check("the INVITEE cannot revoke (they decline instead) → 403", (await revoke("loner", w.S, id)).status === 403);
    t.check("T's OWNER via T's id → 200 cancelled: false, invite untouched (scope includes the Space)",
      await (async () => { const r = await revoke("stranger", w.T, id); return r.status === 200 && r.body.cancelled === false && !!fake.one("SpaceInvite", { id }); })());
    t.check("T's OWNER via S's id → 403", (await revoke("stranger", w.S, id)).status === 403 && !!fake.one("SpaceInvite", { id }));
    const r = await revoke("admin", w.S, id);
    t.check("ADMIN → 200 cancelled: true, the invite is gone", r.status === 200 && r.body.cancelled === true && !fake.one("SpaceInvite", { id }));
    t.check("the invitee then finds nothing to accept (404)", (await respond("loner", w.S, id, "accept")).status === 404 && !membership(w.S, "loner"));
    t.check("revoking again → 200 cancelled: false (idempotent)", (await revoke("owner", w.S, id)).body.cancelled === false);
    t.check("anonymous → 401", (await revoke(null, w.S, id)).status === 401);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
