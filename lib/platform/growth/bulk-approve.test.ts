/**
 * lib/platform/growth/bulk-approve.test.ts  (PR C · bulk beta approval)
 *
 * The REAL bulk-approve handler (and the list route's eligibility) against the
 * in-memory Prisma fake, signed in through the unmodified session chain. No
 * database, no network, no provider: emails land in the capture adapter.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/growth/bulk-approve.test.ts
 */

import "@/lib/test-support/route-env";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { capturedEmails, clearCapturedEmails } from "@/lib/email/providers/capture";
import { DAY_MS } from "./invitation-issue.core";
import { approvalEligibility, BULK_APPROVE_MAX_IDS, parseBulkApproveBody } from "./bulk-approve.core";

const t = makeChecker("PR C — bulk beta approval: preview, confirm, idempotent, audited");
const fake = new FakePrisma();
type H = (req: Request) => Promise<Response>;
const URL_ = "/api/platform/growth-revenue/requests/bulk-approve";
const BULK = "BETA_ACCESS_BULK_APPROVED";

let admin: { id: string; cookie: string };
async function world() {
  fake.reset();
  fake.clearHooks();
  freshCache();
  clearCapturedEmails();
  const hash = await bcrypt.hash("pw", 4);
  const a = fake.seed("User", { email: "ops@example.test", username: "ops", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
  admin = { id: a.id as string, cookie: (await signIn(fake, a.id as string)).cookie };
}
const row = (where: Record<string, unknown>) => fake.one("BetaAccessRequest", where)!;
const sentTo = (email: string) => capturedEmails().filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(email));
const audits = (action: string) => fake.rows("AuditLog", { action });
const daysOf = (r: Record<string, unknown>) => ((r.inviteExpiresAt as Date).getTime() - (r.invitedAt as Date).getTime()) / DAY_MS;
const pending = (email: string) => fake.seed("BetaAccessRequest", { email, status: "PENDING" }).id as string;

/** Make the next `n` reads of `model.op` wait for each other (the race made deterministic). */
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

async function operator(level: "READ" | "WRITE" | null) {
  const u = fake.seed("User", { email: `op-${randomUUID()}@example.test`, username: `op${randomUUID().slice(0, 6)}`, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER", totpEnabled: true, totpSecret: "x" });
  if (level) fake.seed("PlatformGrant", { userId: u.id, area: "GROWTH_REVENUE", level, status: "ACTIVE" });
  return { id: u.id as string, ...(await signIn(fake, u.id as string)) };
}

async function main() {
  await installFakePrisma(fake);
  const { POST: BULK_POST } = (await import("@/app/api/platform/growth-revenue/requests/bulk-approve/route")) as unknown as { POST: H };
  const { GET: LIST } = (await import("@/app/api/platform/growth-revenue/requests/route")) as unknown as { GET: H };
  const bulk = (body: unknown, cookie: string | null = admin.cookie) =>
    invoke(BULK_POST as never, request(URL_, { method: "POST", cookie, body }));
  const list = () => invoke(LIST as never, request("/api/platform/growth-revenue/requests", { cookie: admin.cookie }));

  // ── 1. The body: cap, dedupe, batchKey, validity — refused, never clamped ──
  t.section("1. body validation: cap 100, non-empty, UUID batchKey, validity 1–30 server-side");
  {
    await world();
    const p = pending("cap@example.test");
    const ids101 = [p, ...Array.from({ length: BULK_APPROVE_MAX_IDS }, (_, i) => `missing-${i}`)];
    for (const dryRun of [true, false]) {
      const r = await bulk({ requestIds: ids101, batchKey: randomUUID(), dryRun });
      t.check(`${dryRun ? "dryRun" : "execute"}: 101 ids → 400, nothing approved, nothing sent`, r.status === 400 && row({ id: p }).status === "PENDING" && capturedEmails().length === 0, [r.status, r.body]);
    }
    const r100 = await bulk({ requestIds: ids101.slice(0, 100), batchKey: randomUUID(), dryRun: true });
    t.check("exactly 100 ids → 200 (the cap is inclusive)", r100.status === 200 && (r100.body.rows as unknown[]).length === 100, r100.status);
    for (const [label, body] of [
      ["no body", undefined],
      ["empty requestIds", { requestIds: [], batchKey: randomUUID() }],
      ["requestIds not an array", { requestIds: p, batchKey: randomUUID() }],
      ["a non-string id", { requestIds: [p, 7], batchKey: randomUUID() }],
      ["missing batchKey", { requestIds: [p] }],
      ["batchKey not a UUID", { requestIds: [p], batchKey: "click-1" }],
      ["dryRun not a boolean", { requestIds: [p], batchKey: randomUUID(), dryRun: "yes" }],
    ] as const) {
      const r = await bulk(body);
      t.check(`${label} → 400`, r.status === 400 && row({ id: p }).status === "PENDING", [r.status, r.body]);
    }
    for (const bad of [0, 31, 2.5, -1, "abc"]) {
      for (const dryRun of [true, false]) {
        const r = await bulk({ requestIds: [p], batchKey: randomUUID(), dryRun, validityDays: bad });
        t.check(`validity ${JSON.stringify(bad)} (${dryRun ? "dryRun" : "execute"}) → 400 INVALID_VALIDITY, row untouched`,
          r.status === 400 && r.body.code === "INVALID_VALIDITY" && row({ id: p }).status === "PENDING", [r.status, r.body]);
      }
    }
    t.check("no email, no approval audit and no batch row for any refused body", capturedEmails().length === 0 && audits("BETA_ACCESS_APPROVED").length === 0 && audits(BULK).length === 0);
    const parsed = parseBulkApproveBody({ requestIds: ["a", "b", "a", "a"], batchKey: randomUUID() });
    t.check("dedupe keeps first-occurrence order and reports the extra occurrences", parsed.ok && parsed.body.ids.join() === "a,b" && parsed.body.duplicates.length === 2 && parsed.body.requested === 4);
  }

  // ── 2. Permissions: fresh GROWTH_REVENUE WRITE, dry run included ───────────
  t.section("2. permissions: fresh GROWTH_REVENUE WRITE (as single approve), the dry run too");
  {
    await world();
    const p = pending("perm@example.test");
    const body = (dryRun: boolean) => ({ requestIds: [p], batchKey: randomUUID(), dryRun });
    const anon = await bulk(body(false), null);
    t.check("anonymous → 401", anon.status === 401, anon.status);
    const none = await operator(null);
    const reader = await operator("READ");
    for (const dryRun of [true, false]) {
      const n = await bulk(body(dryRun), none.cookie);
      const r = await bulk(body(dryRun), reader.cookie);
      t.check(`${dryRun ? "dryRun" : "execute"}: no grant → 403, READ grant → 403`, n.status === 403 && r.status === 403, [n.status, r.status]);
    }
    t.check("row still PENDING, nothing sent", row({ id: p }).status === "PENDING" && capturedEmails().length === 0);

    const writer = await operator("WRITE");
    const okDry = await bulk(body(true), writer.cookie);
    t.check("WRITE grant → dryRun 200 (warms the session cache)", okDry.status === 200, okDry.status);
    // Revoke the session AFTER a cached hit: only the FRESH variant notices.
    const sessions = fake.table("UserSession");
    sessions.splice(sessions.findIndex((s) => s.userId === writer.id), 1);
    const stale = await bulk(body(false), writer.cookie);
    t.check("revoked session within the cache TTL → 401 (the fresh, live-revocation gate)", stale.status === 401 && row({ id: p }).status === "PENDING", stale.status);

    const w2 = await operator("WRITE");
    const ok = await bulk(body(false), w2.cookie);
    const ap = audits("BETA_ACCESS_APPROVED")[0];
    t.check("WRITE grant → execute 200, row APPROVED, performedByAdminId = that operator",
      ok.status === 200 && row({ id: p }).status === "APPROVED" && ap?.performedByAdminId === w2.id && audits(BULK)[0]?.performedByAdminId === w2.id, ok.body);
  }

  // ── 3. A mixed batch: dry run = execution, duplicates once ─────────────────
  t.section("3. mixed batch (pending · approved · redeemed · denied · existing account · unknown · duplicate)");
  {
    await world();
    const p1 = pending("p1@example.test");
    const p2 = pending("p2@example.test");
    const a1 = fake.seed("BetaAccessRequest", { email: "a1@example.test", status: "APPROVED", inviteTokenHash: "h-a1", inviteExpiresAt: new Date(Date.now() + 3 * DAY_MS), invitedAt: new Date() }).id as string;
    const r1 = fake.seed("BetaAccessRequest", { email: "r1@example.test", status: "REDEEMED" }).id as string;
    const d1 = fake.seed("BetaAccessRequest", { email: "d1@example.test", status: "DENIED" }).id as string;
    const x1 = pending("member@example.test");
    fake.seed("User", { email: "member@example.test", username: "member", passwordHash: "x", emailVerifiedAt: new Date() });
    const ids = [p1, a1, r1, d1, x1, "no-such-request", p2, p1];
    const key = randomUUID();

    const dry = await bulk({ requestIds: ids, batchKey: key, dryRun: true });
    const rows = dry.body.rows as Array<{ id: string; eligible: boolean; code?: string; reason?: string }>;
    const codeOf = Object.fromEntries(rows.map((r) => [r.id, r.eligible ? "OK" : r.code]));
    t.check("dryRun → 200 with one row per DISTINCT id", dry.status === 200 && rows.length === 7, dry.body);
    t.check("dryRun codes: pending OK; APPROVED/REDEEMED/DENIED/ACCOUNT_EXISTS/NOT_FOUND refused",
      codeOf[p1] === "OK" && codeOf[p2] === "OK" && codeOf[a1] === "ALREADY_APPROVED" && codeOf[r1] === "REDEEMED"
      && codeOf[d1] === "DENIED" && codeOf[x1] === "ACCOUNT_EXISTS" && codeOf["no-such-request"] === "NOT_FOUND", codeOf);
    t.check("every ineligible row carries a reason", rows.every((r) => r.eligible || (typeof r.reason === "string" && r.reason.length > 0)));
    const ds = dry.body.summary as Record<string, number>;
    t.check("dryRun summary: requested 8, unique 7, duplicates 1, eligible 2, ineligible 5",
      ds.requested === 8 && ds.unique === 7 && ds.duplicates === 1 && ds.eligible === 2 && ds.ineligible === 5, ds);
    t.check("dryRun wrote nothing: no status change, no email, no audit",
      row({ id: p1 }).status === "PENDING" && capturedEmails().length === 0
      && fake.rows("AuditLog").filter((a) => String(a.action).startsWith("BETA_")).length === 0);
    t.check("dryRun states the validity and an absolute UTC expiry", dry.body.validityDays === 7 && dry.body.validitySource === "setting"
      && typeof dry.body.expiresAtIfIssuedNow === "string" && (dry.body.expiresAtIfIssuedNow as string).endsWith("Z"), dry.body);

    const ex = await bulk({ requestIds: ids, batchKey: key });
    const s = ex.body.summary as Record<string, number>;
    const succeeded = (ex.body.succeeded as Array<{ id: string }>).map((x) => x.id).sort();
    const skipped = Object.fromEntries((ex.body.skipped as Array<{ id: string; code: string }>).map((x) => [x.id, x.code]));
    t.check("execute → succeeded 2 · skipped 5 · failed 0, duplicate counted once (unique 7)",
      ex.status === 200 && s.succeeded === 2 && s.skipped === 5 && s.failed === 0 && s.unique === 7 && s.duplicates === 1 && s.requested === 8, s);
    t.check("succeeded + skipped + failed = unique", s.succeeded + s.skipped + s.failed === s.unique);
    t.check("DRY RUN ELIGIBILITY MATCHES EXECUTION, row by row",
      rows.every((r) => (r.eligible ? succeeded.includes(r.id) : skipped[r.id] === r.code)), { codeOf, succeeded, skipped });
    t.check("exactly one email to each approved address (p1 listed twice), none to the others",
      sentTo("p1@example.test").length === 1 && sentTo("p2@example.test").length === 1 && capturedEmails().length === 2);
    t.check("the APPROVED, REDEEMED, DENIED and existing-account rows are untouched",
      row({ id: a1 }).inviteTokenHash === "h-a1" && row({ id: r1 }).status === "REDEEMED" && row({ id: d1 }).status === "DENIED" && row({ id: x1 }).status === "PENDING");
    t.check("one BETA_ACCESS_APPROVED per approved row, through issuance (target BETA_REQUEST)",
      audits("BETA_ACCESS_APPROVED").length === 2
      && audits("BETA_ACCESS_APPROVED").every((a) => [p1, p2].includes(((a.metadata as { target?: { id?: string } }).target?.id) ?? "")));
    const b = audits(BULK);
    const bm = (b[0]?.metadata ?? {}) as Record<string, unknown>;
    t.check("ONE batch row: target BETA_BATCH = batchKey, counts, validity, requestCount",
      b.length === 1 && (bm.target as { kind?: string; id?: string })?.kind === "BETA_BATCH" && (bm.target as { id?: string }).id === key
      && bm.batchKey === key && bm.requestCount === 8 && bm.uniqueCount === 7 && bm.duplicateCount === 1 && bm.validityDays === 7
      && JSON.stringify(bm.counts) === JSON.stringify({ succeeded: 2, skipped: 5, failed: 0 }) && bm.result === "SUCCESS" && bm.repeat === false, bm);
    const json = JSON.stringify(b[0]);
    const tokenHashes = [p1, p2].map((id) => row({ id }).inviteTokenHash as string);
    t.check("batch row carries no email, no email hash, no token or token hash, no link",
      !json.includes("@") && !/emailHash/.test(json) && !/invite=/.test(json) && tokenHashes.every((h) => !json.includes(h)), json);
    t.check("the per-row approvals carry no token either", audits("BETA_ACCESS_APPROVED").every((a) => tokenHashes.every((h) => !JSON.stringify(a).includes(h))));
  }

  // ── 4. Retry with the same batchKey ────────────────────────────────────────
  t.section("4. retry / double-click with the same batchKey: nothing issued twice");
  {
    await world();
    const ids = [pending("q1@example.test"), pending("q2@example.test"), pending("q3@example.test")];
    const key = randomUUID();
    // q3's conditional write throws once — a partial failure.
    let calls = 0;
    fake.on("BetaAccessRequest", "updateMany", () => { calls++; if (calls === 3) throw new Error("db blip"); return undefined; });
    const first = await bulk({ requestIds: ids, batchKey: key });
    fake.clearHooks();
    const f = first.body.summary as Record<string, number>;
    t.check("partial failure: 2 succeeded, 1 failed (ERROR), the failure did not block the others",
      first.status === 200 && f.succeeded === 2 && f.failed === 1 && (first.body.failed as Array<{ id: string; code: string }>)[0]?.id === ids[2]
      && (first.body.failed as Array<{ code: string }>)[0]?.code === "ERROR" && row({ id: ids[2] }).status === "PENDING", first.body);
    t.check("the failed row's reason is generic (no driver message leaked)", !JSON.stringify(first.body).includes("db blip"));
    t.check("batch row result FAILURE with the real counts", audits(BULK).length === 1 && (audits(BULK)[0].metadata as Record<string, unknown>).result === "FAILURE");
    const hashes = ids.slice(0, 2).map((id) => row({ id }).inviteTokenHash);
    const emails0 = capturedEmails().length;

    const retry = await bulk({ requestIds: ids, batchKey: key });
    const r = retry.body.summary as Record<string, number>;
    t.check("retry (same batchKey) → the failed row succeeds, the approved ones are SKIPPED already-approved",
      retry.status === 200 && r.succeeded === 1 && r.skipped === 2 && r.failed === 0 && retry.body.repeat === true
      && (retry.body.skipped as Array<{ code: string }>).every((x) => x.code === "ALREADY_APPROVED"), retry.body);
    t.check("retry sent exactly one email (the previously failed row), rotated no token",
      capturedEmails().length === emails0 + 1 && sentTo("q3@example.test").length === 1 && sentTo("q1@example.test").length === 1
      && ids.slice(0, 2).every((id, i) => row({ id }).inviteTokenHash === hashes[i]));
    t.check("retry that approved something adds one batch row marked repeat", audits(BULK).length === 2 && (audits(BULK)[1].metadata as Record<string, unknown>).repeat === true);

    const again = await bulk({ requestIds: ids, batchKey: key });
    t.check("a third submit issues nothing: no email, no token, no approval audit, no further batch row",
      again.status === 200 && (again.body.summary as Record<string, number>).succeeded === 0 && capturedEmails().length === emails0 + 1
      && audits("BETA_ACCESS_APPROVED").length === 3 && audits(BULK).length === 2 && again.body.batchAudited === false, again.body);
  }

  // ── 5. Concurrent double submit ────────────────────────────────────────────
  t.section("5. concurrent double submit: each row approved exactly once");
  {
    await world();
    const emails = ["c1@example.test", "c2@example.test", "c3@example.test"];
    const ids = emails.map(pending);
    const key = randomUUID();
    barrier("BetaAccessRequest", "findUnique", 2);
    const [a, b] = await Promise.all([bulk({ requestIds: ids, batchKey: key }), bulk({ requestIds: ids, batchKey: key })]);
    fake.clearHooks();
    const won = [...(a.body.succeeded as Array<{ id: string }>), ...(b.body.succeeded as Array<{ id: string }>)].map((x) => x.id).sort();
    t.check("both 200; across the two responses each row succeeded exactly once", a.status === 200 && b.status === 200 && won.join() === [...ids].sort().join(), [a.body.summary, b.body.summary]);
    t.check("the loser of each row reports it skipped (already approved), never failed",
      (a.body.summary as Record<string, number>).failed === 0 && (b.body.summary as Record<string, number>).failed === 0
      && (a.body.summary as Record<string, number>).skipped + (b.body.summary as Record<string, number>).skipped === 3);
    t.check("one email and one BETA_ACCESS_APPROVED per row", emails.every((e) => sentTo(e).length === 1) && audits("BETA_ACCESS_APPROVED").length === 3);
    // A different batchKey (a second tab) is no different: the per-row write decides.
    const other = await bulk({ requestIds: ids, batchKey: randomUUID() });
    t.check("a second tab (new batchKey) → all skipped, no email", (other.body.summary as Record<string, number>).skipped === 3 && emails.every((e) => sentTo(e).length === 1));
  }

  // ── 6. Validity: the setting, or a bounded override ────────────────────────
  t.section("6. validity: configured setting by default, per-batch override 1–30");
  {
    await world();
    fake.seed("PlatformSetting", { key: "beta_invitation_validity_days", value: "10" });
    const s1 = pending("set1@example.test");
    const viaSetting = await bulk({ requestIds: [s1], batchKey: randomUUID() });
    const am = (audits("BETA_ACCESS_APPROVED")[0]?.metadata ?? {}) as Record<string, unknown>;
    t.check("no override → the setting (10 days), audited validitySource 'setting'",
      viaSetting.body.validityDays === 10 && viaSetting.body.validitySource === "setting" && daysOf(row({ id: s1 })) === 10 && am.validitySource === "setting", [viaSetting.body, am]);
    const o1 = pending("ovr1@example.test");
    const o2 = pending("ovr2@example.test");
    const dry = await bulk({ requestIds: [o1, o2], batchKey: randomUUID(), dryRun: true, validityDays: 14 });
    const ex = await bulk({ requestIds: [o1, o2], batchKey: randomUUID(), validityDays: 14 });
    t.check("override 14 → preview and every issued row say 14 days, audited 'override'",
      dry.body.validityDays === 14 && dry.body.validitySource === "override" && ex.body.validityDays === 14
      && [o1, o2].every((id) => daysOf(row({ id })) === 14)
      && audits("BETA_ACCESS_APPROVED").filter((a) => (a.metadata as Record<string, unknown>).validitySource === "override").length === 2, ex.body);
    t.check("batch row records the batch validity", (audits(BULK).at(-1)?.metadata as Record<string, unknown>).validityDays === 14);
    for (const edge of [1, 30]) {
      const id = pending(`edge${edge}@example.test`);
      const r = await bulk({ requestIds: [id], batchKey: randomUUID(), validityDays: edge });
      t.check(`override ${edge} (bound) → accepted`, r.status === 200 && daysOf(row({ id })) === edge, r.body);
    }
  }

  // ── 7. Risk-blind ──────────────────────────────────────────────────────────
  t.section("7. eligibility is risk-blind");
  {
    await world();
    const id = pending("risky@example.test");
    const dry = await bulk({ requestIds: [id], batchKey: randomUUID(), dryRun: true, risk: { level: "high" }, acknowledged: false });
    const ex = await bulk({ requestIds: [id], batchKey: randomUUID(), risk: { [id]: { level: "high" } } });
    t.check("risk-ish body fields change nothing: eligible and approved", (dry.body.rows as Array<{ eligible: boolean }>)[0]?.eligible === true
      && (ex.body.summary as Record<string, number>).succeeded === 1, [dry.body, ex.body]);
    const ROOT = process.cwd();
    for (const f of ["lib/platform/growth/bulk-approve.ts", "lib/platform/growth/bulk-approve.core.ts", "app/api/platform/growth-revenue/requests/bulk-approve/route.ts"]) {
      const code = readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      t.check(`${f}: no code reads risk`, !/risk/i.test(code));
    }
  }

  // ── 8. The list route's eligibility (same pure rule) ───────────────────────
  t.section("8. GET /requests: optional eligibility per pending row, from the same rule");
  {
    await world();
    const ok = pending("free@example.test");
    const taken = pending("taken@example.test");
    fake.seed("User", { email: "taken@example.test", username: "taken", passwordHash: "x", emailVerifiedAt: new Date() });
    // The list's submission stats are a groupBy the fake does not model; no events here.
    fake.on("BetaAccessRequestEvent", "groupBy", () => []);
    const g = await list();
    const byId = Object.fromEntries((g.body.pending as Array<{ id: string; eligibility?: { approvable: boolean; reason?: string } }>).map((r) => [r.id, r.eligibility]));
    t.check("free address → approvable", g.status === 200 && byId[ok]?.approvable === true && byId[ok]?.reason === undefined, byId);
    t.check("address with an account → not approvable, with the issuance reason",
      byId[taken]?.approvable === false && /already has a Fourth Meridian account/.test(byId[taken]?.reason ?? ""), byId);
    const e = approvalEligibility({ id: "x", email: "x@example.test", status: "DENIED", inviteTokenHash: null, inviteExpiresAt: null }, false);
    t.check("pure rule: DENIED is not bulk-approvable (single approve may reverse a denial; a batch must not)", !e.approvable && e.code === "DENIED");
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
