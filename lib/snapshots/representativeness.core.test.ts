/**
 * lib/snapshots/representativeness.core.test.ts
 *
 * V26-PRICE-5B — representativeness fixtures. Standalone tsx script:
 *
 *     npx tsx lib/snapshots/representativeness.core.test.ts
 *
 * The property under test: representativeness measures EVIDENCE COVERAGE and is
 * completely independent of magnitude. Section 5 pins that directly — the module
 * takes no value at all, so a classification cannot move because the market did.
 */

import { readFileSync } from "node:fs";
import {
  assessRepresentativeness,
  summariseRepresentativeness,
  REPRESENTATIVENESS_REASONS,
  type HoldingEvidence,
} from "./representativeness.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const D = "2026-01-05";
const h = (over: Partial<HoldingEvidence> = {}): HoldingEvidence => ({
  instrumentId: "i", eligible: true, inferred: false, marketPriced: true, priced: true, ...over,
});
const CASH = h({ instrumentId: "CUR:USD", marketPriced: false, priced: false });

function main(): void {
  // ── 1. REPRESENTATIVE ─────────────────────────────────────────────────────
  console.log("1. REPRESENTATIVE");
  {
    const a = assessRepresentativeness(D, [h({ instrumentId: "a" }), h({ instrumentId: "b" })]);
    check("every surfaced market holding eligible and priced", a.representativeness === "REPRESENTATIVE");
    check("ownership coverage is 2/2", eq(a.ownershipCoverage, { covered: 2, total: 2 }));
    check("price coverage is 2/2", eq(a.priceCoverage, { covered: 2, total: 2 }));
    check("no reasons", eq(a.reasons, []));

    // A cash position must not affect the verdict either way.
    const withCash = assessRepresentativeness(D, [h({ instrumentId: "a" }), CASH]);
    check("a cash position is excluded from the ratios, not counted as coverage",
      withCash.representativeness === "REPRESENTATIVE" &&
      eq(withCash.ownershipCoverage, { covered: 1, total: 1 }));
  }

  // ── 2. PARTIAL ────────────────────────────────────────────────────────────
  console.log("2. PARTIAL");
  {
    const a = assessRepresentativeness(D, [
      h({ instrumentId: "a" }), h({ instrumentId: "b", eligible: false }),
    ]);
    check("some valued, some excluded → PARTIAL", a.representativeness === "PARTIAL");
    check("ownership coverage is 1/2", eq(a.ownershipCoverage, { covered: 1, total: 2 }));
    check("the exclusion is counted and named",
      a.excludedCount === 1 && a.reasons.includes("HOLDINGS_EXCLUDED"));

    // The 2025-10-29 shape: one evidenced holding, twelve excluded, plus cash.
    const realShape = assessRepresentativeness(D, [
      h({ instrumentId: "NVDA" }),
      ...Array.from({ length: 12 }, (_, i) => h({ instrumentId: `x${i}`, eligible: false })),
      CASH,
    ]);
    check("1 of 13 holdings valued → PARTIAL, not REPRESENTATIVE",
      realShape.representativeness === "PARTIAL");
    check("…and the ratio makes the sparseness legible",
      eq(realShape.ownershipCoverage, { covered: 1, total: 13 }));

    const gap = assessRepresentativeness(D, [
      h({ instrumentId: "a" }), h({ instrumentId: "b", priced: false }),
    ]);
    check("an eligible but unpriced holding → PARTIAL with PRICE_GAP",
      gap.representativeness === "PARTIAL" && gap.reasons.includes("PRICE_GAP"));
    check("price coverage is 1/2", eq(gap.priceCoverage, { covered: 1, total: 2 }));
  }

  // ── 3. NON_REPRESENTATIVE ─────────────────────────────────────────────────
  console.log("3. NON_REPRESENTATIVE");
  {
    const allExcluded = assessRepresentativeness(D, [
      h({ instrumentId: "a", eligible: false }), h({ instrumentId: "b", eligible: false }),
    ]);
    check("every market holding excluded → NON_REPRESENTATIVE",
      allExcluded.representativeness === "NON_REPRESENTATIVE");
    check("…and says so", allExcluded.reasons.includes("NO_ELIGIBLE_HOLDINGS"));

    // THE CASE THE ASSESSMENT EXISTS FOR: a cash balance alone must never make a
    // day look represented.
    const cashOnly = assessRepresentativeness(D, [
      CASH, h({ instrumentId: "a", eligible: false }),
    ]);
    check("a cash position alone cannot make a day representative",
      cashOnly.representativeness === "NON_REPRESENTATIVE");

    const nothing = assessRepresentativeness(D, []);
    check("no holdings at all → NON_REPRESENTATIVE", nothing.representativeness === "NON_REPRESENTATIVE");
    check("…with NO_HOLDINGS_SURFACED", eq(nothing.reasons, ["NO_HOLDINGS_SURFACED"]));

    const onlyCash = assessRepresentativeness(D, [CASH]);
    check("only a cash position → NON_REPRESENTATIVE / NO_MARKET_HOLDINGS",
      onlyCash.representativeness === "NON_REPRESENTATIVE" &&
      onlyCash.reasons.includes("NO_MARKET_HOLDINGS"));

    const unpriced = assessRepresentativeness(D, [h({ instrumentId: "a", priced: false })]);
    check("eligible but nothing priced → NON_REPRESENTATIVE",
      unpriced.representativeness === "NON_REPRESENTATIVE");
  }

  // ── 4. Inferred ownership is disclosed, not penalised ─────────────────────
  console.log("4. inferred ownership");
  {
    const a = assessRepresentativeness(D, [h({ instrumentId: "a", inferred: true })]);
    check("POSSIBLE ownership still counts as covered — it was valued",
      a.representativeness === "REPRESENTATIVE" && eq(a.ownershipCoverage, { covered: 1, total: 1 }));
    check("…but the inference is disclosed",
      a.inferredCount === 1 && a.reasons.includes("OWNERSHIP_INFERRED"));
  }

  // ── 5. INDEPENDENT OF MAGNITUDE ───────────────────────────────────────────
  console.log("5. independent of magnitude (the point of rejecting a value floor)");
  {
    // The module's input type carries no money at all, so this is structural
    // rather than merely observed: no threshold on value can exist here.
    const code = readFileSync("lib/snapshots/representativeness.core.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    check("no value, price or amount field is read",
      !/\bvalue\b|\bprice\b(?!d)|\bamount\b|reportingValue|nativeValue/.test(code),
      code.match(/\bvalue\b|reportingValue|nativeValue/)?.[0]);
    check("no numeric threshold constant", !/[<>]=?\s*\d{2,}/.test(code));
    check("no float ratio is emitted (integer numerator/denominator only)",
      !/toFixed|\/\s*total|Math\.round/.test(code));

    // Same evidence, wildly different portfolios ⇒ identical classification.
    const sparse = assessRepresentativeness(D, [
      h({ instrumentId: "a" }), h({ instrumentId: "b", eligible: false }),
    ]);
    const same = assessRepresentativeness(D, [
      h({ instrumentId: "big" }), h({ instrumentId: "huge", eligible: false }),
    ]);
    check("classification depends only on evidence counts",
      sparse.representativeness === same.representativeness &&
      eq(sparse.ownershipCoverage, same.ownershipCoverage));
  }

  // ── 6. Summary and determinism ────────────────────────────────────────────
  console.log("6. summary and determinism");
  {
    const all = [
      assessRepresentativeness("2026-01-01", [h()]),
      assessRepresentativeness("2026-01-02", [h(), h({ instrumentId: "b", eligible: false })]),
      assessRepresentativeness("2026-01-03", [h({ eligible: false })]),
    ];
    check("tally counts each class", eq(summariseRepresentativeness(all),
      { REPRESENTATIVE: 1, PARTIAL: 1, NON_REPRESENTATIVE: 1 }));

    const holdings = [h({ instrumentId: "z", eligible: false }), h({ instrumentId: "a" })];
    const forward = assessRepresentativeness(D, holdings);
    const reverse = assessRepresentativeness(D, [...holdings].reverse());
    check("INPUT ORDER CANNOT CHANGE THE ASSESSMENT",
      JSON.stringify(forward) === JSON.stringify(reverse));
    check("repeat invocation → byte-identical",
      JSON.stringify(assessRepresentativeness(D, holdings)) === JSON.stringify(forward));
    check("reasons are a strictly ordered subsequence of the declared tuple", (() => {
      const idx = forward.reasons.map((r) => REPRESENTATIVENESS_REASONS.indexOf(r));
      return idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
    })());
    check("every non-representative day carries at least one reason",
      forward.representativeness === "REPRESENTATIVE" || forward.reasons.length > 0);
  }

  console.log(failures === 0 ? "\nAll representativeness checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
