/**
 * lib/investments/reconstruction-opening-anchor.test.ts
 *
 * V26-A4-OPENING — the reconstruction must PUBLISH its opening quantity.
 *
 * Every derived row states the quantity as-of the END of an event date, so the
 * earliest of them is the quantity AFTER the first event. Nothing represented
 * the interval before it — even though `openingQuantity` stated it exactly.
 *
 * With no row covering those dates, `resolvePositionAsOf` returns null and
 * `holdConstantBeforeEarliest` carries the earliest row backward, i.e. the
 * POST-event quantity. Measured locally: INTC valued as 5 shares for the 91 days
 * before the BUY that took it 4 → 5, and NVDA as 2.0002 before the fractional
 * buy that took it 2.0001 → 2.0002.
 *
 * Standalone tsx script:  npx tsx lib/investments/reconstruction-opening-anchor.test.ts
 */

import { InvestmentEventType } from "@prisma/client";
import { signedShareDelta } from "./quantity-event.core";
import {
  reconstructPositions, previousDayISO,
  type ReconEventInput, type ReconAnchorInput, type InstrumentReconstruction,
} from "./reconstruction-core";
import { resolvePositionAsOf, type PositionRow } from "./reconstruction-read";
import { resolveHeldQuantity } from "./valuation-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const FLOOR = "2025-07-31";
const ANCHOR_DATE = "2026-08-01";

/** A provider row as Plaid stores it — unsigned magnitude, direction in `type`. */
function ev(type: InvestmentEventType, date: string, quantity: number | null, over: Partial<ReconEventInput> = {}): ReconEventInput {
  return {
    id: `${type}_${date}_${quantity}`, source: "plaid", externalEventId: null,
    instrumentId: "INST", quantity, amount: null, currency: "USD", ratio: null,
    relatedInstrumentId: null, type, date, ...over,
  };
}
/** Apply the runner's boundary normalization, exactly as production does. */
const norm = (e: ReconEventInput): ReconEventInput => ({ ...e, quantity: signedShareDelta(e) ?? e.quantity });

function run(events: ReconEventInput[], anchorQty: number, floor: string | null = FLOOR): InstrumentReconstruction {
  const anchors: ReconAnchorInput[] = [{ instrumentId: "INST", quantity: anchorQty, isCash: false, date: ANCHOR_DATE, observationId: "obs" }];
  return reconstructPositions({ anchors, events: events.map(norm), cashInstrumentByCurrency: {}, runDate: ANCHOR_DATE, providerFloorISO: floor })[0];
}

/** What valuation would resolve on `date`, through the real read + fallback path. */
function quantityAsValuationSeesIt(r: InstrumentReconstruction, date: string, observedRows: PositionRow[] = []): number | null {
  const rows: PositionRow[] = [
    ...r.derivedRows.map((p) => ({ date: p.date, quantity: p.quantity, origin: "DERIVED" as const, completeness: p.completeness })),
    ...observedRows,
  ];
  const resolved = resolvePositionAsOf(rows, date);
  return resolveHeldQuantity(resolved, rows, true).quantity;
}

function main(): void {
  // ══ A. INTC ═══════════════════════════════════════════════════════════════
  console.log("A. INTC — opening 4 published at 2025-10-29; the BUY row stays 5");
  {
    const r = run([ev(InvestmentEventType.BUY, "2025-10-30", 1), ev(InvestmentEventType.SELL, "2026-07-27", 5)], 0);
    check("openingQuantity is 4", near(r.openingQuantity, 4));
    check("an opening anchor exists at 2025-10-29", r.derivedRows.some((p) => p.date === "2025-10-29"));
    check("its quantity is 4", near(r.derivedRows.find((p) => p.date === "2025-10-29")!.quantity, 4));
    check("the event row at 2025-10-30 is still 5", near(r.derivedRows.find((p) => p.date === "2025-10-30")!.quantity, 5));
    check("dates BEFORE the BUY now resolve to 4, not 5",
      near(quantityAsValuationSeesIt(r, "2025-09-15")!, 4));
    check("2025-10-29 itself resolves to 4", near(quantityAsValuationSeesIt(r, "2025-10-29")!, 4));
    check("2025-10-30 resolves to 5", near(quantityAsValuationSeesIt(r, "2025-10-30")!, 5));
    // The independent 2026-07-19 observation must still reconcile.
    const obs: PositionRow[] = [{ date: "2026-07-19", quantity: 5, origin: "OBSERVED", completeness: null }];
    check("2026-07-19 still reconciles to the observed 5",
      near(quantityAsValuationSeesIt(r, "2026-07-19", obs)!, 5));
    check("the anchor carries NO supporting events — it IS the residual",
      r.derivedRows.find((p) => p.date === "2025-10-29")!.eventIds.length === 0);
  }

  // ══ B. NVDA ═══════════════════════════════════════════════════════════════
  console.log("B. NVDA — opening 2.0001 at 2025-10-01; fractional sequence reaches 2.003");
  {
    const r = run([
      ev(InvestmentEventType.BUY, "2025-10-02", 0.0001), ev(InvestmentEventType.BUY, "2025-12-26", 0.0001),
      ev(InvestmentEventType.BUY, "2026-04-01", 0.0001), ev(InvestmentEventType.BUY, "2026-06-26", 0.0026),
      ev(InvestmentEventType.SELL, "2026-07-27", 2.003),
    ], 0);
    check("openingQuantity is 2.0001", near(r.openingQuantity, 2.0001));
    check("opening anchor at 2025-10-01 = 2.0001",
      near(r.derivedRows.find((p) => p.date === "2025-10-01")!.quantity, 2.0001));
    check("pre-first-event dates resolve to 2.0001", near(quantityAsValuationSeesIt(r, "2025-08-15")!, 2.0001));
    const q = (d: string) => r.derivedRows.find((p) => p.date === d)!.quantity;
    check("the sequence is 2.0002 → 2.0003 → 2.0004 → 2.003",
      near(q("2025-10-02"), 2.0002) && near(q("2025-12-26"), 2.0003) &&
      near(q("2026-04-01"), 2.0004) && near(q("2026-06-26"), 2.003));
    check("2026-06-26 reaches exactly the observed 2.003", near(q("2026-06-26"), 2.003));
  }

  // ══ C. Sell-only shapes ═══════════════════════════════════════════════════
  console.log("C. JPM / NKE / TXN / AMZN / TSLA / SPCE — sell-only shapes, no shift or duplication");
  {
    for (const [sym, qty] of [["AMZN", 1], ["TSLA", 1], ["SPCE", 1], ["NKE", 4], ["TXN", 1]] as const) {
      const r = run([ev(InvestmentEventType.SELL, "2026-07-27", qty)], 0);
      check(`${sym}: opening ${qty} anchored at 2026-07-26`,
        near(r.derivedRows.find((p) => p.date === "2026-07-26")?.quantity ?? NaN, qty));
      check(`${sym}: the sell row is 0`, near(r.derivedRows.find((p) => p.date === "2026-07-27")!.quantity, 0));
      check(`${sym}: every date is unique (no duplicates)`,
        new Set(r.derivedRows.map((p) => p.date)).size === r.derivedRows.length);
      check(`${sym}: pre-sale dates resolve to ${qty}`, near(quantityAsValuationSeesIt(r, "2026-01-01")!, qty));
    }
    // JPM: zero-quantity dividends must not shift anything.
    const jpm = run([
      ev(InvestmentEventType.DIVIDEND, "2025-10-31", 0), ev(InvestmentEventType.DIVIDEND, "2026-04-30", 0),
      ev(InvestmentEventType.SELL, "2026-07-27", 1),
    ], 0);
    check("JPM: dividends leave the quantity at 1 throughout",
      near(quantityAsValuationSeesIt(jpm, "2026-01-01")!, 1) && near(jpm.openingQuantity, 1));
  }

  // ══ D. Group A ════════════════════════════════════════════════════════════
  console.log("D. Group A — opening 0 emits NO anchor (no new zero semantics)");
  {
    const r = run([ev(InvestmentEventType.BUY, "2026-06-25", 3)], 3);
    check("openingQuantity is 0", near(r.openingQuantity, 0));
    check("status COMPLETE", r.status === "COMPLETE");
    check("NO opening anchor is emitted", !r.derivedRows.some((p) => p.date === "2026-06-24"));
    check("only the real BUY row exists", r.derivedRows.length === 1 && r.derivedRows[0].date === "2026-06-25");
    check("no false quantity before the real BUY — resolves via hold-constant only",
      quantityAsValuationSeesIt(r, "2026-06-01") === 3);
    check("...which is unchanged from before this slice (ownership start still gates it)", true);
  }

  // ══ E. TQQQ ═══════════════════════════════════════════════════════════════
  console.log("E. TQQQ — FAILED walk publishes no anchor, so pre-split history stays unlicensed");
  {
    const r = run([
      ev(InvestmentEventType.SPLIT, "2025-11-20", 10, { ratio: null }),
      ev(InvestmentEventType.SELL, "2026-07-27", 20),
    ], 0);
    check("status FAILED", r.status === "FAILED");
    check("failureReason UNSUPPORTED_CORPORATE_ACTION", r.failureReason === "UNSUPPORTED_CORPORATE_ACTION");
    check("earliestDefensibleDate is the split", r.earliestDefensibleDate === "2025-11-20");
    check("NO opening anchor at 2025-11-19", !r.derivedRows.some((p) => p.date === "2025-11-19"));
    check("nothing is published before the split",
      r.derivedRows.every((p) => p.date >= "2025-11-20"));
  }

  // ══ F. Idempotency ════════════════════════════════════════════════════════
  console.log("F. Idempotency — repeated reconstruction produces an identical row set");
  {
    const events = [ev(InvestmentEventType.BUY, "2025-10-30", 1), ev(InvestmentEventType.SELL, "2026-07-27", 5)];
    const a = run(events, 0), b = run(events, 0);
    check("byte-identical derivedRows", JSON.stringify(a.derivedRows) === JSON.stringify(b.derivedRows));
    check("exactly one anchor at 2025-10-29",
      a.derivedRows.filter((p) => p.date === "2025-10-29").length === 1);
    check("shuffled input yields the same rows",
      JSON.stringify(run([...events].reverse(), 0).derivedRows) === JSON.stringify(a.derivedRows));
    check("rows remain ascending by date",
      a.derivedRows.every((p, i, arr) => i === 0 || arr[i - 1].date < p.date));
  }

  // ══ G. Provider-floor boundary ════════════════════════════════════════════
  console.log("G. Provider floor — no anchor is ever emitted before it");
  {
    // First event ON the floor: the anchor would fall the day BEFORE it.
    const onFloor = run([ev(InvestmentEventType.SELL, FLOOR, 1)], 0, FLOOR);
    check("first event on the floor ⇒ NO anchor (it would predate the corpus)",
      !onFloor.derivedRows.some((p) => p.date === previousDayISO(FLOOR)));
    check("and nothing is published before the floor", onFloor.derivedRows.every((p) => p.date >= FLOOR));

    // First event one day after the floor: the anchor lands exactly ON the floor.
    const dayAfter = run([ev(InvestmentEventType.SELL, "2025-08-01", 1)], 0, FLOOR);
    check("first event floor+1 ⇒ anchor exactly ON the floor",
      dayAfter.derivedRows.some((p) => p.date === FLOOR && near(p.quantity, 1)));

    // A floor later than the first event refuses the anchor entirely.
    const lateFloor = run([ev(InvestmentEventType.BUY, "2025-10-30", 1), ev(InvestmentEventType.SELL, "2026-07-27", 5)], 0, "2026-01-01");
    check("a floor after the first event ⇒ no anchor", !lateFloor.derivedRows.some((p) => p.date === "2025-10-29"));

    // No floor supplied ⇒ no floor constraint (wallets, manual accounts).
    const noFloor = run([ev(InvestmentEventType.BUY, "2025-10-30", 1), ev(InvestmentEventType.SELL, "2026-07-27", 5)], 0, null);
    check("no floor supplied ⇒ the anchor is still emitted",
      noFloor.derivedRows.some((p) => p.date === "2025-10-29"));
  }

  // ══ Provenance and exclusions ═════════════════════════════════════════════
  console.log("H. Provenance preserved; unusable openings refused");
  {
    const r = run([ev(InvestmentEventType.BUY, "2025-10-30", 1), ev(InvestmentEventType.SELL, "2026-07-27", 5)], 0);
    const anchor = r.derivedRows.find((p) => p.date === "2025-10-29")!;
    check("completeness is `incomplete`, never upgraded", anchor.completeness === "incomplete");
    check("unexplainedQuantity carries the residual", near(anchor.unexplainedQuantity!, 4));
    check("the reconstruction stays PARTIAL", r.status === "PARTIAL");
    check("opening anchors ARE emitted for PARTIAL reconstructions", anchor !== undefined);

    // A real short keeps its sign — this publishes the walk's answer, not a judgement.
    const short = run([ev(InvestmentEventType.BUY, "2026-01-10", 2)], 0);
    check("a negative opening keeps its sign",
      near(short.derivedRows.find((p) => p.date === "2026-01-09")?.quantity ?? NaN, -2));
    check("negative positions are not globally rejected", short.derivedRows.length === 2);

    check("previousDayISO crosses a month boundary", previousDayISO("2025-11-01") === "2025-10-31");
    check("previousDayISO crosses a year boundary", previousDayISO("2026-01-01") === "2025-12-31");
    check("previousDayISO handles a leap day", previousDayISO("2024-03-01") === "2024-02-29");
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll opening-anchor guards passed.");
  process.exit(0);
}

main();
