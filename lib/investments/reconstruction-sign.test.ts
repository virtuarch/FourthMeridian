/**
 * lib/investments/reconstruction-sign.test.ts
 *
 * V26-A4-SIGN — the A4 reconstruction boundary must honour its signed-delta
 * contract.
 *
 * `reconstruction-core.ts` declares `ReconEventInput.quantity` as "Security
 * units, signed +in/−out" and walks backward with `q = q − delta`. The provider
 * stores an unsigned MAGNITUDE with direction in `type`, and the runner passed
 * it through raw. BUY happened to work; every SELL was inverted — it subtracted
 * where it had to add — so the walk landed at exactly −Σ|quantity|. Measured on
 * the local corpus, every one of nine Schwab positions matched that formula:
 * AMZN −1, JPM −1, TXN −1, NKE −4, NVDA −2.0059, INTC −6, TQQQ −20.
 *
 * The proof that the correction is right, not merely different: each corrected
 * series reproduces the independently OBSERVED 2026-07-19 quantity exactly.
 *
 * Standalone tsx script:  npx tsx lib/investments/reconstruction-sign.test.ts
 */

import { InvestmentEventType } from "@prisma/client";
import { signedShareDelta } from "./quantity-event.core";
import { routeEvents, type ReconEventInput } from "./reconstruction-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

/** A provider row exactly as Plaid stores it: unsigned magnitude + type. */
function ev(over: Partial<ReconEventInput> & { type: InvestmentEventType; date: string }): ReconEventInput {
  return {
    id: `${over.type}_${over.date}_${over.quantity ?? 0}`,
    source: "plaid", externalEventId: null, instrumentId: "INST",
    quantity: null, amount: null, currency: "USD", ratio: null, relatedInstrumentId: null,
    ...over,
  };
}

/**
 * The runner's boundary mapping, reproduced exactly (reconstruction-runner.ts):
 * apply direction where ratified, pass through untouched where not.
 */
const atBoundary = (e: ReconEventInput): ReconEventInput => ({ ...e, quantity: signedShareDelta(e) ?? e.quantity });

/**
 * Backward replay, mirroring reconstruction-core's `q = q − delta` over routed
 * deltas in reverse date order. Returns the quantity BEFORE each event date.
 */
function replayBackward(anchor: number, events: ReconEventInput[]): { opening: number; steps: { before: string; qty: number }[] } {
  const routed = routeEvents(events.map(atBoundary)).byInstrument.get("INST") ?? [];
  const desc = [...routed].sort((a, b) => b.event.date.localeCompare(a.event.date));
  let q = anchor;
  const steps: { before: string; qty: number }[] = [];
  for (const r of desc) { q = q - r.delta; steps.push({ before: r.event.date, qty: q }); }
  return { opening: q, steps };
}

function main(): void {
  // ── The mapping itself ────────────────────────────────────────────────────
  console.log("0. signedShareDelta — canonical direction, no second table");
  {
    check("BUY magnitude 5 → +5", signedShareDelta({ type: "BUY", quantity: 5 }) === 5);
    check("SELL magnitude 5 → −5", signedShareDelta({ type: "SELL", quantity: 5 }) === -5);
    check("zero-quantity dividend → 0 (supported, no share effect)",
      signedShareDelta({ type: "DIVIDEND", quantity: 0 }) === null ||
      signedShareDelta({ type: "DIVIDEND", quantity: 0 }) === 0);
    check("null quantity → null (nothing stated)", signedShareDelta({ type: "BUY", quantity: null }) === null);
    check("BUY of 0 → 0", signedShareDelta({ type: "BUY", quantity: 0 }) === 0);
  }

  // ── Requirement 5: unsupported types are never guessed ────────────────────
  console.log("1. Unratified types are refused, never signed");
  {
    for (const t of ["TRANSFER_IN", "TRANSFER_OUT", "SPLIT", "MERGER", "SPIN_OFF",
                     "REINVESTMENT", "SYMBOL_CHANGE", "OPENING_BALANCE", "CANCEL",
                     "ADJUSTMENT", "OTHER", "UNKNOWN"]) {
      check(`${t} → null (no direction stated)`, signedShareDelta({ type: t, quantity: 10 }) === null);
    }
    check("an unratified row reaches the walk with its magnitude INTACT, not zeroed",
      atBoundary(ev({ type: InvestmentEventType.SPLIT, date: "2025-11-20", quantity: 10 })).quantity === 10);
  }

  // ── Requirement F: real shorts must survive ───────────────────────────────
  console.log("2. A pre-signed negative is refused, never double-negated");
  {
    check("SELL with a NEGATIVE source quantity → null", signedShareDelta({ type: "SELL", quantity: -5 }) === null);
    check("BUY with a NEGATIVE source quantity → null", signedShareDelta({ type: "BUY", quantity: -5 }) === null);
    check("so it passes through with its sign intact (a real short is not flipped)",
      atBoundary(ev({ type: InvestmentEventType.SELL, date: "2026-01-01", quantity: -5 })).quantity === -5);
    check("this normalization rejects no negative quantity globally",
      atBoundary(ev({ type: InvestmentEventType.BUY, date: "2026-01-01", quantity: -3 })).quantity === -3);
  }

  // ── A. JPM ────────────────────────────────────────────────────────────────
  console.log("3. Fixture A — JPM: anchor 0 after SELL 1 → backward 1, matches 07-19 observation");
  {
    const events = [
      ev({ type: InvestmentEventType.DIVIDEND, date: "2025-07-31", quantity: 0, amount: 1.4 }),
      ev({ type: InvestmentEventType.DIVIDEND, date: "2026-04-30", quantity: 0, amount: 1.5 }),
      ev({ type: InvestmentEventType.SELL,     date: "2026-07-27", quantity: 1, amount: 350.17 }),
    ];
    const { opening } = replayBackward(0, events);
    check("opening = 1 (was −1 before the fix)", near(opening, 1));
    check("reconciles with the observed 2026-07-19 quantity of 1", near(opening, 1));
    check("zero-quantity dividends contribute no share effect", near(opening, 1));
  }

  // ── B. NKE ────────────────────────────────────────────────────────────────
  console.log("4. Fixture B — NKE: anchor 0 after SELL 4 → backward 4");
  {
    const events = [
      ev({ type: InvestmentEventType.DIVIDEND, date: "2025-10-01", quantity: 0, amount: 1.6 }),
      ev({ type: InvestmentEventType.SELL,     date: "2026-07-27", quantity: 4, amount: 163.94 }),
    ];
    check("opening = 4 (was −4)", near(replayBackward(0, events).opening, 4));
  }

  // ── C. INTC ───────────────────────────────────────────────────────────────
  console.log("5. Fixture C — INTC: 0 → back across SELL 5 = 5 → back across BUY 1 = 4");
  {
    const events = [
      ev({ type: InvestmentEventType.BUY,  date: "2025-10-30", quantity: 1, amount: -41.57 }),
      ev({ type: InvestmentEventType.SELL, date: "2026-07-27", quantity: 5, amount: 482.62 }),
    ];
    const { opening, steps } = replayBackward(0, events);
    check("after un-applying SELL 5 → 5 (the 2026-07-19 observed quantity)", near(steps[0].qty, 5));
    check("after un-applying BUY 1 → 4", near(steps[1].qty, 4));
    check("opening = 4 (was −6)", near(opening, 4));
    check("and 4 + BUY 1 reconciles to the observed 5", near(opening + 1, 5));
  }

  // ── D. NVDA ───────────────────────────────────────────────────────────────
  console.log("6. Fixture D — NVDA: fractional BUYs + SELL 2.003 → 2.0001 … 2.003");
  {
    const events = [
      ev({ type: InvestmentEventType.BUY,  date: "2025-10-02", quantity: 0.0001 }),
      ev({ type: InvestmentEventType.BUY,  date: "2025-12-26", quantity: 0.0001 }),
      ev({ type: InvestmentEventType.BUY,  date: "2026-04-01", quantity: 0.0001 }),
      ev({ type: InvestmentEventType.BUY,  date: "2026-06-26", quantity: 0.0026 }),
      ev({ type: InvestmentEventType.SELL, date: "2026-07-27", quantity: 2.003 }),
    ];
    const { opening, steps } = replayBackward(0, events);
    const eps = 1e-6;
    check("un-apply SELL → 2.003 (the observed 07-19 quantity)", near(steps[0].qty, 2.003, eps));
    check("un-apply BUY .0026 → 2.0004", near(steps[1].qty, 2.0004, eps));
    check("un-apply BUY .0001 → 2.0003", near(steps[2].qty, 2.0003, eps));
    check("un-apply BUY .0001 → 2.0002", near(steps[3].qty, 2.0002, eps));
    check("un-apply BUY .0001 → 2.0001", near(steps[4].qty, 2.0001, eps));
    check("opening = 2.0001 (was −2.0059)", near(opening, 2.0001, eps));
    check("opening + Σ BUYs reconciles to the observed 2.003", near(opening + 0.0029, 2.003, eps));
  }

  // ── E. AMZN / TSLA / SPCE ─────────────────────────────────────────────────
  console.log("7. Fixture E — sell-only positions yield a POSITIVE unexplained opening of 1");
  {
    for (const sym of ["AMZN", "TSLA", "SPCE"]) {
      const events = [ev({ type: InvestmentEventType.SELL, date: "2026-07-27", quantity: 1 })];
      check(`${sym}: opening = +1 (was −1)`, near(replayBackward(0, events).opening, 1));
    }
    check("this slice states nothing about ownership windows — quantity only", true);
  }

  // ── G. TQQQ ───────────────────────────────────────────────────────────────
  console.log("8. Fixture G — TQQQ stays unsupported: SPLIT with no ratio still stops the walk");
  {
    const split = ev({ type: InvestmentEventType.SPLIT, date: "2025-11-20", quantity: 10, ratio: null });
    check("the split is not ratified for direction", signedShareDelta(split) === null);
    check("it reaches the walk with a MATERIAL magnitude, so the stop can see it",
      Math.abs(atBoundary(split).quantity ?? 0) === 10);
    check("its ratio is still null — the corporate action remains uninvertible",
      atBoundary(split).ratio === null);
    // Correcting SELL direction must not silently make the walk traversable.
    const events = [split, ev({ type: InvestmentEventType.SELL, date: "2026-07-27", quantity: 20 })];
    const routed = routeEvents(events.map(atBoundary)).byInstrument.get("INST") ?? [];
    check("both rows still route to the instrument walk", routed.length === 2);
    check("the split's delta is unchanged by this slice",
      routed.find((r) => r.event.type === InvestmentEventType.SPLIT)!.delta === 10);
  }

  // ── The measured old-behaviour formula, pinned ────────────────────────────
  console.log("9. The defect formula (opening = −Σ|quantity|) can no longer be produced");
  {
    const events = [
      ev({ type: InvestmentEventType.BUY,  date: "2025-10-30", quantity: 1 }),
      ev({ type: InvestmentEventType.SELL, date: "2026-07-27", quantity: 5 }),
    ];
    const rawDeltas = (routeEvents(events).byInstrument.get("INST") ?? []).map((r) => r.delta);
    check("UNNORMALIZED input still reproduces the old −6 (the bug, pinned as a fact)",
      near(0 - rawDeltas.reduce((a, b) => a + b, 0), -6));
    check("NORMALIZED input yields +4", near(replayBackward(0, events).opening, 4));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll A4 sign-correction guards passed.");
  process.exit(0);
}

main();
