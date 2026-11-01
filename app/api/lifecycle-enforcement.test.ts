/**
 * app/api/lifecycle-enforcement.test.ts  (BETA LIFECYCLE L1 — review fixes 1, 2, 3, 6)
 *
 * The REAL exported handlers of the resolver-driven customer routes, real
 * session cookies, the in-memory Prisma fake (the real schema). Under each of
 * COST_FREEZE, BETA_PAUSED, BETA_ENDED and an unreadable lifecycle
 * (POLICY_UNAVAILABLE), every NEW paid operation is refused with the owner's
 * wording, BEFORE any provider call, whatever the cooldown or the allowance
 * switch says — and reading existing data stays allowed.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/lifecycle-enforcement.test.ts
 *
 *   POST /api/brief/generate         refused (with `ai_daily_allowance_enforced` OFF)
 *   POST /api/plaid/refresh          refused (lastManualRefreshAt null AND long past)
 *   POST /api/refresh/all            every authority REFUSED / PLAN_RESTRICTED, none started
 *   POST /api/plaid/investments/enable  refused
 *   POST /api/accounts/[id]/sync     refused (wallet)
 *   POST /api/ai/chat                refused with the restriction wording, never "not on your plan"
 *   GET  /api/brief                  allowed (reading an existing Brief)
 *   export                           reads only (source scan: no provider / refresh / AI import)
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed JSON bodies */

import "@/lib/test-support/route-env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1 } from "@/lib/entitlements/catalogue";
import { RESTRICTION_MESSAGES, restrictionMessage, RESTRICTION_CODES } from "@/lib/entitlements/restriction-messages";
import { planUnavailableSentence } from "@/lib/ai/conversation/refusal-sentences";

const t = makeChecker("resolver-driven customer routes under PAUSED / ENDED / COST_FREEZE / POLICY_UNAVAILABLE");
const fake = new FakePrisma();
const BETA = BETA_FULL_ACCESS_V1.values;
type H = (req: never, ctx?: never) => Promise<Response>;
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function main() {
  await installFakePrisma(fake);
  const { POST: BRIEF_GENERATE } = await import("./brief/generate/route") as unknown as { POST: H };
  const { GET: BRIEF_GET } = await import("./brief/route") as unknown as { GET: H };
  const { POST: PLAID_REFRESH } = await import("./plaid/refresh/route") as unknown as { POST: H };
  const { POST: REFRESH_ALL } = await import("./refresh/all/route") as unknown as { POST: H };
  const { POST: INVESTMENTS_ENABLE } = await import("./plaid/investments/enable/route") as unknown as { POST: H };
  const { POST: WALLET_SYNC } = await import("./accounts/[id]/sync/route") as unknown as { POST: H };
  const { POST: CHAT } = await import("./ai/chat/route") as unknown as { POST: H };
  const C = await import("@/lib/platform/policies/policy-group-catalogue");
  const { entitlementsForUser, refuseIfDisabled } = await import("@/lib/entitlements/consume");
  fake.reset();
  freshCache();
  C.invalidatePolicyGroupCatalogue();

  fake.seed("PolicyGroup", { key: DEFAULT_POLICY_GROUP, label: BETA_FULL_ACCESS_V1.label, description: "", isDefault: true, builtIn: true, currentVersion: 1 });
  fake.seed("PolicyGroupVersion", { groupKey: DEFAULT_POLICY_GROUP, version: 1, values: { ...BETA }, label: BETA_FULL_ACCESS_V1.label, changeSummary: { kind: "SEEDED", changes: [] }, reasonCode: "POLICY_ROLLOUT" });
  // The allowance switch is OFF: Brief generation must still be refused explicitly (review fix 2).
  fake.seed("PlatformSetting", { key: "ai_daily_allowance_enforced", value: "false" });

  const u = fake.seed("User", { email: "beta@example.test", username: "betacust", passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  const userId = u.id as string;
  // A Founder with the per-customer override: nothing user-level may lift the restriction.
  fake.seed("CustomerPolicyAssignment", { userId, policyGroup: DEFAULT_POLICY_GROUP, overlay: FOUNDER_INTERNAL_V1.key, aiDailyUsdAllowanceOverride: 20 });
  const session = await signIn(fake, userId);
  const space = fake.seed("Space", { name: "Personal", type: "PERSONAL" });
  fake.seed("SpaceMember", { spaceId: space.id, userId, role: "OWNER", status: "ACTIVE" });
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  const neverItem = fake.seed("PlaidItem", { userId, externalItemId: "ext_1", institutionId: "ins_1", institutionName: "Bank A", encryptedToken: "x", status: "ACTIVE", lastManualRefreshAt: null });
  fake.seed("PlaidItem", { userId, externalItemId: "ext_2", institutionId: "ins_2", institutionName: "Bank B", encryptedToken: "x", status: "ACTIVE", lastManualRefreshAt: longAgo });
  const wallet = fake.seed("FinancialAccount", { ownerType: "USER", ownerUserId: userId, createdByUserId: userId, name: "BTC", type: "crypto", currency: "USD", walletChain: "BTC", walletAddress: "bc1qexample" });

  const setState = (p: Record<string, unknown>) => {
    const row = fake.rows("PolicyGroup", { key: DEFAULT_POLICY_GROUP })[0];
    Object.assign(row, { lifecycle: "ACTIVE", costFrozen: false, endedTransition: null }, p);
    C.invalidatePolicyGroupCatalogue();
  };
  const providerWork = () => fake.rows("RefreshExecution").length + fake.callsTo("AiInvocation").length;
  const call = (h: H, p: string, method: string, body?: unknown, params: Record<string, unknown> = {}) =>
    invoke<Record<string, any>>(h, request(p, { method, cookie: session.cookie, ...(body !== undefined ? { body } : {}) }), params);

  const STATES: [string, Record<string, unknown> | "UNREADABLE", keyof typeof RESTRICTION_MESSAGES][] = [
    ["COST_FREEZE", { costFrozen: true }, "COST_FREEZE"],
    ["PAUSED", { lifecycle: "PAUSED" }, "BETA_PAUSED"],
    ["ENDED", { lifecycle: "ENDED", endedTransition: "READ_ONLY" }, "BETA_ENDED"],
    ["lifecycle unreadable", "UNREADABLE", "POLICY_UNAVAILABLE"],
  ];

  t.section("0. the one wording");
  t.check("the owner's four sentences, exactly", RESTRICTION_MESSAGES.BETA_PAUSED === "Beta is paused — paid features are temporarily unavailable."
    && RESTRICTION_MESSAGES.BETA_ENDED === "Beta has ended — your account is read-only."
    && RESTRICTION_MESSAGES.COST_FREEZE === "Paid features are temporarily frozen."
    && RESTRICTION_MESSAGES.POLICY_UNAVAILABLE === "We couldn't verify your plan right now — paid features are paused for safety.");

  for (const [label, state, kind] of STATES) {
    t.section(`${label}`);
    fake.clearHooks();
    if (state === "UNREADABLE") {
      setState({});
      fake.on("PolicyGroup", "findMany", (args) => {
        if ((args.select as Record<string, unknown> | undefined)?.lifecycle) throw new Error('column "lifecycle" does not exist');
        return undefined;
      });
    } else setState(state);
    const msg = restrictionMessage(kind);
    const status = kind === "POLICY_UNAVAILABLE" ? 503 : 403;
    const before = providerWork();
    const isRefusal = (r: { status: number; body: Record<string, any> }) =>
      r.status === status && r.body.error === msg && r.body.code === RESTRICTION_CODES[kind] && r.body.restriction === kind;

    const gen = await call(BRIEF_GENERATE, "/api/brief/generate", "POST", { spaceId: space.id });
    t.check(`brief/generate (allowance switch OFF) → ${status} "${msg}"`, isRefusal(gen), { s: gen.status, b: gen.body });
    const pr = await call(PLAID_REFRESH, "/api/plaid/refresh", "POST", { itemId: neverItem.id });
    t.check(`plaid/refresh (lastManualRefreshAt null) → ${status}`, isRefusal(pr), { s: pr.status, b: pr.body });
    const prBulk = await call(PLAID_REFRESH, "/api/plaid/refresh", "POST", {});
    t.check(`plaid/refresh (bulk; one item refreshed 30 days ago) → ${status}`, isRefusal(prBulk), { s: prBulk.status, b: prBulk.body });
    const all = await call(REFRESH_ALL, "/api/refresh/all", "POST");
    const outs = (all.body.outcomes ?? []) as any[];
    const plaidOuts = outs.filter((o) => o.kind === "PLAID_ITEM");
    t.check("refresh/all → every Plaid authority REFUSED / PLAN_RESTRICTED with the restriction, none STARTED",
      plaidOuts.length === 2 && plaidOuts.every((o) => o.decision === "REFUSED" && o.reason === "PLAN_RESTRICTED" && o.restriction === kind)
        && !outs.some((o) => o.decision === "STARTED"), { s: all.status, outs });
    const inv = await call(INVESTMENTS_ENABLE, "/api/plaid/investments/enable", "POST", { itemId: neverItem.id });
    t.check(`plaid/investments/enable → ${status}`, isRefusal(inv), { s: inv.status, b: inv.body });
    const ws = await call(WALLET_SYNC, `/api/accounts/${wallet.id}/sync`, "POST", undefined, { id: wallet.id });
    t.check(`accounts/[id]/sync (wallet) → ${status}`, isRefusal(ws), { s: ws.status, b: ws.body });
    const chat = await call(CHAT, "/api/ai/chat", "POST", { spaceId: space.id, messages: [{ role: "user", content: "hello" }] });
    t.check(`ai/chat → refused with the restriction wording, never "not on your plan"`,
      (chat.status === 403 || chat.status === 503) && JSON.stringify(chat.body).includes(msg) && !JSON.stringify(chat.body).includes(planUnavailableSentence("Conversations")),
      { s: chat.status, b: chat.body });
    t.check("no provider work began (no RefreshExecution, no AI invocation)", providerWork() === before);
    // GET /api/brief — the read gate is `refuseIfDisabled(dailyBrief)`, which READ_ONLY keeps on. The
    // handler then reads the stored Brief through raw SQL the fake cannot execute, so the read itself
    // is not exercised here; what is pinned is that the restriction never refuses it.
    const e = await entitlementsForUser(userId);
    t.check("GET /api/brief: the read gate (dailyBrief) stays open under the restriction",
      e.lifecycleRestriction === kind && e.dimensions.dailyBrief.value === true && refuseIfDisabled(e, "dailyBrief", "The Daily Brief") === null);
    const read = await call(BRIEF_GET, `/api/brief?spaceId=${space.id}`, "GET");
    t.check("GET /api/brief: the handler's answer is not a restriction refusal",
      read.body.code !== RESTRICTION_CODES[kind] && !Object.values(RESTRICTION_MESSAGES).includes(read.body.error), { s: read.status, b: read.body });
  }
  fake.clearHooks();

  t.section("ACTIVE control");
  {
    setState({});
    const all = await call(REFRESH_ALL, "/api/refresh/all", "POST");
    t.check("ACTIVE: refresh/all refuses nothing for PLAN_RESTRICTED", !((all.body.outcomes ?? []) as any[]).some((o) => o.reason === "PLAN_RESTRICTED"), all.body);
  }

  t.section("export reads only (owner decision: allowed under every restriction, no paid provider work)");
  {
    const files = ["app/api/user/export/route.ts", "lib/export/assemble.ts", "lib/export/zip.ts", "lib/export/holdings.ts"];
    const PROVIDER = /from ["']@\/lib\/(plaid\/(client|refresh|sync|investments)|crypto\/(wallet-sync|btc|eth|sol|alchemy|helius)|prices\/(fetch|coingecko|history)|ai\/(provider|chat)|refresh\/)/;
    for (const f of files) t.check(`${f}: imports no provider client, refresh, price fetch or AI module`, !PROVIDER.test(code(f)));
    t.check("export assembly makes no network call (no fetch)", files.every((f) => !/\bfetch\(/.test(code(f))));
    t.check("the export route is NOT gated by the restriction seam (reads stay available)", !/refuseIfFailClosed|refuseIfBillableRestricted|assertBillableAllowed/.test(code("app/api/user/export/route.ts")));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
