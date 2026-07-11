/**
 * lib/investments/reconstruction-read.test.ts
 *
 * A4-4 — pure tests for the reconstruction read model: the honesty line per
 * reconciliation outcome (derived history never styled as observed; unexplained
 * openings always stated; conflicts surfaced), and the position-as-of resolution
 * (latest row ≤ date, origin precedence, incomplete gap, per-origin trust tier).
 * DB bindings are validated on real data after merge.
 *
 *   npx tsx lib/investments/reconstruction-read.test.ts
 */

import { PositionOrigin } from "@prisma/client";
import {
  describeReconstruction,
  toPositionHonesty,
  resolvePositionAsOf,
  type ReconstructionSummaryView,
  type PositionRow,
} from "./reconstruction-read";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const summary = (o: Partial<ReconstructionSummaryView>): ReconstructionSummaryView => ({
  instrumentId: "TQQQ",
  observedCurrentQuantity: 42.5,
  openingQuantity: 0,
  unexplainedOpeningQuantity: 0,
  earliestDefensibleDate: "2026-06-03",
  reconciliation: "COMPLETE",
  completeness: "derived",
  conflicted: false,
  ...o,
});

console.log("describeReconstruction — honest, name-free copy per outcome");
{
  const complete = describeReconstruction(summary({ reconciliation: "COMPLETE", completeness: "derived" }));
  check("COMPLETE says 'Reconstructed', never 'observed'",
    /reconstructed/i.test(complete) && !/observed/i.test(complete));

  const partial = describeReconstruction(summary({ reconciliation: "PARTIAL", completeness: "incomplete", unexplainedOpeningQuantity: 20 }));
  check("PARTIAL states the unexplained opening quantity", /20/.test(partial) && /before your history/i.test(partial));

  const failed = describeReconstruction(summary({ reconciliation: "FAILED", completeness: "incomplete", earliestDefensibleDate: "2026-05-01" }));
  check("FAILED states where history stops", /history stops at 2026-05-01/i.test(failed));

  const conflicted = describeReconstruction(summary({ conflicted: true, reconciliation: "PARTIAL" }));
  check("conflicted is surfaced first", /sources disagree/i.test(conflicted));

  const partialZero = describeReconstruction(summary({ reconciliation: "PARTIAL", unexplainedOpeningQuantity: 0 }));
  check("PARTIAL with no residual still reads partial (never 'complete')", /partially reconstructed/i.test(partialZero));
}

console.log("toPositionHonesty — composes display + residual flags");
{
  const h = toPositionHonesty(
    summary({ reconciliation: "PARTIAL", completeness: "incomplete", unexplainedOpeningQuantity: 19.99995 }),
    { symbol: "TQQQ", name: "ProShares UltraPro QQQ" },
  );
  check("symbol/name carried", h.symbol === "TQQQ" && h.name === "ProShares UltraPro QQQ");
  check("unexplained rounded, non-negative", Math.abs(h.unexplained - 20) <= 1e-3);
  check("hasUnexplainedOpening true", h.hasUnexplainedOpening === true);
  check("canonical completeness tier preserved", h.completeness === "incomplete");

  const clean = toPositionHonesty(summary({}), { symbol: "VTI", name: null });
  check("complete position has no unexplained opening", clean.hasUnexplainedOpening === false && clean.unexplained === 0);
}

console.log("resolvePositionAsOf — latest row ≤ date, origin precedence, trust tier");
{
  const rows: PositionRow[] = [
    { date: "2026-05-01", quantity: 10, origin: PositionOrigin.DERIVED, completeness: "derived" },
    { date: "2026-06-01", quantity: 25, origin: PositionOrigin.DERIVED, completeness: "derived" },
    { date: "2026-07-11", quantity: 42.5, origin: PositionOrigin.OBSERVED, completeness: null },
  ];
  check("as-of before the first row ⇒ incomplete gap (never a fabricated 0)",
    resolvePositionAsOf(rows, "2026-04-01").quantity === null && resolvePositionAsOf(rows, "2026-04-01").tier === "incomplete");

  const mid = resolvePositionAsOf(rows, "2026-06-15");
  check("as-of mid-window picks the latest ≤ date (25, derived)", mid.quantity === 25 && mid.tier === "derived");

  const now = resolvePositionAsOf(rows, "2026-07-11");
  check("as-of today picks the OBSERVED anchor (42.5, observed)", now.quantity === 42.5 && now.tier === "observed");
}

console.log("resolvePositionAsOf — origin precedence + incomplete DERIVED tier on a tie");
{
  const sameDate: PositionRow[] = [
    { date: "2026-06-01", quantity: 30, origin: PositionOrigin.DERIVED, completeness: "incomplete" },
    { date: "2026-06-01", quantity: 31, origin: PositionOrigin.OBSERVED, completeness: null },
  ];
  const r = resolvePositionAsOf(sameDate, "2026-06-01");
  check("OBSERVED beats DERIVED on the same date", r.quantity === 31 && r.origin === PositionOrigin.OBSERVED && r.tier === "observed");

  const onlyDerived = resolvePositionAsOf(
    [{ date: "2026-06-01", quantity: 30, origin: PositionOrigin.DERIVED, completeness: "incomplete" }],
    "2026-06-01",
  );
  check("a DERIVED 'incomplete' row resolves as incomplete", onlyDerived.tier === "incomplete");
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll reconstruction-read checks passed");
