/**
 * lib/refresh/refresh-all.test.ts — the provider-agnostic Refresh All decides
 * deterministically, composes the existing primitives, and never pretends.
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/refresh/refresh-all.test.ts
 */
import { resolveEffectiveEntitlements } from "@/lib/entitlements/resolve";
import type { RefreshSummary, RefreshItemResult } from "@/lib/plaid/refresh";
import type { WalletSyncOutcome } from "@/lib/crypto/wallet-sync-dispatch";
import { refreshAllForUser, type RefreshAllDeps, type PlaidAuthorityFact, type WalletAuthorityFact } from "./refresh-all";
import type { RefreshAuthorityOutcome } from "./outcomes";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-10-08T10:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const beta = resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: null, assignedAt: NOW, assignedById: null });
const founder = resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: "FOUNDER_INTERNAL_V1", assignedAt: NOW, assignedById: null });

const item = (id: string, status = "ACTIVE", last: Date | null = null): PlaidAuthorityFact => ({ id, institutionName: `Bank ${id}`, status, lastManualRefreshAt: last });
const wallet = (accountId: string, chain: string | null = "BTC", connectionId: string | null = `c-${accountId}`, last: Date | null = null): WalletAuthorityFact =>
  ({ accountId, chain, label: `${chain ?? "Wallet"} …${accountId}`, connectionId, lastManualRefreshAt: last });
const okItem = (id: string): RefreshItemResult => ({ plaidItemId: id, institution: `Bank ${id}`, ok: true, accountsUpdated: 1, holdingsUpdated: 0, transactionsAdded: 0, transactionsModified: 0, transactionsRemoved: 0, spacesSnapshotted: [], executionId: `exec-${id}` });
const walletOk: WalletSyncOutcome = { accountId: "w1", chain: "BTC", support: "SYNCABLE", ok: true, netWorthParticipation: "LEGACY_COLUMN", valuationModel: "ADAPTER_VALUED" } as unknown as WalletSyncOutcome;

interface Calls { marks: string[][]; fanouts: { exclude: string[]; trigger: string }[]; walletRuns: { id: string; trigger: string }[]; claims: string[]; releases: string[]; walletMarks: string[]; rateChecks: number[] }
function deps(over: Partial<RefreshAllDeps> & { plaid?: PlaidAuthorityFact[]; wallets?: WalletAuthorityFact[]; fanoutResults?: RefreshItemResult[]; walletOutcome?: WalletSyncOutcome; claimOk?: boolean; rateAllowed?: boolean }): { d: RefreshAllDeps; calls: Calls } {
  const calls: Calls = { marks: [], fanouts: [], walletRuns: [], claims: [], releases: [], walletMarks: [], rateChecks: [] };
  const d: RefreshAllDeps = {
    admit: async () => ({ decision: "ADMIT", reason: null }),
    listPlaidItems: async () => over.plaid ?? [],
    listWallets: async () => over.wallets ?? [],
    markPlaidAttempts: async (ids) => { calls.marks.push(ids); },
    runPlaidItems: async (_u, exclude, trigger) => {
      calls.fanouts.push({ exclude, trigger });
      const results = over.fanoutResults ?? [];
      return { results, itemCount: results.length, totalAccountsUpdated: 0, totalHoldingsUpdated: 0, totalTransactionsAdded: 0, totalTransactionsModified: 0, totalTransactionsRemoved: 0, spacesSnapshotted: [] } satisfies RefreshSummary;
    },
    walletRateCheck: async (_u, limit) => { calls.rateChecks.push(limit); return { allowed: over.rateAllowed ?? true, retryAfterSeconds: 120 }; },
    claimWallet: async (id) => { calls.claims.push(id); return over.claimOk ?? true; },
    releaseWallet: async (id) => { calls.releases.push(id); },
    markWalletAttempt: async (id) => { calls.walletMarks.push(id); },
    runWallet: async (id, _chain, trigger) => { calls.walletRuns.push({ id, trigger }); return over.walletOutcome ?? { ...walletOk, accountId: id }; },
    afterWallet: async () => undefined,
    isSyncableChain: (c) => c === "BTC" || c === "ETH" || c === "SOL",
    now: () => NOW,
    ...over,
  };
  return { d, calls };
}
const by = (r: { outcomes: RefreshAuthorityOutcome[] }, id: string): RefreshAuthorityOutcome => r.outcomes.find((o) => o.id === id)!;

(async () => {
  console.log("admission");
  {
    const { d, calls } = deps({ plaid: [item("p1")], wallets: [wallet("w1")], admit: async () => ({ decision: "DENY", reason: "MAINTENANCE_MODE" }) });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("every authority is REFUSED NOT_ADMITTED", r.outcomes.length === 2 && r.outcomes.every((o) => o.decision === "REFUSED" && o.reason === "NOT_ADMITTED"));
    check("no clock touched, no fan-out, no wallet run", calls.marks.length === 0 && calls.fanouts.length === 0 && calls.walletRuns.length === 0);
    check("summary counts refused=2", r.summary.refused === 2 && r.summary.started === 0);
  }

  console.log("plaid decisions");
  {
    const { d, calls } = deps({
      plaid: [item("p1"), item("p2", "NEEDS_REAUTH"), item("p3", "ACTIVE", minsAgo(10)), item("p4"), item("p5")],
      fanoutResults: [okItem("p1"), { ...okItem("p4"), ok: false, skipped: "in-flight" }, { ...okItem("p5"), ok: false, error: "ITEM_LOGIN_REQUIRED" }],
    });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("ACTIVE off-cooldown ⇒ STARTED with the execution id", by(r, "p1").decision === "STARTED" && by(r, "p1").executionId === "exec-p1");
    check("NEEDS_REAUTH ⇒ REFUSED NOT_REFRESHABLE, status in the label", by(r, "p2").decision === "REFUSED" && by(r, "p2").reason === "NOT_REFRESHABLE" && by(r, "p2").label.includes("NEEDS_REAUTH"));
    const p3 = by(r, "p3");
    check("10 min ago under a 60-min policy ⇒ SKIPPED COOLDOWN with retryAfter", p3.decision === "SKIPPED" && p3.reason === "COOLDOWN" && p3.retryAfterSeconds === 50 * 60 && p3.entitlement === "manualBankRefreshCooldownMinutes");
    check("in-flight from the fan-out ⇒ SKIPPED IN_FLIGHT", by(r, "p4").decision === "SKIPPED" && by(r, "p4").reason === "IN_FLIGHT");
    check("a failed item ⇒ FAILED ERROR", by(r, "p5").decision === "FAILED" && by(r, "p5").reason === "ERROR");
    check("the clock was marked ONLY for eligible items", calls.marks.length === 1 && calls.marks[0].sort().join() === "p1,p4,p5");
    check("ONE fan-out, excluding the non-eligible ids, trigger MANUAL", calls.fanouts.length === 1 && calls.fanouts[0].exclude.sort().join() === "p2,p3" && calls.fanouts[0].trigger === "MANUAL");
    check("summary is honest", r.summary.started === 1 && r.summary.skipped === 2 && r.summary.refused === 1 && r.summary.failed === 1 && r.summary.byReason.COOLDOWN === 1);
  }

  console.log("entitlement changes the cooldown (founder overlay 15 min)");
  {
    const { d } = deps({ plaid: [item("p3", "ACTIVE", minsAgo(10)), item("p6", "ACTIVE", minsAgo(20))], fanoutResults: [okItem("p6")] });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: founder }, d);
    check("10 min ago is still on a 15-min cooldown", by(r, "p3").reason === "COOLDOWN" && by(r, "p3").retryAfterSeconds === 5 * 60);
    check("20 min ago is eligible under the overlay", by(r, "p6").decision === "STARTED");
  }

  console.log("wallet decisions");
  {
    const { d, calls } = deps({
      wallets: [wallet("w1"), wallet("w2", "DOGE"), wallet("w3", "ETH", "c-w3", minsAgo(30)), wallet("w4", "SOL", null)],
    });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("syncable wallet ⇒ STARTED", by(r, "w1").decision === "STARTED");
    check("unsupported chain ⇒ REFUSED NOT_REFRESHABLE, never run", by(r, "w2").reason === "NOT_REFRESHABLE" && !calls.walletRuns.some((x) => x.id === "w2"));
    check("wallet cooldown uses the SAME customer window as banks", by(r, "w3").reason === "COOLDOWN" && by(r, "w3").retryAfterSeconds === 30 * 60);
    check("a wallet without a Connection runs without a claim (legacy row) and is STARTED", by(r, "w4").decision === "STARTED" && !calls.claims.includes("c-w4"));
    check("claim → mark → run → release for the claimed wallet", calls.claims.includes("c-w1") && calls.walletMarks.includes("c-w1") && calls.releases.includes("c-w1"));
    check("rate check asked with the ENTITLED limit (6)", calls.rateChecks.every((l) => l === 6) && calls.rateChecks.length === 2);
    check("wallets run sequentially in listing order", calls.walletRuns.map((x) => x.id).join() === "w1,w4");
  }
  {
    const { d, calls } = deps({ wallets: [wallet("w1")], rateAllowed: false });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("rate exhausted ⇒ REFUSED RATE_LIMITED (no thrown 429), nothing claimed", by(r, "w1").reason === "RATE_LIMITED" && by(r, "w1").retryAfterSeconds === 120 && calls.claims.length === 0);
  }
  {
    const { d, calls } = deps({ wallets: [wallet("w1")], claimOk: false });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("lock held ⇒ SKIPPED IN_FLIGHT, no run, no release of a claim we never held", by(r, "w1").reason === "IN_FLIGHT" && calls.walletRuns.length === 0 && calls.releases.length === 0);
  }
  {
    const { d, calls } = deps({ wallets: [wallet("w1")], runWallet: async () => { throw new Error("explorer down"); } });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("a throwing adapter ⇒ FAILED ERROR and the lock is still released", by(r, "w1").decision === "FAILED" && calls.releases.includes("c-w1"));
  }
  {
    const { d } = deps({ wallets: [wallet("w1")], walletOutcome: { ...walletOk, ok: false, support: "SYNCABLE" } as unknown as WalletSyncOutcome });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("a failed adapter outcome ⇒ FAILED ERROR", by(r, "w1").decision === "FAILED" && by(r, "w1").reason === "ERROR");
  }
  {
    let t = NOW.getTime();
    const { d, calls } = deps({ wallets: [wallet("w1"), wallet("w2")], budgetMs: 1_000, now: () => new Date(t), runWallet: async (id, _c, trigger) => { t += 5_000; calls.walletRuns.push({ id, trigger }); return { ...walletOk, accountId: id }; } });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("past the budget the remaining wallet is SKIPPED BUDGET, not dropped", by(r, "w1").decision === "STARTED" && by(r, "w2").decision === "SKIPPED" && String(by(r, "w2").reason) === "BUDGET");
  }

  console.log("authority");
  {
    const { d, calls } = deps({ plaid: [item("p1")], wallets: [wallet("w1")], fanoutResults: [okItem("p1")] });
    const r = await refreshAllForUser({ userId: "u", authority: "OPERATOR", actor: { userId: "op", via: "PLATFORM_GRANT" }, entitlements: beta }, d);
    check("OPERATOR authority records the OPERATOR trigger on both providers", calls.fanouts[0].trigger === "OPERATOR" && calls.walletRuns[0].trigger === "OPERATOR" && r.authority === "OPERATOR");
    const { d: d2 } = deps({ plaid: [item("p3", "ACTIVE", minsAgo(10))] });
    const r2 = await refreshAllForUser({ userId: "u", authority: "OPERATOR", actor: { userId: "op", via: "PLATFORM_GRANT" }, entitlements: beta }, d2);
    check("an operator obeys the customer's cooldown — no force", by(r2, "p3").reason === "COOLDOWN");
  }

  console.log("fan-out failure isolation");
  {
    const { d } = deps({ plaid: [item("p1")], wallets: [wallet("w1")], runPlaidItems: async () => { throw new Error("plaid down"); } });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("a thrown Plaid fan-out ⇒ FAILED items, wallets still run", by(r, "p1").decision === "FAILED" && by(r, "w1").decision === "STARTED");
  }
  {
    const { d } = deps({ plaid: [item("p1")], fanoutResults: [] });
    const r = await refreshAllForUser({ userId: "u", authority: "USER", entitlements: beta }, d);
    check("an item the fan-out dropped (orphan self-healed) ⇒ REFUSED NOT_REFRESHABLE", by(r, "p1").decision === "REFUSED" && by(r, "p1").reason === "NOT_REFRESHABLE");
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
})();
