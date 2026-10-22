/**
 * app/api/spaces/[id]/invite/route.test.ts  (TEST-002)
 *
 * POST /api/spaces/[id]/invite — the REAL exported handler, real session cookies,
 * in-memory Prisma fake, two-tenant world. ADMIN+ invites; PERSONAL refuses; no
 * OWNER invitations; duplicates are 409; a per-user hourly limit applies.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/spaces/[id]/invite/route.test.ts"
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { spaceWorld, type Person, type SpaceWorld } from "@/lib/test-support/space-world";
import { capturedEmails, clearCapturedEmails } from "@/lib/email/providers/capture";

const t = makeChecker("POST /api/spaces/[id]/invite (TEST-002)");
const fake = new FakePrisma();
let POST: typeof import("./route").POST;
let w: SpaceWorld;
const invite = (by: Person | null, spaceId: string, body: unknown) =>
  invoke(POST, request(`/api/spaces/${spaceId}/invite`, { cookie: by ? w.as[by].cookie : null, body }), { id: spaceId });

async function main() {
  await installFakePrisma(fake);
  ({ POST } = await import("./route"));

  t.section("1. an ADMIN invites by username");
  {
    w = await spaceWorld(fake);
    clearCapturedEmails();
    const r = await invite("admin", w.S, { username: "@loner" });
    t.check("201 with the PENDING invite (default role MEMBER)", r.status === 201 && r.body.status === "PENDING" && r.body.role === "MEMBER", r.body);
    t.check("the response names the invitee without their e-mail", (r.body.invitedUser as Record<string, unknown>).username === "loner" && !r.text.includes("loner@example.test"));
    const row = fake.one("SpaceInvite", { spaceId: w.S, invitedUserId: w.ids.loner })!;
    t.check("one SpaceInvite row, invitedBy = the admin", !!row && row.invitedById === w.ids.admin);
    const mails = capturedEmails();
    t.check("the invitation e-mail goes to the invitee (and only to them)",
      mails.some((m) => m.to === "loner@example.test" && /invited to Household/.test(m.subject)) && mails.every((m) => m.to === "loner@example.test"),
      mails.map((m) => [m.to, m.subject]));
    t.known("the invitee receives ONE e-mail per invitation", mails.length === 1,
      `J-D4: the route's space-invite mail AND the SPACE_INVITE_RECEIVED notification's EMAIL channel both send (${mails.length} mails)`);
    t.check("MEMBER_INVITED audit in S + an in-app notification for the invitee",
      fake.rows("AuditLog", { action: "MEMBER_INVITED", spaceId: w.S }).length === 1 && fake.rows("Notification", { userId: w.ids.loner }).length === 1);
    t.check("no membership is created by inviting", !fake.one("SpaceMember", { spaceId: w.S, userId: w.ids.loner }));
    t.check("the OWNER can invite as VIEWER or ADMIN", (await invite("owner", w.S, { username: "stranger", role: "ADMIN" })).body.role === "ADMIN");
  }

  t.section("2. role floor, tenancy, PERSONAL");
  {
    w = await spaceWorld(fake);
    for (const by of ["member", "viewer", "former"] as const) {
      t.check(`${by.toUpperCase()} → 403`, (await invite(by, w.S, { username: "loner" })).status === 403);
    }
    t.check("T's OWNER inviting into S → 403", (await invite("stranger", w.S, { username: "loner" })).status === 403);
    t.check("anonymous → 401", (await invite(null, w.S, { username: "loner" })).status === 401);
    t.check("a PERSONAL Space → 400", (await invite("owner", w.P, { username: "loner" })).status === 400);
    t.check("no invite row from any refusal", fake.rows("SpaceInvite").length === 0);
  }

  t.section("3. input + target refusals");
  {
    w = await spaceWorld(fake);
    t.check("role OWNER → 400 (W1-D3: never invitable)", (await invite("owner", w.S, { username: "loner", role: "OWNER" })).status === 400);
    t.check("an unknown role → 400", (await invite("owner", w.S, { username: "loner", role: "GOD" })).status === 400);
    t.check("blank username → 400", (await invite("owner", w.S, { username: "  " })).status === 400);
    t.check("unknown username → 404", (await invite("owner", w.S, { username: "nobody" })).status === 404);
    t.check("inviting yourself → 400", (await invite("admin", w.S, { username: "admin" })).status === 400);
    t.check("an ACTIVE member → 409", (await invite("owner", w.S, { username: "viewer" })).status === 409);
    t.check("first invite → 201", (await invite("owner", w.S, { username: "loner" })).status === 201);
    t.check("a second while PENDING → 409", (await invite("admin", w.S, { username: "loner" })).status === 409);
    t.check("still exactly one invite row", fake.rows("SpaceInvite", { invitedUserId: w.ids.loner }).length === 1);
    const caps = await invite("owner", w.S, { username: "Loner" });
    t.known("a username typed with capitals finds the (lower-cased) account", caps.status !== 404,
      "J-D3: invite looks the username up case-sensitively; registration stores it lower-cased");
  }

  t.section("4. a LEFT member and a DECLINED invite can be re-invited (upsert resets the row)");
  {
    w = await spaceWorld(fake);
    t.check("a former (LEFT) member can be re-invited → 201", (await invite("owner", w.S, { username: "former" })).status === 201);
    const old = fake.seed("SpaceInvite", { spaceId: w.S, invitedById: w.ids.owner, invitedUserId: w.ids.loner, role: "VIEWER", status: "DECLINED",
      createdAt: new Date(Date.now() - 86_400_000), seenAt: new Date() });
    const r = await invite("admin", w.S, { username: "loner", role: "ADMIN" });
    const row = fake.one("SpaceInvite", { id: old.id })!;
    t.check("re-inviting after DECLINED → 201, same row, PENDING again with the new role and inviter, seenAt cleared",
      r.status === 201 && row.status === "PENDING" && row.role === "ADMIN" && row.invitedById === w.ids.admin && row.seenAt === null
      && fake.rows("SpaceInvite", { invitedUserId: w.ids.loner }).length === 1, row);
  }

  t.section("5. per-user limit — 20 invitations per hour");
  {
    w = await spaceWorld(fake);
    process.env.RATE_LIMIT_ENABLED = "true";
    try {
      const s: number[] = [];
      for (let i = 0; i < 21; i++) s.push((await invite("admin", w.S, { username: "nobody" })).status);
      t.check("20 answered (404), the 21st is 429", s.slice(0, 20).every((x) => x === 404) && s[20] === 429, s);
      t.check("the limit is per user: the OWNER is unaffected", (await invite("owner", w.S, { username: "loner" })).status === 201);
    } finally { delete process.env.RATE_LIMIT_ENABLED; }
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
