/**
 * app/api/connection-add-failure.test.ts  (B12 PR-B — link / exchange / wallet-add failure capture)
 *
 * The REAL exported handlers, real session cookies, the in-memory Prisma fake
 * (the real schema), the REAL policy reads. Every Plaid SDK method is trapped
 * (its behaviour set per case) and global `fetch` refuses, so nothing leaves
 * the process.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/connection-add-failure.test.ts
 *
 * Per route:
 *   • the success / ordinary-answer path is unchanged and writes NO CONNECTION_ADD_FAILED row;
 *   • the failure path answers exactly as before and writes EXACTLY ONE row whose
 *     metadata is { actorType, result, provider, stage, errorCode } — allowlisted
 *     codes only, never the provider's message, the institution, a token or an address;
 *   • when the capture itself throws, the route still answers what it always answered.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed JSON bodies */

import "@/lib/test-support/route-env";
import "@/lib/test-support/plaid-test-env";
import { PlaidApi } from "plaid";
import { FakePrisma, installFakePrisma, knownError } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP } from "@/lib/entitlements/catalogue";

const t = makeChecker("B12 PR-B — link / exchange / wallet-add failures reach Platform Operations");
const fake = new FakePrisma();
type H = (req: never, ctx?: never) => Promise<Response>;

// ── Provider traps: each Plaid method answers from `plaidBehaviour`, or rejects. ──
const SECRET_TEXT = "Example Bank says: account 000123456789 for someone@example.com, $1,234.56";
const plaidError = (code: string | null, status = 400) =>
  Object.assign(new Error("Request failed with status code " + status), {
    isAxiosError: true,
    response: { status, data: { error_code: code ?? undefined, error_type: "ITEM_ERROR", error_message: SECRET_TEXT, display_message: null, request_id: "req-secret" } },
  });
let plaidBehaviour: Record<string, () => Promise<unknown>> = {};
let plaidCalls: string[] = [];
for (const name of Object.getOwnPropertyNames(PlaidApi.prototype)) {
  if (name === "constructor") continue;
  (PlaidApi.prototype as any)[name] = function trapped() {
    plaidCalls.push(name);
    const b = plaidBehaviour[name];
    return b ? b() : Promise.reject(new Error(`unexpected Plaid ${name}`));
  };
}
globalThis.fetch = (async () => { throw new Error("network call in a unit test"); }) as typeof fetch;

const failedRows = () => fake.rows("AuditLog", { action: "CONNECTION_ADD_FAILED" });
const META_KEYS = JSON.stringify(["actorType", "errorCode", "provider", "result", "stage"]);
function isCleanRow(row: Record<string, unknown> | undefined, userId: string, provider: string, stage: string, errorCode: string): boolean {
  if (!row) return false;
  const m = row.metadata as Record<string, unknown>;
  return row.userId === userId && row.ipAddress === null && row.userAgent === null
    && JSON.stringify(Object.keys(m).sort()) === META_KEYS
    && m.actorType === "USER" && m.result === "FAILURE"
    && m.provider === provider && m.stage === stage && m.errorCode === errorCode
    && !JSON.stringify(row).includes("Example Bank") && !JSON.stringify(row).includes("000123456789")
    && !JSON.stringify(row).includes("someone@example.com") && !JSON.stringify(row).includes("req-secret");
}
/** Make every AuditLog create for CONNECTION_ADD_FAILED throw (the capture's own failure). */
const breakCapture = () => fake.on("AuditLog", "create", (args) => {
  if ((args.data as Record<string, unknown> | undefined)?.action === "CONNECTION_ADD_FAILED") throw knownError("P2024", "capture store unavailable");
  return undefined;
});

async function main() {
  await installFakePrisma(fake);
  const { GET: LINK } = await import("./plaid/link-token/route") as unknown as { GET: H };
  const { POST: EXCHANGE } = await import("./plaid/exchange-token/route") as unknown as { POST: H };
  const { POST: WALLET } = await import("./accounts/wallet/route") as unknown as { POST: H };
  const C = await import("@/lib/platform/policies/policy-group-catalogue");
  fake.reset();
  freshCache();
  C.invalidatePolicyGroupCatalogue();

  fake.seed("PolicyGroup", { key: DEFAULT_POLICY_GROUP, label: BETA_FULL_ACCESS_V1.label, description: "", isDefault: true, builtIn: true, currentVersion: 1, lifecycle: "ACTIVE", costFrozen: false });
  fake.seed("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 1, values: { ...BETA_FULL_ACCESS_V1.values }, label: BETA_FULL_ACCESS_V1.label, changeSummary: { kind: "SEEDED", changes: [] }, reasonCode: "POLICY_ROLLOUT" });
  const u = fake.seed("User", { email: "link@example.test", username: "linker", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  const userId = u.id as string;
  fake.seed("CustomerPolicyAssignment", { userId, policyGroup: DEFAULT_POLICY_GROUP });
  const session = await signIn(fake, userId);
  const space = fake.seed("Space", { name: "Personal", type: "PERSONAL" });
  fake.seed("SpaceMember", { spaceId: space.id, userId, role: "OWNER", status: "ACTIVE" });
  const item = fake.seed("PlaidItem", { userId, externalItemId: "ext_dup", institutionId: "ins_dup", institutionName: "Dup Bank", encryptedToken: "x", status: "ACTIVE" });
  const wallet = fake.seed("FinancialAccount", { ownerType: "USER", ownerUserId: userId, createdByUserId: userId, name: "ETH", type: "crypto", currency: "USD",
    walletChain: "ETH", walletAddress: "0x00000000000000000000000000000000000000aa" });
  void item;

  const link = () => { freshCache(); return invoke<Record<string, any>>(LINK, request("/api/plaid/link-token", { method: "GET", cookie: session.cookie })); };
  const exchange = (body: unknown) => { freshCache(); return invoke<Record<string, any>>(EXCHANGE, request("/api/plaid/exchange-token", { method: "POST", cookie: session.cookie, body })); };
  const addWallet = (body: unknown, raw?: string) => {
    freshCache();
    return invoke<Record<string, any>>(WALLET, request("/api/accounts/wallet", raw !== undefined
      ? { method: "POST", cookie: session.cookie, rawBody: raw, headers: { "content-type": "application/json" } }
      : { method: "POST", cookie: session.cookie, body }));
  };

  // ── GET /api/plaid/link-token ────────────────────────────────────────────────
  t.section("link-token — success is unchanged, nothing captured");
  {
    fake.clearHooks(); plaidCalls = [];
    plaidBehaviour = { linkTokenCreate: async () => ({ data: { link_token: "link-sandbox-ok" } }) };
    const before = failedRows().length;
    const r = await link();
    t.check("200 { link_token }", r.status === 200 && r.body.link_token === "link-sandbox-ok", { s: r.status, b: r.body });
    t.check("no CONNECTION_ADD_FAILED row", failedRows().length === before);
  }

  t.section("link-token — a Plaid failure: same answer, ONE allowlisted row");
  {
    fake.clearHooks();
    plaidBehaviour = { linkTokenCreate: async () => { throw plaidError("INSTITUTION_DOWN"); } };
    const before = failedRows().length;
    const r = await link();
    t.check("the response is the route's own error (not a capture artefact)", r.status === 400 && typeof r.body.error === "string" && !("capture" in r.body), { s: r.status, b: r.body });
    const rows = failedRows().slice(before);
    t.check("exactly one row", rows.length === 1, rows.length);
    t.check("{PLAID, LINK_TOKEN, INSTITUTION_DOWN}, no provider text / ids", isCleanRow(rows[0], userId, "PLAID", "LINK_TOKEN", "INSTITUTION_DOWN"), rows[0]);
  }

  t.section("link-token — an unknown provider code is stored as OTHER, a code-less HTTP error as PROVIDER_HTTP_ERROR");
  {
    fake.clearHooks();
    plaidBehaviour = { linkTokenCreate: async () => { throw plaidError("SOME_NEW_PLAID_CODE_2027"); } };
    let before = failedRows().length;
    await link();
    t.check("unknown code ⇒ OTHER", isCleanRow(failedRows().slice(before)[0], userId, "PLAID", "LINK_TOKEN", "OTHER"), failedRows().slice(before));
    plaidBehaviour = { linkTokenCreate: async () => { throw plaidError(null, 502); } };
    before = failedRows().length;
    await link();
    t.check("no code ⇒ PROVIDER_HTTP_ERROR", isCleanRow(failedRows().slice(before)[0], userId, "PLAID", "LINK_TOKEN", "PROVIDER_HTTP_ERROR"), failedRows().slice(before));
  }

  t.section("link-token — the capture itself throws: the response is unchanged");
  {
    fake.clearHooks();
    plaidBehaviour = { linkTokenCreate: async () => { throw plaidError("INSTITUTION_DOWN"); } };
    const control = await link();
    breakCapture();
    const before = failedRows().length;
    const r = await link();
    t.check("same status and body as with a working capture", r.status === control.status && JSON.stringify(r.body) === JSON.stringify(control.body), { s: r.status, b: r.body });
    t.check("…and no row", failedRows().length === before);
  }

  // ── POST /api/plaid/exchange-token ───────────────────────────────────────────
  t.section("exchange-token — an ordinary answer (400 missing fields) is unchanged, nothing captured");
  {
    fake.clearHooks(); plaidBehaviour = {};
    const before = failedRows().length;
    const r = await exchange({ public_token: "public-sandbox-x" });
    t.check("400 Missing required fields", r.status === 400 && r.body.error === "Missing required fields", { s: r.status, b: r.body });
    t.check("no row", failedRows().length === before);
  }

  t.section("exchange-token — a deliberate refusal (duplicate institution, 409) is not a failure");
  {
    fake.clearHooks();
    plaidBehaviour = {
      itemPublicTokenExchange: async () => ({ data: { access_token: "access-sandbox-dup", item_id: "item-dup-2" } }),
      itemRemove: async () => ({ data: {} }),
    };
    const before = failedRows().length;
    const r = await exchange({ public_token: "public-sandbox-dup", institution_id: "ins_dup", institution_name: "Dup Bank" });
    t.check("409 with the duplicate shape", r.status === 409 && typeof r.body.existingItemId === "string", { s: r.status, b: r.body });
    t.check("no row", failedRows().length === before);
  }

  t.section("exchange-token — a Plaid failure: same answer, ONE allowlisted row");
  {
    fake.clearHooks();
    plaidBehaviour = { itemPublicTokenExchange: async () => { throw plaidError("INVALID_PUBLIC_TOKEN_NOT_IN_VOCAB"); } };
    let before = failedRows().length;
    let r = await exchange({ public_token: "public-sandbox-bad", institution_id: "ins_9", institution_name: "Example Bank" });
    t.check("the route's own answer for an unrecognised Plaid code (500, generic message)", r.status === 500 && r.body.error === "Failed to connect account", { s: r.status, b: r.body });
    let rows = failedRows().slice(before);
    t.check("exactly one row, {PLAID, EXCHANGE, OTHER} (code outside the vocabulary)", rows.length === 1 && isCleanRow(rows[0], userId, "PLAID", "EXCHANGE", "OTHER"), rows);

    plaidBehaviour = { itemPublicTokenExchange: async () => { throw plaidError("RATE_LIMIT_EXCEEDED", 429); } };
    before = failedRows().length;
    r = await exchange({ public_token: "public-sandbox-bad", institution_id: "ins_9", institution_name: "Example Bank" });
    rows = failedRows().slice(before);
    t.check("429 answered as before; one row {PLAID, EXCHANGE, RATE_LIMIT_EXCEEDED}",
      r.status === 429 && rows.length === 1 && isCleanRow(rows[0], userId, "PLAID", "EXCHANGE", "RATE_LIMIT_EXCEEDED"), { s: r.status, rows });
  }

  t.section("exchange-token — a non-JSON body: same 500, one INVALID_BODY row");
  {
    fake.clearHooks();
    freshCache();
    const before = failedRows().length;
    const r = await invoke<Record<string, any>>(EXCHANGE, request("/api/plaid/exchange-token", { method: "POST", cookie: session.cookie, rawBody: "{not json", headers: { "content-type": "application/json" } }));
    const rows = failedRows().slice(before);
    t.check("500 { error }", r.status === 500 && typeof r.body.error === "string", { s: r.status, b: r.body });
    t.check("one row {PLAID, EXCHANGE, INVALID_BODY}", rows.length === 1 && isCleanRow(rows[0], userId, "PLAID", "EXCHANGE", "INVALID_BODY"), rows);
  }

  t.section("exchange-token — the capture itself throws: the response is unchanged");
  {
    fake.clearHooks();
    plaidBehaviour = { itemPublicTokenExchange: async () => { throw plaidError("INSTITUTION_DOWN"); } };
    const body = { public_token: "public-sandbox-bad", institution_id: "ins_9", institution_name: "Example Bank" };
    const control = await exchange(body);
    breakCapture();
    const before = failedRows().length;
    const r = await exchange(body);
    t.check("same status and body", r.status === control.status && JSON.stringify(r.body) === JSON.stringify(control.body), { s: r.status, b: r.body });
    t.check("…and no row", failedRows().length === before);
  }

  t.section("exchange-token — unauthenticated: 401, nothing captured");
  {
    fake.clearHooks();
    const before = failedRows().length;
    const r = await invoke<Record<string, any>>(EXCHANGE, request("/api/plaid/exchange-token", { method: "POST", body: { public_token: "p", institution_id: "i", institution_name: "n" } }));
    t.check("401", r.status === 401, r.status);
    t.check("no row (no identity to attribute)", failedRows().length === before);
  }

  // ── POST /api/accounts/wallet ────────────────────────────────────────────────
  t.section("wallet — a re-add of an active wallet succeeds as before, nothing captured");
  {
    fake.clearHooks(); plaidBehaviour = {};
    const before = failedRows().length;
    const r = await addWallet({ name: "ETH", walletChain: "ETH", walletAddress: wallet.walletAddress });
    t.check("200 { success, accountId }", r.status === 200 && r.body.success === true && r.body.accountId === wallet.id, { s: r.status, b: r.body });
    t.check("no row", failedRows().length === before);
  }

  t.section("wallet — validation answers (400) are not failures");
  {
    fake.clearHooks();
    const before = failedRows().length;
    const r = await addWallet({ name: "x", walletChain: "NOT_A_CHAIN", walletAddress: "abc" });
    t.check("400", r.status === 400, { s: r.status, b: r.body });
    t.check("no row", failedRows().length === before);
  }

  t.section("wallet — the add THROWS: rethrown as before, ONE allowlisted row");
  {
    fake.clearHooks();
    fake.on("FinancialAccount", "findFirst", () => { throw knownError("P1001", "Can't reach database server at db.example:5432"); });
    const before = failedRows().length;
    let thrown: unknown = null;
    try { await addWallet({ name: "Cold storage", walletChain: "ETH", walletAddress: "0x00000000000000000000000000000000000000bb" }); }
    catch (e) { thrown = e; }
    fake.clearHooks();
    t.check("the ORIGINAL error propagates (the framework's 500, unchanged)", thrown instanceof Error && /Can't reach database server/.test((thrown as Error).message), String(thrown));
    const rows = failedRows().slice(before);
    t.check("exactly one row {WALLET, WALLET_ADD, DATABASE_ERROR}", rows.length === 1 && isCleanRow(rows[0], userId, "WALLET", "WALLET_ADD", "DATABASE_ERROR"), rows);
    t.check("the row names neither the address nor the wallet name", !JSON.stringify(rows).includes("0x000") && !JSON.stringify(rows).includes("Cold storage"));
  }

  t.section("wallet — a non-JSON body: rethrown, one INVALID_BODY row");
  {
    fake.clearHooks();
    const before = failedRows().length;
    let thrown: unknown = null;
    try { await addWallet(undefined, "{nope"); } catch (e) { thrown = e; }
    const rows = failedRows().slice(before);
    t.check("SyntaxError propagates", thrown instanceof SyntaxError, String(thrown));
    t.check("one row {WALLET, WALLET_ADD, INVALID_BODY}", rows.length === 1 && isCleanRow(rows[0], userId, "WALLET", "WALLET_ADD", "INVALID_BODY"), rows);
  }

  t.section("wallet — the capture itself throws: the ORIGINAL error still propagates");
  {
    fake.clearHooks();
    breakCapture();
    fake.on("FinancialAccount", "findFirst", () => { throw knownError("P1001", "Can't reach database server"); });
    const before = failedRows().length;
    let thrown: unknown = null;
    try { await addWallet({ name: "x", walletChain: "ETH", walletAddress: "0x00000000000000000000000000000000000000cc" }); }
    catch (e) { thrown = e; }
    fake.clearHooks();
    t.check("the route's own error, not the capture's", thrown instanceof Error && /Can't reach database server/.test((thrown as Error).message) && (thrown as { code?: string }).code === "P1001", String(thrown));
    t.check("…and no row", failedRows().length === before);
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
