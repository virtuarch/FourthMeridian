/**
 * lib/history/net-worth-node.test.ts
 *
 * V27-B — the Net Worth historical node: composition, reconciliation, and the
 * three things that must never be conflated (real-assets residual, unattributed
 * observed remainder, contradiction).
 *
 * Calibrated on the live corpus: 378 rows whose crypto may not be asserted must
 * make computed Net Worth UNAVAILABLE and must not regress.
 */

import { readFileSync } from "node:fs";
import { buildNetWorthNode } from "./net-worth-node";
import { authoriseAggregates } from "@/lib/snapshots/aggregate-authorisation.core";
import { explainedFromComponents, signedContribution, isCountable } from "./historical-node.core";
import type { Snapshot } from "@/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const read = (p: string) => readFileSync(p, "utf8");

/** A row shaped like the live ones, with the authorisation the boundary resolves. */
function snap(over: Partial<Record<string, number | boolean>> = {}) {
  const v = {
    stocks: 5000, crypto: 15000, cash: 3000, savings: 2000, debt: 1000,
    realAssets: 0, isEstimated: true, cryptoAssertable: true, ...over,
  } as Record<string, number | boolean>;
  const stocks = v.stocks as number, crypto = v.crypto as number, cash = v.cash as number;
  const savings = v.savings as number, debt = v.debt as number, real = v.realAssets as number;
  const total = stocks + crypto;
  const totalAssets = total + cash + savings + real;
  const netWorth = totalAssets - debt;
  const netLiquid = cash + savings - debt;
  const cashOnHand = Math.max(cash, 0);
  const values = { stocks, crypto, cash, savings, debt, total, totalAssets, netWorth, netLiquid, cashOnHand };
  const s: Snapshot = {
    date: "2026-01-01", netWorth, totalAssets, totalDebt: debt, totalCash: cash,
    totalSavings: savings, totalInvestments: stocks, totalCrypto: crypto,
    cashOnHand, netLiquid, isEstimated: v.isEstimated as boolean,
    currency: "USD", completenessTier: "derived",
    aggregateAuthorisation: authoriseAggregates({
      values, componentAssertable: { crypto: v.cryptoAssertable as boolean },
      isEstimated: v.isEstimated as boolean,
    }),
  } as Snapshot;
  return s;
}
const build = (s: Snapshot) =>
  buildNetWorthNode({ snapshot: s, dateISO: "2026-01-01", fromISO: "2025-08-03", toISO: "2026-08-03", currency: "USD" });

function main(): void {
  console.log("V27-B — Net Worth historical node\n");

  // ══ A. ASSERTABLE NET WORTH IS UNTOUCHED ══════════════════════════════════
  console.log("A. An assertable Net Worth is byte-identical");
  {
    const s = snap();
    const n = build(s);
    check("A. displayedValue IS the stored netWorth", n.displayedValue === s.netWorth);
    check("A. state is EXACT and assertable", n.reconciliation === "EXACT" && n.assertable);
    check("A. children explain it exactly",
      Math.abs((n.explainedValue ?? 0) - s.netWorth) <= 0.01,
      `explained ${n.explainedValue} vs ${s.netWorth}`);
    check("A. no remainder on a computed row", n.unattributedObservedAmount === null);
    check("A. the window is carried untouched", n.fromISO === "2025-08-03" && n.toISO === "2026-08-03");
    check("A. and the currency", n.currency === "USD");
  }

  // ══ B. UNAVAILABLE CRYPTO PROPAGATES ══════════════════════════════════════
  console.log("\nB. Unavailable crypto makes COMPUTED Net Worth unavailable");
  {
    const n = build(snap({ cryptoAssertable: false, isEstimated: true }));
    check("B. Net Worth is UNAVAILABLE", n.reconciliation === "UNAVAILABLE" && !n.assertable);
    check("B. displayedValue is null, never a number", n.displayedValue === null);
    check("B. with the coded reason", n.unavailableReason === "AGGREGATE_COMPONENT_UNASSERTABLE");
    check("B. and NO remainder is invented", n.unattributedObservedAmount === null);
    // The refusal must remain diagnosable: which component failed?
    const crypto = n.components.find((c) => c.id === "bucket:crypto")!;
    check("B. the crypto bucket names itself as the refusal",
      crypto.reconciliation === "UNAVAILABLE" && crypto.displayedValue === null);
    check("B. while the untouched buckets stay EXACT",
      n.components.filter((c) => c.id !== "bucket:crypto").every((c) => c.reconciliation === "EXACT"));
    check("B. components are still carried, so the refusal is explainable",
      n.components.length === 5);
  }

  // ══ C. AN OBSERVED PARENT MAY CARRY A REMAINDER ═══════════════════════════
  console.log("\nC. An OBSERVED Net Worth may expose an observed remainder");
  {
    const n = build(snap({ cryptoAssertable: false, isEstimated: false }));
    check("C. state is PARTIALLY_ATTRIBUTED", n.reconciliation === "PARTIALLY_ATTRIBUTED");
    check("C. and it remains assertable — the recording stands", n.assertable);
    check("C. displayedValue is the recorded total", n.displayedValue === 24000);
    check("C. explained excludes the unassertable component",
      Math.abs((n.explainedValue ?? 0) - (5000 + 3000 + 2000 - 1000)) <= 0.01,
      `got ${n.explainedValue}`);
    check("C. the remainder is displayed − explained, POSITIVE",
      Math.abs((n.unattributedObservedAmount ?? 0) - 15000) <= 0.01 && (n.unattributedObservedAmount ?? 0) > 0);
    check("C. explained + remainder reconstructs the total",
      Math.abs((n.explainedValue ?? 0) + (n.unattributedObservedAmount ?? 0) - 24000) <= 0.01);
  }

  // ══ D. A COMPUTED PARENT NEVER CARRIES ONE ════════════════════════════════
  console.log("\nD. A COMPUTED Net Worth never exposes a remainder");
  {
    const computed = build(snap({ cryptoAssertable: false, isEstimated: true }));
    const observed = build(snap({ cryptoAssertable: false, isEstimated: false }));
    check("D. computed → UNAVAILABLE, no remainder",
      computed.reconciliation === "UNAVAILABLE" && computed.unattributedObservedAmount === null);
    check("D. the ONLY difference is whether the total was recorded",
      observed.reconciliation === "PARTIALLY_ATTRIBUTED" && computed.reconciliation === "UNAVAILABLE");
  }

  // ══ E/F. THE REAL-ASSETS RESIDUAL ═════════════════════════════════════════
  console.log("\nE/F. Real assets — a canonical bucket, not a remainder, not an account");
  {
    const n = build(snap({ realAssets: 250000 }));
    const real = n.components.find((c) => c.id === "bucket:real-assets");
    check("E. a property-holding Space is NOT contradictory", n.reconciliation === "EXACT");
    check("E. the residual appears as its own bucket", real !== undefined);
    check("E. carrying the recovered value", Math.abs((real?.displayedValue ?? 0) - 250000) <= 0.01);
    check("E. and it is NOT the unattributed remainder", n.unattributedObservedAmount === null);
    check("F. it is a bucket, never an account or holding", real?.nodeType === "bucket");
    check("F. it cannot be drilled — nothing is beneath a residual",
      real?.drilldown.available === false &&
      real?.drilldown.reason === "REAL_ASSETS_HAVE_NO_STORED_COMPOSITION");
    check("F. and it says what it is NOT",
      (real?.provenance.note ?? "").includes("does not hold its per-account composition"));
    check("E. children still explain the parent exactly",
      Math.abs((n.explainedValue ?? 0) - n.displayedValue!) <= 0.01);

    // Absent real assets, no phantom bucket.
    check("E. a Space with no real assets has no such bucket",
      build(snap()).components.every((c) => c.id !== "bucket:real-assets"));
  }

  // ══ G. DEBT SUBTRACTS ═════════════════════════════════════════════════════
  console.log("\nG. Debt is the other side of the sheet");
  {
    const n = build(snap());
    const debt = n.components.find((c) => c.id === "bucket:debt")!;
    check("G. the debt bucket is positive in magnitude", (debt.displayedValue ?? 0) === 1000);
    check("G. but subtracts from its parent",
      debt.nodeType === "bucket" && debt.subtracts && signedContribution(debt) === -1000);
    check("G. explainedLiabilities is reported separately", n.explainedLiabilities === 1000);
    check("G. explainedAssets excludes it", n.explainedAssets === 25000);
    check("G. and assets − liabilities is the total",
      Math.abs((n.explainedAssets ?? 0) - (n.explainedLiabilities ?? 0) - n.displayedValue!) <= 0.01);
  }

  // ══ CONTRADICTION ═════════════════════════════════════════════════════════
  console.log("\nContradiction is refused, never softened");
  {
    const s = snap();
    (s as { netWorth: number }).netWorth = 999999; // breaks netWorth = totalAssets − debt
    s.aggregateAuthorisation = authoriseAggregates({
      values: { stocks: 5000, crypto: 15000, cash: 3000, savings: 2000, debt: 1000,
                total: 20000, totalAssets: 25000, netWorth: 999999, netLiquid: 4000, cashOnHand: 3000 },
      componentAssertable: {}, isEstimated: false,
    });
    const n = build(s);
    check("a violated identity is CONTRADICTORY", n.reconciliation === "CONTRADICTORY");
    check("not assertable", !n.assertable);
    check("and never a remainder", n.unattributedObservedAmount === null);
    check("with a coded reason", n.unavailableReason === "AGGREGATE_IDENTITY_VIOLATED");
  }

  // ══ O/P. CONTRACT AND STATIC GUARDS ═══════════════════════════════════════
  console.log("\nO/P. The contract carries; it does not compute");
  {
    const contract = strip(read("lib/history/historical-node.core.ts"));
    check("O. the node contract prices nothing",
      !/priceArchive|getPriceAsOf|createPriceService/.test(contract));
    check("O. owns nothing", !/loadHoldingOwnership|resolveOwnershipWindow/.test(contract));
    check("O. authorises nothing", !/authoriseAggregates|isCryptoAssertable/.test(contract));
    check("O. reads no clock and no DB",
      !/Date\.now\(\)|new Date\(\)|@prisma\/client|from "@\/lib\/db"/.test(contract));
    check("O. and its only arithmetic is signing and summing children",
      (contract.match(/=>\s*n \+ /g) ?? []).length <= 1);

    const authority = strip(read("lib/history/net-worth-node.ts"));
    check("P. the Net Worth authority CONSUMES Slice A, never re-derives it",
      /aggregateAuthorisation/.test(authority) && !/resolveCryptoValuationState/.test(authority));
    check("P. it reuses the ONE reconciliation vocabulary",
      /from "@\/lib\/perspective-engine\/reconciliation\.core"/.test(authority));
    check("P. it is pure — no DB", !/from "@\/lib\/db"|@prisma\/client/.test(authority));
    check("P. and reads no clock", !/Date\.now\(\)|new Date\(\)/.test(authority));

    // One authority, not several.
    const binding = strip(read("lib/history/net-worth-point-detail.ts"));
    check("P. exactly one Net Worth point authority exists",
      (binding.match(/buildNetWorthNode\(/g) ?? []).length === 2 && // node + series
      /getRecentSnapshots\(/.test(binding));
    check("P. the binding never writes",
      !/\.(create|update|upsert|delete)(Many)?\(/.test(binding));
  }

  // ══ H/I. OTHER LENSES UNTOUCHED ═══════════════════════════════════════════
  console.log("\nH/I. Liquidity, Debt and Investments are structurally independent");
  {
    const n = build(snap({ cryptoAssertable: false, isEstimated: true }));
    const s = snap({ cryptoAssertable: false, isEstimated: true });
    check("H. netLiquid stays EXACT even when netWorth refuses",
      s.aggregateAuthorisation!.netLiquid.state === "EXACT" && n.reconciliation === "UNAVAILABLE");
    check("H. cash and savings buckets stay assertable",
      n.components.filter((c) => ["bucket:cash", "bucket:savings"].includes(c.id))
        .every((c) => c.assertable));
    check("H. and the debt bucket too", n.components.find((c) => c.id === "bucket:debt")!.assertable);

    const wealth = strip(read("lib/wealth/wealth-time-machine.ts"));
    check("I. Wealth refuses on the AGGREGATE verdict, with the boolean as fallback",
      /aggregateAuthorisation\.netWorth\.assertable === false/.test(wealth) &&
      /assetSideContaminated === true/.test(wealth));
    const ai = strip(read("lib/ai/assemblers/snapshot.ts"));
    check("J. AI nulls Net Worth on the aggregate verdict",
      /aggregateAuthorisation\.netWorth\.assertable === false/.test(ai));
    const csv = strip(read("lib/export/csv.ts"));
    check("K. export exposes the aggregate status beside the raw values",
      /net_worth_state/.test(csv) && /net_worth_assertable/.test(csv));
    check("K. and still writes the raw stored totals", /net_worth:/.test(csv) || /netWorth/.test(csv));
  }

  // ══ CONTRACT SHAPE ════════════════════════════════════════════════════════
  console.log("\nContract shape");
  {
    const n = build(snap());
    check("a lens node is countable", isCountable(n));
    check("a bucket node is countable", isCountable(n.components[0]));
    check("explainedFromComponents skips refused children",
      Math.abs(explainedFromComponents(build(snap({ cryptoAssertable: false })).components)
        - (5000 + 3000 + 2000 - 1000)) <= 0.01);
    check("every component carries the SAME window as its parent",
      n.components.every((c) => c.fromISO === n.fromISO && c.toISO === n.toISO && c.dateISO === n.dateISO));
    check("and the same currency", n.components.every((c) => c.currency === n.currency));
    check("breadcrumbs extend by exactly one step",
      n.breadcrumb.length === 1 && n.components[0].breadcrumb.length === 2 &&
      n.components[0].breadcrumb[0].id === "net-worth");
  }

  console.log(failures === 0 ? "\nAll Net Worth node checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
