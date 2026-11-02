/**
 * app/api/platform/growth-revenue/requests/status-view.test.ts  (PB-6)
 *
 * The status view and request review through the REAL route handlers against
 * the in-memory Prisma fake:
 *   1. gate — GET ?view=… keeps requirePlatformAccess("GROWTH_REVENUE","READ")
 *   2. filters — every status view, latest-verdict SUSPICIOUS, server paging, 400s
 *   3. the legacy queue answers unchanged without `view`
 *   4. blocked-state derivation — ACTIVE + unexpired + sourceRequestId only
 *   5. DTOs never carry an HMAC, key version, block id, token hash or key
 *   6. the history GET carries status / decision / block / availability
 *   7. Deny vs Deny and block, end to end: the client model
 *      (beta-request-review-model.ts) posting to the real deny + risk-review
 *      handlers — including the partial failure (Production, no key) and the
 *      "Block now" / "Clear block" recovery.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs "app/api/platform/growth-revenue/requests/status-view.test.ts"
 */

import "@/lib/test-support/route-env";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { resetBlocklistWarnings } from "@/lib/platform/growth/beta-blocklist";
import { runDeny, runDenyAndBlock, runVerdict, type Poster } from "@/components/platform/growth/beta-request-review-model";

const t = makeChecker("/api/platform/growth-revenue/requests?view=… (PB-6 status view + review)");
const fake = new FakePrisma();
fake.partialUnique("BetaBlockedIdentifier", ["identifierHmac", "keyVersion"], { status: "ACTIVE" }, "BetaBlockedIdentifier_identifierHmac_keyVersion_active_key");

type H = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let LIST: H, DENY: H, REVIEW_GET: H, REVIEW_POST: H;

const KEY = "pb6-".padEnd(40, "k");
function setEnv(o: { prod?: boolean; key?: string | null }) {
  const e = process.env as Record<string, string | undefined>;
  if (o.prod) e.VERCEL_ENV = "production"; else delete e.VERCEL_ENV;
  if (o.key) e.BETA_BLOCKLIST_HMAC_KEY_V1 = o.key; else delete e.BETA_BLOCKLIST_HMAC_KEY_V1;
  delete e.BETA_BLOCKLIST_HMAC_KEY_VERSION;
}

let ADMIN = "", READER = "", NOGRANT = "";
const DAY = 86_400_000;

async function world() {
  fake.reset();
  freshCache();
  resetBlocklistWarnings();
  fake.queryRaw = (sql: string, values: unknown[]) => {
    if (/FROM "BetaAccessRequest" WHERE "id" = [\s\S]*FOR UPDATE/.test(sql)) {
      return fake.rows("BetaAccessRequest", { id: values[0] as string }).map((r) => ({ id: r.id }));
    }
    throw new Error("unexpected raw query");
  };
  const hash = await bcrypt.hash("pw", 4);
  ADMIN = fake.seed("User", { email: "ops@fm.test", username: "ops", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" }).id as string;
  READER = fake.seed("User", { email: "reader@fm.test", username: "reader", passwordHash: hash, emailVerifiedAt: new Date() }).id as string;
  NOGRANT = fake.seed("User", { email: "nobody@fm.test", username: "nobody", passwordHash: hash, emailVerifiedAt: new Date() }).id as string;
  fake.seed("PlatformGrant", { userId: READER, area: "GROWTH_REVENUE", level: "READ", status: "ACTIVE" });
}

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);
const seedReq = (email: string, status: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
  fake.seed("BetaAccessRequest", { email, status, createdAt: at(daysAgo), ...(status !== "PENDING" ? { decidedAt: at(daysAgo - 0.5) } : {}), ...extra }).id as string;
const seedReview = (requestId: string, status: string, daysAgo: number) =>
  fake.seed("BetaAccessRequestReview", { requestId, status, reasonCode: "ABUSE", note: null, operatorId: ADMIN, createdAt: at(daysAgo) });

const cookie = async (id: string) => (await signIn(fake, id)).cookie;
const list = (c: string | undefined, qs: string) => invoke(LIST as never, request(`/api/platform/growth-revenue/requests?${qs}`, { cookie: c }));
const history = (c: string, id: string) => invoke(REVIEW_GET as never, request(`/api/platform/growth-revenue/requests/${id}/risk-review`, { cookie: c }), { id });
const ids = (b: Record<string, unknown>) => ((b.rows ?? []) as { id: string }[]).map((r) => r.id);

/** The client model's Poster, wired to the REAL handlers (URL → route). */
const realPoster = (c: string): Poster => async (url, body) => {
  const m = /^\/api\/platform\/growth-revenue\/requests\/([^/]+)\/(deny|risk-review)$/.exec(url);
  if (!m) throw new Error(`unexpected url ${url}`);
  calls.push(`${m[2]}${(body as { status?: string })?.status ? `:${(body as { status: string }).status}` : ""}`);
  const id = decodeURIComponent(m[1]);
  const h = m[2] === "deny" ? DENY : REVIEW_POST;
  const r = await invoke(h as never, request(url, { method: "POST", cookie: c, body }), { id });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body as Record<string, unknown> };
};
const calls: string[] = [];
const activeBlocks = (sourceRequestId: string) => fake.rows("BetaBlockedIdentifier", { sourceRequestId, status: "ACTIVE" });

async function main() {
  await installFakePrisma(fake);
  ({ GET: LIST } = await import("./route") as unknown as { GET: H });
  ({ POST: DENY } = await import("./[id]/deny/route") as unknown as { POST: H });
  ({ GET: REVIEW_GET, POST: REVIEW_POST } = await import("./[id]/risk-review/route") as unknown as { GET: H; POST: H });
  setEnv({});

  t.section("1. the status view keeps the GROWTH_REVENUE READ gate");
  {
    await world();
    seedReq("d@example.test", "DENIED", 3);
    const anon = await list(undefined, "view=DENIED");
    t.check("anonymous → 401", anon.status === 401, anon.status);
    const none = await list(await cookie(NOGRANT), "view=DENIED");
    t.check("no Growth grant → 403", none.status === 403, none.status);
    const r = await list(await cookie(READER), "view=DENIED");
    t.check("a READ holder → 200 with rows", r.status === 200 && ids(r.body).length === 1, r.body);
    t.check("the status view is no-store", r.headers.get("cache-control") === "no-store");
  }

  t.section("2. filters — status views, latest-verdict SUSPICIOUS, paging, malformed queries");
  {
    await world();
    const p1 = seedReq("p1@example.test", "PENDING", 9);
    const p2 = seedReq("p2@example.test", "PENDING", 2);
    const a1 = seedReq("a1@example.test", "APPROVED", 5, { invitedAt: at(4.5), inviteExpiresAt: new Date(Date.now() + DAY) });
    const d1 = seedReq("d1@example.test", "DENIED", 8);
    const d2 = seedReq("d2@example.test", "DENIED", 4);
    const d3 = seedReq("d3@example.test", "DENIED", 1);
    const r1 = seedReq("r1@example.test", "REDEEMED", 7, { redeemedAt: at(6) });
    seedReview(d1, "SUSPICIOUS", 3);                                   // latest SUSPICIOUS
    seedReview(d2, "SUSPICIOUS", 3); seedReview(d2, "LEGITIMATE", 2);  // cleared — latest LEGITIMATE
    seedReview(p2, "SUSPICIOUS", 1);                                   // a pending suspicious
    const c = await cookie(READER);

    const pending = await list(c, "view=PENDING");
    t.check("PENDING: only pending, oldest first (FIFO)", JSON.stringify(ids(pending.body)) === JSON.stringify([p1, p2]) && pending.body.total === 2, pending.body);
    const approved = await list(c, "view=APPROVED");
    t.check("APPROVED: only approved", JSON.stringify(ids(approved.body)) === JSON.stringify([a1]));
    const denied = await list(c, "view=DENIED");
    t.check("DENIED: only denied, newest first", JSON.stringify(ids(denied.body)) === JSON.stringify([d3, d2, d1]) && denied.body.total === 3, ids(denied.body));
    const joined = await list(c, "view=REDEEMED");
    const jrow = ((joined.body.rows ?? []) as Record<string, unknown>[])[0];
    t.check("REDEEMED (Joined): only redeemed, with redeemedAt", ids(joined.body).join() === r1 && typeof jrow?.redeemedAt === "string");
    const all = await list(c, "view=ALL");
    t.check("ALL: every request", all.body.total === 7 && ids(all.body).length === 7);

    const sus = await list(c, "view=DENIED&verdict=SUSPICIOUS");
    t.check("DENIED + SUSPICIOUS: the LATEST verdict decides (d2 was cleared, so only d1)", ids(sus.body).join() === d1 && sus.body.total === 1, ids(sus.body));
    const susAll = await list(c, "view=ALL&verdict=SUSPICIOUS");
    t.check("ALL + SUSPICIOUS: denied AND pending suspicious requests", new Set(ids(susAll.body)).size === 2 && ids(susAll.body).includes(p2) && ids(susAll.body).includes(d1), ids(susAll.body));
    const row = ((sus.body.rows ?? []) as Record<string, unknown>[])[0];
    t.check("each row carries its latest verdict (status + operator label) and status", (row?.review as { status?: string; by?: string })?.status === "SUSPICIOUS"
      && (row?.review as { by?: string }).by === "ops" && row?.status === "DENIED" && typeof row?.decidedAt === "string", row);

    const pg1 = await list(c, "view=ALL&pageSize=3");
    const pg3 = await list(c, "view=ALL&pageSize=3&page=3");
    t.check("server paging: page 1 has pageSize rows, total is all pages", ids(pg1.body).length === 3 && pg1.body.total === 7 && pg1.body.page === 1 && pg1.body.pageSize === 3);
    t.check("server paging: the last page holds the remainder, no overlap", ids(pg3.body).length === 1 && !ids(pg1.body).includes(ids(pg3.body)[0]));

    for (const qs of ["view=NOPE", "view=DENIED&verdict=LEGITIMATE", "view=DENIED&pageSize=101", "view=DENIED&page=0", "view=DENIED&page=abc", "view="]) {
      const bad = await list(c, qs);
      t.check(`malformed query → 400 (${qs})`, bad.status === 400 && typeof bad.body.error === "string", bad.status);
    }
    const anonBad = await list(undefined, "view=NOPE");
    t.check("the gate runs BEFORE the query is parsed (anonymous malformed → 401, not 400)", anonBad.status === 401);
  }

  t.section("3. without `view`, the legacy queue response is unchanged");
  {
    await world();
    fake.on("BetaAccessRequestEvent", "groupBy", () => []);
    seedReq("p@example.test", "PENDING", 1);
    const q = await invoke(LIST as never, request("/api/platform/growth-revenue/requests", { cookie: await cookie(READER) }));
    t.check("pending / invitations / counts, no `rows`", q.status === 200 && Array.isArray(q.body.pending) && Array.isArray(q.body.invitations)
      && typeof q.body.counts === "object" && !("rows" in q.body), Object.keys(q.body));
  }

  t.section("4. blocked state — derived from ACTIVE, unexpired blocks whose sourceRequestId is the request");
  {
    await world();
    const blocked = seedReq("blocked@example.test", "DENIED", 5);
    const expired = seedReq("expired@example.test", "DENIED", 5);
    const removed = seedReq("removed@example.test", "DENIED", 5);
    const plain = seedReq("plain@example.test", "DENIED", 5);
    const since = at(2);
    const until = new Date(Date.now() + 700 * DAY);
    fake.seed("BetaBlockedIdentifier", { identifierHmac: "a".repeat(64), keyVersion: "v1", status: "ACTIVE", sourceRequestId: blocked, reasonCode: "ABUSE", createdById: ADMIN, createdAt: since, expiresAt: until });
    fake.seed("BetaBlockedIdentifier", { identifierHmac: "b".repeat(64), keyVersion: "v1", status: "ACTIVE", sourceRequestId: expired, reasonCode: "ABUSE", createdById: ADMIN, createdAt: at(800), expiresAt: at(1) });
    fake.seed("BetaBlockedIdentifier", { identifierHmac: "c".repeat(64), keyVersion: "v1", status: "REMOVED", sourceRequestId: removed, reasonCode: "ABUSE", createdById: ADMIN, createdAt: at(3), expiresAt: until, removedAt: at(1) });
    const c = await cookie(READER);
    const r = await list(c, "view=DENIED");
    const byId = new Map(((r.body.rows ?? []) as { id: string; block: Record<string, unknown> }[]).map((x) => [x.id, x.block]));
    t.check("ACTIVE + unexpired ⇒ BLOCKED with since / expiresAt", JSON.stringify(byId.get(blocked)) === JSON.stringify({ state: "BLOCKED", since: since.toISOString(), expiresAt: until.toISOString() }), byId.get(blocked));
    t.check("ACTIVE but past expiry ⇒ NOT_BLOCKED (no longer enforced)", byId.get(expired)?.state === "NOT_BLOCKED");
    t.check("REMOVED ⇒ NOT_BLOCKED", byId.get(removed)?.state === "NOT_BLOCKED");
    t.check("no block row ⇒ NOT_BLOCKED", byId.get(plain)?.state === "NOT_BLOCKED");
    t.check("blocklist availability without a key outside Production = NOT_CONFIGURED", r.body.blocklist === "NOT_CONFIGURED", r.body.blocklist);

    t.section("5. no HMAC, key version, block id, token hash or key in either DTO");
    const blockRow = fake.one("BetaBlockedIdentifier", { sourceRequestId: blocked });
    (fake.one("BetaAccessRequest", { id: blocked }) as Record<string, unknown>).inviteTokenHash = "tokenhash-should-never-leak";
    const h = await history(c, blocked);
    const texts = [JSON.stringify(r.body), JSON.stringify((await list(c, "view=DENIED")).body), JSON.stringify(h.body)];
    for (const [label, needle] of [
      ["the HMAC", "a".repeat(64)], ["an HMAC prefix", "aaaaaaaa"], ["the block id", String(blockRow?.id)],
      ["the key version", "\"v1\""], ["the key", KEY], ["the token hash", "tokenhash-should-never-leak"],
    ] as const) {
      t.check(`neither the list nor the history carries ${label}`, texts.every((x) => !x.includes(needle)), label);
    }
    t.check("no blocklist field names leak (identifierHmac / keyVersion / hmacPrefix / blockId / inviteTokenHash)",
      texts.every((x) => !/identifierHmac|keyVersion|hmacPrefix|blockId|inviteTokenHash/.test(x)));

    t.section("6. the history GET carries status, decision instant, block state and availability");
    t.check("history: request.status + decidedAt", (h.body.request as { status?: string; decidedAt?: string })?.status === "DENIED"
      && typeof (h.body.request as { decidedAt?: string }).decidedAt === "string", h.body.request);
    t.check("history: block BLOCKED (same derivation as the list)", (h.body.block as { state?: string })?.state === "BLOCKED");
    setEnv({ key: KEY });
    t.check("availability with a key = ENFORCED", (await history(c, plain)).body.blocklist === "ENFORCED");
    setEnv({ prod: true });
    t.check("availability in Production without a key = UNAVAILABLE", (await history(c, plain)).body.blocklist === "UNAVAILABLE");
    setEnv({});
  }

  t.section("7. Deny vs Deny and block — the client model against the real routes");
  {
    await world();
    setEnv({ key: KEY });
    const c = await cookie(ADMIN);
    const post = realPoster(c);

    const a = seedReq("plain-deny@example.test", "PENDING", 2);
    calls.length = 0;
    const o1 = await runDeny(a, post);
    t.check("Deny calls ONLY the deny route", JSON.stringify(calls) === JSON.stringify(["deny"]), calls);
    t.check("Deny: status DENIED, NO block, and the outcome says it is not blocked",
      fake.one("BetaAccessRequest", { id: a })?.status === "DENIED" && activeBlocks(a).length === 0 && o1.tone === "success" && /not blocked/.test(o1.message), o1);
    t.check("the list shows the plain denial as NOT_BLOCKED", ((await list(c, "view=DENIED")).body.rows as { id: string; block: { state: string } }[]).find((x) => x.id === a)?.block.state === "NOT_BLOCKED");

    const b = seedReq("deny-block@example.test", "PENDING", 2);
    calls.length = 0;
    const o2 = await runDenyAndBlock(b, { code: "ABUSE", note: "burst" }, "burst", post);
    t.check("Deny and block calls deny FIRST, then risk-review SUSPICIOUS", JSON.stringify(calls) === JSON.stringify(["deny", "risk-review:SUSPICIOUS"]), calls);
    t.check("Deny and block: DENIED + one ACTIVE block + success outcome", fake.one("BetaAccessRequest", { id: b })?.status === "DENIED"
      && activeBlocks(b).length === 1 && o2.tone === "success" && /blocked/.test(o2.message) && !o2.offerBlockNow, o2);
    t.check("the list derives BLOCKED for it", ((await list(c, "view=DENIED&verdict=SUSPICIOUS")).body.rows as { id: string; block: { state: string } }[]).find((x) => x.id === b)?.block.state === "BLOCKED");

    // Partial failure: Production with no usable key — the deny commits (it would not block), the verdict is refused.
    const p = seedReq("partial@example.test", "PENDING", 2);
    setEnv({ prod: true });
    calls.length = 0;
    const o3 = await runDenyAndBlock(p, { code: "ABUSE" }, null, post);
    t.check("partial: both routes were called", JSON.stringify(calls) === JSON.stringify(["deny", "risk-review:SUSPICIOUS"]), calls);
    t.check("partial: the request IS denied, NOT blocked, and no verdict was kept (the verdict rolled back)",
      fake.one("BetaAccessRequest", { id: p })?.status === "DENIED" && activeBlocks(p).length === 0 && fake.rows("BetaAccessRequestReview", { requestId: p }).length === 0);
    t.check("partial: the outcome states precisely 'Denied, but NOT blocked' and offers Block now",
      o3.tone === "warning" && /^Denied, but NOT blocked/.test(o3.message) && /blocklist is unavailable/.test(o3.message) && o3.offerBlockNow, o3);

    // Block now (same SUSPICIOUS verdict) once the key is back.
    setEnv({ key: KEY });
    const o4 = await runVerdict(p, "SUSPICIOUS", { code: "ABUSE" }, null, { requestStatus: "DENIED" }, post);
    t.check("Block now: blocks the denied request", activeBlocks(p).length === 1 && o4.tone === "success" && /blocked/.test(o4.message), o4);

    // Block address on a denied request in Production with no key → honest 409 text, nothing changed.
    setEnv({ prod: true });
    const o5 = await runVerdict(a, "SUSPICIOUS", { code: "ABUSE" }, null, { requestStatus: "DENIED" }, post);
    t.check("Block address with the blocklist unavailable → 'Not recorded … Nothing was changed', no block",
      o5.tone === "error" && /^Not recorded/.test(o5.message) && /blocklist is unavailable/.test(o5.message) && activeBlocks(a).length === 0, o5);
    setEnv({ key: KEY });

    // Clear block (LEGITIMATE) removes the block this request caused; the request stays DENIED.
    const o6 = await runVerdict(b, "LEGITIMATE", { code: "SUPPORT_REQUEST" }, null, { requestStatus: "DENIED" }, post);
    t.check("Clear block: the block is removed, the request stays DENIED, the outcome says so",
      activeBlocks(b).length === 0 && fake.one("BetaAccessRequest", { id: b })?.status === "DENIED" && /block this request caused was removed/.test(o6.message), o6);

    // Outside Production with no key, Deny and block says no block was written (and offers no futile retry).
    setEnv({});
    const s = seedReq("skip@example.test", "PENDING", 2);
    const o7 = await runDenyAndBlock(s, { code: "TESTING" }, null, post);
    t.check("no key outside Production: denied + marked, 'no block was written', no Block now", o7.tone === "warning"
      && /no block was written/.test(o7.message) && !o7.offerBlockNow && activeBlocks(s).length === 0, o7);

    // A plain Deny on a request ALREADY marked Suspicious does block (the deny route's rule) — and says so.
    setEnv({ key: KEY });
    const q = seedReq("already-suspicious@example.test", "PENDING", 2);
    await runVerdict(q, "SUSPICIOUS", { code: "ABUSE" }, null, { requestStatus: "PENDING" }, post);
    t.check("a SUSPICIOUS verdict on a PENDING request blocks nothing", activeBlocks(q).length === 0);
    const o8 = await runDeny(q, post);
    t.check("…then a plain Deny blocks, and the outcome says why", activeBlocks(q).length === 1 && /already marked Suspicious/.test(o8.message), o8);
    setEnv({});
  }

  t.section("8. PB-6b — a failed blocklist read never fails the list or the history: state UNKNOWN + a note");
  {
    await world();
    const p = seedReq("pending@example.test", "PENDING", 3);
    const d = seedReq("denied@example.test", "DENIED", 2);
    // The table missing (Preview before its migration) or a transient error.
    fake.on("BetaBlockedIdentifier", "findMany", () => { throw Object.assign(new Error('relation "BetaBlockedIdentifier" does not exist'), { name: "PrismaClientKnownRequestError" }); });
    const c = await cookie(READER);
    const pend = await list(c, "view=PENDING");
    t.check("the Pending view still answers 200 with its rows", pend.status === 200 && ids(pend.body).join() === p, pend.status);
    const all = await list(c, "view=ALL");
    const rows = (all.body.rows ?? []) as { block: { state: string } }[];
    t.check("every row's block state is UNKNOWN — never NOT_BLOCKED", all.status === 200 && rows.length === 2 && rows.every((r) => r.block.state === "UNKNOWN"), rows);
    t.check("…with the note 'Block status is unavailable right now.'", Array.isArray(all.body.notes) && (all.body.notes as string[]).includes("Block status is unavailable right now."), all.body.notes);
    const h = await history(c, d);
    t.check("the history GET still answers 200, block UNKNOWN", h.status === 200 && (h.body.block as { state?: string })?.state === "UNKNOWN", h.status);
    t.check("the failure leaks no driver message into the response", !JSON.stringify(all.body).includes("does not exist") && !JSON.stringify(h.body).includes("does not exist"));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
