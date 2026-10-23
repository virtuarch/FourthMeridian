/**
 * app/api/spaces/[id]/accounts/share/route.test.ts  (TEST-002)
 *
 * POST (share one of YOUR accounts into a Space) and DELETE (revoke a share) —
 * REAL exported handlers, real session cookies, in-memory Prisma fake,
 * two-tenant world.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/spaces/[id]/accounts/share/route.test.ts"
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma, knownError } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker } from "@/lib/test-support/route-harness";
import { spaceWorld, type Person, type SpaceWorld } from "@/lib/test-support/space-world";

const t = makeChecker("POST/DELETE /api/spaces/[id]/accounts/share (TEST-002)");
const fake = new FakePrisma();
let POST: typeof import("./route").POST;
let DELETE: typeof import("./route").DELETE;
let w: SpaceWorld;
const share = (by: Person | null, spaceId: string, body: unknown) =>
  invoke(POST, request(`/api/spaces/${spaceId}/accounts/share`, { cookie: by ? w.as[by].cookie : null, body }), { id: spaceId });
const unshare = (by: Person | null, spaceId: string, financialAccountId: string) =>
  invoke(DELETE, request(`/api/spaces/${spaceId}/accounts/share`, { method: "DELETE", cookie: by ? w.as[by].cookie : null, body: { financialAccountId } }), { id: spaceId });
const account = (owner: Person, over: Record<string, unknown> = {}) =>
  fake.seed("FinancialAccount", { ownerUserId: w.ids[owner], name: `${owner}'s Chase Checking`, type: "checking", ...over }).id as string;
const link = (spaceId: string, fa: string) => fake.one("SpaceAccountLink", { spaceId, financialAccountId: fa });

async function main() {
  await installFakePrisma(fake);
  ({ POST, DELETE } = await import("./route"));

  t.section("1. sharing your own account");
  {
    w = await spaceWorld(fake);
    const fa = account("member");
    const r = await share("member", w.S, { financialAccountId: fa });
    t.check("201 { ok: true }", r.status === 201 && r.body.ok === true, r);
    const l = link(w.S, fa)!;
    t.check("an ACTIVE FULL link added by the sharer (first link ⇒ HOME)", l.status === "ACTIVE" && l.visibilityLevel === "FULL" && l.addedByUserId === w.ids.member && l.kind === "HOME", l);
    const audit = fake.one("AuditLog", { action: "ACCOUNT_SHARED" })!;
    t.check("ACCOUNT_SHARED audit in S naming the account (FULL visibility)", audit.spaceId === w.S && (audit.metadata as Record<string, unknown>).accountName === "member's Chase Checking");
    const fb = account("viewer");
    const v = await share("viewer", w.S, { financialAccountId: fb, visibilityLevel: "BALANCE_ONLY" });
    t.check("a VIEWER may share their own account (policy: account:share is VIEWER+)", v.status === 201);
    const vAudit = fake.rows("AuditLog", { action: "ACCOUNT_SHARED" }).find((a) => (a.metadata as Record<string, unknown>).financialAccountId === fb)!;
    t.check("BALANCE_ONLY: the audit stores a GENERIC account name, never the real one",
      !JSON.stringify(vAudit.metadata).includes("Chase") && (vAudit.metadata as Record<string, unknown>).visibilityLevel === "BALANCE_ONLY", vAudit.metadata);
    t.check("sharing into a second Space ⇒ kind SHARED", (await share("owner", w.P, { financialAccountId: account("owner") })).status === 201
      && await (async () => { const id = fake.rows("FinancialAccount", { ownerUserId: w.ids.owner })[0].id as string; await share("owner", w.S, { financialAccountId: id }); return link(w.S, id)!.kind === "SHARED"; })());
  }

  t.section("2. you can only share what you OWN, into a Space you belong to");
  {
    w = await spaceWorld(fake);
    const theirs = account("admin");
    const r = await share("member", w.S, { financialAccountId: theirs });
    t.check("sharing another member's account → 403 'You do not own'", r.status === 403 && String(r.body.error).includes("own") && !link(w.S, theirs), r.body);
    const mine = account("member");
    t.check("into the other tenant's Space → 403", (await share("member", w.T, { financialAccountId: mine })).status === 403 && !link(w.T, mine));
    t.check("as a former (LEFT) member → 403", (await share("former", w.S, { financialAccountId: account("former") })).status === 403);
    t.check("anonymous → 401", (await share(null, w.S, { financialAccountId: mine })).status === 401);
    t.check("a deleted account → 404", (await share("member", w.S, { financialAccountId: account("member", { deletedAt: new Date() }) })).status === 404);
    t.check("an unknown account → 404", (await share("member", w.S, { financialAccountId: "nope" })).status === 404);
    t.check("missing financialAccountId → 400", (await share("member", w.S, {})).status === 400);
    t.check("visibilityLevel NONE (not shareable) → 400", (await share("member", w.S, { financialAccountId: mine, visibilityLevel: "NONE" })).status === 400);
    t.check("no link and no audit from any refusal", fake.rows("SpaceAccountLink").length === 0 && fake.rows("AuditLog").length === 0);
  }

  t.section("3. P2002 race → 409, and the audit rolls back with the link");
  {
    w = await spaceWorld(fake);
    const fa = account("member");
    fake.on("SpaceAccountLink", "upsert", () => { throw knownError("P2002", "Unique constraint failed on the fields: (`spaceId`,`financialAccountId`)"); }, { once: true });
    const r = await share("member", w.S, { financialAccountId: fa });
    t.check("409 'shared at the same moment'", r.status === 409 && String(r.body.error).includes("same moment"), r);
    t.check("no link, no ACCOUNT_SHARED audit", !link(w.S, fa) && fake.rows("AuditLog").length === 0);
    t.check("a retry succeeds", (await share("member", w.S, { financialAccountId: fa })).status === 201);
  }

  t.section("4. DELETE — the sharer, or an ADMIN+, revokes");
  {
    w = await spaceWorld(fake);
    const fa = account("member");
    await share("member", w.S, { financialAccountId: fa });
    const x = await unshare("viewer", w.S, fa);
    t.check("another non-admin member → 403, still ACTIVE", x.status === 403 && link(w.S, fa)!.status === "ACTIVE");
    t.check("the other tenant's owner → 403", (await unshare("stranger", w.S, fa)).status === 403);
    const r = await unshare("member", w.S, fa);
    const l = link(w.S, fa)!;
    t.check("the sharer → 200; REVOKED with revokedAt + revokedBy", r.status === 200 && l.status === "REVOKED" && l.revokedAt instanceof Date && l.revokedByUserId === w.ids.member);
    t.check("ACCOUNT_REVOKED audit", fake.rows("AuditLog", { action: "ACCOUNT_REVOKED", spaceId: w.S }).length === 1);
    t.check("revoking again → 404 (not ACTIVE)", (await unshare("member", w.S, fa)).status === 404);
    const back = await share("member", w.S, { financialAccountId: fa });
    const again = link(w.S, fa)!;
    t.check("re-sharing re-activates the SAME link and clears the revocation",
      back.status === 201 && again.id === l.id && again.status === "ACTIVE" && again.revokedAt === null && again.revokedByUserId === null);
    const adm = await unshare("admin", w.S, fa);
    t.check("an ADMIN may revoke another member's share (account:revoke)", adm.status === 200 && link(w.S, fa)!.revokedByUserId === w.ids.admin);
    t.check("an unknown share → 404", (await unshare("owner", w.S, "nope")).status === 404);
    t.check("missing financialAccountId → 400", (await invoke(DELETE, request(`/api/spaces/${w.S}/accounts/share`, { method: "DELETE", cookie: w.as.owner.cookie, body: {} }), { id: w.S })).status === 400);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
