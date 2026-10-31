/**
 * app/api/cost-freeze-enforcement.test.ts  (BETA LIFECYCLE L2 — Cost Freeze enforcement, request paths)
 *
 * The REAL exported handlers, real session cookies, the in-memory Prisma fake
 * (the real schema), the REAL policy reads. The Plaid SDK's every method and
 * global `fetch` are trapped: a refused operation that reached a provider would
 * fail the run. Under Cost Freeze — which beats the Founder overlay and the
 * per-customer AI override — and an unverifiable policy, every path that starts
 * a paid Plaid subscription or paid crypto / price work is refused BEFORE the
 * provider, with the owner's lifecycle wording, and leaves no state behind.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/cost-freeze-enforcement.test.ts
 *
 *   POST /api/plaid/exchange-token          new Item AND update-mode repair (no Item created, token unspent)
 *   POST /api/plaid/link-token              new link: lifecycle wording, never "Connection limit reached"
 *   POST /api/plaid/resume-sync             refused BEFORE the incomplete-import marker is rewritten
 *   POST /api/accounts/wallet               re-adding an ACTIVE wallet runs no chain sync / history
 *   POST /api/connections/build-intelligence  no price-vendor rebuild
 *   POST …/platform-ops/connections/[id]/resync  operator refused, ledgered SKIPPED, cooldown unspent
 *   POST /api/admin/plaid/expand-history-token + exchange-expanded-history-token  operator refused
 *   GLOBAL cost freeze (platform_cost_frozen) beats an ACTIVE group; an invalid flag fails closed
 *   shared Space billing owner (billedOwnerOf), per-user lifecycle state (the comms guard API),
 *   ≤ 30 s propagation (clock-pinned), readers still available
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed JSON bodies */

import "@/lib/test-support/route-env";
import "@/lib/test-support/plaid-test-env";
import { PlaidApi } from "plaid";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1 } from "@/lib/entitlements/catalogue";
import { RESTRICTION_CODES, restrictionMessage } from "@/lib/entitlements/restriction-messages";

const t = makeChecker("Cost Freeze enforcement — request paths (L2)");
const fake = new FakePrisma();
const BETA = BETA_FULL_ACCESS_V1.values;
type H = (req: never, ctx?: never) => Promise<Response>;

// ── Provider traps ────────────────────────────────────────────────────────────
let plaidCalls: string[] = [];
for (const name of Object.getOwnPropertyNames(PlaidApi.prototype)) {
  if (name === "constructor") continue;
  (PlaidApi.prototype as any)[name] = function trapped() { plaidCalls.push(name); return Promise.reject(new Error(`Plaid ${name} called in a frozen test`)); };
}
let fetchCalls = 0;
globalThis.fetch = (async () => { fetchCalls++; throw new Error("network call in a frozen test"); }) as typeof fetch;

async function main() {
  await installFakePrisma(fake);
  const { POST: EXCHANGE } = await import("./plaid/exchange-token/route") as unknown as { POST: H };
  const { GET: LINK } = await import("./plaid/link-token/route") as unknown as { GET: H };
  const { POST: RESUME } = await import("./plaid/resume-sync/route") as unknown as { POST: H };
  const { POST: WALLET } = await import("./accounts/wallet/route") as unknown as { POST: H };
  const { POST: BUILD } = await import("./connections/build-intelligence/route") as unknown as { POST: H };
  const { POST: RESYNC } = await import("./platform/platform-ops/connections/[id]/resync/route") as unknown as { POST: H };
  const { POST: EXPAND_TOKEN } = await import("./admin/plaid/expand-history-token/route") as unknown as { POST: H };
  const { POST: EXPAND_EXCHANGE } = await import("./admin/plaid/exchange-expanded-history-token/route") as unknown as { POST: H };
  const { GET: BRIEF_GET } = await import("./brief/route") as unknown as { GET: H };
  const C = await import("@/lib/platform/policies/policy-group-catalogue");
  const { assertBillableAllowed } = await import("@/lib/entitlements/billable-gate");
  const { decideBillable } = await import("@/lib/entitlements/billable-gate-core");
  const { getBetaLifecycleStateForUser, getBetaLifecycleStatesForUsers } = await import("@/lib/entitlements/beta-lifecycle");
  const { entitlementsForUser, refuseIfDisabled } = await import("@/lib/entitlements/consume");
  const { performPlaidTokenExchange, BillableRestrictedError } = await import("@/lib/plaid/exchangeToken");
  fake.reset();
  freshCache();
  C.invalidatePolicyGroupCatalogue();

  fake.seed("PolicyGroup", { key: DEFAULT_POLICY_GROUP, label: BETA_FULL_ACCESS_V1.label, description: "", isDefault: true, builtIn: true, currentVersion: 1 });
  fake.seed("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 1, values: { ...BETA }, label: BETA_FULL_ACCESS_V1.label, changeSummary: { kind: "SEEDED", changes: [] }, reasonCode: "POLICY_ROLLOUT" });

  // The customer: a FOUNDER with a $20 per-customer AI override — nothing user-level may lift a freeze.
  const u = fake.seed("User", { email: "beta@example.test", username: "betacust", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  const userId = u.id as string;
  fake.seed("CustomerPolicyAssignment", { userId, policyGroup: DEFAULT_POLICY_GROUP, overlay: FOUNDER_INTERNAL_V1.key, aiDailyUsdAllowanceOverride: 20 });
  const session = await signIn(fake, userId);
  const space = fake.seed("Space", { name: "Personal", type: "PERSONAL" });
  fake.seed("SpaceMember", { spaceId: space.id, userId, role: "OWNER", status: "ACTIVE" });
  const anHourAgo = new Date(Date.now() - 3_600_000);
  const item = fake.seed("PlaidItem", { userId, externalItemId: "ext_1", institutionId: "ins_1", institutionName: "Bank A", encryptedToken: "x", status: "ACTIVE",
    cursor: "cursor-page-7", lastManualRefreshAt: null, syncIncompleteAt: anHourAgo, syncResumeAttempts: 2 });
  const fa = fake.seed("FinancialAccount", { ownerType: "USER", ownerUserId: userId, createdByUserId: userId, name: "Checking", type: "checking", currency: "USD", mask: "1234" });
  fake.seed("AccountConnection", { financialAccountId: fa.id, connectedByUserId: userId, plaidItemDbId: item.id });
  const wallet = fake.seed("FinancialAccount", { ownerType: "USER", ownerUserId: userId, createdByUserId: userId, name: "BTC", type: "crypto", currency: "USD", walletChain: "BTC", walletAddress: "bc1qexamplewalletaddress0000000000000000" });

  const admin = fake.seed("User", { email: "ops@example.test", username: "ops", passwordHash: "x", emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
  const adminSession = await signIn(fake, admin.id as string);
  const op = fake.seed("User", { email: "op@example.test", username: "op", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  fake.seed("PlatformGrant", { userId: op.id, area: "PLATFORM_OPS", level: "WRITE", status: "ACTIVE" });
  const opSession = await signIn(fake, op.id as string);

  const group = () => fake.rows("PolicyGroup", { key: DEFAULT_POLICY_GROUP })[0];
  const setState = (p: Record<string, unknown>) => { Object.assign(group(), { lifecycle: "ACTIVE", costFrozen: false, endedTransition: null }, p); C.invalidatePolicyGroupCatalogue(); };
  const setFlag = (v: string | null) => {
    // null = never configured: an existing row is set to "false", which the flag's contract reads identically.
    const row = fake.rows("PlatformSetting", { key: "platform_cost_frozen" })[0];
    if (row) row.value = v ?? "false";
    else if (v !== null) fake.seed("PlatformSetting", { key: "platform_cost_frozen", value: v });
    C.invalidatePolicyGroupCatalogue();
  };
  const call = (h: H, p: string, body?: unknown, cookie = session.cookie, params: Record<string, unknown> = {}) =>
    invoke<Record<string, any>>(h, request(p, { method: "POST", cookie, ...(body !== undefined ? { body } : {}) }), params);
  const isRefusal = (r: { status: number; body: Record<string, any> }, kind: keyof typeof RESTRICTION_CODES) =>
    r.status === (kind === "POLICY_UNAVAILABLE" ? 503 : 403) && r.body.error === restrictionMessage(kind) && r.body.code === RESTRICTION_CODES[kind];
  const snapshotItem = () => JSON.stringify(fake.rows("PlaidItem").map((r) => ({ ...r, updatedAt: undefined })));

  const STATES: [string, () => void, keyof typeof RESTRICTION_CODES][] = [
    ["COST_FREEZE (group, Founder overlay + $20 override)", () => { fake.clearHooks(); setFlag(null); setState({ costFrozen: true }); }, "COST_FREEZE"],
    ["GLOBAL cost freeze over an ACTIVE group", () => { fake.clearHooks(); setState({}); setFlag("true"); }, "COST_FREEZE"],
    ["policy unverifiable (lifecycle read fails)", () => {
      setFlag(null); setState({});
      fake.on("PolicyGroup", "findMany", (args) => { if ((args.select as Record<string, unknown> | undefined)?.lifecycle) throw new Error('column "lifecycle" does not exist'); return undefined; });
    }, "POLICY_UNAVAILABLE"],
    ["global flag unreadable (invalid value)", () => { fake.clearHooks(); setState({}); setFlag("maybe"); }, "POLICY_UNAVAILABLE"],
  ];

  for (const [label, apply, kind] of STATES) {
    t.section(label);
    apply();
    plaidCalls = []; const fetchBefore = fetchCalls;
    const itemsBefore = snapshotItem();
    const execBefore = fake.rows("RefreshExecution").length;

    const ex = await call(EXCHANGE, "/api/plaid/exchange-token", { public_token: "public-sandbox-new", institution_id: "ins_9", institution_name: "New Bank" });
    t.check(`exchange-token, NEW Item → ${kind} wording`, isRefusal(ex, kind), { s: ex.status, b: ex.body });
    const repair = await call(EXCHANGE, "/api/plaid/exchange-token", { public_token: "public-sandbox-repair", institution_id: "ins_1", institution_name: "Bank A" });
    t.check("exchange-token, update-mode REPAIR of the existing Item → refused the same way", isRefusal(repair, kind), { s: repair.status, b: repair.body });
    t.check("…no Item created or changed (the duplicate check never had to remove one at Plaid)", snapshotItem() === itemsBefore);

    const link = await invoke<Record<string, any>>(LINK, request("/api/plaid/link-token", { method: "GET", cookie: session.cookie }));
    t.check("link-token (new link) → the lifecycle wording, never \"Connection limit reached\"",
      isRefusal(link, kind) && !String(link.body.error).includes("Connection limit"), { s: link.status, b: link.body });

    const resume = await call(RESUME, "/api/plaid/resume-sync", { plaidItemId: item.id });
    t.check("resume-sync → refused", isRefusal(resume, kind), { s: resume.status, b: resume.body });
    t.check("…BEFORE the import-incomplete marker is rewritten (syncIncompleteAt, attempts, cursor identical)", snapshotItem() === itemsBefore);

    const build = await call(BUILD, "/api/connections/build-intelligence", { connectionIds: [item.id] });
    t.check("build-intelligence (price-vendor rebuild) → refused", isRefusal(build, kind), { s: build.status, b: build.body });

    const readd = await call(WALLET, "/api/accounts/wallet", { name: "BTC", walletChain: "BTC", walletAddress: wallet.walletAddress });
    t.check("re-adding an ACTIVE wallet: the share succeeds, but NO chain sync / quote / history (PLAN_RESTRICTED)",
      readd.status === 200 && readd.body.initialSync?.ok === false && readd.body.initialSync?.errorCode === "PLAN_RESTRICTED", { s: readd.status, b: readd.body });

    const resync = await call(RESYNC, `/api/platform/platform-ops/connections/${item.id}/resync`, undefined, opSession.cookie, { id: item.id });
    t.check("operator resync of the customer's Item → refused with the customer's restriction", isRefusal(resync, kind), { s: resync.status, b: resync.body });
    const skipped = fake.rows("RefreshExecution").slice(execBefore);
    t.check("…ledgered as ONE SKIPPED execution with the billable skip code (never completed)",
      skipped.length === 1 && skipped[0].overallStatus === "SKIPPED" && String(skipped[0].admissionReason).startsWith("BILLABLE_"), skipped.map((r) => ({ s: r.overallStatus, a: r.admissionReason })));
    t.check("…and the 60-minute operator cooldown is NOT consumed", fake.rows("PlaidItem", { id: item.id })[0].lastManualRefreshAt === null);
    t.check("…audited as REFUSED", fake.rows("AuditLog", { action: "CONNECTION_RESYNC_TRIGGERED" }).some((a) => a.result === "REFUSED" || JSON.stringify(a).includes("plan-restricted")));

    const et = await call(EXPAND_TOKEN, "/api/admin/plaid/expand-history-token", { plaidItemId: item.id }, adminSession.cookie);
    // The Item is mid-import (syncIncompleteAt set), so the route's own validation answers first; prove the
    // gate on a completed copy below. Either way: no Plaid call.
    t.check("admin expand-history-token → no Plaid call (refused)", et.status >= 400, { s: et.status, b: et.body });
    const ee = await call(EXPAND_EXCHANGE, "/api/admin/plaid/exchange-expanded-history-token", { publicToken: "public-x", oldPlaidItemId: item.id }, adminSession.cookie);
    t.check("admin exchange-expanded-history-token (creates a NEW Item) → refused with the restriction", isRefusal(ee, kind), { s: ee.status, b: ee.body });

    t.check("ZERO Plaid SDK calls on every path above", plaidCalls.length === 0, plaidCalls);
    t.check("ZERO network calls (crypto explorers, CoinGecko, Tiingo)", fetchCalls === fetchBefore);
    t.check("Item state identical after every refusal (status, cursor, marker, retry counter, cooldown)", snapshotItem() === itemsBefore);
  }

  t.section("admin Expand History on a COMPLETED Item (passes the route's own validation) — refused before linkTokenCreate");
  {
    fake.clearHooks(); setFlag(null); setState({ costFrozen: true });
    const done = fake.seed("PlaidItem", { userId, externalItemId: "ext_done", institutionId: "ins_7", institutionName: "Done Bank", encryptedToken: "x", status: "ACTIVE", cursor: "c", syncIncompleteAt: null });
    const dfa = fake.seed("FinancialAccount", { ownerType: "USER", ownerUserId: userId, createdByUserId: userId, name: "Sav", type: "savings", currency: "USD", mask: "9999" });
    fake.seed("AccountConnection", { financialAccountId: dfa.id, connectedByUserId: userId, plaidItemDbId: done.id });
    plaidCalls = [];
    const r = await call(EXPAND_TOKEN, "/api/admin/plaid/expand-history-token", { plaidItemId: done.id }, adminSession.cookie);
    t.check("expand-history-token → COST_FREEZE refusal for the institution OWNER", isRefusal(r, "COST_FREEZE"), { s: r.status, b: r.body });
    t.check("…no linkTokenCreate", plaidCalls.length === 0, plaidCalls);
  }

  t.section("the exchange core: refused before ANY Plaid call (direct)");
  {
    plaidCalls = [];
    let thrown: unknown = null;
    try { await performPlaidTokenExchange({ userId, spaceId: space.id as string, public_token: "p", institution_id: "i", institution_name: "n" }, { billable: async () => { throw new Error("must not be swallowed into allowed"); } }); }
    catch (e) { thrown = e; }
    t.check("a policy read that THROWS never becomes an exchange (it propagates; zero Plaid calls)", thrown !== null && plaidCalls.length === 0);
    try { await performPlaidTokenExchange({ userId, spaceId: space.id as string, public_token: "p", institution_id: "i", institution_name: "n" }); thrown = null; }
    catch (e) { thrown = e; }
    t.check("real gate under COST_FREEZE ⇒ BillableRestrictedError(COST_FREEZE), zero Plaid calls",
      thrown instanceof BillableRestrictedError && (thrown as InstanceType<typeof BillableRestrictedError>).reason === "COST_FREEZE" && plaidCalls.length === 0);
  }

  t.section("Cost Freeze beats the Founder overlay and the per-customer AI override");
  {
    setState({ costFrozen: true });
    const d = await assertBillableAllowed({ userId, operation: "ai_chat" });
    t.check("ai_chat for a Founder with a $20 override ⇒ COST_FREEZE", !d.allowed && (d as any).reason === "COST_FREEZE");
    const e = await entitlementsForUser(userId);
    t.check("…and the resolver agrees (allowance 0, restriction COST_FREEZE)", e.lifecycleRestriction === "COST_FREEZE" && e.dimensions.aiDailyUsdAllowance.value === 0);
  }

  t.section("shared Spaces: an explicit billing owner, never the earliest owner");
  {
    setState({});
    const mk = (name: string) => fake.seed("User", { email: `${name}@example.test`, username: name, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
    const earliest = mk("earliest"); const later = mk("later");
    fake.seed("CustomerPolicyAssignment", { userId: earliest.id, policyGroup: DEFAULT_POLICY_GROUP });
    fake.seed("CustomerPolicyAssignment", { userId: later.id, policyGroup: DEFAULT_POLICY_GROUP });
    const shared = fake.seed("Space", { name: "Shared", type: "SHARED" });
    fake.seed("SpaceMember", { spaceId: shared.id, userId: earliest.id, role: "OWNER", status: "ACTIVE", joinedAt: new Date("2025-01-01") });
    fake.seed("SpaceMember", { spaceId: shared.id, userId: later.id, role: "OWNER", status: "ACTIVE", joinedAt: new Date("2026-01-01") });
    const two = await assertBillableAllowed({ spaceId: shared.id as string, operation: "price_history" });
    t.check("2 ACTIVE owners ⇒ NO_OWNER (refused) — the earliest owner's allowed plan is never consulted", !two.allowed && (two as any).reason === "NO_OWNER");
    const empty = fake.seed("Space", { name: "Empty", type: "SHARED" });
    const none = await assertBillableAllowed({ spaceId: empty.id as string, operation: "price_history" });
    t.check("0 ACTIVE owners ⇒ NO_OWNER", !none.allowed && (none as any).reason === "NO_OWNER");
    const one = await assertBillableAllowed({ spaceId: space.id as string, operation: "price_history" });
    t.check("exactly 1 ACTIVE owner ⇒ that owner's decision", one.allowed);
  }

  t.section("per-user lifecycle state (the comms send-time guard's API)");
  {
    fake.clearHooks(); setFlag(null);
    for (const [p, want] of [[{}, "ACTIVE"], [{ lifecycle: "PAUSED" }, "PAUSED"], [{ lifecycle: "ENDED", endedTransition: "READ_ONLY" }, "ENDED"],
      [{ costFrozen: true }, "COST_FREEZE"], [{ costFrozen: true, lifecycle: "ENDED" }, "COST_FREEZE"], [{ costFrozen: true, lifecycle: "PAUSED" }, "COST_FREEZE"]] as const) {
      setState(p as Record<string, unknown>);
      const s = await getBetaLifecycleStateForUser(userId);
      t.check(`${JSON.stringify(p)} ⇒ ${want} (a Founder overlay changes nothing)`, s === want, s);
    }
    setState({}); setFlag("true");
    t.check("GLOBAL cost freeze ⇒ COST_FREEZE", (await getBetaLifecycleStateForUser(userId)) === "COST_FREEZE");
    setFlag(null);
    fake.on("PolicyGroup", "findMany", (args) => { if ((args.select as Record<string, unknown> | undefined)?.lifecycle) throw new Error("down"); return undefined; });
    C.invalidatePolicyGroupCatalogue();
    t.check("policy unverifiable ⇒ UNKNOWN (never defaults to ACTIVE)", (await getBetaLifecycleStateForUser(userId)) === "UNKNOWN");
    fake.clearHooks(); C.invalidatePolicyGroupCatalogue();
    fake.on("CustomerPolicyAssignment", "findMany", () => { throw new Error("down"); });
    t.check("assignment read fails ⇒ UNKNOWN", (await getBetaLifecycleStateForUser(userId)) === "UNKNOWN");
    fake.clearHooks(); C.invalidatePolicyGroupCatalogue();
    const before = fake.callsTo("CustomerPolicyAssignment", "findMany").length;
    const ids = [userId, admin.id as string, op.id as string, "no-such-user"];
    const m = await getBetaLifecycleStatesForUsers(ids, undefined, { failClosed: true });
    t.check("the batch form makes ONE assignment read for every user", fake.callsTo("CustomerPolicyAssignment", "findMany").length - before === 1);
    t.check("…every id answered; an unassigned user under the fail-closed switch ⇒ UNKNOWN", m.size === 4 && m.get(userId) === "ACTIVE" && m.get("no-such-user") === "UNKNOWN", [...m]);
  }

  t.section("propagation ≤ 30 s (clock-pinned)");
  {
    fake.clearHooks(); setFlag(null); setState({});
    let now = Date.parse("2026-10-31T12:00:00Z");
    C.setPolicyGroupCatalogueClockForTests(() => now);
    C.invalidatePolicyGroupCatalogue();
    // The read takes 2 s, and the freeze is written right AFTER its lifecycle query (the worst case).
    fake.on("PolicyGroup", "findMany", () => { now += 1_000; return undefined; });
    const readStart = now;
    await C.loadPolicyGroupCatalogue();
    const writtenAt = now;
    fake.clearHooks();
    Object.assign(group(), { costFrozen: true }); // another instance froze the group — no local invalidation here
    const at = async (ms: number) => { now = writtenAt + ms; return assertBillableAllowed({ userId, operation: "plaid_sync" }, { now: () => now }); };
    const early = await at(1_000);
    t.check("just after the write, the cached read may still allow (bounded staleness)", early.allowed);
    const bound = readStart + C.CATALOGUE_TTL_MS - writtenAt;
    const seen = await at(bound + 1);
    t.check(`the freeze is enforced ${bound + 1} ms after the write — within 30 s (TTL 25 s stamped from the read START)`,
      !seen.allowed && (seen as any).reason === "COST_FREEZE" && bound + 1 <= 30_000, { bound, seen });
    C.setPolicyGroupCatalogueClockForTests(null);
    C.invalidatePolicyGroupCatalogue();
  }

  t.section("readers stay available while frozen");
  {
    fake.clearHooks(); setFlag(null); setState({ costFrozen: true });
    const e = await entitlementsForUser(userId);
    t.check("existing Briefs: the read gate (dailyBrief) stays open", e.dimensions.dailyBrief.value === true && refuseIfDisabled(e, "dailyBrief", "The Daily Brief") === null);
    const read = await invoke<Record<string, any>>(BRIEF_GET, request(`/api/brief?spaceId=${space.id}`, { method: "GET", cookie: session.cookie }));
    t.check("GET /api/brief is not a restriction refusal", read.body?.code !== RESTRICTION_CODES.COST_FREEZE, { s: read.status, b: read.body });
    const catalogue = await C.loadFreshPolicyGroupCatalogue();
    const exp = decideBillable({ operation: "export", billedUserId: userId, assignment: { policyGroup: DEFAULT_POLICY_GROUP, overlay: null, assignedAt: new Date(), assignedById: null }, catalogue, failClosed: false, nowMs: Date.now() });
    t.check("exports (a read of the customer's own data, no paid call) stay allowed", exp.allowed && Number(e.dimensions.exportsPerDay.value) >= 1, { exp, v: e.dimensions.exportsPerDay.value });
    const { readFileSync } = await import("node:fs");
    const readers = ["app/api/user/export/route.ts", "app/api/brief/route.ts", "app/api/sync/status/route.ts"];
    t.check("stored-data readers (export, Brief read, sync status) never consult the billable gate or the cost freeze",
      readers.every((f) => !/billable-gate|billable-subjects|cost-freeze/.test(readFileSync(f, "utf8"))));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
