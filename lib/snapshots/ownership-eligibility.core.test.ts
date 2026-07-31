/**
 * lib/snapshots/ownership-eligibility.core.test.ts
 *
 * V26-PRICE-5A — ownership-eligibility fixtures. Standalone tsx script:
 *
 *     npx tsx lib/snapshots/ownership-eligibility.core.test.ts
 *
 * The doctrine under test: UNKNOWN ownership prehistory must not be valued, and
 * an all-excluded day must NEVER become a zero-valued portfolio — zero is a
 * claim, and the truth is "we cannot say".
 */

import { readFileSync } from "node:fs";
import {
  applyOwnershipEligibility,
  ownershipOn,
  ownershipTier,
  type ValuedHolding,
} from "./ownership-eligibility.core";
import { resolveOwnershipWindow, type OwnershipResolution } from "@/lib/prices/ownership-window.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const CEILING = "2026-07-30";

/** BTC shape: POSSIBLE 2023-03-24…2026-07-18, KNOWN 2026-07-19…ceiling. */
const INFERRED: OwnershipResolution = resolveOwnershipWindow({
  instrumentId: "inferred", earliestDirectISO: "2026-07-19",
  earliestPossibleISO: "2023-03-24", valuationToISO: CEILING,
});
/** Equity shape: KNOWN from 2025-10-01, nothing before. */
const EVIDENCED: OwnershipResolution = resolveOwnershipWindow({
  instrumentId: "evidenced", earliestDirectISO: "2025-10-01",
  earliestPossibleISO: null, valuationToISO: CEILING,
});
/** No evidence at all. */
const NONE: OwnershipResolution = resolveOwnershipWindow({
  instrumentId: "none", earliestDirectISO: null,
  earliestPossibleISO: null, valuationToISO: CEILING,
});

const OWN = new Map<string, OwnershipResolution>([
  ["inferred", INFERRED], ["evidenced", EVIDENCED], ["none", NONE],
]);

const h = (instrumentId: string, reportingValue: number | null = 100): ValuedHolding =>
  ({ instrumentId, reportingValue });

function main(): void {
  // ── 1. Before all evidence ────────────────────────────────────────────────
  console.log("1. an instrument before ALL ownership evidence contributes nothing");
  {
    const r = applyOwnershipEligibility("2024-01-01", [h("evidenced", 5000)], OWN);
    check("it is excluded", eq(r.excludedInstrumentIds, ["evidenced"]));
    check("it contributes nothing to the subtotal", r.valuedSubtotal === 0);
    check("the day has no eligible holdings", r.hasEligibleHoldings === false);
    check("…and is NOT reported as a zero-valued portfolio — the caller must skip",
      r.hasEligibleHoldings === false && r.includedInstrumentIds.length === 0);
    check("confidence is UNKNOWN when nothing survived", r.ownershipConfidence === "UNKNOWN");
  }

  // ── 2. POSSIBLE stays valued and disclosed ────────────────────────────────
  console.log("2. POSSIBLE ownership remains valued, and disclosed");
  {
    const r = applyOwnershipEligibility("2024-06-01", [h("inferred", 1200)], OWN);
    check("it is included", eq(r.includedInstrumentIds, ["inferred"]));
    check("its value counts", r.valuedSubtotal === 1200);
    check("the inferred confidence is carried, not absorbed", r.ownershipConfidence === "POSSIBLE");
    check("…and maps to a non-observed tier", ownershipTier(r.ownershipConfidence) === "estimated");
  }

  // ── 3. KNOWN behaves normally ─────────────────────────────────────────────
  console.log("3. KNOWN ownership is valued normally");
  {
    const r = applyOwnershipEligibility("2026-01-15", [h("evidenced", 900)], OWN);
    check("included with full value", r.valuedSubtotal === 900 && r.hasEligibleHoldings);
    check("confidence is KNOWN", r.ownershipConfidence === "KNOWN");
    check("…and maps to observed", ownershipTier(r.ownershipConfidence) === "observed");
    check("nothing excluded", eq(r.excludedInstrumentIds, []));
  }

  // ── 4. Mixed holdings ─────────────────────────────────────────────────────
  console.log("4. mixed KNOWN / POSSIBLE / UNKNOWN on one date");
  {
    // 2026-01-15: evidenced=KNOWN, inferred=POSSIBLE, none=UNKNOWN.
    const r = applyOwnershipEligibility("2026-01-15",
      [h("evidenced", 900), h("inferred", 300), h("none", 5000)], OWN);
    check("only the UNKNOWN holding is excluded", eq(r.excludedInstrumentIds, ["none"]));
    check("the other two are included, ascending",
      eq(r.includedInstrumentIds, ["evidenced", "inferred"]));
    check("the subtotal counts only included holdings", r.valuedSubtotal === 1200);
    check("the day's confidence takes the WORST included — POSSIBLE, not KNOWN",
      r.ownershipConfidence === "POSSIBLE");
    check("a $5000 unevidenced holding cannot inflate the day", r.valuedSubtotal === 1200);
  }

  // ── 5. All UNKNOWN ────────────────────────────────────────────────────────
  console.log("5. every holding UNKNOWN");
  {
    const r = applyOwnershipEligibility("2022-01-01",
      [h("evidenced", 900), h("inferred", 300), h("none", 5000)], OWN);
    check("all three excluded", r.excludedInstrumentIds.length === 3);
    check("subtotal is zero AND hasEligibleHoldings is false — the caller must not write 0",
      r.valuedSubtotal === 0 && r.hasEligibleHoldings === false);
  }

  // ── 6. Transitions ────────────────────────────────────────────────────────
  console.log("6. boundary transitions");
  {
    // UNKNOWN → POSSIBLE at 2023-03-24.
    check("the day before the POSSIBLE segment is UNKNOWN",
      ownershipOn("2023-03-23", INFERRED) === "UNKNOWN");
    check("the first POSSIBLE day is POSSIBLE", ownershipOn("2023-03-24", INFERRED) === "POSSIBLE");
    const before = applyOwnershipEligibility("2023-03-23", [h("inferred", 400)], OWN);
    const after  = applyOwnershipEligibility("2023-03-24", [h("inferred", 400)], OWN);
    check("value appears exactly at the boundary, not before",
      before.valuedSubtotal === 0 && after.valuedSubtotal === 400);
    check("…and the day before has no eligible holdings", !before.hasEligibleHoldings);

    // POSSIBLE → KNOWN at 2026-07-19.
    check("the last POSSIBLE day is POSSIBLE", ownershipOn("2026-07-18", INFERRED) === "POSSIBLE");
    check("the first KNOWN day is KNOWN", ownershipOn("2026-07-19", INFERRED) === "KNOWN");
    const poss = applyOwnershipEligibility("2026-07-18", [h("inferred", 400)], OWN);
    const know = applyOwnershipEligibility("2026-07-19", [h("inferred", 400)], OWN);
    check("value is continuous across the POSSIBLE→KNOWN boundary",
      poss.valuedSubtotal === know.valuedSubtotal);
    check("…but the disclosed confidence changes",
      poss.ownershipConfidence === "POSSIBLE" && know.ownershipConfidence === "KNOWN");
  }

  // ── 7. holdConstantBeforeEarliest cannot cross the boundary ───────────────
  console.log("7. hold-constant projection cannot cross the UNKNOWN boundary");
  {
    // A8 with holdConstantBeforeEarliest projects a quantity backwards, so it
    // hands us a fully-valued holding for a prehistoric date. Exclusion must not
    // depend on the value being absent — it depends only on ownership.
    const projected = applyOwnershipEligibility("2020-01-01", [h("evidenced", 7777)], OWN);
    check("a projected, fully-valued holding is STILL excluded in prehistory",
      projected.valuedSubtotal === 0 && eq(projected.excludedInstrumentIds, ["evidenced"]));

    // Beyond the valuation ceiling is equally UNKNOWN.
    const beyond = applyOwnershipEligibility("2026-12-31", [h("evidenced", 900)], OWN);
    check("a date beyond the ownership ceiling is also excluded", !beyond.hasEligibleHoldings);

    // An unvalued holding in prehistory must not make the day look covered.
    const unvalued = applyOwnershipEligibility("2020-01-01", [h("evidenced", null)], OWN);
    check("an UNVALUED prehistoric holding is excluded, not counted as coverage",
      !unvalued.hasEligibleHoldings && eq(unvalued.excludedInstrumentIds, ["evidenced"]));
  }

  // ── 8. Determinism ────────────────────────────────────────────────────────
  console.log("8. determinism");
  {
    const holdings = [h("none", 5000), h("inferred", 300), h("evidenced", 900)];
    const forward = applyOwnershipEligibility("2026-01-15", holdings, OWN);
    const reverse = applyOwnershipEligibility("2026-01-15", [...holdings].reverse(), OWN);
    check("INPUT ORDER CANNOT CHANGE THE RESULT", JSON.stringify(forward) === JSON.stringify(reverse));
    check("repeat invocation → byte-identical",
      JSON.stringify(applyOwnershipEligibility("2026-01-15", holdings, OWN)) === JSON.stringify(forward));
    check("included and excluded ids are both sorted",
      eq(forward.includedInstrumentIds, [...forward.includedInstrumentIds].sort()) &&
      eq(forward.excludedInstrumentIds, [...forward.excludedInstrumentIds].sort()));
    check("an unresolved instrument is UNKNOWN everywhere",
      ownershipOn("2026-01-15", undefined) === "UNKNOWN");
    check("empty holdings → no eligible holdings, never a zero portfolio",
      applyOwnershipEligibility("2026-01-15", [], OWN).hasEligibleHoldings === false);
  }

  // ── 9. Purity ─────────────────────────────────────────────────────────────
  console.log("9. purity");
  {
    // Comments legitimately mention providers and writes; scan CODE only.
    const code = readFileSync("lib/snapshots/ownership-eligibility.core.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    check("no database import", !code.includes("@/lib/db") && !code.includes("prisma"));
    check("no provider or fetch import",
      !code.includes("providers/") && !code.includes("fetchInstrumentWindow") && !code.includes("fetch("));
    check("no archive write path", !code.includes("writeBatch") && !code.includes("priceArchive"));
    check("no clock", !code.includes("Date.now") && !code.includes("new Date("));
  }

  console.log(failures === 0 ? "\nAll ownership-eligibility checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
