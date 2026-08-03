/**
 * lib/investments/reconstruction-cash.test.ts
 *
 * V26-S1-CASH — the brokerage cash replay. Standalone tsx, pure.
 *
 * Every fixture here is the SHAPE OF THE REAL CORPUS, because the bug was a
 * mismatch between an assumption and that shape:
 *
 *   · a DIVIDEND carries the PAYING security's instrumentId, quantity 0 and a
 *     positive amount;
 *   · a SELL carries the traded security's instrumentId, a positive magnitude
 *     quantity (direction lives in `type`) and a positive amount;
 *   · a TRANSFER carries a synthetic instrument Plaid invents for the transfer
 *     itself, classified EQUITY, with a signed amount;
 *   · a SPLIT carries the security, a quantity, amount 0 and ratio NULL.
 *
 * 47 of 51 live events carry an instrumentId, so routing on its ABSENCE sent
 * $3,480.08 of one account's cash movement nowhere.
 */

import { InvestmentEventType } from "@prisma/client";
import { routeEvents, reconstructPositions, reconcileWalkAgainstObservations, type ReconEventInput } from "./reconstruction-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const CASH = "instr_cash_usd";
const CASH_MAP = { USD: CASH };
let seq = 0;
const ev = (over: Partial<ReconEventInput>): ReconEventInput => ({
  id: `ev${seq++}`, source: "plaid", externalEventId: `x${seq}`, date: "2026-01-01",
  type: InvestmentEventType.BUY, instrumentId: null, quantity: null, amount: null,
  currency: "USD", ratio: null, ...over,
});

function main(): void {
  console.log("V26-S1-CASH — brokerage cash replay\n");

  // ── A. A security-attached cash leg REACHES the cash walk ─────────────────
  {
    const dividend = ev({ type: InvestmentEventType.DIVIDEND, instrumentId: "TQQQ", quantity: 0, amount: 1.71 });
    const { byInstrument } = routeEvents([dividend], CASH_MAP);
    check("A. the dividend still routes to its security", byInstrument.get("TQQQ")?.length === 1);
    check("A. and ALSO routes its cash leg (the whole bug)", byInstrument.get(CASH)?.length === 1);
    check("A. the security leg moves no shares", byInstrument.get("TQQQ")![0].delta === 0);
    check("A. the cash leg carries the amount", byInstrument.get(CASH)![0].delta === 1.71);
    check("A. legs are labelled",
      byInstrument.get("TQQQ")![0].leg === "SECURITY" && byInstrument.get(CASH)![0].leg === "CASH");
  }

  // ── B. A cash-ONLY event behaves exactly as before (no regression) ────────
  {
    const cashOnly = ev({ type: InvestmentEventType.DIVIDEND, instrumentId: null, amount: 0.03 });
    const { byInstrument, unroutableCashEvents } = routeEvents([cashOnly], CASH_MAP);
    check("B. a cash-only row still routes to cash", byInstrument.get(CASH)?.[0].delta === 0.03);
    check("B. and is not reported unroutable", unroutableCashEvents.length === 0);
  }

  // ── C. Zero and absent amounts create NO cash entry ───────────────────────
  {
    const split = ev({ type: InvestmentEventType.SPLIT, instrumentId: "TQQQ", quantity: 10, amount: 0 });
    const inKind = ev({ type: InvestmentEventType.TRANSFER_IN, instrumentId: "VTI", quantity: 5, amount: null });
    const { byInstrument } = routeEvents([split, inKind], CASH_MAP);
    check("C. a zero-amount split adds no cash row", byInstrument.get(CASH) === undefined);
    check("C. an in-kind transfer adds no cash row", byInstrument.get(CASH) === undefined);
  }

  // ── D. Unknown currency is REPORTED, never applied elsewhere ──────────────
  {
    const eur = ev({ type: InvestmentEventType.SELL, instrumentId: "ASML", quantity: 1, amount: 500, currency: "EUR" });
    const { byInstrument, unroutableCashEvents } = routeEvents([eur], CASH_MAP);
    check("D. a foreign cash leg never lands on the USD walk", byInstrument.get(CASH) === undefined);
    check("D. it is reported unroutable", unroutableCashEvents.length === 1);
  }

  // ── E. Same-walk collision — one row may never apply two deltas ───────────
  {
    const onCash = ev({ instrumentId: CASH, quantity: 5, amount: 5 });
    const { byInstrument, unroutableCashEvents } = routeEvents([onCash], CASH_MAP);
    check("E. a row attached to the cash instrument produces exactly ONE entry",
      byInstrument.get(CASH)?.length === 1);
    check("E. the dropped cash leg is reported, not silent", unroutableCashEvents.length === 1);
  }

  // ── F. A ratio-less SPLIT must NOT stop the CASH walk ─────────────────────
  // The share leg is uninvertible; the cash leg is a plain amount. Before the
  // leg split, a ratio-less TQQQ split halted the account's entire cash history.
  {
    const results = reconstructPositions({
      anchors: [
        { instrumentId: CASH, quantity: 1000, isCash: true, date: "2026-03-01" },
        { instrumentId: "TQQQ", quantity: 20, isCash: false, date: "2026-03-01" },
      ],
      events: [
        ev({ type: InvestmentEventType.DIVIDEND, instrumentId: "TQQQ", date: "2026-01-05", quantity: 0, amount: 5 }),
        ev({ type: InvestmentEventType.SPLIT, instrumentId: "TQQQ", date: "2026-02-01", quantity: 10, amount: 0, ratio: null }),
      ],
      cashInstrumentByCurrency: CASH_MAP,
      runDate: "2026-03-01",
    });
    const tqqq = results.find((r) => r.instrumentId === "TQQQ")!;
    const cash = results.find((r) => r.instrumentId === CASH)!;
    check("F. the SHARE walk still stops on the uninvertible split",
      tqqq.status === "FAILED" && tqqq.failureReason === "UNSUPPORTED_CORPORATE_ACTION");
    check("F. the CASH walk is unaffected and walks past it", cash.status !== "FAILED");
    check("F. cash reaches back to the dividend", cash.earliestDefensibleDate === "2026-01-05");
    check("F. cash opening = 1000 − 5", Math.abs(cash.openingQuantity - 995) < 1e-6);
  }

  // ── G. A ratio'd SPLIT divides SHARES and only subtracts from CASH ────────
  {
    const results = reconstructPositions({
      anchors: [
        { instrumentId: CASH, quantity: 100, isCash: true, date: "2026-03-01" },
        { instrumentId: "TQQQ", quantity: 20, isCash: false, date: "2026-03-01" },
      ],
      events: [
        ev({ type: InvestmentEventType.SPLIT, instrumentId: "TQQQ", date: "2026-02-01", quantity: 10, amount: 0, ratio: 2 }),
      ],
      cashInstrumentByCurrency: CASH_MAP,
      runDate: "2026-03-01",
    });
    const tqqq = results.find((r) => r.instrumentId === "TQQQ")!;
    check("G. shares are DIVIDED by the ratio (20 → 10)", Math.abs(tqqq.openingQuantity - 10) < 1e-6);
    check("G. the split has no cash effect, so cash is untouched",
      results.find((r) => r.instrumentId === CASH)!.openingQuantity === 100);
  }

  // ── H. THE INCIDENT, to the cent ──────────────────────────────────────────
  // The live LLC account: cash observed 11.65 on 2026-07-22 and 3556.22 on
  // 2026-07-27, the delta being nine sells totalling 3544.57. A replay must
  // reproduce both, and land on the SAME opening from either anchor.
  {
    const sells = [232.92, 482.62, 350.17, 163.94, 416.84, 2.52, 1298.79, 315.32, 281.45];
    const results = reconstructPositions({
      anchors: [{ instrumentId: CASH, quantity: 3556.22, isCash: true, date: "2026-07-27" }],
      events: sells.map((amount, i) =>
        ev({ type: InvestmentEventType.SELL, instrumentId: `sec${i}`, date: "2026-07-27", quantity: 1, amount })),
      cashInstrumentByCurrency: CASH_MAP,
      runDate: "2026-07-27",
    });
    const cash = results.find((r) => r.instrumentId === CASH)!;
    check("H. walking back through the nine sells lands on the observed 11.65",
      Math.abs(cash.openingQuantity - 11.65) < 0.005, `got ${cash.openingQuantity}`);

    const recon = reconcileWalkAgainstObservations(cash, [{ date: "2026-07-27", quantity: 3556.22 }]);
    check("H. the walk reconciles against the provider's own balance",
      recon.checkpoints === 1 && recon.reconciled === 1);
  }

  // ── I. Reconciliation REPORTS a residual; it does not hide or escalate it ─
  // The real settlement lag: a $1.50 dividend dated 2026-07-31 that posted to
  // cash on 2026-08-03. The walk mispredicts the intermediate date — and on that
  // date the OBSERVATION wins by origin precedence, so this is diagnostic.
  {
    const results = reconstructPositions({
      anchors: [{ instrumentId: CASH, quantity: 100, isCash: true, date: "2026-08-03" }],
      events: [ev({ type: InvestmentEventType.DIVIDEND, instrumentId: "JPM", date: "2026-07-31", quantity: 0, amount: 1.5 })],
      cashInstrumentByCurrency: CASH_MAP,
      runDate: "2026-08-03",
    });
    const cash = results.find((r) => r.instrumentId === CASH)!;
    const recon = reconcileWalkAgainstObservations(cash, [
      { date: "2026-07-31", quantity: 98.5 }, // observed: the dividend had not posted
      { date: "2026-08-03", quantity: 100 },
    ]);
    check("I. the lagging date is reported as a miss", recon.reconciled === 1 && recon.checkpoints === 2);
    check("I. the residual is the exact lagging amount", Math.abs(recon.maxResidual - 1.5) < 1e-6);
    check("I. a residual does NOT flag the walk conflicted", cash.conflicted === false);
  }

  // ── J. Observations outside coverage are skipped, not counted as misses ───
  {
    const results = reconstructPositions({
      anchors: [{ instrumentId: CASH, quantity: 100, isCash: true, date: "2026-08-03" }],
      events: [ev({ type: InvestmentEventType.DIVIDEND, instrumentId: "JPM", date: "2026-07-31", quantity: 0, amount: 1.5 })],
      cashInstrumentByCurrency: CASH_MAP,
      runDate: "2026-08-03",
    });
    const cash = results.find((r) => r.instrumentId === CASH)!;
    const recon = reconcileWalkAgainstObservations(cash, [{ date: "2020-01-01", quantity: 999 }]);
    check("J. a date the walk makes no claim about is not a checkpoint", recon.checkpoints === 0);
  }

  console.log(failures === 0 ? "\nAll cash-replay checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
