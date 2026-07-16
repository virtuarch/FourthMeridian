/**
 * lib/investments/reconstruction-core.test.ts
 *
 * A4-1 — pure fixture tests for the reconstruction walk. No DB, no prisma
 * generate needed beyond the InvestmentEventType enum (house pattern):
 *
 *   npx tsx lib/investments/reconstruction-core.test.ts
 *
 * Covers the backward walk, opening residual (never zeroed), COMPLETE/PARTIAL/
 * FAILED status, CANCEL matching + CONFLICTED, corporate-action stops, split
 * ratio, cash-only routing, closed-position discovery, and determinism.
 */

import { InvestmentEventType } from "@prisma/client";
import {
  reconstructPositions,
  routeEvents,
  RECON_FAILURE,
  detectCheckpointConflicts,
  applyCheckpointConflicts,
  type ReconEventInput,
  type ReconAnchorInput,
  type InstrumentReconstruction,
  type ImportedCheckpoint,
} from "./reconstruction-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number) => Math.abs(a - b) <= 1e-6;

let seq = 0;
function ev(p: Partial<ReconEventInput> & { date: string; type: InvestmentEventType }): ReconEventInput {
  seq += 1;
  return {
    id: p.id ?? `e${seq}`,
    source: p.source ?? "plaid",
    externalEventId: p.externalEventId ?? `x${seq}`,
    date: p.date,
    type: p.type,
    // Preserve an explicit `instrumentId: null` (cash-only) — ?? would eat it.
    instrumentId: "instrumentId" in p ? p.instrumentId! : "TQQQ",
    quantity: p.quantity ?? null,
    amount: p.amount ?? null,
    currency: p.currency ?? null,
    ratio: p.ratio ?? null,
  };
}
const anchor = (p: Partial<ReconAnchorInput> & { quantity: number }): ReconAnchorInput => ({
  instrumentId: p.instrumentId ?? "TQQQ",
  quantity: p.quantity,
  isCash: p.isCash ?? false,
  date: p.date ?? "2026-07-11",
  observationId: p.observationId ?? "obs1",
});
const only = (rs: InstrumentReconstruction[], id = "TQQQ") => rs.find((r) => r.instrumentId === id)!;

console.log("backward walk — partial (opening residual persisted, never zeroed)");
{
  // 42.5 held; events explain 22.5 → 20 unexplained (plan §3.1 example).
  const rs = reconstructPositions({
    runDate: "2026-07-11",
    anchors: [anchor({ quantity: 42.5 })],
    events: [
      ev({ date: "2026-06-03", type: InvestmentEventType.BUY, quantity: 7.5 }),
      ev({ date: "2026-06-20", type: InvestmentEventType.BUY, quantity: 15 }),
    ],
  });
  const r = only(rs);
  check("openingQuantity = 20", approx(r.openingQuantity, 20), `got ${r.openingQuantity}`);
  check("unexplainedOpeningQuantity = openingQuantity", approx(r.unexplainedOpeningQuantity, 20));
  check("status PARTIAL", r.status === "PARTIAL");
  check("summary completeness incomplete", r.completeness === "incomplete");
  check("observedCurrentQuantity = anchor", approx(r.observedCurrentQuantity, 42.5));
  check("earliestDefensibleDate = first event date", r.earliestDefensibleDate === "2026-06-03");
  check("derived row at 2026-06-20 = 42.5 (as-of end of that day)", approx(r.derivedRows.find((x) => x.date === "2026-06-20")!.quantity, 42.5));
  check("derived row at 2026-06-03 = 27.5 (before the 06-20 buy of 15)", approx(r.derivedRows.find((x) => x.date === "2026-06-03")!.quantity, 27.5));
  const boundary = r.derivedRows.find((x) => x.date === "2026-06-03")!;
  check("boundary row reads incomplete with the residual", boundary.completeness === "incomplete" && approx(boundary.unexplainedQuantity ?? -1, 20));
  check("non-boundary row reads derived", r.derivedRows.find((x) => x.date === "2026-06-20")!.completeness === "derived");
}

console.log("backward walk — complete (events fully explain the position)");
{
  const rs = reconstructPositions({
    runDate: "2026-07-11",
    anchors: [anchor({ quantity: 30 })],
    events: [
      ev({ date: "2026-05-01", type: InvestmentEventType.BUY, quantity: 10 }),
      ev({ date: "2026-06-01", type: InvestmentEventType.BUY, quantity: 20 }),
    ],
  });
  const r = only(rs);
  check("openingQuantity ≈ 0", approx(r.openingQuantity, 0));
  check("status COMPLETE", r.status === "COMPLETE");
  check("summary completeness derived", r.completeness === "derived");
  check("every derived row reads derived", r.derivedRows.every((x) => x.completeness === "derived" && x.unexplainedQuantity === null));
}

console.log("SELL reduces the walk (signed quantity)");
{
  const rs = reconstructPositions({
    runDate: "2026-07-11",
    anchors: [anchor({ quantity: 10 })],
    events: [
      ev({ date: "2026-05-01", type: InvestmentEventType.BUY, quantity: 30 }),
      ev({ date: "2026-06-01", type: InvestmentEventType.SELL, quantity: -20 }),
    ],
  });
  check("buy 30 then sell 20 from opening 0 → complete", approx(only(rs).openingQuantity, 0) && only(rs).status === "COMPLETE");
}

console.log("closed position discovered from events (anchored at 0)");
{
  const rs = reconstructPositions({
    runDate: "2026-07-11",
    anchors: [], // not currently held
    events: [
      ev({ date: "2026-03-01", type: InvestmentEventType.BUY, quantity: 10, instrumentId: "OLD" }),
      ev({ date: "2026-04-01", type: InvestmentEventType.SELL, quantity: -10, instrumentId: "OLD" }),
    ],
  });
  const r = only(rs, "OLD");
  check("closed position reconstructed with anchor 0", approx(r.observedCurrentQuantity, 0));
  check("fully disposed → opening ≈ 0, COMPLETE", approx(r.openingQuantity, 0) && r.status === "COMPLETE");
}

console.log("CANCEL — equal-and-opposite match nets to zero, no conflict");
{
  const rs = reconstructPositions({
    runDate: "2026-07-11",
    anchors: [anchor({ quantity: 5 })],
    events: [
      ev({ date: "2026-05-01", type: InvestmentEventType.BUY, quantity: 10 }),
      ev({ date: "2026-05-02", type: InvestmentEventType.CANCEL, quantity: -10 }),
      ev({ date: "2026-05-03", type: InvestmentEventType.BUY, quantity: 5 }),
    ],
  });
  const r = only(rs);
  check("matched cancel removes both → opening ≈ 0", approx(r.openingQuantity, 0));
  check("not conflicted", r.conflicted === false);
  check("status COMPLETE", r.status === "COMPLETE");
}

console.log("CANCEL — unmatched cancel flags CONFLICTED, never guessed");
{
  const rs = reconstructPositions({
    runDate: "2026-07-11",
    anchors: [anchor({ quantity: 10 })],
    events: [
      ev({ date: "2026-05-01", type: InvestmentEventType.BUY, quantity: 10 }),
      ev({ date: "2026-05-05", type: InvestmentEventType.CANCEL, quantity: -3 }), // no +3 to match
    ],
  });
  const r = only(rs);
  check("conflicted flag set", r.conflicted === true);
  check("conflicted walk never claims COMPLETE", r.status === "PARTIAL");
}

console.log("corporate-action STOP — SPLIT without ratio");
{
  const rs = reconstructPositions({
    runDate: "2026-07-11",
    anchors: [anchor({ quantity: 20 })],
    events: [
      ev({ date: "2026-04-01", type: InvestmentEventType.BUY, quantity: 5 }),
      ev({ date: "2026-05-01", type: InvestmentEventType.SPLIT, quantity: 10, ratio: null }),
      ev({ date: "2026-06-01", type: InvestmentEventType.BUY, quantity: 10 }),
    ],
  });
  const r = only(rs);
  check("status FAILED", r.status === "FAILED");
  check("failureReason UNSUPPORTED_CORPORATE_ACTION", r.failureReason === RECON_FAILURE.UNSUPPORTED_CORPORATE_ACTION);
  check("stops at the split date (never walks through)", r.earliestDefensibleDate === "2026-05-01");
  check("summary completeness incomplete", r.completeness === "incomplete");
  check("no derived row exists before the split", !r.derivedRows.some((x) => x.date < "2026-05-01"));
}

console.log("corporate-action APPLY — SPLIT with a known ratio (backward divide)");
{
  // Forward: buy 5 → 2:1 split → 10 → buy 10 → 20. Backward must reach opening 0.
  const rs = reconstructPositions({
    runDate: "2026-07-11",
    anchors: [anchor({ quantity: 20 })],
    events: [
      ev({ date: "2026-04-01", type: InvestmentEventType.BUY, quantity: 5 }),
      ev({ date: "2026-05-01", type: InvestmentEventType.SPLIT, ratio: 2 }),
      ev({ date: "2026-06-01", type: InvestmentEventType.BUY, quantity: 10 }),
    ],
  });
  const r = only(rs);
  check("split with ratio does not stop", r.status !== "FAILED");
  check("ratio applied → opening ≈ 0, COMPLETE", approx(r.openingQuantity, 0) && r.status === "COMPLETE", `opening=${r.openingQuantity}`);
  check("derived quantity at split date = 10 (post-split)", approx(r.derivedRows.find((x) => x.date === "2026-05-01")!.quantity, 10));
}

console.log("corporate-action STOP — MERGER, and quantity-bearing UNKNOWN");
{
  const merger = only(reconstructPositions({
    runDate: "2026-07-11", anchors: [anchor({ quantity: 4 })],
    events: [ev({ date: "2026-05-01", type: InvestmentEventType.MERGER, quantity: 4 })],
  }));
  check("MERGER stops with UNSUPPORTED_CORPORATE_ACTION", merger.status === "FAILED" && merger.failureReason === RECON_FAILURE.UNSUPPORTED_CORPORATE_ACTION);

  const unk = only(reconstructPositions({
    runDate: "2026-07-11", anchors: [anchor({ quantity: 4 })],
    events: [ev({ date: "2026-05-01", type: InvestmentEventType.UNKNOWN, quantity: 4 })],
  }));
  check("quantity-bearing UNKNOWN stops", unk.status === "FAILED" && unk.failureReason === RECON_FAILURE.UNKNOWN_EVENT);

  const unkZero = only(reconstructPositions({
    runDate: "2026-07-11", anchors: [anchor({ quantity: 10 })],
    events: [
      ev({ date: "2026-05-01", type: InvestmentEventType.BUY, quantity: 10 }),
      ev({ date: "2026-06-01", type: InvestmentEventType.UNKNOWN, quantity: null }),
    ],
  }));
  check("UNKNOWN with no quantity does not stop", unkZero.status === "COMPLETE");
}

console.log("cash-only routing — cash events walk the per-currency cash instrument, not securities");
{
  const rs = reconstructPositions({
    runDate: "2026-07-11",
    cashInstrumentByCurrency: { USD: "CASH_USD" },
    anchors: [anchor({ quantity: 42.5 }), anchor({ instrumentId: "CASH_USD", quantity: 500, isCash: true })],
    events: [
      ev({ date: "2026-06-03", type: InvestmentEventType.BUY, quantity: 7.5, instrumentId: "TQQQ" }),
      // cash-only contribution: no instrumentId, carries currency + amount.
      ev({ date: "2026-06-10", type: InvestmentEventType.CONTRIBUTION, instrumentId: null, amount: 100, currency: "USD" }),
    ],
  });
  const security = only(rs, "TQQQ");
  const cash = only(rs, "CASH_USD");
  check("security walk untouched by the cash-only event (opening 35)", approx(security.openingQuantity, 35), `got ${security.openingQuantity}`);
  check("cash walk applies the cash amount (opening 400)", approx(cash.openingQuantity, 400), `got ${cash.openingQuantity}`);
  check("cash instrument flagged isCash", cash.isCash === true);
}

console.log("routeEvents — unroutable cash-only event (no cash instrument for its currency)");
{
  const routed = routeEvents(
    [ev({ date: "2026-06-10", type: InvestmentEventType.CONTRIBUTION, instrumentId: null, amount: 100, currency: "EUR" })],
    { USD: "CASH_USD" },
  );
  check("cash-only event with no cash instrument is unroutable, never applied",
    routed.unroutableCashEvents.length === 1 && routed.byInstrument.size === 0);
}

console.log("determinism + order independence");
{
  const events = [
    ev({ id: "b", externalEventId: "b", date: "2026-06-20", type: InvestmentEventType.BUY, quantity: 15 }),
    ev({ id: "a", externalEventId: "a", date: "2026-06-03", type: InvestmentEventType.BUY, quantity: 7.5 }),
  ];
  const one = reconstructPositions({ runDate: "2026-07-11", anchors: [anchor({ quantity: 42.5 })], events });
  const two = reconstructPositions({ runDate: "2026-07-11", anchors: [anchor({ quantity: 42.5 })], events: [...events].reverse() });
  check("identical inputs (any input order) → byte-identical JSON", JSON.stringify(one) === JSON.stringify(two));
}

console.log("A7-7 corporate-action inversion (terms known) + statement checkpoints");
{
  // Merged from the retired reconstruction-corp-actions suite (TEST-2). The
  // ratio-less SPLIT stop, terms-less MERGER stop, and SPLIT-ratio inversion it
  // also carried are already covered above (see the SPLIT/MERGER STOP + APPLY
  // blocks), so only the UNIQUE cases remain: MERGER/SPIN_OFF inversion WITH
  // terms, the SPIN_OFF stop, and imported statement checkpoints. Its fixture
  // anchors instrument "X" via csv:schwab events, so it keeps its own
  // block-scoped builders rather than the module `ev()`/`only()`.
  let cseq = 0;
  const cev = (type: InvestmentEventType, date: string, over: Partial<ReconEventInput> = {}): ReconEventInput =>
    ({ id: `c${cseq++}`, source: "csv:schwab", externalEventId: `cx${cseq}`, date, type, instrumentId: "X", quantity: null, amount: null, currency: "USD", ratio: null, ...over });
  const cone = (anchorQty: number, events: ReconEventInput[]) =>
    reconstructPositions({ anchors: [{ instrumentId: "X", quantity: anchorQty, isCash: false, date: "2026-07-11", observationId: "o1" }], events, runDate: "2026-07-11" })[0];

  // MERGER inversion (terms known): acquired leg closed (anchor 0), BUY +5 then
  // MERGER −5 with terms ⇒ fully explained.
  const merged = cone(0, [cev(InvestmentEventType.BUY, "2026-05-01", { quantity: 5 }), cev(InvestmentEventType.MERGER, "2026-06-01", { quantity: -5, ratio: 1.5, relatedInstrumentId: "ACQ" })]);
  check("stock MERGER with ratio+relatedInstrumentId inverts ⇒ COMPLETE", merged.status === "COMPLETE" && approx(merged.unexplainedOpeningQuantity, 0), JSON.stringify({ s: merged.status, u: merged.unexplainedOpeningQuantity }));
  const cashMerger = cone(0, [cev(InvestmentEventType.BUY, "2026-05-01", { quantity: 5 }), cev(InvestmentEventType.MERGER, "2026-06-01", { quantity: -5, amount: 750 })]);
  check("cash MERGER (cash leg + disposed shares) inverts ⇒ COMPLETE", cashMerger.status === "COMPLETE");

  // SPIN_OFF inversion (terms known) vs stop.
  const spun = cone(3, [cev(InvestmentEventType.SPIN_OFF, "2026-06-01", { quantity: 3, ratio: 0.5, relatedInstrumentId: "PARENT" })]);
  check("SPIN_OFF with ratio+relatedInstrumentId inverts ⇒ COMPLETE (child created)", spun.status === "COMPLETE" && approx(spun.unexplainedOpeningQuantity, 0));
  const spunStop = cone(3, [cev(InvestmentEventType.SPIN_OFF, "2026-06-01", { quantity: 3 })]);
  check("SPIN_OFF without terms still STOPS", spunStop.status === "FAILED");

  // Statement checkpoints: conflict surfaced, never averaged / re-anchoring.
  const recon = [cone(10, [cev(InvestmentEventType.BUY, "2026-06-01", { quantity: 4 })])];
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
console.log("\nAll reconstruction-core checks passed");
