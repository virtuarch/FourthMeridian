/**
 * lib/snapshots/aggregate-authorisation.core.test.ts
 *
 * v2.6-A — aggregate authorisation. Standalone tsx, pure.
 *
 * The rule under test: an aggregate may be asserted only when every component it
 * is composed from is assertable — and when that fails, WHICH outcome applies
 * depends on one thing only, whether the total is a recording or a computation.
 *
 * Calibrated on the live corpus: 378 rows carry material crypto that may not be
 * asserted while their `netWorth` asserted freely; `netLiquid` on the same rows
 * never touched crypto and must stay untouched.
 */

import { readFileSync } from "node:fs";
import {
  authoriseAggregates, AGGREGATE_COMPOSITION, SNAPSHOT_AGGREGATES,
  derivedRealAssets, type AggregateAuthorisationInput,
} from "./aggregate-authorisation.core";
import { RECONCILIATION_STATES, COMPUTED_TOLERANCE } from "@/lib/perspective-engine/reconciliation.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const read = (p: string) => readFileSync(p, "utf8");

/** A row shaped like the live contaminated ones: crypto is 53% of assets. */
function row(over: Partial<AggregateAuthorisationInput["values"]> = {}) {
  const v = {
    stocks: 5000, crypto: 15000, cash: 3000, savings: 2000, debt: 1000,
    ...over,
  } as Record<string, number>;
  const total = v.stocks + v.crypto;
  const totalAssets = total + v.cash + v.savings;
  return {
    stocks: v.stocks, crypto: v.crypto, cash: v.cash, savings: v.savings, debt: v.debt,
    total, totalAssets,
    netWorth: totalAssets - v.debt,
    netLiquid: v.cash + v.savings - v.debt,
    cashOnHand: Math.max(v.cash, 0),
    ...over,
  } as AggregateAuthorisationInput["values"];
}

function main(): void {
  console.log("v2.6-A — aggregate authorisation\n");

  // ══ A. AN ASSERTABLE AGGREGATE IS UNTOUCHED ═══════════════════════════════
  console.log("A. Every assertable aggregate is byte-identical");
  {
    const values = row();
    const a = authoriseAggregates({ values, componentAssertable: { crypto: true }, isEstimated: true });
    for (const agg of SNAPSHOT_AGGREGATES) {
      check(`A. ${agg} is EXACT and assertable`, a[agg].state === "EXACT" && a[agg].assertable);
      check(`A. ${agg} explains its whole stored value`,
        Math.abs((a[agg].explained ?? NaN) - values[agg]) <= COMPUTED_TOLERANCE,
        `explained ${a[agg].explained} vs stored ${values[agg]}`);
      check(`A. ${agg} carries no remainder`, a[agg].remainder === null);
    }
    // Authorisation NEVER rewrites a number.
    const after = authoriseAggregates({ values, componentAssertable: {}, isEstimated: true });
    check("A. the input values are not mutated",
      JSON.stringify(values) === JSON.stringify(row()) && after.netWorth.state === "EXACT");
  }

  // ══ B. ONE UNASSERTABLE COMPONENT PROPAGATES ══════════════════════════════
  console.log("\nB. A computed aggregate containing an unassertable component");
  {
    // The live shape: an ESTIMATED row whose crypto may not be asserted.
    const a = authoriseAggregates({
      values: row(), componentAssertable: { crypto: false }, isEstimated: true,
    });
    check("B. netWorth becomes UNAVAILABLE", a.netWorth.state === "UNAVAILABLE" && !a.netWorth.assertable);
    check("B. totalAssets becomes UNAVAILABLE", a.totalAssets.state === "UNAVAILABLE");
    check("B. total becomes UNAVAILABLE", a.total.state === "UNAVAILABLE");
    check("B. the offending component is named",
      a.netWorth.unassertableComponents.join() === "crypto");
    check("B. with a coded reason",
      a.netWorth.refusalReason === "AGGREGATE_COMPONENT_UNASSERTABLE");

    // F. Aggregates that never touched crypto are untouched.
    check("F. netLiquid stays EXACT (Liquidity is unaffected)",
      a.netLiquid.state === "EXACT" && a.netLiquid.assertable);
    check("F. cashOnHand stays EXACT (Debt/cash surfaces unaffected)",
      a.cashOnHand.state === "EXACT" && a.cashOnHand.assertable);
    check("F. and neither names an unassertable component",
      a.netLiquid.unassertableComponents.length === 0 && a.cashOnHand.unassertableComponents.length === 0);
  }

  // ══ C. AN OBSERVED AGGREGATE MAY CARRY A REMAINDER ════════════════════════
  console.log("\nC. An OBSERVED aggregate exposes explained + remainder");
  {
    const values = row();
    const a = authoriseAggregates({
      values, componentAssertable: { crypto: false }, isEstimated: false,
    });
    check("C. netWorth is PARTIALLY_ATTRIBUTED, not refused",
      a.netWorth.state === "PARTIALLY_ATTRIBUTED");
    check("C. and remains assertable — the recording stands", a.netWorth.assertable);
    check("C. explained = the assertable components only",
      Math.abs((a.netWorth.explained ?? 0) - (5000 + 3000 + 2000 - 1000)) <= 0.01,
      `got ${a.netWorth.explained}`);
    check("C. the remainder is observed − explained, and POSITIVE",
      Math.abs((a.netWorth.remainder ?? 0) - 15000) <= 0.01 && (a.netWorth.remainder ?? 0) > 0,
      `got ${a.netWorth.remainder}`);
    check("C. remainder + explained reconstructs the observed total",
      Math.abs(((a.netWorth.explained ?? 0) + (a.netWorth.remainder ?? 0)) - values.netWorth) <= 0.01);
  }

  // ══ D. A COMPUTED AGGREGATE NEVER CARRIES A REMAINDER ═════════════════════
  console.log("\nD. A COMPUTED aggregate never fabricates a remainder");
  {
    const a = authoriseAggregates({
      values: row(), componentAssertable: { crypto: false }, isEstimated: true,
    });
    for (const agg of SNAPSHOT_AGGREGATES) {
      check(`D. ${agg} exposes no remainder`, a[agg].remainder === null);
    }
    check("D. and the contaminated ones are UNAVAILABLE, never PARTIALLY_ATTRIBUTED",
      a.netWorth.state === "UNAVAILABLE" && a.totalAssets.state === "UNAVAILABLE");
    // The asymmetry IS the rule.
    const observed = authoriseAggregates({
      values: row(), componentAssertable: { crypto: false }, isEstimated: false,
    });
    check("D. the ONLY difference between the two is whether the total was recorded",
      observed.netWorth.state === "PARTIALLY_ATTRIBUTED" && a.netWorth.state === "UNAVAILABLE");
  }

  // ══ CONTRADICTION ═════════════════════════════════════════════════════════
  console.log("\nContradiction — an identity that must hold, does not");
  {
    const broken = { ...row(), netWorth: 999999 };
    const a = authoriseAggregates({ values: broken, componentAssertable: {}, isEstimated: false });
    check("a violated identity refuses EVERY aggregate on the row",
      SNAPSHOT_AGGREGATES.every((g) => a[g].state === "CONTRADICTORY"));
    check("with its own reason code", a.netWorth.refusalReason === "AGGREGATE_IDENTITY_VIOLATED");
    check("and never a remainder — a contradiction is not softened",
      SNAPSHOT_AGGREGATES.every((g) => a[g].remainder === null));

    // Components exceeding a stored total is the negative-remainder case.
    const under = { ...row(), totalAssets: 100 };
    check("totalAssets below its own stored components is a contradiction",
      authoriseAggregates({ values: under, componentAssertable: {}, isEstimated: false })
        .totalAssets.state === "CONTRADICTORY");
  }

  // ══ UNSTORED REAL ASSETS ══════════════════════════════════════════════════
  console.log("\nReal assets — composed into totals, never stored");
  {
    // A Space with property: totalAssets exceeds the four stored components.
    const withProperty = { ...row(), totalAssets: row().totalAssets + 250000 };
    withProperty.netWorth = withProperty.totalAssets - withProperty.debt;
    const a = authoriseAggregates({ values: withProperty, componentAssertable: {}, isEstimated: true });
    check("a positive residual is real assets, NOT a contradiction",
      a.totalAssets.state === "EXACT" && a.netWorth.state === "EXACT");
    check("and is recoverable by subtraction",
      Math.abs(derivedRealAssets(withProperty) - 250000) <= 0.01);
    check("realAssets is a declared component of both totals",
      AGGREGATE_COMPOSITION.totalAssets.includes("realAssets") &&
      AGGREGATE_COMPOSITION.netWorth.includes("realAssets"));
    check("but not of netLiquid or total",
      !AGGREGATE_COMPOSITION.netLiquid.includes("realAssets") &&
      !AGGREGATE_COMPOSITION.total.includes("realAssets"));
  }

  // ══ COMPOSITION MATCHES THE ONE PLACE THE ARITHMETIC LIVES ════════════════
  console.log("\nComposition is pinned to computeSnapshotFields");
  {
    const src = strip(read("lib/snapshots/backfill-core.ts"));
    check("total = stocks + crypto", /const total\s*=\s*stocks \+ crypto/.test(src));
    check("totalAssets = total + cash + savings + realAssets",
      /const totalAssets\s*=\s*total \+ cash \+ savings \+ realAssets/.test(src));
    check("netWorth = totalAssets − debt", /const netWorth\s*=\s*totalAssets - debt/.test(src));
    check("netLiquid = cash + savings − debt", /const netLiquid\s*=\s*cash \+ savings - debt/.test(src));
    check("cashOnHand depends on cash alone", /const cashOnHand\s*=\s*Math\.max\(cash, 0\)/.test(src));

    // If the writer's arithmetic changes, this table must change with it.
    check("the declared composition matches, aggregate by aggregate",
      AGGREGATE_COMPOSITION.total.join() === "stocks,crypto" &&
      AGGREGATE_COMPOSITION.totalAssets.join() === "stocks,crypto,cash,savings,realAssets" &&
      AGGREGATE_COMPOSITION.netWorth.join() === "stocks,crypto,cash,savings,realAssets,debt" &&
      AGGREGATE_COMPOSITION.netLiquid.join() === "cash,savings,debt" &&
      AGGREGATE_COMPOSITION.cashOnHand.join() === "cash");
  }

  // ══ cashOnHand IS DELIBERATELY NOT IDENTITY-CHECKED ═══════════════════════
  console.log("\ncashOnHand — authorised by its component, not by an identity");
  {
    // 483 live rows hold a cashOnHand that is neither max(cash,0) nor anything
    // derivable from stored columns. Checking it would manufacture 483
    // contradictions out of a formula disagreement.
    const odd = { ...row(), cashOnHand: 99999 };
    const a = authoriseAggregates({ values: odd, componentAssertable: {}, isEstimated: true });
    check("an unexpected cashOnHand does NOT contradict the row",
      a.netWorth.state === "EXACT" && a.cashOnHand.state === "EXACT");
    check("but it still follows its component's authorisation",
      authoriseAggregates({ values: odd, componentAssertable: { cash: false }, isEstimated: true })
        .cashOnHand.state === "UNAVAILABLE");
  }

  // ══ VOCABULARY + STATIC GUARDS (G, H, I) ══════════════════════════════════
  console.log("\nG–I. One vocabulary, no writes, no schema");
  {
    check("the four states come from the SHARED vocabulary",
      RECONCILIATION_STATES.length === 4 &&
      RECONCILIATION_STATES.includes("PARTIALLY_ATTRIBUTED"));

    const core = strip(read("lib/snapshots/aggregate-authorisation.core.ts"));
    check("the authority imports the vocabulary rather than restating it",
      /from "@\/lib\/perspective-engine\/reconciliation\.core"/.test(core) &&
      !/const .*STATES\s*=\s*\[/.test(core.replace(/SNAPSHOT_(COMPONENTS|AGGREGATES)/g, "")));
    check("G. it is pure — no Prisma, no db", !/@prisma\/client|from "@\/lib\/db"/.test(core));
    check("G. and performs no writes", !/\.(create|update|upsert|delete)(Many)?\(/.test(core));
    check("G. and reads no clock", !/Date\.now\(\)|new Date\(\)/.test(core));

    const boundary = strip(read("lib/data/snapshots.ts"));
    check("the read boundary resolves authorisation exactly once",
      (boundary.match(/authoriseAggregates\(/g) ?? []).length === 1);
    check("G. and still performs no writes",
      !/\.(create|update|upsert|delete)(Many)?\(/.test(boundary));
    check("the boundary authorises on STORED values, before display conversion",
      boundary.indexOf("authoriseAggregates(") < boundary.indexOf("convertStampedValues("));
    check("I. no schema field was added for this",
      !/aggregateAuthorisation/.test(read("prisma/schema.prisma")));
    check("H. nothing here regenerates",
      !/regenerateWealthHistory|regenerateSpaceSnapshot/.test(boundary + core));

    // The general rule and the special case it generalises must agree.
    check("assetSideContaminated is retained for its existing consumers",
      /assetSideContaminated:\s*isAssetSideContaminated/.test(boundary));
  }

  console.log(failures === 0 ? "\nAll aggregate-authorisation checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
