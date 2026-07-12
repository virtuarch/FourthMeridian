/**
 * lib/investments/reconstruction-corp-actions.test.ts
 *
 * A7-7 — imported corporate-action inversion + statement checkpoints, over the
 * pure reconstruction core. Proves:
 *   - MERGER / SPIN_OFF with a stated share quantity invert (walk-through);
 *   - MERGER / SPIN_OFF without a quantity still STOP (never guess terms);
 *   - SPLIT with a known ratio still inverts; ratio-less SPLIT still stops (no
 *     regression);
 *   - imported statement anchors that disagree with the walk flag `conflicted`
 *     with checkpoint evidence — never averaged, never re-anchoring; agreement and
 *     beyond-coverage anchors raise no conflict.
 *
 *   npx tsx lib/investments/reconstruction-corp-actions.test.ts
 */

import { InvestmentEventType } from "@prisma/client";
import {
  reconstructPositions, detectCheckpointConflicts, applyCheckpointConflicts,
  type ReconEventInput, type ImportedCheckpoint,
} from "./reconstruction-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

let seq = 0;
const ev = (type: InvestmentEventType, date: string, over: Partial<ReconEventInput> = {}): ReconEventInput =>
  ({ id: `e${seq++}`, source: "csv:schwab", externalEventId: `x${seq}`, date, type, instrumentId: "X", quantity: null, amount: null, currency: "USD", ratio: null, ...over });

function one(anchorQty: number, events: ReconEventInput[]) {
  return reconstructPositions({ anchors: [{ instrumentId: "X", quantity: anchorQty, isCash: false, date: "2026-07-11", observationId: "o1" }], events, runDate: "2026-07-11" })[0];
}

function main(): void {
  // ── Merger inversion ───────────────────────────────────────────────────────
  console.log("MERGER inversion (terms known) vs stop");
  {
    // Stock merger, terms known (ratio + relatedInstrumentId): acquired leg closed
    // (anchor 0), BUY +5 then MERGER −5 with terms ⇒ fully explained.
    const inverted = one(0, [ev(InvestmentEventType.BUY, "2026-05-01", { quantity: 5 }), ev(InvestmentEventType.MERGER, "2026-06-01", { quantity: -5, ratio: 1.5, relatedInstrumentId: "ACQ" })]);
    check("stock MERGER with ratio+relatedInstrumentId inverts ⇒ COMPLETE", inverted.status === "COMPLETE" && Math.abs(inverted.unexplainedOpeningQuantity) <= 1e-6, JSON.stringify({ s: inverted.status, u: inverted.unexplainedOpeningQuantity }));
    // Cash merger: cash leg + disposed quantity, ratio-less ⇒ position → 0.
    const cash = one(0, [ev(InvestmentEventType.BUY, "2026-05-01", { quantity: 5 }), ev(InvestmentEventType.MERGER, "2026-06-01", { quantity: -5, amount: 750 })]);
    check("cash MERGER (cash leg + disposed shares) inverts ⇒ COMPLETE", cash.status === "COMPLETE");
    // Terms unknown (quantity only, no ratio/related/cash) ⇒ stop — never guess.
    const stopped = one(0, [ev(InvestmentEventType.BUY, "2026-05-01", { quantity: 5 }), ev(InvestmentEventType.MERGER, "2026-06-01", { quantity: -5 })]);
    check("MERGER with no terms (quantity only) still STOPS", stopped.status === "FAILED" && stopped.failureReason === "UNSUPPORTED_CORPORATE_ACTION");
  }

  // ── Spin-off inversion ─────────────────────────────────────────────────────
  console.log("SPIN_OFF inversion (terms known) vs stop");
  {
    const inverted = one(3, [ev(InvestmentEventType.SPIN_OFF, "2026-06-01", { quantity: 3, ratio: 0.5, relatedInstrumentId: "PARENT" })]);
    check("SPIN_OFF with ratio+relatedInstrumentId inverts ⇒ COMPLETE (child created)", inverted.status === "COMPLETE" && Math.abs(inverted.unexplainedOpeningQuantity) <= 1e-6);
    const stopped = one(3, [ev(InvestmentEventType.SPIN_OFF, "2026-06-01", { quantity: 3 })]);
    check("SPIN_OFF without terms still STOPS", stopped.status === "FAILED");
  }

  // ── Split: no regression ───────────────────────────────────────────────────
  console.log("SPLIT ratio inversion unchanged (no regression)");
  {
    const ok = one(20, [ev(InvestmentEventType.BUY, "2026-05-01", { quantity: 10 }), ev(InvestmentEventType.SPLIT, "2026-06-01", { ratio: 2 })]);
    check("SPLIT ratio 2 divides backward ⇒ COMPLETE, residual 0", ok.status === "COMPLETE" && Math.abs(ok.unexplainedOpeningQuantity) <= 1e-6);
    const stop = one(20, [ev(InvestmentEventType.SPLIT, "2026-06-01", { ratio: null })]);
    check("ratio-less SPLIT still STOPS", stop.status === "FAILED" && stop.failureReason === "UNSUPPORTED_CORPORATE_ACTION");
  }

  // ── Statement checkpoints ──────────────────────────────────────────────────
  console.log("statement checkpoints: conflict surfaced, never averaged");
  {
    const recon = [one(10, [ev(InvestmentEventType.BUY, "2026-06-01", { quantity: 4 })])];
    // Walk quantity on 2026-06-01 is 10 (before reversing the buy).
    const agree: ImportedCheckpoint = { instrumentId: "X", date: "2026-06-01", quantity: 10, observationId: "obsA" };
    const disagree: ImportedCheckpoint = { instrumentId: "X", date: "2026-06-01", quantity: 8, observationId: "obsB" };
    const beyond: ImportedCheckpoint = { instrumentId: "X", date: "2026-05-01", quantity: 99, observationId: "obsC" };

    check("agreeing checkpoint ⇒ no conflict", detectCheckpointConflicts(recon, [agree]).length === 0);
    check("beyond-coverage checkpoint ⇒ no conflict (no claim)", detectCheckpointConflicts(recon, [beyond]).length === 0);
    const conflicts = detectCheckpointConflicts(recon, [disagree]);
    check("disagreeing checkpoint ⇒ one conflict with both quantities", conflicts.length === 1 && conflicts[0].walkQuantity === 10 && conflicts[0].anchorQuantity === 8);

    const applied = applyCheckpointConflicts(recon, conflicts);
    check("conflict marks the position conflicted + records checkpoint evidence, quantity untouched", applied[0].conflicted === true && applied[0].evidenceRefs.checkpointConflicts?.length === 1 && applied[0].unexplainedOpeningQuantity === recon[0].unexplainedOpeningQuantity);
    check("no conflicts ⇒ reconstructions returned unchanged", applyCheckpointConflicts(recon, []) === recon);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll reconstruction corp-action checks passed");
}

main();
