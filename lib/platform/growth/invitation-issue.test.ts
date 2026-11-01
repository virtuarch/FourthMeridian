/**
 * lib/platform/growth/invitation-issue.test.ts  (PR B)
 *
 * ONE issuance mechanism + the configurable invitation validity, run for real:
 * the route handlers (approve, resend, direct invite, extend, invitation-policy)
 * and the module, against the in-memory Prisma fake. No database, no network,
 * no provider (emails land in the capture adapter).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/growth/invitation-issue.test.ts
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { allowRequestRowLock, seedBetaGroup } from "@/lib/test-support/beta-group";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { capturedEmails } from "@/lib/email/providers/capture";
import { DAY_MS, expiryFor, parseValidityDays, planDirect } from "./invitation-issue.core";

const t = makeChecker("PR B — one beta-invitation issuance mechanism + configurable validity");
const fake = new FakePrisma();
type IdH = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type H = (req: Request) => Promise<Response>;

// Every console line, for the log-hygiene check.
const logged: string[] = [];
for (const k of ["log", "error", "warn", "info", "debug"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => {
    logged.push(a.map((x) => (typeof x === "string" ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(" "));
    orig(...a);
  };
}

const REASON = { code: "TESTING" };
const KEY = "beta_invitation_validity_days";

let admin: { id: string; cookie: string };
async function world() {
  fake.reset();
  freshCache();
  await seedBetaGroup(fake);
  allowRequestRowLock(fake);
  const hash = await bcrypt.hash("pw", 4);
  const a = fake.seed("User", { email: "ops@example.test", username: "ops", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
  const s = await signIn(fake, a.id as string);
  admin = { id: a.id as string, cookie: s.cookie };
}
const row = (where: Record<string, unknown>) => fake.one("BetaAccessRequest", where)!;
const sentTo = (email: string) => capturedEmails().filter((m) => m.to === email);
const audits = (action: string) => fake.rows("AuditLog", { action });
/**
 * Make the next `n` reads of `model.op` wait for each other, so concurrent
 * requests all observe the SAME state before any of them writes — the race the
 * conditional writes exist for, made deterministic.
 */
function barrier(model: string, op: string, n: number) {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => { release = r; });
  fake.on(model, op, async () => {
    if (arrived >= n) return undefined;
    arrived++;
    if (arrived === n) release();
    await all;
    return undefined;
  });
}
const daysOf = (r: Record<string, unknown>) =>
  ((r.inviteExpiresAt as Date).getTime() - (r.invitedAt as Date).getTime()) / DAY_MS;

async function main() {
  await installFakePrisma(fake);
  const { db } = await import("@/lib/db");
  const { POST: APPROVE } = (await import("@/app/api/platform/growth-revenue/requests/[id]/approve/route")) as unknown as { POST: IdH };
  const { POST: RESEND } = (await import("@/app/api/platform/growth-revenue/requests/[id]/resend/route")) as unknown as { POST: IdH };
  const { POST: EXTEND } = (await import("@/app/api/platform/growth-revenue/requests/[id]/extend/route")) as unknown as { POST: IdH };
  const { POST: DIRECT } = (await import("@/app/api/platform/growth-revenue/invitations/route")) as unknown as { POST: H };
  const policyRoute = (await import("@/app/api/platform/growth-revenue/invitation-policy/route")) as unknown as { GET: H; PUT: H; DELETE: H };
  const { issueBetaInvitation } = await import("./invitation-issue");
  const { redeemBetaInvite, InviteNotConsumedError, validateInvite } = await import("@/lib/registration-policy");

  const approve = (id: string, body?: unknown) =>
    invoke(APPROVE as never, request(`/api/platform/growth-revenue/requests/${id}/approve`, { method: "POST", cookie: admin.cookie, body }), { id });
  const resend = (id: string, body?: unknown) =>
    invoke(RESEND as never, request(`/api/platform/growth-revenue/requests/${id}/resend`, { method: "POST", cookie: admin.cookie, body }), { id });
  const extend = (id: string, body: unknown) =>
    invoke(EXTEND as never, request(`/api/platform/growth-revenue/requests/${id}/extend`, { method: "POST", cookie: admin.cookie, body }), { id });
  const direct = (body: unknown) =>
    invoke(DIRECT as never, request("/api/platform/growth-revenue/invitations", { method: "POST", cookie: admin.cookie, body }));
  const getPolicy = (cookie = admin.cookie) =>
    invoke(policyRoute.GET as never, request("/api/platform/growth-revenue/invitation-policy", { cookie }));
  const putPolicy = (body: unknown, cookie = admin.cookie) =>
    invoke(policyRoute.PUT as never, request("/api/platform/growth-revenue/invitation-policy", { method: "PUT", cookie, body }));

  // ── 1. The setting ─────────────────────────────────────────────────────────
  t.section("1. setting: default, bounds, version, audit in the same transaction");
  {
    await world();
    const g = await getPolicy();
    t.check("GET → default 7, bounds 1–30, version null", g.status === 200 && g.body.validityDays === 7 && g.body.min === 1 && g.body.max === 30
      && g.body.default === 7 && g.body.version === null && g.body.origin === "DEFAULT", g.body);

    for (const bad of [0, 31, 2.5, -3, "abc", "", null]) {
      const r = await putPolicy({ validityDays: bad, version: null, reason: REASON });
      t.check(`PUT ${JSON.stringify(bad)} → 400, nothing written`, r.status === 400 && !fake.one("PlatformSetting", { key: KEY }) && audits("BETA_INVITATION_VALIDITY_CHANGED").length === 0, [r.status, r.body]);
    }
    const noReason = await putPolicy({ validityDays: 10, version: null });
    t.check("PUT without a reason → 400, nothing written", noReason.status === 400 && !fake.one("PlatformSetting", { key: KEY }), noReason.body);
    const noVersion = await putPolicy({ validityDays: 10, reason: REASON });
    t.check("PUT without a version → 400", noVersion.status === 400, noVersion.body);

    // An invitation issued BEFORE the change must keep its expiry.
    const existingExpiry = new Date("2026-11-03T09:00:00.000Z");
    fake.seed("BetaAccessRequest", { email: "issued-earlier@example.test", status: "APPROVED", inviteTokenHash: "h-earlier", inviteExpiresAt: existingExpiry, invitedAt: new Date("2026-10-27T09:00:00.000Z") });

    const ok = await putPolicy({ validityDays: 10, version: null, reason: REASON });
    const a1 = audits("BETA_INVITATION_VALIDITY_CHANGED");
    const meta = (a1[0]?.metadata ?? {}) as { change?: { before?: { validityDays?: number }; after?: { validityDays?: number } }; reason?: { code?: string } };
    t.check("PUT 10 (version null) → 200, row '10', model says 10 / CONFIGURED", ok.status === 200 && fake.one("PlatformSetting", { key: KEY })?.value === "10"
      && ok.body.validityDays === 10 && ok.body.origin === "CONFIGURED" && typeof ok.body.version === "string", ok.body);
    t.check("one BETA_INVITATION_VALIDITY_CHANGED row with before 7 → after 10 and the reason",
      a1.length === 1 && meta.change?.before?.validityDays === 7 && meta.change?.after?.validityDays === 10 && meta.reason?.code === "TESTING", a1.map((a) => a.metadata));
    t.check("changing the setting did NOT alter an already-issued invitation",
      (row({ email: "issued-earlier@example.test" }).inviteExpiresAt as Date).getTime() === existingExpiry.getTime() && row({ email: "issued-earlier@example.test" }).inviteTokenHash === "h-earlier");

    const stale = await putPolicy({ validityDays: 12, version: null, reason: REASON });
    t.check("a stale version → 409 with the current model, nothing written", stale.status === 409 && (stale.body.model as { validityDays?: number })?.validityDays === 10
      && fake.one("PlatformSetting", { key: KEY })?.value === "10" && audits("BETA_INVITATION_VALIDITY_CHANGED").length === 1, stale.body);
    const stale2 = await putPolicy({ validityDays: 12, version: "2020-01-01T00:00:00.000Z", reason: REASON });
    t.check("an old timestamp version → 409", stale2.status === 409, stale2.body);

    // Same transaction: the audit write fails ⇒ the setting write is rolled back.
    fake.on("AuditLog", "create", () => { throw new Error("audit store down"); }, { once: true });
    let threw = false;
    try { await putPolicy({ validityDays: 14, version: ok.body.version, reason: REASON }); } catch { threw = true; }
    t.check("audit failure ⇒ the setting change is rolled back (one transaction)", threw && fake.one("PlatformSetting", { key: KEY })?.value === "10", fake.one("PlatformSetting", { key: KEY })?.value);

    const ok2 = await putPolicy({ validityDays: 14, version: ok.body.version, reason: REASON });
    t.check("the current version → 200 (14)", ok2.status === 200 && ok2.body.validityDays === 14, ok2.body);

    // Reset = delete the override, same gate / reason / version / audit.
    const delPolicy = (body: unknown) =>
      invoke(policyRoute.DELETE as never, request("/api/platform/growth-revenue/invitation-policy", { method: "DELETE", cookie: admin.cookie, body }));
    const dNoReason = await delPolicy({ version: ok2.body.version });
    t.check("DELETE without a reason → 400, override kept", dNoReason.status === 400 && fake.one("PlatformSetting", { key: KEY })?.value === "14", dNoReason.body);
    const dStale = await delPolicy({ version: ok.body.version, reason: REASON });
    t.check("DELETE with a stale version → 409, override kept", dStale.status === 409 && fake.one("PlatformSetting", { key: KEY })?.value === "14", dStale.body);
    const auditsBefore = audits("BETA_INVITATION_VALIDITY_CHANGED").length;
    const dOk = await delPolicy({ version: ok2.body.version, reason: REASON });
    const last = audits("BETA_INVITATION_VALIDITY_CHANGED").at(-1)?.metadata as { change?: { before?: { validityDays?: number }; after?: { validityDays?: number; origin?: string } } } | undefined;
    t.check("DELETE (current version) → 200, row gone, model back to DEFAULT 7", dOk.status === 200 && !fake.one("PlatformSetting", { key: KEY })
      && dOk.body.validityDays === 7 && dOk.body.origin === "DEFAULT" && dOk.body.version === null, dOk.body);
    t.check("reset audited in the same write: before 14 → after 7 / DEFAULT", audits("BETA_INVITATION_VALIDITY_CHANGED").length === auditsBefore + 1
      && last?.change?.before?.validityDays === 14 && last?.change?.after?.validityDays === 7 && last?.change?.after?.origin === "DEFAULT", last);
    const dNone = await delPolicy({ version: ok2.body.version, reason: REASON });
    t.check("DELETE when the default is already in force → 409", dNone.status === 409, dNone.body);
    fake.seed("PlatformSetting", { key: KEY, value: "14" });
    const ver = fake.one("PlatformSetting", { key: KEY })!.updatedAt as Date;
    fake.on("AuditLog", "create", () => { throw new Error("audit store down"); }, { once: true });
    let rThrew = false;
    try { await delPolicy({ version: ver.toISOString(), reason: REASON }); } catch { rThrew = true; }
    t.check("reset audit failure ⇒ the override is NOT deleted (one transaction)", rThrew && fake.one("PlatformSetting", { key: KEY })?.value === "14");

    // READ holder can GET but not PUT.
    const reader = fake.seed("User", { email: "reader@example.test", username: "reader", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER", totpEnabled: true, totpSecret: "x" });
    fake.seed("PlatformGrant", { userId: reader.id, area: "GROWTH_REVENUE", level: "READ", status: "ACTIVE" });
    const rs = await signIn(fake, reader.id as string);
    const rg = await getPolicy(rs.cookie);
    const rp = await putPolicy({ validityDays: 3, version: ok2.body.version, reason: REASON }, rs.cookie);
    const rd = await invoke(policyRoute.DELETE as never, request("/api/platform/growth-revenue/invitation-policy", { method: "DELETE", cookie: rs.cookie, body: { version: ver.toISOString(), reason: REASON } }));
    t.check("GROWTH_REVENUE READ → GET 200, PUT 403, DELETE 403", rg.status === 200 && rg.body.validityDays === 14 && rp.status === 403 && rd.status === 403, [rg.status, rp.status, rd.status]);
  }

  // ── 2. Every kind uses the setting; the override is honoured and bounded ───
  t.section("2. every issuance path takes the setting; the override is bounded 1–30");
  {
    await world();
    fake.seed("PlatformSetting", { key: KEY, value: "10" });
    const p = fake.seed("BetaAccessRequest", { email: "p@example.test", status: "PENDING" });
    const a = await approve(p.id as string);
    t.check("approve → 10 days from the setting", a.status === 200 && daysOf(row({ id: p.id })) === 10 && a.body.validityDays === 10, a.body);
    const r = await resend(p.id as string);
    t.check("resend → 10 days from the setting (no longer 14)", r.status === 200 && daysOf(row({ id: p.id })) === 10, r.body);
    const d = await direct({ email: "d@example.test" });
    t.check("direct (no days) → 10 days from the setting", d.status === 200 && daysOf(row({ email: "d@example.test" })) === 10, d.body);
    const auditMeta = (audits("BETA_ACCESS_APPROVED")[0]?.metadata ?? {}) as Record<string, unknown>;
    t.check("issuance audit carries validityDays, expiresAt and emailHash", auditMeta.validityDays === 10 && typeof auditMeta.expiresAt === "string"
      && typeof auditMeta.emailHash === "string" && auditMeta.validitySource === "setting", auditMeta);

    const p2 = fake.seed("BetaAccessRequest", { email: "p2@example.test", status: "PENDING" });
    const a3 = await approve(p2.id as string, { validityDays: 3 });
    t.check("approve override 3 → 3 days", a3.status === 200 && daysOf(row({ id: p2.id })) === 3, a3.body);
    const r30 = await resend(p2.id as string, { validityDays: 30 });
    t.check("resend override 30 → 30 days", r30.status === 200 && daysOf(row({ id: p2.id })) === 30, r30.body);
    const d1 = await direct({ email: "d1@example.test", expiresDays: 1 });
    t.check("direct override 1 → 1 day", d1.status === 200 && daysOf(row({ email: "d1@example.test" })) === 1, d1.body);

    const p3 = fake.seed("BetaAccessRequest", { email: "p3@example.test", status: "PENDING" });
    const before = capturedEmails().length;
    for (const bad of [0, 31, 7.5, "x"]) {
      const ra = await approve(p3.id as string, { validityDays: bad });
      t.check(`approve override ${JSON.stringify(bad)} → 400, row untouched`, ra.status === 400 && ra.body.code === "INVALID_VALIDITY" && row({ id: p3.id }).status === "PENDING", ra.body);
    }
    const rr = await resend(p2.id as string, { validityDays: 45 });
    const dd = await direct({ email: "d45@example.test", expiresDays: 45 });
    t.check("resend / direct override 45 → 400 (refused, never clamped)", rr.status === 400 && dd.status === 400 && !fake.one("BetaAccessRequest", { email: "d45@example.test" }), [rr.body, dd.body]);
    t.check("no email for any refused override", capturedEmails().length === before);
  }

  // ── 3. Double-click / concurrency ──────────────────────────────────────────
  t.section("3. double-click / concurrent: one email and one live token per path");
  {
    await world();
    const p = fake.seed("BetaAccessRequest", { email: "race-approve@example.test", status: "PENDING" });
    barrier("BetaAccessRequest", "findUnique", 2);
    const [a, b] = await Promise.all([approve(p.id as string), approve(p.id as string)]);
    fake.clearHooks();
    t.check("approve ×2 concurrently → one issued, one alreadyApproved", [a.body.alreadyApproved, b.body.alreadyApproved].filter(Boolean).length === 1 && a.status === 200 && b.status === 200, [a.body, b.body]);
    t.check("approve ×2 → exactly one email, one audit", sentTo("race-approve@example.test").length === 1 && audits("BETA_ACCESS_APPROVED").length === 1);

    const hash0 = row({ id: p.id }).inviteTokenHash;
    barrier("BetaAccessRequest", "findUnique", 2);
    const [r1, r2] = await Promise.all([resend(p.id as string), resend(p.id as string)]);
    fake.clearHooks();
    const hash1 = row({ id: p.id }).inviteTokenHash;
    t.check("resend ×2 concurrently → one reissued, one alreadyReissued", [r1.body.alreadyReissued, r2.body.alreadyReissued].filter(Boolean).length === 1, [r1.body, r2.body]);
    t.check("resend ×2 → exactly one new email, token rotated once", sentTo("race-approve@example.test").length === 2 && hash1 !== hash0 && audits("BETA_INVITATION_RESENT").length === 1);
    const lastLink = sentTo("race-approve@example.test").at(-1)!.text.match(/invite=([0-9a-f]{64})/)![1];
    const { hashResetToken } = await import("@/lib/password-reset-token");
    t.check("the one live token is the one in the last email", hashResetToken(lastLink) === hash1);

    // A SEQUENTIAL double-click: both requests carry the invitedAt the screen showed.
    const shown = (row({ id: p.id }).invitedAt as Date).toISOString();
    const s1 = await resend(p.id as string, { expectedInvitedAt: shown });
    const s2 = await resend(p.id as string, { expectedInvitedAt: shown });
    t.check("sequential double-click (same expectedInvitedAt) → one reissue, then alreadyReissued, one email",
      s1.status === 200 && s1.body.performed === "reissue" && s2.status === 200 && s2.body.alreadyReissued === true
      && sentTo("race-approve@example.test").length === 3 && audits("BETA_INVITATION_RESENT").length === 2, [s1.body, s2.body]);

    // Deterministic guard: a concurrent winner rotates the hash between our read and our write.
    fake.on("BetaAccessRequest", "updateMany", () => { row({ id: p.id }).inviteTokenHash = "someone-elses-hash"; return undefined; }, { once: true });
    const lost = await resend(p.id as string);
    t.check("reissue whose observed hash moved → alreadyReissued, nothing sent, nothing audited",
      lost.status === 200 && lost.body.alreadyReissued === true && sentTo("race-approve@example.test").length === 3
      && row({ id: p.id }).inviteTokenHash === "someone-elses-hash" && audits("BETA_INVITATION_RESENT").length === 2, lost.body);

    // A resend racing a revoke: the row turns DENIED with a null hash in between.
    fake.on("BetaAccessRequest", "updateMany", () => { const r = row({ id: p.id }); r.status = "DENIED"; r.inviteTokenHash = null; return undefined; }, { once: true });
    const vsRevoke = await resend(p.id as string);
    t.check("reissue racing a revoke → 409, no token written onto the DENIED row, no email",
      vsRevoke.status === 409 && row({ id: p.id }).inviteTokenHash === null && sentTo("race-approve@example.test").length === 3, vsRevoke.body);

    barrier("BetaAccessRequest", "findUnique", 2);
    const [d1, d2] = await Promise.all([direct({ email: "race-direct@example.test" }), direct({ email: "race-direct@example.test" })]);
    fake.clearHooks();
    t.check("direct ×2 concurrently → one 200, one 409 LIVE_INVITE", [d1.status, d2.status].sort().join(",") === "200,409"
      && [d1.body.code, d2.body.code].includes("LIVE_INVITE"), [d1.body, d2.body]);
    t.check("direct ×2 → one row, one email, one audit", fake.rows("BetaAccessRequest", { email: "race-direct@example.test" }).length === 1
      && sentTo("race-direct@example.test").length === 1 && audits("BETA_INVITATION_CREATED").length === 1);

    // Read PENDING → a concurrent deny/revoke lands → the stale approve must lose.
    const denyBetween = (id: unknown) => fake.on("BetaAccessRequest", "updateMany", () => {
      const r = row({ id }); r.status = "DENIED"; r.inviteTokenHash = null; r.inviteExpiresAt = null; return undefined;
    }, { once: true });
    const sp = fake.seed("BetaAccessRequest", { email: "stale-approve@example.test", status: "PENDING" });
    denyBetween(sp.id);
    const sa = await approve(sp.id as string);
    t.check("approve that read PENDING, then a deny landed → 409 CONFLICT, still DENIED, no token, no email, no audit",
      sa.status === 409 && sa.body.code === "CONFLICT" && row({ id: sp.id }).status === "DENIED" && row({ id: sp.id }).inviteTokenHash === null
      && sentTo("stale-approve@example.test").length === 0
      && !audits("BETA_ACCESS_APPROVED").some((a) => (a.metadata as { betaRequestId?: string }).betaRequestId === sp.id), sa.body);
    const sd = fake.seed("BetaAccessRequest", { email: "stale-direct@example.test", status: "PENDING" });
    denyBetween(sd.id);
    const sdr = await direct({ email: "stale-direct@example.test" });
    t.check("direct that read PENDING, then a deny landed → 409 CONFLICT, still DENIED, no email (direct never overturns DENIED)",
      sdr.status === 409 && sdr.body.code === "CONFLICT" && row({ id: sd.id }).status === "DENIED" && row({ id: sd.id }).inviteTokenHash === null
      && sentTo("stale-direct@example.test").length === 0, sdr.body);
    const dn = fake.seed("BetaAccessRequest", { email: "read-denied@example.test", status: "DENIED" });
    const dnr = await approve(dn.id as string);
    const dnAudit = audits("BETA_ACCESS_APPROVED").find((a) => (a.metadata as { betaRequestId?: string }).betaRequestId === dn.id);
    t.check("approving a row READ as DENIED is still allowed, and its audit says before = DENIED",
      dnr.status === 200 && row({ id: dn.id }).status === "APPROVED" && (dnAudit?.metadata as { change?: { before?: { status?: string } } })?.change?.before?.status === "DENIED", dnr.body);

    // Resend vs a concurrent extend (same token, expiry moved): the resend loses.
    const rx = fake.seed("BetaAccessRequest", { email: "resend-vs-extend@example.test", status: "APPROVED", inviteTokenHash: "h-rx", inviteExpiresAt: new Date(Date.now() + DAY_MS), invitedAt: new Date() });
    const extended = new Date(Date.now() + 9 * DAY_MS);
    fake.on("BetaAccessRequest", "updateMany", () => { row({ id: rx.id }).inviteExpiresAt = extended; return undefined; }, { once: true });
    const rxr = await resend(rx.id as string);
    t.check("resend racing an extend → 409 CONFLICT, the extend stands (token + expiry), no email",
      rxr.status === 409 && rxr.body.code === "CONFLICT" && row({ id: rx.id }).inviteTokenHash === "h-rx"
      && (row({ id: rx.id }).inviteExpiresAt as Date).getTime() === extended.getTime() && sentTo("resend-vs-extend@example.test").length === 0, rxr.body);
  }

  // ── 4. Direct-invite rules ─────────────────────────────────────────────────
  t.section("4. direct invite: no silent status flips");
  {
    await world();
    const mk = (email: string, data: Record<string, unknown>) => fake.seed("BetaAccessRequest", { email, ...data });
    mk("denied@example.test", { status: "DENIED" });
    mk("redeemed@example.test", { status: "REDEEMED" });
    mk("live@example.test", { status: "APPROVED", inviteTokenHash: "h-live", inviteExpiresAt: new Date(Date.now() + 3 * DAY_MS), invitedAt: new Date() });
    mk("expired@example.test", { status: "APPROVED", inviteTokenHash: "h-old", inviteExpiresAt: new Date(Date.now() - DAY_MS), invitedAt: new Date(Date.now() - 8 * DAY_MS) });
    mk("pending@example.test", { status: "PENDING" });
    fake.seed("User", { email: "member@example.test", username: "member", passwordHash: "x", emailVerifiedAt: new Date() });

    for (const [email, code, status] of [
      ["denied@example.test", "DENIED", "DENIED"],
      ["redeemed@example.test", "REDEEMED", "REDEEMED"],
      ["live@example.test", "LIVE_INVITE", "APPROVED"],
    ] as const) {
      const r = await direct({ email });
      t.check(`${status} → 409 ${code}, row untouched, no email`, r.status === 409 && r.body.code === code && row({ email }).status === status && sentTo(email).length === 0, r.body);
    }
    t.check("the live invite kept its token", row({ email: "live@example.test" }).inviteTokenHash === "h-live");
    const m = await direct({ email: "member@example.test" });
    t.check("an address with an account → 409 ACCOUNT_EXISTS, no row, no email", m.status === 409 && m.body.code === "ACCOUNT_EXISTS"
      && !fake.one("BetaAccessRequest", { email: "member@example.test" }) && sentTo("member@example.test").length === 0, m.body);
    const pen = await direct({ email: "PENDING@example.test " });
    t.check("PENDING via direct → approved through the approve path (BETA_ACCESS_APPROVED, request copy)",
      pen.status === 200 && pen.body.performed === "approve" && row({ email: "pending@example.test" }).status === "APPROVED"
      && audits("BETA_ACCESS_APPROVED").length === 1 && sentTo("pending@example.test")[0]?.subject === "Your Fourth Meridian beta access is approved", pen.body);
    const exp = await direct({ email: "expired@example.test" });
    t.check("APPROVED but expired → reissue semantics (new token, BETA_INVITATION_RESENT)",
      exp.status === 200 && exp.body.performed === "reissue" && row({ email: "expired@example.test" }).inviteTokenHash !== "h-old"
      && audits("BETA_INVITATION_RESENT").length === 1 && sentTo("expired@example.test").length === 1, exp.body);
    const bad = await direct({ email: "not-an-email" });
    t.check("invalid email → 400", bad.status === 400 && bad.body.code === "INVALID_EMAIL", bad.body);
    t.check("pure rule: planDirect never flips DENIED/REDEEMED", planDirect({ id: "x", email: "e", status: "DENIED", inviteTokenHash: null, inviteExpiresAt: null }, false, new Date()).action === "refuse"
      && planDirect({ id: "x", email: "e", status: "REDEEMED", inviteTokenHash: null, inviteExpiresAt: null }, false, new Date()).action === "refuse");

    // Approve also refuses an existing account (E-6).
    const q = mk("member2@example.test", { status: "PENDING" });
    fake.seed("User", { email: "member2@example.test", username: "member2", passwordHash: "x", emailVerifiedAt: new Date() });
    const ap = await approve(q.id as string);
    t.check("approve for an address with an account → 409 ACCOUNT_EXISTS, still PENDING, no email",
      ap.status === 409 && ap.body.code === "ACCOUNT_EXISTS" && row({ id: q.id }).status === "PENDING" && sentTo("member2@example.test").length === 0, ap.body);

    // Atomicity of issuance: the audit write fails ⇒ no state change, no email.
    const z = mk("atomic@example.test", { status: "PENDING" });
    fake.on("AuditLog", "create", () => { throw new Error("audit store down"); }, { once: true });
    let threw = false;
    try { await approve(z.id as string); } catch { threw = true; }
    t.check("issuance audit failure ⇒ row stays PENDING with no token, and no email", threw && row({ id: z.id }).status === "PENDING"
      && row({ id: z.id }).inviteTokenHash == null && sentTo("atomic@example.test").length === 0);
  }

  // ── 5. Extend ──────────────────────────────────────────────────────────────
  t.section("5. extend: keeps the token, audited, APPROVED only");
  {
    await world();
    const oldExp = new Date(Date.now() + DAY_MS);
    const r = fake.seed("BetaAccessRequest", { email: "ext@example.test", status: "APPROVED", inviteTokenHash: "h-keep", inviteExpiresAt: oldExp, invitedAt: new Date(Date.now() - 6 * DAY_MS) });
    const noReason = await extend(r.id as string, { validityDays: 5 });
    t.check("no reason → 400, unchanged", noReason.status === 400 && (row({ id: r.id }).inviteExpiresAt as Date).getTime() === oldExp.getTime(), noReason.body);
    const bad = await extend(r.id as string, { validityDays: 31, reason: REASON });
    t.check("31 days → 400", bad.status === 400 && bad.body.code === "INVALID_VALIDITY", bad.body);
    const t0 = Date.now();
    const ok = await extend(r.id as string, { validityDays: 5, reason: REASON });
    const after = row({ id: r.id });
    const ext = audits("BETA_INVITATION_EXTENDED");
    const em = (ext[0]?.metadata ?? {}) as { change?: { before?: { inviteExpiresAt?: string }; after?: { inviteExpiresAt?: string } }; reason?: { code?: string } };
    const got = (after.inviteExpiresAt as Date).getTime();
    t.check("extend 5 → 200, expiry ≈ now + 5 d", ok.status === 200 && got >= t0 + 5 * DAY_MS && got <= Date.now() + 5 * DAY_MS, ok.body);
    t.check("the token is KEPT and no email is sent", after.inviteTokenHash === "h-keep" && sentTo("ext@example.test").length === 0);
    t.check("BETA_INVITATION_EXTENDED with before/after expiry and the reason", ext.length === 1 && em.change?.before?.inviteExpiresAt === oldExp.toISOString()
      && em.change?.after?.inviteExpiresAt === new Date(got).toISOString() && em.reason?.code === "TESTING", ext.map((a) => a.metadata));

    for (const status of ["PENDING", "DENIED", "REDEEMED"]) {
      const x = fake.seed("BetaAccessRequest", { email: `ext-${status.toLowerCase()}@example.test`, status });
      const rr = await extend(x.id as string, { validityDays: 5, reason: REASON });
      t.check(`${status} → 409 NOT_APPROVED, untouched`, rr.status === 409 && rr.body.code === "NOT_APPROVED" && row({ id: x.id }).inviteExpiresAt == null, rr.body);
    }
    // Extend never shortens; an expired invite may be revived; an account blocks it.
    const longer = fake.seed("BetaAccessRequest", { email: "ext-long@example.test", status: "APPROVED", inviteTokenHash: "h-long", inviteExpiresAt: new Date(Date.now() + 10 * DAY_MS), invitedAt: new Date() });
    const sh = await extend(longer.id as string, { validityDays: 5, reason: REASON });
    t.check("extend to an EARLIER expiry → 409 WOULD_SHORTEN (use revoke), untouched, not audited",
      sh.status === 409 && sh.body.code === "WOULD_SHORTEN" && /revoke/i.test(String(sh.body.error))
      && row({ id: longer.id }).inviteTokenHash === "h-long" && audits("BETA_INVITATION_EXTENDED").length === 1, sh.body);
    const dead = fake.seed("BetaAccessRequest", { email: "ext-dead@example.test", status: "APPROVED", inviteTokenHash: "h-dead", inviteExpiresAt: new Date(Date.now() - 2 * DAY_MS), invitedAt: new Date(Date.now() - 9 * DAY_MS) });
    const rev = await extend(dead.id as string, { validityDays: 3, reason: REASON });
    t.check("extend an EXPIRED invite → 200 revived (same token, expiry in the future)", rev.status === 200 && row({ id: dead.id }).inviteTokenHash === "h-dead"
      && (row({ id: dead.id }).inviteExpiresAt as Date).getTime() > Date.now(), rev.body);
    const acct = fake.seed("BetaAccessRequest", { email: "ext-member@example.test", status: "APPROVED", inviteTokenHash: "h-m", inviteExpiresAt: new Date(Date.now() + DAY_MS), invitedAt: new Date() });
    fake.seed("User", { email: "ext-member@example.test", username: "extmember", passwordHash: "x", emailVerifiedAt: new Date() });
    const am = await extend(acct.id as string, { validityDays: 5, reason: REASON });
    t.check("extend for an address that already has an account → 409 ACCOUNT_EXISTS, untouched", am.status === 409 && am.body.code === "ACCOUNT_EXISTS"
      && (row({ id: acct.id }).inviteExpiresAt as Date).getTime() < Date.now() + 2 * DAY_MS, am.body);

    // A concurrent resend between the read and the write.
    fake.on("BetaAccessRequest", "updateMany", () => { row({ id: r.id }).inviteTokenHash = "rotated"; return undefined; }, { once: true });
    const raced = await extend(r.id as string, { validityDays: 9, reason: REASON });
    t.check("token rotated in between → 409 CONFLICT, nothing written or audited", raced.status === 409 && raced.body.code === "CONFLICT"
      && (row({ id: r.id }).inviteExpiresAt as Date).getTime() === got && audits("BETA_INVITATION_EXTENDED").length === 2, raced.body);
  }

  // ── 6. Redemption enforces expiry in the WRITE ─────────────────────────────
  t.section("6. redemption: expiry enforced by validateInvite; single use enforced by the write");
  {
    // The consuming write itself keeps its status-only predicate: fm_auth (the
    // role redemption runs as under strict RLS) may read only ("id","status") —
    // migration 20261002000600 — so an expiry or token-hash predicate there would
    // be "permission denied". Expiry is enforced by validateInvite, before it.
    await world();
    const { hashResetToken } = await import("@/lib/password-reset-token");
    fake.seed("BetaAccessRequest", { email: "late@example.test", status: "APPROVED", inviteTokenHash: hashResetToken("late-token"), inviteExpiresAt: new Date(Date.now() - 1000) });
    const v = await validateInvite("late-token");
    t.check("an expired token is rejected by validateInvite (the register gate)", v.valid === false && v.email === null);
    const live = fake.seed("BetaAccessRequest", { email: "ontime@example.test", status: "APPROVED", inviteTokenHash: hashResetToken("live-token"), inviteExpiresAt: new Date(Date.now() + DAY_MS) });
    const lv = await validateInvite("live-token");
    t.check("a live token validates and binds its email", lv.valid && lv.email === "ontime@example.test" && lv.requestId === live.id);
    await redeemBetaInvite(db as never, { requestId: live.id as string, redeemedUserId: "u2" });
    t.check("a live invite is consumed once (REDEEMED, hash nulled)", row({ id: live.id }).status === "REDEEMED" && row({ id: live.id }).inviteTokenHash === null);
    let again: unknown = null;
    try { await redeemBetaInvite(db as never, { requestId: live.id as string, redeemedUserId: "u3" }); } catch (e) { again = e; }
    t.check("a second redemption is refused (single use)", again instanceof InviteNotConsumedError);
    t.check("the redeemed token no longer validates", (await validateInvite("live-token")).valid === false);
  }

  // ── 7. UTC arithmetic ──────────────────────────────────────────────────────
  t.section("7. time zones: expiry is UTC epoch arithmetic");
  {
    await world();
    const prevTz = process.env.TZ;
    process.env.TZ = "America/New_York"; // the US DST change is 2026-03-08
    const now = new Date("2026-03-07T12:00:00.000Z");
    const p = fake.seed("BetaAccessRequest", { email: "dst@example.test", status: "PENDING" });
    const r = await issueBetaInvitation({ client: db, actor: { userId: admin.id, via: "SYSTEM_ADMIN", area: "GROWTH_REVENUE" }, kind: "approve", requestId: p.id as string, now });
    const x = row({ id: p.id });
    t.check("7 days across a DST change = exactly 7 × 24 h, as an ISO instant", r.ok && (x.inviteExpiresAt as Date).toISOString() === "2026-03-14T12:00:00.000Z"
      && (x.invitedAt as Date).getTime() === now.getTime(), (x.inviteExpiresAt as Date)?.toISOString());
    t.check("issuedAt is read once (invitedAt = decidedAt = the email's issuedAt)", (x.decidedAt as Date).getTime() === now.getTime()
      && sentTo("dst@example.test")[0]?.text.includes("It expires on Saturday, March 14, 2026 at 12:00 PM UTC."), sentTo("dst@example.test")[0]?.text);
    t.check("expiryFor is pure millisecond arithmetic", expiryFor(new Date("2026-10-31T23:30:00.000Z"), 1).toISOString() === "2026-11-01T23:30:00.000Z");
    t.check("parseValidityDays refuses fractions and junk, accepts digit strings", !parseValidityDays(1.5).ok && !parseValidityDays("1e1").ok && !parseValidityDays(true).ok
      && parseValidityDays(" 12 ").ok && !parseValidityDays(0).ok && !parseValidityDays(31).ok);
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }

  // ── 8. Email outcome + log hygiene ─────────────────────────────────────────
  t.section("8. email outcome recorded after commit; no raw token anywhere");
  {
    await world();
    const p = fake.seed("BetaAccessRequest", { email: "outcome@example.test", status: "PENDING" });
    await approve(p.id as string);
    const issuedRow = audits("BETA_ACCESS_APPROVED")[0];
    const outcome = audits("BETA_INVITATION_EMAIL_OUTCOME")[0];
    const om = (outcome?.metadata ?? {}) as { betaRequestId?: string; emailStatus?: string };
    t.check("the hand-off outcome is appended (betaRequestId + emailStatus), after the issuance row",
      !!outcome && om.betaRequestId === p.id && om.emailStatus === "captured" && (outcome.createdAt as Date) >= (issuedRow.createdAt as Date), om);
    const { GET: LIST } = (await import("@/app/api/platform/growth-revenue/requests/route")) as unknown as { GET: H };
    const list = await invoke(LIST as never, request("/api/platform/growth-revenue/requests", { cookie: admin.cookie }));
    const inv = (list.body.invitations as Array<{ id: string; inviteEmail: { status: string | null } }>).find((i) => i.id === p.id);
    t.check("Growth's invitation list still shows the email status", inv?.inviteEmail.status === "captured", inv);

    const tokens = capturedEmails().map((m) => m.text.match(/invite=([0-9a-f]{64})/)?.[1]).filter(Boolean) as string[];
    const auditBlob = JSON.stringify(fake.rows("AuditLog"));
    t.check("tokens were issued in this run (the check is live)", tokens.length >= 1, tokens.length);
    t.check("no audit row carries a raw token, an invite link or an invitee address",
      !tokens.some((tk) => auditBlob.includes(tk)) && !auditBlob.includes("/register?invite=") && !auditBlob.includes("outcome@example.test"));
  }
  {
    // Across EVERY email this file captured (sections 2–8).
    const all = capturedEmails().filter((m) => /invite=[0-9a-f]{64}/.test(m.text));
    const tokens = all.map((m) => m.text.match(/invite=([0-9a-f]{64})/)![1]);
    const leaks = logged.filter((l) => tokens.some((tk) => l.includes(tk)) || l.includes("/register?invite="));
    t.check(`no console line carries a token or invite link (${tokens.length} tokens checked)`, tokens.length >= 10 && leaks.length === 0, leaks.slice(0, 3));
  }

  // ── PR C — the optional expectedStatus guard (approve) ────────────────────
  t.section("PR C. approve expectedStatus: a DENIED row is refused STATUS_CHANGED; without it, unchanged");
  {
    await world();
    const actor = { userId: admin.id, via: "SYSTEM_ADMIN" as const, area: "GROWTH_REVENUE" };
    const d = fake.seed("BetaAccessRequest", { email: "denied-guard@example.test", status: "DENIED" });
    const guarded = await issueBetaInvitation({ client: db, actor, kind: "approve", requestId: d.id as string, expectedStatus: "PENDING" });
    t.check("expectedStatus PENDING on a DENIED row → refused STATUS_CHANGED (409)", !guarded.ok && guarded.code === "STATUS_CHANGED" && guarded.status === 409, guarded);
    t.check("…nothing minted, nothing sent, nothing audited", row({ id: d.id }).status === "DENIED" && row({ id: d.id }).inviteTokenHash == null
      && sentTo("denied-guard@example.test").length === 0 && audits("BETA_ACCESS_APPROVED").length === 0);
    const p = fake.seed("BetaAccessRequest", { email: "pending-guard@example.test", status: "PENDING" });
    const okGuarded = await issueBetaInvitation({ client: db, actor, kind: "approve", requestId: p.id as string, expectedStatus: "PENDING" });
    t.check("expectedStatus PENDING on a PENDING row → issued as normal", okGuarded.ok && okGuarded.outcome === "issued" && sentTo("pending-guard@example.test").length === 1, okGuarded);
    const unguarded = await issueBetaInvitation({ client: db, actor, kind: "approve", requestId: d.id as string });
    t.check("WITHOUT expectedStatus a DENIED approve behaves as before (issued, audit before = DENIED)",
      unguarded.ok && unguarded.outcome === "issued" && row({ id: d.id }).status === "APPROVED" && sentTo("denied-guard@example.test").length === 1
      && ((audits("BETA_ACCESS_APPROVED").find((a) => (a.metadata as { target?: { id?: string } }).target?.id === d.id)?.metadata as { change?: { before?: { status?: string } } })?.change?.before?.status) === "DENIED", unguarded);
  }

  t.section("BETA_NOT_ACCEPTING. issuance and extend refuse unless the Beta group reads ACTIVE");
  {
    const C = await import("@/lib/platform/policies/policy-group-catalogue");
    const setLifecycle = (lifecycle: string) => {
      Object.assign(fake.rows("PolicyGroup", {})[0], { lifecycle, endedTransition: lifecycle === "ENDED" ? "READ_ONLY" : null });
      C.invalidatePolicyGroupCatalogue();
    };
    const untouched = (id: unknown, status: string) => row({ id }).status === status && row({ id }).inviteTokenHash == null;
    for (const lifecycle of ["PAUSED", "ENDED"]) {
      await world();
      setLifecycle(lifecycle);
      const p = fake.seed("BetaAccessRequest", { email: `p-${lifecycle}@example.test`, status: "PENDING" });
      const a = await approve(p.id as string);
      t.check(`${lifecycle}: approve → 409 BETA_NOT_ACCEPTING, nothing minted`, a.status === 409 && a.body.code === "BETA_NOT_ACCEPTING" && untouched(p.id, "PENDING"), a.body);
      const d = await direct({ email: `d-${lifecycle}@example.test` });
      t.check(`${lifecycle}: direct → 409, no row created`, d.status === 409 && d.body.code === "BETA_NOT_ACCEPTING" && !fake.one("BetaAccessRequest", { email: `d-${lifecycle}@example.test` }), d.body);
      const live = fake.seed("BetaAccessRequest", { email: `r-${lifecycle}@example.test`, status: "APPROVED", inviteTokenHash: "h-old", inviteExpiresAt: new Date(Date.now() + DAY_MS), invitedAt: new Date() });
      const r = await resend(live.id as string);
      t.check(`${lifecycle}: resend → 409, token NOT rotated`, r.status === 409 && r.body.code === "BETA_NOT_ACCEPTING" && row({ id: live.id }).inviteTokenHash === "h-old", r.body);
      const e = await extend(live.id as string, { validityDays: 5, reason: REASON });
      t.check(`${lifecycle}: extend → 409, expiry unchanged`, e.status === 409 && e.body.code === "BETA_NOT_ACCEPTING"
        && (row({ id: live.id }).inviteExpiresAt as Date).getTime() === (live.inviteExpiresAt as Date).getTime(), e.body);
      t.check(`${lifecycle}: no email, no issuance or extension audit`, ["p", "d", "r"].every((k) => capturedEmails().filter((m) => m.to.toLowerCase() === `${k}-${lifecycle}@example.test`.toLowerCase()).length === 0)
        && audits("BETA_ACCESS_APPROVED").length === 0 && audits("BETA_INVITATION_CREATED").length === 0
        && audits("BETA_INVITATION_RESENT").length === 0 && audits("BETA_INVITATION_EXTENDED").length === 0);
    }

    // No Beta row at all ⇒ UNKNOWN ⇒ closed.
    fake.reset();
    freshCache();
    C.invalidatePolicyGroupCatalogue();
    {
      const hash = await bcrypt.hash("pw", 4);
      const a = fake.seed("User", { email: "ops2@example.test", username: "ops2", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
      admin = { id: a.id as string, cookie: (await signIn(fake, a.id as string)).cookie };
    }
    const u = fake.seed("BetaAccessRequest", { email: "unknown@example.test", status: "PENDING" });
    const ua = await approve(u.id as string);
    t.check("no Beta group (UNKNOWN) → approve 409 BETA_NOT_ACCEPTING, no email, no audit", ua.status === 409 && ua.body.code === "BETA_NOT_ACCEPTING" && untouched(u.id, "PENDING")
      && sentTo("unknown@example.test").length === 0 && audits("BETA_ACCESS_APPROVED").length === 0, ua.body);

    // A DB catalogue with OTHER groups but no Beta row ⇒ UNKNOWN ⇒ closed.
    fake.seed("PolicyGroup", { key: "SOME_OTHER_GROUP", label: "Other", description: "", isDefault: false, builtIn: false, currentVersion: 1, lifecycle: "ACTIVE", costFrozen: false, endedTransition: null });
    fake.seed("PolicyGroupVersion", { groupKey: "SOME_OTHER_GROUP", version: 1, values: {}, label: "Other", changeSummary: { kind: "SEEDED", changes: [] }, reasonCode: "POLICY_ROLLOUT" });
    C.invalidatePolicyGroupCatalogue();
    const ob = await approve(u.id as string);
    t.check("other DB groups but no Beta row → approve 409 BETA_NOT_ACCEPTING, no email, no audit", ob.status === 409 && ob.body.code === "BETA_NOT_ACCEPTING"
      && untouched(u.id, "PENDING") && sentTo("unknown@example.test").length === 0 && audits("BETA_ACCESS_APPROVED").length === 0, ob.body);

    // The seam: UNKNOWN and a throwing read are closed; ACTIVE issues.
    await world();
    const actor = { userId: admin.id, via: "SYSTEM_ADMIN" as const, area: "GROWTH_REVENUE" };
    const s1 = fake.seed("BetaAccessRequest", { email: "seam@example.test", status: "PENDING" });
    const unk = await issueBetaInvitation({ client: db, actor, kind: "approve", requestId: s1.id as string, betaLifecycle: async () => "UNKNOWN" });
    t.check("seam UNKNOWN → refused BETA_NOT_ACCEPTING (409)", !unk.ok && unk.code === "BETA_NOT_ACCEPTING" && unk.status === 409 && untouched(s1.id, "PENDING"), unk);
    const thr = await issueBetaInvitation({ client: db, actor, kind: "approve", requestId: s1.id as string, betaLifecycle: async () => { throw new Error("db down"); } });
    t.check("seam throws → refused (fail closed)", !thr.ok && thr.code === "BETA_NOT_ACCEPTING" && untouched(s1.id, "PENDING"), thr);
    const ok = await issueBetaInvitation({ client: db, actor, kind: "approve", requestId: s1.id as string, betaLifecycle: async () => "ACTIVE" });
    t.check("seam ACTIVE → issued", ok.ok && ok.outcome === "issued" && row({ id: s1.id }).status === "APPROVED", ok);
    const again = await issueBetaInvitation({ client: db, actor, kind: "approve", requestId: s1.id as string, betaLifecycle: async () => "PAUSED" });
    t.check("PAUSED but already APPROVED → alreadyApproved (idempotent, nothing minted, not gated)", again.ok && again.outcome === "alreadyApproved", again);
  }

  t.section("SUSPECTED-ABUSE LOCK. a DENIED request whose latest verdict is SUSPICIOUS cannot be revived by any path");
  {
    const verdict = (requestId: unknown, status: string, at: Date) =>
      fake.seed("BetaAccessRequestReview", { requestId, status, reasonCode: "TESTING", createdAt: at });
    const t0 = Date.now();
    await world();
    const actor = { userId: admin.id, via: "SYSTEM_ADMIN" as const, area: "GROWTH_REVENUE" };

    // 1. Locked: DENIED + latest SUSPICIOUS.
    const locked = fake.seed("BetaAccessRequest", { email: "lock@example.test", status: "DENIED" });
    verdict(locked.id, "SUSPICIOUS", new Date(t0 - 60_000));
    const ap = await approve(locked.id as string);
    t.check("single approve → 409 SUSPECTED_ABUSE", ap.status === 409 && ap.body.code === "SUSPECTED_ABUSE", ap.body);
    const dr = await direct({ email: "lock@example.test" });
    t.check("direct invite to the same address → 409 SUSPECTED_ABUSE", dr.status === 409 && dr.body.code === "SUSPECTED_ABUSE", dr.body);
    const rs = await resend(locked.id as string);
    t.check("resend → refused (not approved), nothing rotated", rs.status === 409 && rs.body.code === "NOT_APPROVED", rs.body);
    const ex = await extend(locked.id as string, { validityDays: 5, reason: REASON });
    t.check("extend → refused (not approved)", ex.status === 409 && ex.body.code === "NOT_APPROVED", ex.body);
    const viaFn = await issueBetaInvitation({ client: db, actor, kind: "approve", requestId: locked.id as string });
    t.check("issueBetaInvitation approve (no expectedStatus) → SUSPECTED_ABUSE", !viaFn.ok && viaFn.code === "SUSPECTED_ABUSE", viaFn);
    t.check("…the row is still DENIED with no token; no email; no approval or creation audit",
      row({ id: locked.id }).status === "DENIED" && row({ id: locked.id }).inviteTokenHash == null
      && sentTo("lock@example.test").length === 0 && audits("BETA_ACCESS_APPROVED").length === 0 && audits("BETA_INVITATION_CREATED").length === 0);

    // 2. An OLDER suspicious verdict superseded by a newer clearing verdict ⇒ unlocked (the deliberate clear).
    for (const clear of ["LEGITIMATE", "UNREVIEWED"]) {
      const r = fake.seed("BetaAccessRequest", { email: `cleared-${clear.toLowerCase()}@example.test`, status: "DENIED" });
      verdict(r.id, "SUSPICIOUS", new Date(t0 - 120_000));
      verdict(r.id, clear, new Date(t0 - 60_000));
      const ok = await approve(r.id as string);
      t.check(`SUSPICIOUS then ${clear} (newer) → the lock is cleared: approve 200, invitation sent`,
        ok.status === 200 && row({ id: r.id }).status === "APPROVED" && sentTo(`cleared-${clear.toLowerCase()}@example.test`).length === 1, ok.body);
    }

    // 3. A clearing verdict OLDER than a later SUSPICIOUS one does not clear it.
    const relock = fake.seed("BetaAccessRequest", { email: "relock@example.test", status: "DENIED" });
    verdict(relock.id, "LEGITIMATE", new Date(t0 - 120_000));
    verdict(relock.id, "SUSPICIOUS", new Date(t0 - 60_000));
    const rl = await approve(relock.id as string);
    t.check("LEGITIMATE then SUSPICIOUS (newer) → still locked", rl.status === 409 && rl.body.code === "SUSPECTED_ABUSE" && row({ id: relock.id }).status === "DENIED", rl.body);

    // 4. Scope: the lock is for REJECTED requests. A plain DENIED (no verdict) behaves as before.
    const plain = fake.seed("BetaAccessRequest", { email: "plain-denied@example.test", status: "DENIED" });
    const pd = await approve(plain.id as string);
    t.check("DENIED with no verdict → single approve still reverses the denial (unchanged)", pd.status === 200 && row({ id: plain.id }).status === "APPROVED", pd.body);

    // 5. A verdict recorded AFTER the plan's read is caught by the in-transaction re-read.
    const racy = fake.seed("BetaAccessRequest", { email: "racy@example.test", status: "DENIED" });
    let reads = 0;
    fake.on("BetaAccessRequestReview", "findFirst", () => (++reads === 1 ? null : { status: "SUSPICIOUS" }));
    const rc = await approve(racy.id as string);
    fake.clearHooks();
    t.check("SUSPICIOUS recorded between the plan and the write → 409 SUSPECTED_ABUSE, nothing written",
      rc.status === 409 && rc.body.code === "SUSPECTED_ABUSE" && row({ id: racy.id }).status === "DENIED" && sentTo("racy@example.test").length === 0, rc.body);

    // 5b. The request row is locked (FOR UPDATE) before the in-transaction verdict re-read.
    const lockedSql: string[] = [];
    const prevRaw = fake.queryRaw;
    fake.queryRaw = (sql: string, values: unknown[]) => { lockedSql.push(sql); return prevRaw!(sql, values); };
    const lk = fake.seed("BetaAccessRequest", { email: "rowlock@example.test", status: "DENIED" });
    verdict(lk.id, "SUSPICIOUS", new Date(t0 - 60_000));
    // The plan's read sees no verdict (as if it landed just after) — so the transaction's lock + re-read decide.
    fake.on("BetaAccessRequestReview", "findFirst", () => null, { once: true });
    const lkr = await approve(lk.id as string);
    fake.clearHooks();
    fake.queryRaw = prevRaw;
    t.check("a DENIED approve takes the request row lock (FOR UPDATE) inside the transaction, then refuses on the re-read",
      lkr.status === 409 && lkr.body.code === "SUSPECTED_ABUSE" && lockedSql.some((q) => /FOR UPDATE/.test(q)) && row({ id: lk.id }).status === "DENIED", [lkr.status, lockedSql]);

    // 5c. Scope pin: PENDING + SUSPICIOUS is NOT locked (the ruling covers rejected requests only).
    const pendSus = fake.seed("BetaAccessRequest", { email: "pending-suspicious@example.test", status: "PENDING" });
    verdict(pendSus.id, "SUSPICIOUS", new Date(t0 - 60_000));
    const ps = await approve(pendSus.id as string);
    t.check("PENDING with a SUSPICIOUS verdict → still approvable (advisory; a deliberate first decision)",
      ps.status === 200 && row({ id: pendSus.id }).status === "APPROVED", ps.body);

    // 5d. A failed PLAN-time verdict read throws (fail closed) — it is never read as "unlocked".
    const planThrow = fake.seed("BetaAccessRequest", { email: "plan-throw@example.test", status: "DENIED" });
    verdict(planThrow.id, "SUSPICIOUS", new Date(t0 - 60_000));
    fake.on("BetaAccessRequestReview", "findFirst", () => { throw new Error("plan read failed"); }, { once: true });
    let planThrew = false;
    try { await issueBetaInvitation({ client: db, actor, kind: "approve", requestId: planThrow.id as string }); } catch { planThrew = true; }
    fake.clearHooks();
    t.check("the plan-time verdict read throws → issuance throws (never treated as unlocked), nothing minted",
      planThrew && row({ id: planThrow.id }).status === "DENIED" && row({ id: planThrow.id }).inviteTokenHash == null);

    // 6. A failed verdict read fails closed (nothing minted).
    const broken = fake.seed("BetaAccessRequest", { email: "broken@example.test", status: "DENIED" });
    fake.on("BetaAccessRequestReview", "findFirst", () => { throw new Error("review read failed"); });
    const origErr = console.error; console.error = () => {};
    // The route lets the error escape (Next answers 500); either way nothing may be minted.
    let failedClosed = false;
    try { failedClosed = (await approve(broken.id as string)).status >= 500; } catch { failedClosed = true; } finally { console.error = origErr; }
    fake.clearHooks();
    t.check("verdict read throws → not approved (fail closed), no email", failedClosed && row({ id: broken.id }).status === "DENIED" && row({ id: broken.id }).inviteTokenHash == null
      && sentTo("broken@example.test").length === 0);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
