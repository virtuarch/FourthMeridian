/**
 * app/api/platform/growth-revenue/requests/[id]/approve/route.test.ts  (I4)
 *
 * The REAL approve handler against the in-memory Prisma fake. A7 (2026-10-22)
 * found that two concurrent approves both answered 200, sent two invite e-mails
 * and rotated the token twice (the first e-mailed link died). Approve is now a
 * first decision: exactly one transition, one token, one e-mail.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/platform/growth-revenue/requests/[id]/approve/route.test.ts"
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { seedBetaGroup } from "@/lib/test-support/beta-group";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { capturedEmails } from "@/lib/email/providers/capture";

const t = makeChecker("POST /api/platform/growth-revenue/requests/[id]/approve (I4)");
const fake = new FakePrisma();
type H = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let APPROVE: H;

async function world(status = "PENDING") {
  fake.reset();
  freshCache();
  await seedBetaGroup(fake);
  const hash = await bcrypt.hash("pw", 4);
  const admin = fake.seed("User", { email: "ops@example.test", username: "ops", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
  const user  = fake.seed("User", { email: "u@example.test", username: "u", passwordHash: hash, emailVerifiedAt: new Date() });
  const req   = fake.seed("BetaAccessRequest", { email: "invitee@example.test", status });
  return { admin, user, req };
}
const approve = async (cookie: string | undefined, id: string) => {
  const r = await invoke(APPROVE as never, request(`/api/platform/growth-revenue/requests/${id}/approve`, { method: "POST", cookie }), { id });
  return r;
};
const sentTo = (email: string) => capturedEmails().filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(email)).length;

async function main() {
  await installFakePrisma(fake);
  ({ POST: APPROVE } = await import("./route") as unknown as { POST: H });

  t.section("1. concurrent double approve → one transition, one token, one e-mail");
  {
    const w = await world();
    const s = await signIn(fake, w.admin.id as string);
    const before = sentTo("invitee@example.test");
    const [a, b] = await Promise.all([approve(s.cookie, w.req.id as string), approve(s.cookie, w.req.id as string)]);
    const row = fake.one("BetaAccessRequest", { id: w.req.id })!;
    const audits = fake.rows("AuditLog", { action: "BETA_ACCESS_APPROVED" }).length;
    t.check("both answer 200 (idempotent), exactly one says alreadyApproved", a.status === 200 && b.status === 200
      && [a.body.alreadyApproved, b.body.alreadyApproved].filter(Boolean).length === 1, [a.body, b.body]);
    t.check("exactly ONE invite e-mail", sentTo("invitee@example.test") - before === 1, sentTo("invitee@example.test") - before);
    t.check("exactly ONE approval audit row", audits === 1, audits);
    t.check("row APPROVED with a token hash", row.status === "APPROVED" && typeof row.inviteTokenHash === "string");
    const hash1 = row.inviteTokenHash;
    const again = await approve(s.cookie, w.req.id as string);
    t.check("a later repeat → 200 alreadyApproved, sends nothing, token NOT rotated", again.status === 200 && again.body.alreadyApproved === true
      && sentTo("invitee@example.test") - before === 1 && fake.one("BetaAccessRequest", { id: w.req.id })!.inviteTokenHash === hash1, again.body);
  }

  t.section("2. state rules");
  {
    const w = await world("DENIED");
    const s = await signIn(fake, w.admin.id as string);
    const r = await approve(s.cookie, w.req.id as string);
    t.check("DENIED → approve is a fresh decision: 200, e-mail sent", r.status === 200 && !r.body.alreadyApproved && fake.one("BetaAccessRequest", { id: w.req.id })!.status === "APPROVED", r.body);
    const w2 = await world("REDEEMED");
    const s2 = await signIn(fake, w2.admin.id as string);
    const r2 = await approve(s2.cookie, w2.req.id as string);
    t.check("REDEEMED → 409, untouched", r2.status === 409 && fake.one("BetaAccessRequest", { id: w2.req.id })!.status === "REDEEMED", r2.body);
    const r3 = await approve(s2.cookie, "does-not-exist");
    t.check("unknown id → 404", r3.status === 404, [r3.status, r3.body]);
  }

  t.section("3. authorization");
  {
    const w = await world();
    const anon = await approve(undefined, w.req.id as string);
    t.check("anonymous → 401", anon.status === 401, anon.status);
    const su = await signIn(fake, w.user.id as string);
    const u = await approve(su.cookie, w.req.id as string);
    t.check("a USER without a GROWTH_REVENUE grant → 403, row still PENDING", u.status === 403 && fake.one("BetaAccessRequest", { id: w.req.id })!.status === "PENDING", u.status);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
