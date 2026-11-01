/**
 * app/api/platform/growth-revenue/blocked-identifiers/route.test.ts  (owner P2-1)
 *
 * The hashed blocked-identifier mechanism end to end, through the REAL route
 * handlers against the in-memory Prisma fake
 * (docs/plans/BETA-BLOCKED-IDENTIFIER-DESIGN-2026-11-01.md §9):
 *   operator-confirmed only · deletion survival · reapplication (every alias) ·
 *   clear / remove / correct · authorization · keys (Production fail-closed,
 *   skip outside, rotation, short key) · races · lookup · backfill · evidence ·
 *   privacy pins (no address and no full HMAC in any audit row or log line).
 *
 * The fake has no row or advisory locks and no isolation: the races below pin
 * the ORDER-independence (deny-first and verdict-first both yield exactly one
 * block), the in-transaction re-checks (a block created mid-plan is seen) and
 * that both writers take the identifier lock; the mutual exclusion itself is
 * Postgres' (SELECT … FOR UPDATE, pg_advisory_xact_lock, the partial unique index).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/platform/growth-revenue/blocked-identifiers/route.test.ts"
 */

import "@/lib/test-support/route-env";

process.env.RATE_LIMIT_ENABLED = "true";

import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { seedBetaGroup } from "@/lib/test-support/beta-group";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { blocklistHmac, blocklistMailbox } from "@/lib/platform/growth/beta-blocklist-core";
import { resetBlocklistWarnings } from "@/lib/platform/growth/beta-blocklist";

const t = makeChecker("beta blocked identifiers (owner P2-1)");
const fake = new FakePrisma();
// prisma/migrations/20261101120000_beta_blocked_identifiers: at most one ACTIVE row per (identifierHmac, keyVersion).
fake.partialUnique("BetaBlockedIdentifier", ["identifierHmac", "keyVersion"], { status: "ACTIVE" }, "BetaBlockedIdentifier_identifierHmac_keyVersion_active_key");

type H = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const R: Record<string, { GET?: H; POST?: H; DELETE?: H }> = {};

const K1 = "k1-".padEnd(40, "x");
const K2 = "k2-".padEnd(40, "y");
const ADDRESSES = ["joe@gmail.com", "j.o.e+x@googlemail.com", "J.O.E+promo@GoogleMail.com", "jo.e@gmail.com", "joe+beta@gmail.com",
  "bob@example.com", "b.ob@example.com", "bob+1@example.com", "a+b@outlook.com", "a@outlook.com", "other@example.com", "zed@example.com",
  "eve@example.com", "carol@example.com", "dave@example.com", "frank@example.com", "gina@example.com", "hal@example.com", "ivy@example.com"];

// ── env control (the blocklist reads process.env on every call) ─────────────
function setEnv(o: { prod?: boolean; v1?: string | null; v2?: string | null; version?: string | null }) {
  const e = process.env as Record<string, string | undefined>;
  if (o.prod) e.VERCEL_ENV = "production"; else delete e.VERCEL_ENV;
  for (const [k, v] of [["BETA_BLOCKLIST_HMAC_KEY_V1", o.v1], ["BETA_BLOCKLIST_HMAC_KEY_V2", o.v2], ["BETA_BLOCKLIST_HMAC_KEY_VERSION", o.version]] as const) {
    if (v == null) delete e[k]; else e[k] = v;
  }
}
const hmac = (email: string, key = K1) => blocklistHmac(blocklistMailbox(email), Buffer.from(key, "utf8"));

// ── log capture (privacy pin) ────────────────────────────────────────────────
const logLines: string[] = [];
for (const m of ["log", "warn", "error", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => {
    const line = a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    const checker = /^\s*[✓✗⚠]/.test(line) || /^\d+ passed, \d+ failed/.test(line);
    if (!checker) logLines.push(line);
    if (m === "log" || m === "info" || checker || process.env.BLOCKLIST_TEST_VERBOSE) orig(...a);
  };
}

// ── world ────────────────────────────────────────────────────────────────────
let ADMIN = "", READER = "", WRITER = "", CONTROLLER = "";
const raws = () => fake.raw.map((r) => r.sql);

async function world() {
  fake.reset();
  freshCache();
  resetBlocklistWarnings();
  await seedBetaGroup(fake);
  fake.queryRaw = (sql: string, values: unknown[]) => {
    if (/FROM "BetaAccessRequest" WHERE "id" = [\s\S]*FOR UPDATE/.test(sql)) {
      return fake.rows("BetaAccessRequest", { id: values[0] as string }).map((r) => ({ id: r.id }));
    }
    throw new Error("unexpected raw query"); // the fleet risk read (evidence signals) — best-effort, caught
  };
  const hash = await bcrypt.hash("pw", 4);
  const u = (email: string, username: string, role = "USER") =>
    fake.seed("User", { email, username, passwordHash: hash, emailVerifiedAt: new Date(), role, ...(role === "SYSTEM_ADMIN" ? { totpEnabled: true, totpSecret: "x" } : {}) });
  ADMIN = u("ops@fm.test", "ops", "SYSTEM_ADMIN").id as string;
  READER = u("reader@fm.test", "reader").id as string;
  WRITER = u("writer@fm.test", "writer").id as string;
  CONTROLLER = u("ctl@fm.test", "ctl").id as string;
  fake.seed("PlatformGrant", { userId: READER, area: "GROWTH_REVENUE", level: "READ", status: "ACTIVE" });
  fake.seed("PlatformGrant", { userId: WRITER, area: "GROWTH_REVENUE", level: "WRITE", status: "ACTIVE" });
  fake.seed("PlatformGrant", { userId: CONTROLLER, area: "GROWTH_REVENUE", level: "CONTROL", status: "ACTIVE" });
}
const cookieOf = async (id: string) => (await signIn(fake, id)).cookie;
const call = (h: H | undefined, path: string, init: { cookie?: string; body?: unknown; method?: string }, params: Record<string, string> = {}) =>
  invoke(h as never, request(path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), cookie: init.cookie, body: init.body }), params);

const seedRequest = (email: string, status = "PENDING") => fake.seed("BetaAccessRequest", { email, status }).id as string;
const verdict = (c: string, id: string, status: string, code = "ABUSE") =>
  call(R.review.POST, `/api/platform/growth-revenue/requests/${id}/risk-review`, { cookie: c, body: { status, reason: { code } } }, { id });
const deny = (c: string, id: string) => call(R.deny.POST, `/api/platform/growth-revenue/requests/${id}/deny`, { cookie: c, body: {} }, { id });
const approve = (c: string, id: string) => call(R.approve.POST, `/api/platform/growth-revenue/requests/${id}/approve`, { cookie: c, body: {} }, { id });
const direct = (c: string, email: string) => call(R.invite.POST, "/api/platform/growth-revenue/invitations", { cookie: c, body: { email } });
let ipSeq = 0;
const apply = (email: string) =>
  invoke(R.intake.POST as never, request("/api/access-request", { body: { email, consent: true }, ip: `198.51.100.${++ipSeq}` }));
const blocks = (where: Record<string, unknown> = {}) => fake.rows("BetaBlockedIdentifier", where);
const audits = (action: string) => fake.rows("AuditLog", { action });

/** Confirmed suspicious denial of `email` through the real routes (verdict first, then deny). */
async function blockVia(c: string, email: string): Promise<string> {
  const id = seedRequest(email);
  await verdict(c, id, "SUSPICIOUS");
  const d = await deny(c, id);
  if (d.status !== 200) throw new Error(`deny failed ${d.status} ${JSON.stringify(d.body)}`);
  return id;
}

async function main() {
  await installFakePrisma(fake);
  R.list = await import("./route") as never;
  R.remove = await import("./[id]/remove/route") as never;
  R.expiry = await import("./[id]/expiry/route") as never;
  R.lookup = await import("./lookup/route") as never;
  R.backfill = await import("./backfill/route") as never;
  R.deny = await import("../requests/[id]/deny/route") as never;
  R.review = await import("../requests/[id]/risk-review/route") as never;
  R.approve = await import("../requests/[id]/approve/route") as never;
  R.evidence = await import("../requests/[id]/preserve-evidence/route") as never;
  R.invite = await import("../invitations/route") as never;
  R.bulk = await import("../requests/bulk-approve/route") as never;
  R.intake = await import("@/app/api/access-request/route") as never;
  R.evList = await import("@/app/api/platform/security-ops/abuse-evidence/route") as never;
  R.evOne = await import("@/app/api/platform/security-ops/abuse-evidence/[id]/route") as never;
  const { runDataRetention } = await import("@/jobs/data-retention");

  setEnv({ v1: K1 });

  t.section("1. operator-confirmed only (requirement 4)");
  {
    await world();
    const c = await cookieOf(ADMIN);
    const plain = seedRequest("bob@example.com");
    await deny(c, plain);
    t.check("a plain DENIED creates no block", blocks().length === 0);
    const pending = seedRequest("eve@example.com");
    await verdict(c, pending, "SUSPICIOUS");
    t.check("PENDING + SUSPICIOUS creates no block", blocks().length === 0);
    // A HIGH automated risk with no verdict: the deny route never reads the heuristics.
    const auto = seedRequest("carol@example.com");
    await deny(c, auto);
    t.check("a high automated risk with no operator verdict creates no block (deny reads only verdicts)", blocks().length === 0);

    const vFirst = seedRequest("joe@gmail.com");
    await verdict(c, vFirst, "SUSPICIOUS");
    const d = await deny(c, vFirst);
    t.check("verdict first, then deny → exactly one ACTIVE block, and the deny says so", d.status === 200 && d.body.identifierBlocked === true
      && blocks({ status: "ACTIVE" }).length === 1 && blocks()[0].sourceRequestId === vFirst && blocks()[0].reasonCode === "ABUSE", d.body);
    const b = blocks()[0];
    t.check("the block holds the HMAC of the canonical mailbox under v1 — never the address", b.identifierHmac === hmac("joe@gmail.com") && b.keyVersion === "v1"
      && !JSON.stringify(b).includes("joe@"));
    t.check("expiresAt = createdAt + 730 days", (b.expiresAt as Date).getTime() - (b.createdAt as Date).getTime() === 730 * 86_400_000);
    t.check("deny + block + audit in ONE transaction under the row lock and the identifier lock",
      raws().some((s) => /pg_advisory_xact_lock/.test(s)) && audits("BETA_IDENTIFIER_BLOCKED").length === 1 && audits("BETA_ACCESS_DENIED").length === 3);

    const dFirst = seedRequest("bob+1@example.com");
    await deny(c, dFirst);
    t.check("deny first: no block yet", blocks({ sourceRequestId: dFirst }).length === 0);
    const v = await verdict(c, dFirst, "SUSPICIOUS");
    t.check("…then a SUSPICIOUS verdict on the DENIED request → exactly one block", v.status === 200 && blocks({ sourceRequestId: dFirst }).length === 1
      && (v.body.blocklist as { blocked?: string })?.blocked === "created", v.body);
    await verdict(c, dFirst, "SUSPICIOUS");
    await deny(c, dFirst);
    t.check("repeat verdict / re-deny: the existing block stands (alreadyBlocked audited, nothing created or extended)",
      blocks({ sourceRequestId: dFirst }).length === 1 && audits("BETA_IDENTIFIER_BLOCKED").filter((a) => (a.metadata as { alreadyBlocked?: boolean }).alreadyBlocked).length === 2);
  }

  t.section("1b. a LIVE invitation already sent to an alias is revoked when the block is created");
  {
    await world();
    const c = await cookieOf(ADMIN);
    const now = Date.now();
    const live = (email: string, hash: string) => fake.seed("BetaAccessRequest", { email, status: "APPROVED", inviteTokenHash: hash, inviteExpiresAt: new Date(now + 5 * 86_400_000), invitedAt: new Date(now - 60_000) }).id as string;
    const aliasLive = live("jo.e+old@gmail.com", "h-alias");
    const unrelated = live("zed@example.com", "h-zed");
    const otherDomainDots = live("j.oe@example.com", "h-dots");
    await blockVia(c, "joe@gmail.com");
    const a = fake.one("BetaAccessRequest", { id: aliasLive })!;
    t.check("the alias's live invitation is revoked: DENIED, token and expiry nulled", a.status === "DENIED" && a.inviteTokenHash == null && a.inviteExpiresAt == null, a);
    const rv = audits("BETA_INVITATION_REVOKED");
    t.check("…with one BETA_INVITATION_REVOKED audit (cause IDENTIFIER_BLOCKED, email hash only)",
      rv.length === 1 && (rv[0].metadata as { cause?: string }).cause === "IDENTIFIER_BLOCKED"
      && !JSON.stringify(rv[0].metadata).includes("@"), rv.map((x) => x.metadata));
    const blocked = audits("BETA_IDENTIFIER_BLOCKED")[0]?.metadata as { revokedAliasInvitations?: number } | undefined;
    t.check("the block audit counts the revocation", blocked?.revokedAliasInvitations === 1, blocked);
    t.check("an unrelated live invitation is untouched", fake.one("BetaAccessRequest", { id: unrelated })!.inviteTokenHash === "h-zed");
    t.check("a dotted address on another domain is NOT an alias and is untouched", fake.one("BetaAccessRequest", { id: otherDomainDots })!.inviteTokenHash === "h-dots");
  }

  t.section("2. deletion: the block outlives the request; reapplication in every alias form is silently dropped");
  {
    await world();
    const c = await cookieOf(ADMIN);
    const src = await blockVia(c, "j.o.e+x@googlemail.com");
    // Simulate the 180-day purge: the request row and its verdicts go.
    fake.tables.set("BetaAccessRequestReview", fake.rows("BetaAccessRequestReview").filter((r) => r.requestId !== src));
    fake.tables.set("BetaAccessRequest", fake.rows("BetaAccessRequest").filter((r) => r.id !== src));
    t.check("after the request purge the block persists", blocks({ status: "ACTIVE" }).length === 1 && !fake.one("BetaAccessRequest", { id: src }));
    const before = { req: fake.rows("BetaAccessRequest").length, ev: fake.rows("BetaAccessRequestEvent").length, aud: audits("BETA_ACCESS_REQUESTED").length };
    const forms = ["j.o.e+x@googlemail.com", "joe@gmail.com", "J.O.E+promo@GoogleMail.com", "jo.e@gmail.com", "joe+beta@gmail.com"];
    const rs = [];
    for (const f of forms) rs.push(await apply(f));
    t.check("every alias form answers the identical 200", rs.every((r) => r.status === 200 && r.body.success === true), rs.map((r) => r.status));
    t.check("…and stores nothing: no request row, no event row, no per-submission audit",
      fake.rows("BetaAccessRequest").length === before.req && fake.rows("BetaAccessRequestEvent").length === before.ev && audits("BETA_ACCESS_REQUESTED").length === before.aud);
    const dropped = audits("BETA_INTAKE_BLOCKED_DROPPED");
    t.check("ONE counts-only BETA_INTAKE_BLOCKED_DROPPED for the hour ({ hourWindow } only)", dropped.length === 1
      && Object.keys(dropped[0].metadata as object).join() === "hourWindow" && dropped[0].userId == null, dropped.map((d) => d.metadata));
    const other = await apply("joe1@gmail.com");
    t.check("a different mailbox (not an alias) is stored as usual", other.status === 200 && fake.rows("BetaAccessRequest").length === before.req + 1);
    const inv = await direct(c, "joe@gmail.com");
    t.check("a direct invite to the purged address → 409 IDENTIFIER_BLOCKED, nothing created", inv.status === 409 && inv.body.code === "IDENTIFIER_BLOCKED"
      && !fake.one("BetaAccessRequest", { email: "joe@gmail.com" }), inv.body);
    const inv2 = await direct(c, "jo.e+again@googlemail.com");
    t.check("…and to an alias of it", inv2.status === 409 && inv2.body.code === "IDENTIFIER_BLOCKED", inv2.body);
  }

  t.section("3. other domains are exact: dots and + are significant (no innocent collateral)");
  {
    await world();
    const c = await cookieOf(ADMIN);
    await blockVia(c, "bob@example.com");
    await blockVia(c, "a+b@outlook.com");
    const n0 = fake.rows("BetaAccessRequest").length;
    await apply("b.ob@example.com");
    await apply("bob+1@example.com");
    t.check("b.ob@ and bob+1@example.com are NOT blocked (stored)", fake.rows("BetaAccessRequest").length === n0 + 2);
    await apply("a@outlook.com");
    t.check("a@outlook.com IS the same mailbox as a+b@outlook.com (dropped)", fake.rows("BetaAccessRequest").length === n0 + 2);
    const ok = await direct(c, "zed@example.com");
    t.check("an unrelated direct invite still issues", ok.status === 200, ok.body);
  }

  t.section("4. clear: a newer LEGITIMATE or UNREVIEWED verdict removes the block (audited)");
  {
    await world();
    const c = await cookieOf(ADMIN);
    const id = await blockVia(c, "joe@gmail.com");
    const r = await verdict(c, id, "LEGITIMATE", "SUPPORT_REQUEST");
    const b = blocks()[0];
    t.check("LEGITIMATE → the block is REMOVED with the verdict's reason, by the operator", r.status === 200 && b.status === "REMOVED"
      && b.removalReasonCode === "SUPPORT_REQUEST" && b.removedById === ADMIN && (r.body.blocklist as { removed?: number }).removed === 1, b);
    const un = audits("BETA_IDENTIFIER_UNBLOCKED");
    t.check("BETA_IDENTIFIER_UNBLOCKED audited with the reason", un.length === 1 && ((un[0].metadata as { reason?: { code?: string } }).reason?.code === "SUPPORT_REQUEST"));
    const a = await apply("j.oe@gmail.com");
    t.check("the mailbox can apply again", a.status === 200 && !!fake.one("BetaAccessRequest", { email: "j.oe@gmail.com" }));
    const id2 = await blockVia(c, "bob@example.com");
    await verdict(c, id2, "UNREVIEWED", "OTHER");
    t.check("UNREVIEWED clears too", blocks({ sourceRequestId: id2 })[0]?.status === "REMOVED");
    const ap = await approve(c, id2);
    t.check("…and the request can be approved again", ap.status === 200, ap.body);
  }

  t.section("5. manual remove / expiry correction — audited, reason required, bounded, CONTROL only");
  {
    await world();
    const admin = await cookieOf(ADMIN);
    await blockVia(admin, "joe@gmail.com");
    const bid = blocks()[0].id as string;
    const reader = await cookieOf(READER), writer = await cookieOf(WRITER), ctl = await cookieOf(CONTROLLER);
    const list = await call(R.list.GET, "/api/platform/growth-revenue/blocked-identifiers", { cookie: reader });
    const row = (list.body.blocks as Record<string, unknown>[] | undefined)?.[0];
    t.check("READ can list: id, 8-hex prefix, version, status, source + whether it still exists — no address, no full HMAC",
      list.status === 200 && row?.id === bid && row.hmacPrefix === hmac("joe@gmail.com").slice(0, 8) && row.sourceRequestExists === true
      && !list.text.includes("joe@") && !list.text.includes(hmac("joe@gmail.com")), list.body);
    const anon = await call(R.list.GET, "/api/platform/growth-revenue/blocked-identifiers", {});
    t.check("anonymous list → 401", anon.status === 401);
    const rm = (cookie: string, body: unknown) => call(R.remove.POST, `/api/platform/growth-revenue/blocked-identifiers/${bid}/remove`, { cookie, body }, { id: bid });
    t.check("READ cannot remove (403)", (await rm(reader, { reason: { code: "SUPPORT_REQUEST" } })).status === 403);
    t.check("WRITE cannot remove (403 — CONTROL required)", (await rm(writer, { reason: { code: "SUPPORT_REQUEST" } })).status === 403);
    const ex = (cookie: string, body: unknown) => call(R.expiry.POST, `/api/platform/growth-revenue/blocked-identifiers/${bid}/expiry`, { cookie, body }, { id: bid });
    t.check("WRITE cannot correct (403)", (await ex(writer, { expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), reason: { code: "OTHER" } })).status === 403);
    t.check("CONTROL without a reason → 400", (await rm(ctl, {})).status === 400 && (await ex(ctl, { expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString() })).status === 400);
    const tooSoon = await ex(ctl, { expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reason: { code: "OTHER" } });
    const tooLate = await ex(ctl, { expiresAt: new Date(Date.now() + 1100 * 86_400_000).toISOString(), reason: { code: "OTHER" } });
    t.check("expiry below now + 1 day or past createdAt + 3 years → 400 (never clamped)", tooSoon.status === 400 && tooLate.status === 400, [tooSoon.body, tooLate.body]);
    const before = (blocks()[0].expiresAt as Date).toISOString();
    const want = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const fix = await ex(ctl, { expiresAt: want, reason: { code: "SUPPORT_REQUEST", note: "appeal reviewed" } });
    const corr = audits("BETA_IDENTIFIER_BLOCK_CORRECTED")[0]?.metadata as { change?: { before?: { expiresAt?: string }; after?: { expiresAt?: string } } } | undefined;
    t.check("CONTROL corrects the expiry; audited with before and after", fix.status === 200 && (blocks()[0].expiresAt as Date).toISOString() === want
      && corr?.change?.before?.expiresAt === before && corr.change.after?.expiresAt === want, [fix.body, corr]);
    const ok = await rm(ctl, { reason: { code: "SUPPORT_REQUEST" } });
    t.check("CONTROL removes with a reason → REMOVED, audited", ok.status === 200 && blocks()[0].status === "REMOVED"
      && audits("BETA_IDENTIFIER_UNBLOCKED").length === 1, ok.body);
    t.check("removing again → 409", (await rm(ctl, { reason: { code: "OTHER" } })).status === 409);
    fake.tables.set("BetaBlockedIdentifier", []);
    const gone = await rm(ctl, { reason: { code: "OTHER" } });
    t.check("a block retention already deleted → 404 (never resurrected)", gone.status === 404 && blocks().length === 0);
  }

  t.section("6. lookup by address — CONTROL, reason, audited by hash; and the backfill");
  {
    await world();
    const admin = await cookieOf(ADMIN);
    await blockVia(admin, "joe@gmail.com");
    const ctl = await cookieOf(CONTROLLER), writer = await cookieOf(WRITER);
    const look = (cookie: string, body: unknown) => call(R.lookup.POST, "/api/platform/growth-revenue/blocked-identifiers/lookup", { cookie, body });
    t.check("WRITE cannot look up (403)", (await look(writer, { email: "joe@gmail.com", reason: { code: "SUPPORT_REQUEST" } })).status === 403);
    const hit = await look(ctl, { email: "J.O.E@googlemail.com", reason: { code: "SUPPORT_REQUEST" } });
    const miss = await look(ctl, { email: "other@example.com", reason: { code: "SUPPORT_REQUEST" } });
    t.check("an alias → blocked + which block; another address → not blocked", hit.status === 200 && hit.body.blocked === true
      && (hit.body.block as { id?: string })?.id === blocks()[0].id && miss.status === 200 && miss.body.blocked === false, [hit.body, miss.body]);
    const la = audits("BETA_IDENTIFIER_LOOKUP");
    t.check("each lookup audited (outcome + emailHash), never the address", la.length === 2 && !JSON.stringify(la).toLowerCase().includes("@googlemail")
      && (la[0].metadata as { outcome?: string }).outcome === "BLOCKED");

    // Backfill: two pre-B9 suspicious denials (no blocks), one plain denial, one already blocked.
    const old1 = seedRequest("dave@example.com", "DENIED");
    const old2 = seedRequest("frank@example.com", "DENIED");
    fake.seed("BetaAccessRequestReview", { requestId: old1, status: "SUSPICIOUS", reasonCode: "ABUSE", operatorId: ADMIN });
    fake.seed("BetaAccessRequestReview", { requestId: old2, status: "SUSPICIOUS", reasonCode: "ABUSE", operatorId: ADMIN });
    const cleared = seedRequest("gina@example.com", "DENIED");
    fake.seed("BetaAccessRequestReview", { requestId: cleared, status: "SUSPICIOUS", reasonCode: "ABUSE", operatorId: ADMIN, createdAt: new Date(Date.now() - 60_000) });
    fake.seed("BetaAccessRequestReview", { requestId: cleared, status: "LEGITIMATE", reasonCode: "OTHER", operatorId: ADMIN });
    seedRequest("hal@example.com", "DENIED");
    const bf = (cookie: string, body: unknown) => call(R.backfill.POST, "/api/platform/growth-revenue/blocked-identifiers/backfill", { cookie, body });
    t.check("WRITE cannot backfill (403)", (await bf(writer, { reason: { code: "INCIDENT" } })).status === 403);
    const n0 = blocks().length;
    const dry = await bf(ctl, { reason: { code: "INCIDENT" } });
    const dc = dry.body.counts as Record<string, number>;
    t.check("DRY RUN by default: 2 would be created, 1 already blocked, 1 cleared — nothing written, nothing audited",
      dry.status === 200 && dry.body.dryRun === true && dc.wouldCreate === 2 && dc.alreadyBlocked === 1 && dc.notSuspicious === 1
      && blocks().length === n0 && audits("BETA_IDENTIFIER_BACKFILL").length === 0, dry.body);
    const run = await bf(ctl, { reason: { code: "INCIDENT" }, dryRun: false });
    const rc = run.body.counts as Record<string, number>;
    t.check("executed: 2 blocks created (each audited), one counts-only batch row", run.status === 200 && rc.created === 2 && rc.alreadyBlocked === 1
      && blocks({ status: "ACTIVE" }).length === n0 + 2 && audits("BETA_IDENTIFIER_BACKFILL").length === 1, run.body);
    const again = await bf(ctl, { reason: { code: "INCIDENT" }, dryRun: false });
    t.check("idempotent: a second run creates nothing", (again.body.counts as Record<string, number>).created === 0 && blocks().length === n0 + 2);
    t.check("backfill needs a reason", (await bf(ctl, {})).status === 400);
  }

  t.section("7. keys — Production fail-closed, skip outside, rotation, short key");
  {
    await world();
    const c = await cookieOf(ADMIN);
    setEnv({ prod: true });
    const p = seedRequest("ivy@example.com");
    const ap = await approve(c, p);
    t.check("Production, no key: approve refuses 409 BLOCKLIST_UNAVAILABLE, nothing minted", ap.status === 409 && ap.body.code === "BLOCKLIST_UNAVAILABLE"
      && fake.one("BetaAccessRequest", { id: p })!.status === "PENDING", ap.body);
    const dv = await direct(c, "zed@example.com");
    t.check("…direct invite refuses too", dv.status === 409 && dv.body.code === "BLOCKLIST_UNAVAILABLE", dv.body);
    const bk = await call(R.bulk.POST, "/api/platform/growth-revenue/requests/bulk-approve", { cookie: c, body: { requestIds: [p], batchKey: "6f1c2a4e-1b2c-4d3e-8f4a-1234567890ab" } });
    const sk = (bk.body.skipped as { code: string }[] | undefined)?.[0];
    t.check("…and bulk skips the row BLOCKLIST_UNAVAILABLE", bk.status === 200 && sk?.code === "BLOCKLIST_UNAVAILABLE", bk.body);
    const sus = seedRequest("eve@example.com");
    await verdict(c, sus, "SUSPICIOUS");
    const d = await deny(c, sus);
    t.check("Production, no key: a deny that WOULD block rolls back (409, still PENDING, no deny audit)", d.status === 409 && d.body.code === "BLOCKLIST_UNAVAILABLE"
      && fake.one("BetaAccessRequest", { id: sus })!.status === "PENDING" && audits("BETA_ACCESS_DENIED").length === 0, d.body);
    const plainId = seedRequest("carol@example.com");
    const d2 = await deny(c, plainId);
    t.check("…a deny that would not block is unaffected", d2.status === 200 && fake.one("BetaAccessRequest", { id: plainId })!.status === "DENIED");
    const sv = await verdict(c, plainId, "SUSPICIOUS");
    t.check("…and a SUSPICIOUS verdict on a DENIED request rolls back too (409, no verdict row)", sv.status === 409
      && fake.rows("BetaAccessRequestReview", { requestId: plainId }).length === 0, sv.body);
    setEnv({ prod: true, v1: "too-short-key" });
    t.check("a key shorter than 32 characters is rejected (still UNAVAILABLE in Production)", (await approve(c, p)).body.code === "BLOCKLIST_UNAVAILABLE");

    setEnv({});
    resetBlocklistWarnings();
    const warnsBefore = logLines.length;
    const d3 = await deny(c, sus);
    const ap2 = await approve(c, seedRequest("gina@example.com"));
    t.check("outside Production, no key: checks are skipped (deny proceeds without a block, approve issues)", d3.status === 200 && blocks().length === 0 && ap2.status === 200, [d3.body, ap2.body]);
    t.check("…with a warning, once per process", logLines.slice(warnsBefore).filter((l) => /SKIPPED outside Production/.test(l)).length === 1, logLines.slice(warnsBefore));

    setEnv({ v1: K1 });
    await blockVia(c, "joe@gmail.com");
    t.check("block written under v1", blocks({ status: "ACTIVE" })[0]?.keyVersion === "v1");
    setEnv({ v1: K1, v2: K2, version: "v2" });
    const rot = await direct(c, "jo.e@googlemail.com");
    t.check("rotation: with VERSION=v2 (and _V1 still set) the v1 block still matches", rot.status === 409 && rot.body.code === "IDENTIFIER_BLOCKED", rot.body);
    await blockVia(c, "bob@example.com");
    t.check("…and new blocks are written under v2", blocks({ status: "ACTIVE", keyVersion: "v2" }).length === 1
      && blocks({ keyVersion: "v2" })[0].identifierHmac === hmac("bob@example.com", K2));
    setEnv({ v2: K2, version: "v2" });
    const retired = await direct(c, "j.oe+r@gmail.com");
    t.check("retiring _V1 before its blocks expire stops them matching (documented: wait or remove first)", retired.status === 200, retired.body);
    setEnv({ v1: K1 });
  }

  t.section("8. races (fake: order-independence + in-transaction re-checks)");
  {
    await world();
    const c = await cookieOf(ADMIN);
    // Approve of an alias while a block for the canonical mailbox lands mid-plan.
    const alias = seedRequest("j.o.e@gmail.com");
    fake.on("User", "findUnique", (args) => {
      if ((args.where as { email?: string })?.email === "j.o.e@gmail.com") {
        fake.seed("BetaBlockedIdentifier", { identifierHmac: hmac("joe@gmail.com"), keyVersion: "v1", status: "ACTIVE", sourceRequestId: "other-req",
          reasonCode: "ABUSE", createdById: ADMIN, expiresAt: new Date(Date.now() + 86_400_000) });
      }
      return undefined;
    }, { once: true });
    const r = await approve(c, alias);
    t.check("approve vs a block created mid-plan → re-checked in the transaction: 409 IDENTIFIER_BLOCKED, still PENDING, no audit",
      r.status === 409 && r.body.code === "IDENTIFIER_BLOCKED" && fake.one("BetaAccessRequest", { id: alias })!.status === "PENDING"
      && audits("BETA_ACCESS_APPROVED").length === 0, r.body);
    t.check("…and the re-check took the identifier's advisory lock", raws().filter((s) => /pg_advisory_xact_lock/.test(s)).length >= 1);

    const [x, y] = await Promise.all([direct(c, "joe@gmail.com"), direct(c, "joe+two@gmail.com")]);
    t.check("two direct invites for a blocked address → both 409, nothing created", x.status === 409 && y.status === 409
      && !fake.one("BetaAccessRequest", { email: "joe@gmail.com" }) && !fake.one("BetaAccessRequest", { email: "joe+two@gmail.com" }), [x.body, y.body]);

    // Direct create while a block lands mid-plan (the create path's own in-transaction re-check).
    fake.on("User", "findUnique", (args) => {
      if ((args.where as { email?: string })?.email === "bob@example.com") {
        fake.seed("BetaBlockedIdentifier", { identifierHmac: hmac("bob@example.com"), keyVersion: "v1", status: "ACTIVE", sourceRequestId: "r-x",
          reasonCode: "ABUSE", createdById: ADMIN, expiresAt: new Date(Date.now() + 86_400_000) });
      }
      return undefined;
    }, { once: true });
    const dc = await direct(c, "bob@example.com");
    t.check("direct create vs a block created mid-plan → 409 IDENTIFIER_BLOCKED, no row", dc.status === 409 && dc.body.code === "IDENTIFIER_BLOCKED"
      && !fake.one("BetaAccessRequest", { email: "bob@example.com" }), dc.body);

    const both = seedRequest("eve@example.com");
    const [dv, vv] = await Promise.all([deny(c, both), verdict(c, both, "SUSPICIOUS")]);
    t.check("deny ∥ verdict → both succeed and exactly one ACTIVE block exists", dv.status === 200 && vv.status === 200
      && blocks({ sourceRequestId: both, status: "ACTIVE" }).length === 1, [dv.body, vv.body]);
    let p2002 = false;
    try {
      fake.seed("BetaBlockedIdentifier", { identifierHmac: hmac("eve@example.com"), keyVersion: "v1", status: "ACTIVE", sourceRequestId: "dup",
        reasonCode: "ABUSE", createdById: ADMIN, expiresAt: new Date(Date.now() + 86_400_000) });
    } catch (e) { p2002 = (e as { code?: string }).code === "P2002"; }
    t.check("the partial unique index refuses a second ACTIVE block for one identifier", p2002);
  }

  t.section("9. evidence — SYSTEM_ADMIN only, sealed, every read audited, explicit deadline");
  {
    await world();
    const c = await cookieOf(ADMIN);
    const ctl = await cookieOf(CONTROLLER);
    const id = await blockVia(c, "joe@gmail.com");
    const pending = seedRequest("bob@example.com");
    const retainUntil = new Date(Date.now() + 365 * 86_400_000).toISOString();
    const cap = (cookie: string, rid: string, body: unknown) => call(R.evidence.POST, `/api/platform/growth-revenue/requests/${rid}/preserve-evidence`, { cookie, body }, { id: rid });
    t.check("a GROWTH_REVENUE CONTROL holder (not SYSTEM_ADMIN) cannot capture (403)", (await cap(ctl, id, { reason: { code: "ABUSE" }, retainUntil })).status === 403);
    t.check("no reason → 400; no retainUntil → 400; past 3 years → 400",
      (await cap(c, id, { retainUntil })).status === 400 && (await cap(c, id, { reason: { code: "ABUSE" } })).status === 400
      && (await cap(c, id, { reason: { code: "ABUSE" }, retainUntil: new Date(Date.now() + 1100 * 86_400_000).toISOString() })).status === 400);
    t.check("a request that is not a SUSPICIOUS denial → 409", (await cap(c, pending, { reason: { code: "ABUSE" }, retainUntil })).status === 409);
    const ok = await cap(c, id, { reason: { code: "ABUSE", note: "earliest of the cluster" }, retainUntil });
    const ev = fake.rows("BetaAbuseEvidence")[0];
    t.check("captured: one row, retainUntil as given, payload ONLY in sealed form", ok.status === 200 && fake.rows("BetaAbuseEvidence").length === 1
      && (ev.retainUntil as Date).toISOString() === retainUntil && String(ev.sealedPayload).startsWith("c1.") && !String(ev.sealedPayload).includes("joe@"), ok.body);
    t.check("one evidence row per request (second capture → 409)", (await cap(c, id, { reason: { code: "ABUSE" }, retainUntil })).status === 409);
    const pres = audits("BETA_ABUSE_EVIDENCE_PRESERVED");
    t.check("BETA_ABUSE_EVIDENCE_PRESERVED { evidenceId, sourceRequestId, retainUntil } — no payload", pres.length === 1
      && (pres[0].metadata as { evidenceId?: string }).evidenceId === ev.id && !JSON.stringify(pres).includes("joe@"));
    const list = await call(R.evList.GET, "/api/platform/security-ops/abuse-evidence", { cookie: c });
    t.check("list = metadata only (no payload, no address)", list.status === 200 && (list.body.evidence as unknown[]).length === 1
      && !list.text.includes("sealedPayload") && !list.text.includes("joe@"), list.body);
    t.check("a non-SYSTEM_ADMIN cannot list or read (403)",
      (await call(R.evList.GET, "/api/platform/security-ops/abuse-evidence", { cookie: ctl })).status === 403
      && (await call(R.evOne.GET, `/api/platform/security-ops/abuse-evidence/${ev.id}`, { cookie: ctl }, { id: ev.id as string })).status === 403
      && audits("BETA_ABUSE_EVIDENCE_ACCESSED").length === 0);
    const r1 = await call(R.evOne.GET, `/api/platform/security-ops/abuse-evidence/${ev.id}`, { cookie: c }, { id: ev.id as string });
    const r2 = await call(R.evOne.GET, `/api/platform/security-ops/abuse-evidence/${ev.id}`, { cookie: c }, { id: ev.id as string });
    const payload = r1.body.payload as { request?: { email?: string }; verdicts?: { status: string }[] } | undefined;
    t.check("SYSTEM_ADMIN opens the payload: email, verdict history", r1.status === 200 && payload?.request?.email === "joe@gmail.com"
      && payload.verdicts?.[payload.verdicts.length - 1]?.status === "SUSPICIOUS", r1.body);
    t.check("EVERY read audited (two reads → two BETA_ABUSE_EVIDENCE_ACCESSED rows)", r2.status === 200 && audits("BETA_ABUSE_EVIDENCE_ACCESSED").length === 2);
    const del = (body: unknown) => call(R.evOne.DELETE, `/api/platform/security-ops/abuse-evidence/${ev.id}`, { cookie: c, body, method: "DELETE" }, { id: ev.id as string });
    t.check("delete without a reason → 400", (await del({})).status === 400 && fake.rows("BetaAbuseEvidence").length === 1);
    const dd = await del({ reason: { code: "OTHER" } });
    t.check("delete with a reason → gone, audited", dd.status === 200 && fake.rows("BetaAbuseEvidence").length === 0 && audits("BETA_ABUSE_EVIDENCE_DELETED").length === 1);
  }

  t.section("10. retention — expired / long-removed blocks and evidence past retainUntil go; the rest stays");
  {
    await world();
    const now = new Date();
    const mk = (over: Record<string, unknown>) => fake.seed("BetaBlockedIdentifier", { identifierHmac: Math.random().toString(16).slice(2), keyVersion: "v1",
      sourceRequestId: "s", reasonCode: "ABUSE", createdById: ADMIN, expiresAt: new Date(now.getTime() + 86_400_000), ...over });
    const keep = mk({ status: "ACTIVE" }).id;
    mk({ status: "ACTIVE", expiresAt: new Date(now.getTime() - 1000) });
    mk({ status: "REMOVED", removedAt: new Date(now.getTime() - 91 * 86_400_000) });
    const recentRemoved = mk({ status: "REMOVED", removedAt: new Date(now.getTime() - 10 * 86_400_000) }).id;
    fake.seed("BetaAbuseEvidence", { sourceRequestId: "e1", sealedPayload: "c1.x", capturedById: ADMIN, reasonCode: "ABUSE", retainUntil: new Date(now.getTime() - 1000) });
    const evKeep = fake.seed("BetaAbuseEvidence", { sourceRequestId: "e2", sealedPayload: "c1.y", capturedById: ADMIN, reasonCode: "ABUSE", retainUntil: new Date(now.getTime() + 86_400_000) }).id;
    const { systemDb } = await import("@/lib/db");
    const res = await runDataRetention(systemDb as never, now);
    t.check("blocks: ACTIVE-unexpired and recently REMOVED kept; expired and REMOVED > 90 d deleted",
      blocks().map((b) => b.id).sort().join() === [keep, recentRemoved].sort().join() && res.betaBlockedIdentifier.deleted === 2, res.betaBlockedIdentifier);
    t.check("evidence past retainUntil deleted; within it kept", fake.rows("BetaAbuseEvidence").map((e) => e.id).join() === evKeep && res.betaAbuseEvidence.deleted === 1);
  }

  t.section("11. privacy pins — no address and no full HMAC in any audit row or log line");
  {
    // Re-run a representative flow so this section stands on its own rows.
    await world();
    setEnv({ v1: K1 });
    const c = await cookieOf(ADMIN);
    const id = await blockVia(c, "joe@gmail.com");
    await apply("j.o.e+x@googlemail.com");
    await direct(c, "jo.e@gmail.com");
    await call(R.lookup.POST, "/api/platform/growth-revenue/blocked-identifiers/lookup", { cookie: c, body: { email: "joe@gmail.com", reason: { code: "SUPPORT_REQUEST" } } });
    await verdict(c, id, "LEGITIMATE", "OTHER");
    const full = blocks().map((b) => String(b.identifierHmac));
    const auditText = JSON.stringify(fake.rows("AuditLog").filter((a) => String(a.action).startsWith("BETA_IDENTIFIER") || String(a.action).startsWith("BETA_INTAKE")
      || String(a.action).startsWith("BETA_ABUSE"))).toLowerCase();
    t.check("blocklist / intake / evidence audit rows carry no address", ADDRESSES.every((a) => !auditText.includes(a.toLowerCase())));
    t.check("…and no full HMAC (8-hex prefix at most)", full.length > 0 && full.every((h) => !JSON.stringify(fake.rows("AuditLog")).includes(h)));
    const logs = logLines.join("\n").toLowerCase();
    t.check("no log line (whole run) carries an address or a full HMAC", ADDRESSES.every((a) => !logs.includes(a.toLowerCase()))
      && [hmac("joe@gmail.com"), hmac("bob@example.com"), hmac("joe@gmail.com", K2), hmac("bob@example.com", K2)].every((h) => !logs.includes(h)),
      logLines.filter((l) => ADDRESSES.some((a) => l.toLowerCase().includes(a.toLowerCase()))).slice(0, 3));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
