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
    const isExchangeRefusal = (r: { status: number; body: Record<string, any> }) =>
      r.status === (kind === "POLICY_UNAVAILABLE" ? 503 : 403) && String(r.body.error).startsWith(restrictionMessage(kind))
        && String(r.body.error).includes("nothing has been disconnected") && r.body.code === RESTRICTION_CODES[kind];
    t.check(`exchange-token, NEW Item → ${kind} wording + "nothing has been disconnected"`, isExchangeRefusal(ex), { s: ex.status, b: ex.body });
    const repair = await call(EXCHANGE, "/api/plaid/exchange-token", { public_token: "public-sandbox-repair", institution_id: "ins_1", institution_name: "Bank A" });
    t.check("exchange-token, update-mode REPAIR of the existing Item → refused the same way; the copy says nothing is disconnected", isExchangeRefusal(repair), { s: repair.status, b: repair.body });
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

  t.section("propagation ≤ 30 s, measured WITH read latency (clock-pinned)");
  {
    fake.clearHooks(); setFlag(null); setState({});
    const { BILLABLE_BATCH_MAX_AGE_MS } = await import("@/lib/entitlements/billable-gate");
    let now = Date.parse("2026-10-31T12:00:00Z");
    C.setPolicyGroupCatalogueClockForTests(() => now);
    C.invalidatePolicyGroupCatalogue();
    // EVERY catalogue read is slow: each policy query advances the clock 1 s (≈ 3 s per read), and the
    // freeze is written right AFTER the first read's lifecycle query — the worst case.
    fake.on("PolicyGroup", "findMany", () => { now += 1_000; return undefined; });
    await C.loadPolicyGroupCatalogue();
    const writtenAt = now;
    Object.assign(group(), { costFrozen: true }); // another instance froze the group — no local invalidation here
    let seenAt: number | null = null;
    for (let step = 0; step <= 40 && seenAt === null; step++) {
      now = writtenAt + step * 1_000;
      const d = await assertBillableAllowed({ userId, operation: "plaid_sync" }, { now: () => now });
      if (!d.allowed) seenAt = now; // `now` includes the re-read's own latency
    }
    fake.clearHooks();
    const staleness = seenAt === null ? Infinity : seenAt - writtenAt;
    t.check(`a freeze is enforced ${staleness} ms after the write, including the slow re-read; + the ${BILLABLE_BATCH_MAX_AGE_MS} ms batch reuse = ${staleness + BILLABLE_BATCH_MAX_AGE_MS} ms ≤ 30 s`,
      staleness + BILLABLE_BATCH_MAX_AGE_MS <= 30_000, { staleness, ttl: C.CATALOGUE_TTL_MS });
    C.setPolicyGroupCatalogueClockForTests(null);
    C.invalidatePolicyGroupCatalogue();
  }

  t.section("the GLOBAL cost freeze has a supported, audited write path (operational controls)");
  {
    fake.clearHooks(); setFlag(null); setState({});
    const { GET: OC_GET, PATCH: OC_PATCH } = await import("./platform/platform-ops/operational-controls/route") as unknown as { GET: H; PATCH: H };
    const ctl = fake.seed("User", { email: "ctl@example.test", username: "ctl", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
    fake.seed("PlatformGrant", { userId: ctl.id, area: "PLATFORM_OPS", level: "CONTROL", status: "ACTIVE" });
    const ctlSession = await signIn(fake, ctl.id as string);
    const patch = (body: unknown, cookie = ctlSession.cookie) => invoke<Record<string, any>>(OC_PATCH, request("/api/platform/platform-ops/operational-controls", { method: "PATCH", cookie, body }));
    const g0 = await invoke<Record<string, any>>(OC_GET, request("/api/platform/platform-ops/operational-controls", { method: "GET", cookie: ctlSession.cookie }));
    t.check("GET shows the global cost freeze state (separate from maintenance)", g0.status === 200 && g0.body.costFreeze?.key === "platform_cost_frozen" && g0.body.costFreeze?.state !== "ON", g0.body.costFreeze);
    const writer = await patch({ control: "COST_FREEZE", action: "ENABLE", expectedUpdatedAt: g0.body.costFreeze?.updatedAt ?? null, reason: { code: "SUPPORT_REQUEST", note: "freeze" } }, opSession.cookie);
    t.check("a PLATFORM_OPS WRITE holder cannot set it (CONTROL required, fresh)", writer.status === 403);
    const noReason = await patch({ control: "COST_FREEZE", action: "ENABLE", expectedUpdatedAt: g0.body.costFreeze?.updatedAt ?? null });
    t.check("a reason is required", noReason.status === 400);
    const auditsBefore = fake.rows("AuditLog", { action: "PLATFORM_POLICY_CHANGED" }).length;
    const on = await patch({ control: "COST_FREEZE", action: "ENABLE", expectedUpdatedAt: g0.body.costFreeze?.updatedAt ?? null, reason: { code: "SUPPORT_REQUEST", note: "vendor bill spike — freeze all paid work" } });
    t.check("CONTROL + reason ⇒ 200, read back ON in the returned model", on.status === 200 && on.body.costFreeze?.state === "ON", { s: on.status, b: on.body });
    const audit = fake.rows("AuditLog", { action: "PLATFORM_POLICY_CHANGED" }).slice(auditsBefore);
    t.check("…audited in the same transaction (one row: the setting key, before/after, reason)",
      audit.length === 1 && JSON.stringify(audit[0]).includes("platform_cost_frozen"), audit);
    C.invalidatePolicyGroupCatalogue();
    const d = await assertBillableAllowed({ userId, operation: "plaid_sync" });
    t.check("…and every billable decision now refuses COST_FREEZE (an ACTIVE group, a Founder)", !d.allowed && (d as any).reason === "COST_FREEZE");
    const { readPolicyGroupLifecycle } = await import("@/lib/platform/policies/policy-group-lifecycle-read");
    const lr = await readPolicyGroupLifecycle(DEFAULT_POLICY_GROUP);
    t.check("operator group view: the GROUP is not frozen; the PLATFORM flag is reported separately",
      lr !== null && lr.costFrozen === false && lr.restriction === null && lr.globalCostFrozen === true && lr.effectiveRestriction === "COST_FREEZE", lr && { c: lr.costFrozen, r: lr.restriction, g: lr.globalCostFrozen, e: lr.effectiveRestriction });
    const g1 = await invoke<Record<string, any>>(OC_GET, request("/api/platform/platform-ops/operational-controls", { method: "GET", cookie: ctlSession.cookie }));
    const off = await patch({ control: "COST_FREEZE", action: "DISABLE", expectedUpdatedAt: g1.body.costFreeze.updatedAt, reason: { code: "SUPPORT_REQUEST", note: "unfreeze" } });
    C.invalidatePolicyGroupCatalogue();
    t.check("DISABLE reads back OFF and paid work is allowed again", off.status === 200 && off.body.costFreeze?.state === "OFF" && (await assertBillableAllowed({ userId, operation: "plaid_sync" })).allowed);
    const stale = await patch({ control: "COST_FREEZE", action: "ENABLE", expectedUpdatedAt: g1.body.costFreeze.updatedAt, reason: { code: "SUPPORT_REQUEST", note: "x" } });
    t.check("a stale version ⇒ 409 CONFLICT, nothing written", stale.status === 409 && stale.body.model?.costFreeze?.state === "OFF");
  }

  t.section("FX under a DECLARED freeze: the allowlisted FREE provider only, once per day; never the paid OXR path");
  {
    fake.clearHooks(); setState({}); setFlag("true");
    const { fetchFxRates, FREE_FX_EXEMPTION, freezeExemptFxRegistry } = await import("@/jobs/fetch-fx-rates");
    const oldKey = process.env.OXR_APP_ID;
    process.env.OXR_APP_ID = "paid-key-present-in-env"; // the paid primary is configured — it must still never be called
    const urls: string[] = [];
    const trap = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input); urls.push(url);
      if (!url.includes("api.frankfurter.dev")) throw new Error(`paid / unexpected FX call: ${url}`);
      const date = url.match(/\/v1\/(\d{4}-\d{2}-\d{2})/)?.[1];
      const { FRANKFURTER_QUOTES } = await import("@/lib/fx/providers/frankfurter");
      return new Response(JSON.stringify({ base: "USD", date, rates: Object.fromEntries(FRANKFURTER_QUOTES.map((q) => [q, 1.5])) }), { status: 200 });
    }) as typeof fetch;
    try {
      t.check("the frozen registry holds ONLY the allowlisted free provider, even with OXR_APP_ID set",
        freezeExemptFxRegistry().adapters.map((a) => a.source).join() === FREE_FX_EXEMPTION.source && FREE_FX_EXEMPTION.maxFetchesPerDayWhileFrozen === 1);
      const first = await fetchFxRates();
      t.check("frozen run #1: one free-provider fetch (Frankfurter), ZERO Open Exchange Rates calls; recorded SKIPPED for the paid path",
        urls.length >= 1 && urls.every((u) => u.includes("api.frankfurter.dev") && !/app_id|openexchangerates/i.test(u))
          && first.freeExemption?.source === "frankfurter" && first.outcome === "SKIPPED" && first.skipReason === "BILLABLE_COST_FREEZE" && first.caughtUp.length === 0,
        { urls, first });
      const n = urls.length;
      const second = await fetchFxRates();
      t.check("frozen run #2 the same day: NO fetch at all (≤ 1 per day while frozen) — the cache is served",
        urls.length === n && second.freeExemption === undefined && second.outcome === "SKIPPED", { urls, second });
      setFlag("maybe");
      const unreadable = await fetchFxRates();
      t.check("an UNREADABLE freeze flag: no exemption, no fetch (fail closed)", urls.length === n && unreadable.billableRestricted === "BILLABLE_POLICY_UNAVAILABLE");
    } finally {
      globalThis.fetch = trap;
      if (oldKey === undefined) delete process.env.OXR_APP_ID; else process.env.OXR_APP_ID = oldKey;
      setFlag(null);
    }
  }

  t.section("wallet re-add: one sync per wallet per entitled window, fail closed, new wallets not counted (review P3-1)");
  {
    fake.clearHooks(); setFlag(null); setState({});
    const body = { name: "BTC", walletChain: "BTC", walletAddress: wallet.walletAddress };
    const first = await call(WALLET, "/api/accounts/wallet", body);
    t.check("the first re-add in the window may re-read the chain (allowed plan; the trapped network makes it non-fatal)",
      first.status === 200 && first.body.initialSync?.errorCode !== "COOLDOWN", { s: first.status, b: first.body });
    const before = fetchCalls;
    const second = await call(WALLET, "/api/accounts/wallet", body);
    t.check("an immediate second re-add: share OK, NO chain sync (COOLDOWN), no network call",
      second.status === 200 && second.body.initialSync?.errorCode === "COOLDOWN" && fetchCalls === before, { s: second.status, b: second.body });
    const third = await call(WALLET, "/api/accounts/wallet", body);
    t.check("…and a third: still COOLDOWN (one sync per wallet per window, however often it is re-posted)", third.body.initialSync?.errorCode === "COOLDOWN" && fetchCalls === before);
    const src = (await import("node:fs")).readFileSync("app/api/accounts/wallet/route.ts", "utf8");
    t.check("the window is a conditional write on the wallet's own Connection (fail closed on any error); no per-user limiter counts new wallets",
      /lastManualRefreshAt: \{ lte:/.test(src) && /return false;\n  \}\n\}/.test(src) && !/limitByUser\(userId, "wallet-add"/.test(src));
  }

  t.section("plan-restricted deferrals say so — never \"syncing resumes automatically\" (review P3-3)");
  {
    const { planRestrictedDeferralMessage, isPlanRestrictedDeferral } = await import("@/lib/sync/deferred-ingestion");
    t.check("BILLABLE_COST_FREEZE ⇒ the lifecycle wording", planRestrictedDeferralMessage("BILLABLE_COST_FREEZE") === restrictionMessage("COST_FREEZE"));
    t.check("an admission pause is NOT a plan deferral (its own copy stays)", !isPlanRestrictedDeferral("INGESTION_PAUSED") && planRestrictedDeferralMessage("INGESTION_PAUSED") === null);
    const fs = await import("node:fs");
    t.check("the detail line, the card and the summary all branch on it",
      /planRestrictedDeferralMessage\(connection\.deferredReason\)/.test(fs.readFileSync("lib/connections/connection-detail.core.ts", "utf8"))
      && /planRestrictedDeferralMessage\(connection\.deferredReason\)/.test(fs.readFileSync("components/connections/ConnectionCard.tsx", "utf8"))
      && /isPlanRestrictedDeferral\(connection\.deferredReason\)/.test(fs.readFileSync("lib/connections/connection-summary.ts", "utf8")));
  }

  t.section("the dormant amendment price path is gated before applyAmendment (review P3-7)");
  {
    const src = (await import("node:fs")).readFileSync("app/api/spaces/[id]/wealth/amend/route.ts", "utf8");
    const gate = src.indexOf('assertBillableAllowed({ userId: user.id, operation: "price_history" })');
    t.check("an APPLIED amendment asks the billable gate (price_history) before applyAmendment; preview stays a dry run",
      gate > 0 && gate < src.indexOf("await applyAmendment(request)") && src.indexOf("await previewAmendment(request)") > 0);
  }

  t.section("readers stay available while frozen");
  {
    fake.clearHooks(); setFlag(null); setState({ costFrozen: true });
    const e = await entitlementsForUser(userId);
    t.check("existing Briefs: the read gate (dailyBrief) stays open", e.dimensions.dailyBrief.value === true && refuseIfDisabled(e, "dailyBrief", "The Daily Brief") === null);
    // A stored Brief for today, generated before the freeze. The Brief's own raw reads (the source
    // watermark) answer empty here; the stored row is what must come back.
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    fake.seed("DailyBrief", { spaceId: space.id, ownerUserId: userId, briefDay: today, content: { headline: "Quiet day." }, generatedAt: new Date(), model: "stored-model" });
    fake.queryRaw = () => [];
    const read = await invoke<Record<string, any>>(BRIEF_GET, request(`/api/brief?spaceId=${space.id}`, { method: "GET", cookie: session.cookie }));
    t.check("GET /api/brief → 200 and the STORED Brief is returned while frozen (no model call)",
      read.status === 200 && JSON.stringify(read.body).includes("Quiet day."), { s: read.status, b: read.body });
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
