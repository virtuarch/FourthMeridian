/**
 * lib/snapshots/price-completeness.core.test.ts
 *
 * V26-PRICE-5 — evidence-axis fixtures. Standalone tsx script:
 *
 *     npx tsx lib/snapshots/price-completeness.core.test.ts
 *
 * Section 3 is the one that matters. The temptation this whole module guards
 * against is specific: complete price coverage FEELS like completeness. It is
 * one axis of three, and a snapshot built on back-projected quantities is not
 * observed no matter how perfect its prices are.
 */

import {
  summariseSnapshotEvidence,
  mayClaimObserved,
  EVIDENCE_REASONS,
  type InstrumentEvidenceAxes,
} from "./price-completeness.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const D = "2026-01-05";
function ax(over: Partial<InstrumentEvidenceAxes> = {}): InstrumentEvidenceAxes {
  return {
    instrumentId:        "inst_1",
    priceCoverage:       "COMPLETE",
    ownershipConfidence: "KNOWN",
    quantityConfidence:  "RECONSTRUCTED",
    ...over,
  };
}
const sum = (axes: InstrumentEvidenceAxes[]) => summariseSnapshotEvidence(D, axes).summary;

function main(): void {
  // ── 1. All clean ──────────────────────────────────────────────────────────
  console.log("1. every axis clean");
  {
    const s = sum([ax()]);
    check("tier is observed", s.tier === "observed");
    check("isEstimated is false", s.isEstimated === false);
    check("no reasons", eq(s.reasons, []));
    check("mayClaimObserved agrees", mayClaimObserved(s));
  }

  // ── 2. Each axis degrades alone ───────────────────────────────────────────
  console.log("2. each axis degrades independently");
  {
    const partial = sum([ax({ priceCoverage: "PARTIAL" })]);
    check("partial prices → estimated, with only the price reason",
      partial.tier === "estimated" && eq(partial.reasons, ["PRICE_COVERAGE_PARTIAL"]));
    check("…and the other two axes stay clean",
      partial.ownershipConfidence === "KNOWN" && partial.quantityConfidence === "RECONSTRUCTED");

    const none = sum([ax({ priceCoverage: "NONE" })]);
    check("no prices → incomplete", none.tier === "incomplete" && eq(none.reasons, ["PRICE_COVERAGE_NONE"]));

    const unreachable = sum([ax({ priceCoverage: "UNREACHABLE" })]);
    check("unreachable prices → estimated, distinctly coded",
      unreachable.tier === "estimated" && eq(unreachable.reasons, ["PRICE_COVERAGE_UNREACHABLE"]));

    const possible = sum([ax({ ownershipConfidence: "POSSIBLE" })]);
    check("inferred ownership → estimated, prices untouched",
      possible.tier === "estimated" && possible.priceCoverage === "COMPLETE" &&
      eq(possible.reasons, ["OWNERSHIP_INFERRED"]));

    const backProjected = sum([ax({ quantityConfidence: "BACK_PROJECTED" })]);
    check("back-projected quantity → estimated, prices untouched",
      backProjected.tier === "estimated" && backProjected.priceCoverage === "COMPLETE" &&
      eq(backProjected.reasons, ["QUANTITY_BACK_PROJECTED"]));

    const unknownQty = sum([ax({ quantityConfidence: "UNKNOWN" })]);
    check("unknown quantity → unknown tier", unknownQty.tier === "unknown");
  }

  // ── 3. THE GUARD ──────────────────────────────────────────────────────────
  console.log("3. perfect prices cannot promote a snapshot to observed");
  {
    const s = sum([ax({ quantityConfidence: "BACK_PROJECTED" })]);
    check("COMPLETE price coverage + back-projected quantity is NOT observed",
      s.priceCoverage === "COMPLETE" && s.tier !== "observed");
    check("…and mayClaimObserved refuses it", !mayClaimObserved(s));
    check("…and the reason names the quantity, not the prices",
      eq(s.reasons, ["QUANTITY_BACK_PROJECTED"]));

    const inferred = sum([ax({ ownershipConfidence: "POSSIBLE" })]);
    check("COMPLETE price coverage + inferred ownership is NOT observed",
      inferred.priceCoverage === "COMPLETE" && !mayClaimObserved(inferred));

    // The specific arc hazard: acquisition succeeds, quantities are still wrong.
    const afterAcquisition = sum([
      ax({ instrumentId: "inst_btc", priceCoverage: "COMPLETE", ownershipConfidence: "POSSIBLE", quantityConfidence: "BACK_PROJECTED" }),
    ]);
    check("a fully priced BTC day with inferred ownership AND back-projection stays estimated",
      afterAcquisition.tier === "estimated" && !mayClaimObserved(afterAcquisition));
    check("…and discloses BOTH causes, not just the first found",
      eq(afterAcquisition.reasons, ["OWNERSHIP_INFERRED", "QUANTITY_BACK_PROJECTED"]));
  }

  // ── 4. Aggregation across instruments ─────────────────────────────────────
  console.log("4. aggregation across instruments");
  {
    const mixed = sum([
      ax({ instrumentId: "inst_a" }),
      ax({ instrumentId: "inst_b", priceCoverage: "PARTIAL" }),
      ax({ instrumentId: "inst_c", quantityConfidence: "BACK_PROJECTED" }),
    ]);
    check("each axis takes its own worst, independently",
      mixed.priceCoverage === "PARTIAL" &&
      mixed.ownershipConfidence === "KNOWN" &&
      mixed.quantityConfidence === "BACK_PROJECTED");
    check("one clean instrument cannot rescue the day", mixed.tier !== "observed");
    check("both degradations are disclosed",
      eq(mixed.reasons, ["PRICE_COVERAGE_PARTIAL", "QUANTITY_BACK_PROJECTED"]));

    const worstWins = sum([
      ax({ instrumentId: "a", priceCoverage: "PARTIAL" }),
      ax({ instrumentId: "b", priceCoverage: "NONE" }),
      ax({ instrumentId: "c", priceCoverage: "COMPLETE" }),
    ]);
    check("price coverage takes the worst, not the most common",
      worstWins.priceCoverage === "NONE");

    const allClean = sum([ax({ instrumentId: "a" }), ax({ instrumentId: "b" }), ax({ instrumentId: "c" })]);
    check("many clean instruments remain observed", allClean.tier === "observed");
  }

  // ── 5. Absence is not health ──────────────────────────────────────────────
  console.log("5. absence of evidence");
  {
    const empty = summariseSnapshotEvidence(D, []);
    check("no instruments → unknown, never observed", empty.summary.tier === "unknown");
    check("…and estimated", empty.summary.isEstimated === true);
    check("…and says so", eq(empty.summary.reasons, ["NO_INSTRUMENT_EVIDENCE"]));
    check("…with every axis at its worst",
      empty.summary.priceCoverage === "NONE" &&
      empty.summary.ownershipConfidence === "UNKNOWN" &&
      empty.summary.quantityConfidence === "UNKNOWN");
  }

  // ── 6. Axes survive the reduction ─────────────────────────────────────────
  console.log("6. per-instrument detail survives");
  {
    const e = summariseSnapshotEvidence(D, [
      ax({ instrumentId: "inst_z", priceCoverage: "PARTIAL" }),
      ax({ instrumentId: "inst_a" }),
    ]);
    check("every instrument's axes are retained, not replaced by the summary",
      e.axes.length === 2);
    check("…so 'which holding degraded this day' stays answerable",
      e.axes.find((a) => a.instrumentId === "inst_z")?.priceCoverage === "PARTIAL" &&
      e.axes.find((a) => a.instrumentId === "inst_a")?.priceCoverage === "COMPLETE");
    check("axes are sorted by instrument id, not input order",
      eq(e.axes.map((a) => a.instrumentId), ["inst_a", "inst_z"]));
  }

  // ── 7. Determinism ────────────────────────────────────────────────────────
  console.log("7. determinism");
  {
    const input = [
      ax({ instrumentId: "b", priceCoverage: "PARTIAL" }),
      ax({ instrumentId: "a", quantityConfidence: "BACK_PROJECTED" }),
    ];
    const forward = summariseSnapshotEvidence(D, input);
    const reverse = summariseSnapshotEvidence(D, [...input].reverse());
    check("INPUT ORDER CANNOT CHANGE THE SUMMARY", JSON.stringify(forward) === JSON.stringify(reverse));
    check("repeat invocation → byte-identical",
      JSON.stringify(summariseSnapshotEvidence(D, input)) === JSON.stringify(forward));
    check("reasons are a strictly ordered subsequence of EVIDENCE_REASONS", (() => {
      const idx = forward.summary.reasons.map((r) => EVIDENCE_REASONS.indexOf(r));
      return idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
    })());
    check("every non-observed summary carries at least one reason",
      forward.summary.tier === "observed" || forward.summary.reasons.length > 0);
    check("isEstimated is exactly 'not observed'",
      forward.summary.isEstimated === (forward.summary.tier !== "observed"));
  }

  console.log(failures === 0 ? "\nAll price-completeness checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
