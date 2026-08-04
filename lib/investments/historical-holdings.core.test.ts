/**
 * lib/investments/historical-holdings.core.test.ts
 *
 * V26-S2-OWNERSHIP — the canonical historical-holdings set. Standalone tsx, pure.
 *
 * Calibrated on the live corpus. The shapes below are the real ones:
 *   · 2026-01-01 produced 19 components, of which ownership licenses 13 and
 *     values 12 — the label read `12 of 19` and should read `12 of 13`;
 *   · nine LLC positions were sold on 2026-07-27 with an OBSERVED zero, and
 *     their ownership windows nevertheless ran to the ceiling;
 *   · `CUR:USD` is held in two accounts, so a holding is a PAIR, never an
 *     instrument.
 */

import { readFileSync } from "node:fs";
import {
  buildHistoricalHoldings, ownershipOn, ownershipTier,
  type HoldingComponent, type HoldingOwnershipFacts,
} from "./historical-holdings.core";
import { resolveOwnershipWindow } from "@/lib/prices/ownership-window.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const CEIL = "2026-08-02";
const own = (fromISO: string, closedFromISO: string | null = null, possibleFromISO?: string): HoldingOwnershipFacts => ({
  resolution: resolveOwnershipWindow({
    instrumentId: "x", earliestDirectISO: fromISO,
    earliestPossibleISO: possibleFromISO ?? null, valuationToISO: CEIL, closedFromISO,
  }),
  closedFromISO,
});

const comp = (
  instrumentId: string, reportingValue: number | null, accountId = "acctA",
): HoldingComponent => ({
  financialAccountId: accountId, instrumentId, quantity: 1,
  reportingValue, tier: "derived", reason: "",
});
const keyOf = (c: HoldingComponent) => `${c.financialAccountId}|${c.instrumentId}`;

function main(): void {
  console.log("V26-S2-OWNERSHIP — historical holdings set\n");

  // ── A. THE DENOMINATOR IS WHAT EXISTED ────────────────────────────────────
  {
    const facts = new Map<string, HoldingOwnershipFacts>([
      ["acctA|HELD_VALUED",   own("2025-01-01")],
      ["acctA|HELD_UNVALUED", own("2025-01-01")],
      ["acctA|PREHISTORY",    own("2026-06-25")], // not yet owned on the test date
    ]);
    const set = buildHistoricalHoldings("2026-01-01", [
      comp("HELD_VALUED", 100), comp("HELD_UNVALUED", null), comp("PREHISTORY", 500),
    ], facts, keyOf);

    check("A. the denominator counts only what ownership licenses", set.heldCount === 2);
    check("A. a HELD but unvalued holding stays in the denominator", set.valuedCount === 1);
    // V26-S4 — a position whose ownership begins LATER is NOT_YET_OWNED, which
    // is a complete explanation; OWNERSHIP_UNKNOWN now means only "we cannot
    // establish either way". The distinction is the point of the split.
    check("A. prehistory is excluded, with a coded reason",
      set.excluded.length === 1 && set.excluded[0].reasonCode === "NOT_YET_OWNED");
    check("A. and it states when the position WOULD become held",
      set.excluded[0].opensISO === "2026-06-25");
    check("A. the subtotal counts only held holdings", set.valuedSubtotal === 100);
    check("A. an excluded holding contributes NOTHING to the subtotal",
      !set.held.some((h) => h.instrumentId === "PREHISTORY"));
  }

  // ── B. OWNERSHIP ENDS — a sold position leaves the denominator ────────────
  // Nine LLC positions were sold on 2026-07-27 with an OBSERVED zero. Before
  // this slice their windows ran to the ceiling and said they were still owned.
  {
    const facts = new Map([["acctA|SOLD", own("2025-07-31", "2026-07-27")]]);
    const before = buildHistoricalHoldings("2026-07-26", [comp("SOLD", 100)], facts, keyOf);
    const onDay  = buildHistoricalHoldings("2026-07-27", [comp("SOLD", 100)], facts, keyOf);
    const after  = buildHistoricalHoldings("2026-08-01", [comp("SOLD", 100)], facts, keyOf);

    check("B. held the day before the closure", before.heldCount === 1);
    check("B. NOT held on the closure date itself (the zero is that day's fact)",
      onDay.heldCount === 0);
    check("B. not held afterwards", after.heldCount === 0);
    check("B. the reason distinguishes CLOSED from never-owned",
      after.excluded[0].reasonCode === "OWNERSHIP_CLOSED");
    check("B. the explanation names the date ownership ended",
      after.excluded[0].explanation.includes("2026-07-27"));
    check("B. and the held day reports when ownership ends",
      before.held[0].ownershipToISO === "2026-07-26");
  }

  // ── C. A HOLDING IS A PAIR, NEVER AN INSTRUMENT ──────────────────────────
  // `CUR:USD` is held in two accounts. Instrument-scoped ownership licensed one
  // account's cash from the OTHER account's evidence.
  {
    const facts = new Map<string, HoldingOwnershipFacts>([
      ["acctA|CUR:USD", own("2025-08-27")], // Robinhood: evidence back to Aug
      ["acctB|CUR:USD", own("2026-07-19")], // LLC: its own evidence starts later
    ]);
    const set = buildHistoricalHoldings("2025-09-01", [
      comp("CUR:USD", 471, "acctA"), comp("CUR:USD", 3556, "acctB"),
    ], facts, keyOf);

    check("C. the account WITH evidence is held", set.heldCount === 1);
    check("C. the account WITHOUT its own evidence is excluded",
      set.excluded.length === 1 && set.excluded[0].financialAccountId === "acctB");
    check("C. and its neighbour's evidence does not rescue it",
      set.valuedSubtotal === 471);
  }

  // ── D. ZERO IS A CORRECT ANSWER ──────────────────────────────────────────
  {
    const facts = new Map([["acctA|BTC", own("2026-01-01")]]);
    const set = buildHistoricalHoldings("2023-06-01", [comp("BTC", 1000)], facts, keyOf);
    check("D. a date before the portfolio began holds nothing", set.heldCount === 0);
    check("D. and that is reported, not failed", set.excluded.length === 1);
    check("D. ownership confidence is UNKNOWN when nothing is held",
      set.ownershipConfidence === "UNKNOWN");
    check("D. the subtotal is 0 — but the caller sees heldCount 0 to tell it apart",
      set.valuedSubtotal === 0);
  }

  // ── E. THE COUNT MOVES IN BOTH DIRECTIONS ────────────────────────────────
  {
    const facts = new Map<string, HoldingOwnershipFacts>([
      ["acctA|EARLY", own("2025-01-01", "2026-03-01")],
      ["acctA|LATE",  own("2026-02-01")],
    ]);
    const parts = ["2024-12-01", "2025-06-01", "2026-02-15", "2026-06-01"].map((d) =>
      buildHistoricalHoldings(d, [comp("EARLY", 10), comp("LATE", 20)], facts, keyOf).heldCount);
    check("E. 0 → 1 → 2 → 1 as positions are acquired and sold",
      parts.join(",") === "0,1,2,1", `got ${parts.join(",")}`);
  }

  // ── F. POSSIBLE ownership is held, and SAID SO ───────────────────────────
  {
    const facts = new Map([["acctA|INFERRED", own("2026-01-01", null, "2025-01-01")]]);
    const set = buildHistoricalHoldings("2025-06-01", [comp("INFERRED", 100)], facts, keyOf);
    check("F. an inferred holding is held", set.heldCount === 1);
    check("F. and carries POSSIBLE, never silently promoted",
      set.held[0].ownership === "POSSIBLE" && set.ownershipConfidence === "POSSIBLE");
    check("F. which only justifies an 'estimated' tier", ownershipTier("POSSIBLE") === "estimated");
  }

  // ── G. No resolution at all is distinguishable ───────────────────────────
  {
    const set = buildHistoricalHoldings("2026-01-01", [comp("ORPHAN", 100)], new Map(), keyOf);
    check("G. an unresolved pair is excluded", set.heldCount === 0);
    check("G. with its own reason code", set.excluded[0].reasonCode === "NO_OWNERSHIP_EVIDENCE");
  }

  // ── H. Determinism — input order cannot change the answer ────────────────
  {
    const facts = new Map<string, HoldingOwnershipFacts>([
      ["acctA|A", own("2025-01-01")], ["acctB|B", own("2025-01-01")],
    ]);
    const fwd = buildHistoricalHoldings("2026-01-01", [comp("A", 1), comp("B", 2, "acctB")], facts, keyOf);
    const rev = buildHistoricalHoldings("2026-01-01", [comp("B", 2, "acctB"), comp("A", 1)], facts, keyOf);
    check("H. identical held order", JSON.stringify(fwd.held) === JSON.stringify(rev.held));
    check("H. identical subtotal", fwd.valuedSubtotal === rev.valuedSubtotal);
  }

  // ── I. ownershipOn boundaries, both ends ─────────────────────────────────
  {
    const r = own("2025-01-01", "2026-03-01").resolution;
    check("I. the first day of the window is inside", ownershipOn("2025-01-01", r) === "KNOWN");
    check("I. the day before is outside", ownershipOn("2024-12-31", r) === "UNKNOWN");
    check("I. the last day before closure is inside", ownershipOn("2026-02-28", r) === "KNOWN");
    check("I. the closure date is outside", ownershipOn("2026-03-01", r) === "UNKNOWN");
    check("I. an undefined resolution is UNKNOWN, never a default yes",
      ownershipOn("2026-01-01", undefined) === "UNKNOWN");
  }

  // ── J. NO CURRENT-HOLDINGS LEAKAGE (the invariant, asserted structurally) ─
  {
    const src = readFileSync("lib/investments/historical-holdings.core.ts", "utf8");
    check("J. the set builder reads no clock", !/Date\.now|new Date\(\)/.test(src));
    check("J. and knows nothing about current holdings",
      !/current|today|getCurrentPositions/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")));
  }

  console.log(failures === 0 ? "\nAll historical-holdings checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
