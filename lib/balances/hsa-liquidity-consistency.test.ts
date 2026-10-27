/**
 * lib/balances/hsa-liquidity-consistency.test.ts   (v2.7-P3 — HSA / liquidity consistency)
 *
 * The liquidity lens's RESTRICTED tier and today's rows from the as-of route
 * now count a restricted depository account (an HSA) on the SAME adjusted basis
 * as the Cash donut, ledger and footer — through `countedBalance`, the one
 * authority — while the reachable (headline) figure stays provider-attested and
 * an HSA stays restricted (never accessible).
 *
 *   1. HSA with pending (EXACT identity) ⇒ restricted tier uses adjusted,
 *      still excluded from accessible; HSA without pending unchanged; a
 *      historical row (no claim) counts the reported balance
 *   2. one fixture (HSA + pending, a hold, a CD with no available, a
 *      PENDING_EXCLUDED checking, a brokerage) built through the REAL
 *      authorities the mount uses: donut = ledger = classifier = Σ groups;
 *      ledger restricted = lens restricted = accessTotals restricted;
 *      ledger accessible = lens headline = reachableNow; footer line exact
 *   3. the as-of route (loadLiquiditySpaceData via its deps seam): today's
 *      restricted tier uses adjusted; a past date never carries the claim
 *   4. source scans: the claim never reaches a historical path
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/balances/hsa-liquidity-consistency.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from "node:fs";
import { resolveRowBalances, reconcileAccount, adjustedDepositoryBalance } from "@/lib/balances/account-balances";
import type { PendingContribution } from "@/lib/balances/pending-evidence";
import { classifyAccounts } from "@/lib/account-classifier";
import { computeLiquidity, type LiquidityAccountRow } from "@/lib/perspective-engine/lenses/liquidity.core";
import { identityContext } from "@/lib/money/convert";
import type { LensResult, PerspectiveScope } from "@/lib/perspective-engine/types";
import { buildCashAccounts, groupCashAccounts, reconcileTerms } from "@/components/space/widgets/liquidity/cash-accounts";
import { reachableNow, accessTotals } from "@/components/space/widgets/liquidity-adapters";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const close = (a: number, b: number) => Math.abs(a - b) < 0.005;

const NOW = new Date("2026-10-27T12:00:00Z");
const SCOPE: PerspectiveScope = { spaceId: "s1", userId: "u1" };
const CTX = identityContext("USD");

interface Raw { id: string; name: string; type: string; sub: string | null; C: number; A: number | null; P?: number[] }
const RAW: Raw[] = [
  { id: "chk",  name: "Checking",     type: "checking",   sub: "checking", C: 5251.68, A: 929.01, P: [-4000, -322.67] }, // PENDING_EXCLUDED
  { id: "sch",  name: "Hold",         type: "checking",   sub: "checking", C: 1500,    A: 0 },                           // hold 1,500
  { id: "hsa",  name: "HSA",          type: "checking",   sub: "hsa",      C: 3000,    A: 2800,   P: [-200] },           // HSA + pending, EXACT
  { id: "hsa2", name: "HSA savings",  type: "savings",    sub: "hsa",      C: 1000,    A: 1000 },                        // HSA, no pending
  { id: "cd",   name: "CD",           type: "savings",    sub: "cd",       C: 10000,   A: null },                        // no available reported
  { id: "brk",  name: "Brokerage",    type: "investment", sub: "brokerage", C: 7000,   A: null },
];

/** The SpaceAccount the mount composes, through the SAME authorities (mount-composition.ts). */
function mountAccount(r: Raw): any {
  const pending: PendingContribution = r.P
    ? { count: r.P.length, sum: r.P.reduce((s, x) => s + x, 0), transactionIds: r.P.map((_, i) => `${r.id}-p${i}`) }
    : { count: 0, sum: 0, transactionIds: [] };
  const b = resolveRowBalances({ id: r.id, type: r.type, currency: "USD", balance: r.C, availableBalance: r.A, lastUpdated: NOW }, NOW);
  const rec = reconcileAccount(b, pending, null);
  const adj = adjustedDepositoryBalance(b, pending);
  const currentState = rec.basis === "DEPOSITORY" ? {
    reachable: rec.reachable?.amount ?? null, unexplained: rec.unexplained, state: rec.state, pendingCount: rec.pending.count,
    ...(adj ? { pendingSum: adj.pendingSum, adjusted: adj.adjusted, basis: adj.basis } : {}),
  } : undefined;
  return {
    id: r.id, name: r.name, type: r.type, providerSubtype: r.sub, balance: r.C, currency: "USD",
    institution: "Bank", lastUpdated: NOW.toISOString(), visibilityLevel: "FULL",
    ...(currentState ? { currentState } : {}),
    ...(typeof currentState?.adjusted === "number" ? { adjustedBalance: currentState.adjusted } : {}),
  };
}

/** The live lens adapter's mapping (lib/perspective-engine/lenses/liquidity.ts), live path. */
function lensRow(a: any, live: boolean): LiquidityAccountRow {
  return {
    id: a.id, type: a.type, providerSubtype: a.providerSubtype, balance: a.balance, currency: a.currency,
    lastUpdated: a.lastUpdated, visibilityLevel: "FULL",
    ...(live && a.currentState ? { reachableCash: a.currentState.reachable, unexplainedHold: a.currentState.unexplained } : {}),
    ...(live && typeof a.adjustedBalance === "number" ? { adjustedBalance: a.adjustedBalance } : {}),
  };
}
const metric = (r: LensResult | null | undefined, id: string) => {
  const m = r?.metrics.find((x) => x.id === id);
  return m && typeof m.value === "number" ? m.value : 0;
};

async function main() {
  const accounts = RAW.map(mountAccount);
  const hsa = accounts.find((a) => a.id === "hsa");

  console.log("\n1. the restricted tier");
  check("HSA with pending resolves PENDING_EXCLUDED (C + P = A exactly) ⇒ adjusted 2,800",
    hsa.currentState.basis === "PENDING_EXCLUDED" && hsa.adjustedBalance === 2800, JSON.stringify(hsa.currentState));
  {
    const only = computeLiquidity(SCOPE, { now: () => NOW }, [lensRow(hsa, true)], CTX);
    check("lens: HSA + pending ⇒ restricted tier = ADJUSTED 2,800 (was reported 3,000)", metric(only, "restricted") === 2800);
    check("lens: HSA is still NOT accessible (headline 0)", metric(only, "cashNow") === 0);
    const hist = computeLiquidity(SCOPE, { now: () => NOW, asOf: "2026-09-30" }, [lensRow(hsa, false)], CTX);
    check("lens: a historical row (no claim) counts the reported balance", metric(hist, "restricted") === 3000);
    const noPend = computeLiquidity(SCOPE, { now: () => NOW }, [lensRow(accounts.find((a) => a.id === "hsa2"), true)], CTX);
    check("lens: HSA without pending unchanged (NO_PENDING ⇒ C)", metric(noPend, "restricted") === 1000);
  }

  console.log("\n2. one fixture, every surface");
  const summary = buildCashAccounts(accounts, CTX);
  const cls = classifyAccounts(accounts, CTX);
  const lens = computeLiquidity(SCOPE, { now: () => NOW }, accounts.map((a) => lensRow(a, true)), CTX);
  const reach = reachableNow(accounts, CTX);
  const access = accessTotals(accounts, CTX);
  const TOTAL = 929.01 + 1500 + 2800 + 1000 + 10000;
  check("total cash: ledger = classifier (totalLiquid + totalRestrictedCash) = 16,229.01",
    close(summary.totalCash, TOTAL) && close(cls.totalLiquid + cls.totalRestrictedCash, TOTAL), `${summary.totalCash} / ${cls.totalLiquid + cls.totalRestrictedCash}`);
  check("donut: Σ groups = total cash (every grouping)",
    (["account", "institution", "type"] as const).every((g) => close(groupCashAccounts(summary, g).reduce((s, x) => s + x.value, 0), TOTAL)));
  check("restricted: ledger = lens tier = accessTotals = classifier = 3,800 (adjusted HSA + HSA savings)",
    close(summary.restricted, 3800) && close(metric(lens, "restricted"), 3800) && close(access.restricted, 3800) && close(cls.totalRestrictedCash, 3800),
    `${summary.restricted} / ${metric(lens, "restricted")} / ${access.restricted} / ${cls.totalRestrictedCash}`);
  check("accessible: ledger = lens headline = reachableNow = 929.01 (provider-attested, unchanged)",
    close(summary.accessible, 929.01) && close(metric(lens, "cashNow"), 929.01) && close(reach.total, 929.01));
  check("the hold is shown as a hold, never lost from total cash", close(summary.holds, 1500) && summary.rows.find((r) => r.account.id === "sch")!.value === 1500);
  check("the CD with no available is 'not reported', in total cash, out of accessible",
    close(summary.notReported, 10000) && reach.unknownCount === 1);
  check("footer: total − restricted − not reported − holds = accessible, exactly",
    close(TOTAL + reconcileTerms(summary).reduce((s, t) => s + t.amount, 0), summary.accessible));
  check("pending is never double-subtracted: reported + correction = total (−4,522.67 once)",
    close(summary.reported + summary.pendingCorrection, summary.totalCash) && close(summary.pendingCorrection, -4522.67));

  console.log("\n3. the as-of route (deps seam)");
  {
    const { loadLiquiditySpaceData } = await import("@/lib/liquidity/space-data");
    const today = NOW.toISOString().slice(0, 10);
    const deps: any = {
      getAccountsAsOf: async (_c: unknown, { asOf }: { asOf: string }) => accounts.map((a) => ({
        // getAccountsAsOf spreads the LIVE account (claims ride along) under the
        // reconstructed balance — the shape the route must not trust on a past date.
        account: { ...a, balance: asOf >= today ? a.balance : a.balance + 100 },
        visibilityLevel: "FULL", method: asOf >= today ? "observed" : "derived", tier: asOf >= today ? "observed" : "derived",
      })),
      getInvestmentValueAsOf: async (_c: unknown, { asOf }: { asOf: string }) => ({
        asOf, reportingCurrency: "USD", valuedSubtotal: 0, valuedCount: 0, unvaluedCount: 0, unvalued: [],
        components: [{ accountId: "brk", reportingValue: 7000, overallTier: "observed" }],
        completeness: { tier: "observed", conflict: false, reason: "x", byInstrument: {} },
      }),
      buildCtx: async () => CTX,
      computeCurrent: async () => lens,
    };
    const atToday = await loadLiquiditySpaceData(SCOPE, { now: () => NOW, asOf: today, deps });
    check("today via the as-of route: restricted tier = adjusted 3,800 (matches the ledger)", close(metric(atToday.atAsOf, "restricted"), 3800), String(metric(atToday.atAsOf, "restricted")));
    check("today via the as-of route: headline = 929.01 (reachable, unchanged)", close(metric(atToday.atAsOf, "cashNow"), 929.01));
    const past = await loadLiquiditySpaceData(SCOPE, { now: () => NOW, asOf: "2026-10-01", deps });
    check("a past date never carries the present claim: restricted = reconstructed 3,100 + 1,100",
      close(metric(past.atAsOf, "restricted"), 4200), String(metric(past.atAsOf, "restricted")));
  }

  console.log("\n4. source scans");
  {
    const strip = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const adapter = strip("lib/perspective-engine/lenses/liquidity.ts");
    check("lens adapter attaches adjustedBalance on the LIVE path only", /!options\.asOf && typeof account\.adjustedBalance === "number"/.test(adapter));
    check("lens adapter attaches the reachable claim on the LIVE path only (a past as-of never carries today's reachable)",
      /!options\.asOf && account\.currentState/.test(adapter));
    const sd = strip("lib/liquidity/space-data.ts");
    check("as-of route attaches adjustedBalance only when the date IS today, only on checking/savings",
      /isToday\s*\?\s*asOfAccounts/.test(sd) && /r\.type === "checking" \|\| r\.type === "savings"/.test(sd));
    const core = strip("lib/perspective-engine/lenses/liquidity.core.ts");
    check("restricted tier reads countedBalance (the one authority), headline does not",
      /access === "restricted"\) restricted \+= inTarget\(countedBalance\(r\)/.test(core) && !/reachable:[^\n]*countedBalance/.test(core));
  }

  if (failures > 0) { console.error(`\n${failures} HSA/liquidity check(s) failed`); process.exit(1); }
  console.log("\nAll HSA/liquidity consistency checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
