/**
 * app/api/platform/growth-revenue/requests/[id]/risk-review/route.test.ts  (Beta-request risk)
 *
 * The REAL risk-review handlers (and the queue GET's `risk` block) against the
 * in-memory Prisma fake: a verdict is one append-only review row plus one
 * reason-carrying operator-action audit row; the request itself is never
 * touched; the queue answers with or without the risk read.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/platform/growth-revenue/requests/[id]/risk-review/route.test.ts"
 */

import "@/lib/test-support/route-env";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { auditEmailHash } from "@/lib/audit";

const t = makeChecker("/api/platform/growth-revenue/requests/[id]/risk-review (beta-request risk)");
const fake = new FakePrisma();
type H = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let POST: H;
let GET: H;
let QUEUE: () => Promise<Response>;

/** The writer's row lock (`SELECT "id" FROM "BetaAccessRequest" … FOR UPDATE`), answered from the fake store. */
const forUpdate = (sql: string, values: unknown[]) => {
  if (!/FOR UPDATE/.test(sql)) return undefined;
  locks.push(String(values[0]));
  const row = fake.one("BetaAccessRequest", { id: values[0] as string });
  return row ? [{ id: row.id }] : [];
};
const locks: string[] = [];

async function world() {
  fake.reset();
  freshCache();
  const hash = await bcrypt.hash("pw", 4);
  const admin = fake.seed("User", { email: "ops@example.test", username: "ops", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
  const user  = fake.seed("User", { email: "u@example.test", username: "u", passwordHash: hash, emailVerifiedAt: new Date() });
  const req   = fake.seed("BetaAccessRequest", { email: "applicant@example.test", status: "PENDING", note: "Keen to try the beta for budgeting" });
  fake.queryRaw = (sql, values) => {
    const r = forUpdate(sql, values);
    if (r !== undefined) return r;
    throw new Error("unexpected raw query");
  };
  locks.length = 0;
  return { admin, user, req };
}
const post = (cookie: string | undefined, id: string, body: unknown) =>
  invoke(POST as never, request(`/api/platform/growth-revenue/requests/${id}/risk-review`, { method: "POST", cookie, body }), { id });
const get = (cookie: string | undefined, id: string) =>
  invoke(GET as never, request(`/api/platform/growth-revenue/requests/${id}/risk-review`, { cookie }), { id });
const reviews = () => fake.rows("BetaAccessRequestReview", {});
const audits = () => fake.rows("AuditLog", { action: "BETA_REQUEST_RISK_REVIEWED" });

async function main() {
  await installFakePrisma(fake);
  ({ POST, GET } = await import("./route") as unknown as { POST: H; GET: H });
  ({ GET: QUEUE } = await import("../../route") as unknown as { GET: () => Promise<Response> });

  t.section("1. a verdict = one review row + one reason-carrying audit row; the request is untouched");
  {
    const w = await world();
    const s = await signIn(fake, w.admin.id as string);
    const before = JSON.stringify(fake.one("BetaAccessRequest", { id: w.req.id }));
    const r = await post(s.cookie, w.req.id as string, { status: "SUSPICIOUS", reason: { code: "ABUSE", note: "burst from one network" }, note: "matches the 10:02 burst" });
    t.check("200 with the new review", r.status === 200 && (r.body.review as { status?: string })?.status === "SUSPICIOUS", r.body);
    const rows = reviews();
    t.check("exactly one review row, with status / reason code / note / operator", rows.length === 1 && rows[0].status === "SUSPICIOUS"
      && rows[0].reasonCode === "ABUSE" && rows[0].note === "matches the 10:02 burst" && rows[0].operatorId === w.admin.id, rows);
    const a = audits();
    const meta = (a[0]?.metadata ?? {}) as Record<string, unknown>;
    t.check("exactly one BETA_REQUEST_RISK_REVIEWED audit row, operator-attributed", a.length === 1 && a[0].performedByAdminId === w.admin.id, a);
    t.check("the audit envelope carries the target, the reason and the before/after verdict",
      (meta.target as { kind?: string; id?: string })?.kind === "BETA_REQUEST" && (meta.target as { id?: string }).id === w.req.id
      && (meta.reason as { code?: string })?.code === "ABUSE"
      && JSON.stringify(meta.change) === JSON.stringify({ before: { reviewStatus: null }, after: { reviewStatus: "SUSPICIOUS" } }), meta);
    t.check("the request row is byte-identical (status, decision, token untouched)", JSON.stringify(fake.one("BetaAccessRequest", { id: w.req.id })) === before);
    t.check("the writer locked the request row (SELECT … FOR UPDATE) before reading the previous verdict", locks.length === 1 && locks[0] === w.req.id, locks);

    const r2 = await post(s.cookie, w.req.id as string, { status: "LEGITIMATE", reason: { code: "BETA_ONBOARDING" } });
    t.check("a second verdict APPENDS (history kept)", r2.status === 200 && reviews().length === 2 && audits().length === 2);
    const meta2 = (audits()[1]?.metadata ?? {}) as Record<string, unknown>;
    t.check("the second audit records the previous verdict as `before`", JSON.stringify(meta2.change) === JSON.stringify({ before: { reviewStatus: "SUSPICIOUS" }, after: { reviewStatus: "LEGITIMATE" } }), meta2.change);

    const h = await get(s.cookie, w.req.id as string);
    const list = (h.body.reviews ?? []) as { status: string; by: string | null; reasonCode: string }[];
    t.check("GET history: newest first, operator label (never an e-mail)", h.status === 200 && list.length === 2 && list[0].status === "LEGITIMATE"
      && list[1].status === "SUSPICIOUS" && list[0].by === "ops" && !h.text.includes("@"), h.body);
    t.check("GET history is no-store", h.headers.get("cache-control") === "no-store");
  }

  t.section("2. refusals write nothing");
  {
    const w = await world();
    const s = await signIn(fake, w.admin.id as string);
    const noReason = await post(s.cookie, w.req.id as string, { status: "SUSPICIOUS" });
    t.check("no reason → 400", noReason.status === 400, noReason.body);
    const badStatus = await post(s.cookie, w.req.id as string, { status: "BOT", reason: { code: "ABUSE" } });
    t.check("unknown status → 400", badStatus.status === 400, badStatus.body);
    const badCode = await post(s.cookie, w.req.id as string, { status: "SUSPICIOUS", reason: { code: "NOPE" } });
    t.check("unknown reason code → 400", badCode.status === 400, badCode.body);
    const pii = await post(s.cookie, w.req.id as string, { status: "SUSPICIOUS", reason: { code: "ABUSE" }, note: "same as other@example.test" });
    t.check("a review note with an address → 400", pii.status === 400, pii.body);
    const piiReason = await post(s.cookie, w.req.id as string, { status: "SUSPICIOUS", reason: { code: "ABUSE", note: "card 4111111111111111" } });
    t.check("a reason note with a long digit run → 400", piiReason.status === 400, piiReason.body);
    const missing = await post(s.cookie, "does-not-exist", { status: "LEGITIMATE", reason: { code: "OTHER" } });
    t.check("unknown request → 404", missing.status === 404, missing.body);
    t.check("…and nothing was written by any refusal", reviews().length === 0 && audits().length === 0, { reviews: reviews().length, audits: audits().length });
    const h = await get(s.cookie, "does-not-exist");
    t.check("GET history for an unknown request → 404", h.status === 404);
  }

  t.section("3. authorization");
  {
    const w = await world();
    const anon = await post(undefined, w.req.id as string, { status: "LEGITIMATE", reason: { code: "OTHER" } });
    t.check("anonymous POST → 401", anon.status === 401, anon.status);
    const anonGet = await get(undefined, w.req.id as string);
    t.check("anonymous GET → 401", anonGet.status === 401, anonGet.status);
    const su = await signIn(fake, w.user.id as string);
    const u = await post(su.cookie, w.req.id as string, { status: "LEGITIMATE", reason: { code: "OTHER" } });
    t.check("a USER without a GROWTH_REVENUE grant → 403, nothing written", u.status === 403 && reviews().length === 0 && audits().length === 0, u.status);
    const ug = await get(su.cookie, w.req.id as string);
    t.check("…and cannot read the history (403)", ug.status === 403, ug.status);
  }

  t.section("4. the queue GET carries `risk` — and still answers without it");
  {
    const w = await world();
    // The queue's own submission count (groupBy) is outside this suite — answer empty.
    fake.on("BetaAccessRequestEvent", "groupBy", () => []);
    const s = await signIn(fake, w.admin.id as string);
    // Fleet reads unanswered ⇒ the risk read fails ⇒ the queue still answers.
    const plain = await invoke(QUEUE as never, request("/api/platform/growth-revenue/requests", { cookie: s.cookie }));
    const row0 = ((plain.body.pending ?? []) as Record<string, unknown>[])[0];
    t.check("risk read unavailable → 200, rows without `risk`, a note", plain.status === 200 && row0 && !("risk" in row0)
      && Array.isArray(plain.body.riskNotes), plain.body);

    const email = "applicant@example.test";
    const k = createHash("md5").update(email).digest("hex");
    const now = Date.now();
    let sawIp = false;
    // A direct (cold) invitation: an APPROVED row that never came through the public form.
    const direct = fake.seed("BetaAccessRequest", { email: "invited-directly@example.test", status: "APPROVED", invitedAt: new Date(), inviteExpiresAt: new Date(Date.now() + 86_400_000) });
    fake.queryRaw = (sql, values) => {
      const locked = forUpdate(sql, values);
      if (locked !== undefined) return locked;
      if (/"ipAddress"\s*(AS|,|\n\s*FROM)/.test(sql) || /"userAgent"\s*(AS|,|\n\s*FROM)/.test(sql)) sawIp = true;
      if (sql.includes('"BetaAccessRequestEvent"')) return [{ k, at: new Date(now - 60_000), source: null }];
      if (sql.includes('"AuditLog"')) return [{ h: auditEmailHash(email), at: new Date(now - 60_000), net: "salted-digest", ua: "script" }];
      throw new Error("unexpected raw query");
    };
    await post(s.cookie, w.req.id as string, { status: "SUSPICIOUS", reason: { code: "ABUSE" } });
    const q = await invoke(QUEUE as never, request("/api/platform/growth-revenue/requests", { cookie: s.cookie }));
    const row = ((q.body.pending ?? []) as Record<string, unknown>[])[0];
    const risk = row?.risk as { level?: string; reasons?: { code: string }[]; review?: { status?: string; by?: string } } | undefined;
    t.check("pending row carries risk: level + reasons", q.status === 200 && risk?.level === "review"
      && JSON.stringify(risk.reasons?.map((x) => x.code)) === JSON.stringify(["AUTOMATION_UA", "NO_BROWSER_SIGNALS"]), risk);
    t.check("…and the latest operator verdict", risk?.review?.status === "SUSPICIOUS" && risk.review.by === "ops", risk?.review);
    t.check("the raw SQL never selects ipAddress / userAgent as a column", !sawIp);
    const inv = ((q.body.invitations ?? []) as Record<string, unknown>[]).find((r) => r.id === direct.id);
    t.check("a direct invitation (no public-form event, no forensic row) carries NO risk block — not 'insufficient'", !!inv && !("risk" in inv), inv);
    t.check("the risk block carries no digest, hash or user-agent", !JSON.stringify(risk).includes("salted-digest") && !JSON.stringify(risk).includes(auditEmailHash(email)) && !JSON.stringify(risk).includes(k) && !/script"/.test(JSON.stringify(risk)), risk);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
