/**
 * lib/investments/investment-flows-core.test.ts
 *
 * A10-1 — pure flow classification + period-flow tests. Standalone tsx script:
 *
 *     npx tsx lib/investments/investment-flows-core.test.ts
 *
 * Pins: type→category mapping, FM-signed netExternalFlows over the boundary
 * categories only, buys/sells/income/fees excluded from external, transfers not
 * equated with performance, in-kind transfer + missing-amount incompleteness,
 * half-open (from, to] interval semantics, FX/unclassified degradation, empty
 * period, and determinism.
 */

import type { InvestmentEventType } from "@prisma/client";
import {
  classifyEventFlow,
  summarizePeriodFlows,
  EXTERNAL_BOUNDARY_CATEGORIES,
  type FlowEvent,
} from "./investment-flows-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const CCY = "USD";
const FROM = "2026-01-01";
const TO = "2026-03-31";

function ev(type: InvestmentEventType, amount: number | null, opts: Partial<FlowEvent> = {}): FlowEvent {
  return {
    type,
    date: opts.date ?? "2026-02-15",
    amount,
    fxEstimated: opts.fxEstimated ?? false,
    hasQuantity: opts.hasQuantity ?? false,
  };
}

function main(): void {
  // ── 1. type → category mapping ────────────────────────────────────────────
  console.log("1. classifyEventFlow mapping");
  {
    check("CONTRIBUTION → contribution", classifyEventFlow("CONTRIBUTION") === "contribution");
    check("WITHDRAWAL → withdrawal", classifyEventFlow("WITHDRAWAL") === "withdrawal");
    check("TRANSFER_IN → transfer_in", classifyEventFlow("TRANSFER_IN") === "transfer_in");
    check("TRANSFER_OUT → transfer_out", classifyEventFlow("TRANSFER_OUT") === "transfer_out");
    check("BUY → buy", classifyEventFlow("BUY") === "buy");
    check("SELL → sell", classifyEventFlow("SELL") === "sell");
    check("DIVIDEND/INTEREST/CAPITAL_GAIN → income",
      classifyEventFlow("DIVIDEND") === "income" && classifyEventFlow("INTEREST") === "income" && classifyEventFlow("CAPITAL_GAIN") === "income");
    check("REINVESTMENT → reinvestment", classifyEventFlow("REINVESTMENT") === "reinvestment");
    check("FEE/TAX → fee", classifyEventFlow("FEE") === "fee" && classifyEventFlow("TAX") === "fee");
    check("SPLIT/MERGER/SPIN_OFF/SYMBOL_CHANGE → corporate_action",
      ["SPLIT", "MERGER", "SPIN_OFF", "SYMBOL_CHANGE"].every((t) => classifyEventFlow(t as InvestmentEventType) === "corporate_action"));
    check("OPENING_BALANCE → opening", classifyEventFlow("OPENING_BALANCE") === "opening");
    check("CANCEL/ADJUSTMENT/OTHER/UNKNOWN → unclassified",
      ["CANCEL", "ADJUSTMENT", "OTHER", "UNKNOWN"].every((t) => classifyEventFlow(t as InvestmentEventType) === "unclassified"));
    check("boundary set is exactly the four external categories",
      EXTERNAL_BOUNDARY_CATEGORIES.size === 4 &&
      ["contribution", "withdrawal", "transfer_in", "transfer_out"].every((c) => EXTERNAL_BOUNDARY_CATEGORIES.has(c as never)));
  }

  // ── 2. netExternalFlows: FM-signed sum over boundary categories only ──────
  console.log("2. netExternalFlows");
  {
    const flows = summarizePeriodFlows([
      ev("CONTRIBUTION", 1000),
      ev("WITHDRAWAL", -300),
      ev("TRANSFER_IN", 500),
      ev("TRANSFER_OUT", -200),
      // internal — must NOT affect netExternalFlows:
      ev("BUY", -900),
      ev("SELL", 400),
      ev("DIVIDEND", 50),
      ev("FEE", -10),
    ], FROM, TO, CCY);
    check("contributions/withdrawals/transfers subtotalled with sign",
      flows.contributions === 1000 && flows.withdrawals === -300 && flows.transfersIn === 500 && flows.transfersOut === -200);
    check("netExternalFlows = 1000 − 300 + 500 − 200 = 1000", flows.netExternalFlows === 1000);
    check("buys/sells/income/fees carried but excluded from netExternalFlows",
      flows.buys === -900 && flows.sells === 400 && flows.income === 50 && flows.fees === -10);
    check("all events counted", flows.eventCount === 8);
    check("fully-valued, classified period → observed", flows.completeness === "observed");
  }

  // ── 3. transfer is not investment performance ─────────────────────────────
  console.log("3. transfer ≠ performance");
  {
    // A large transfer-in must land in netExternalFlows, never in income.
    const flows = summarizePeriodFlows([ev("TRANSFER_IN", 100000)], FROM, TO, CCY);
    check("transfer-in is external, not income", flows.netExternalFlows === 100000 && flows.income === 0);
  }

  // ── 4. in-kind transfer (units, no cash leg) → incomplete, counted ────────
  console.log("4. in-kind transfer incompleteness");
  {
    const flows = summarizePeriodFlows([ev("TRANSFER_IN", null, { hasQuantity: true })], FROM, TO, CCY);
    check("in-kind transfer counted", flows.inKindTransferCount === 1);
    check("not double-counted as missing-amount external", flows.externalAmountMissingCount === 0);
    check("netExternalFlows unaffected by unvaluable leg", flows.netExternalFlows === 0);
    check("degrades completeness to incomplete", flows.completeness === "incomplete");
    check("reason names the in-kind transfer", /in-kind transfer/.test(flows.reason));
  }

  // ── 5. external event missing an amount → incomplete, counted ─────────────
  console.log("5. missing external amount");
  {
    const flows = summarizePeriodFlows([ev("CONTRIBUTION", null)], FROM, TO, CCY);
    check("missing-amount external counted", flows.externalAmountMissingCount === 1);
    check("not counted as in-kind transfer", flows.inKindTransferCount === 0);
    check("completeness incomplete", flows.completeness === "incomplete");
  }

  // ── 6. half-open interval (from, to] ──────────────────────────────────────
  console.log("6. interval semantics");
  {
    const flows = summarizePeriodFlows([
      ev("CONTRIBUTION", 1, { date: "2025-12-31" }), // before → excluded
      ev("CONTRIBUTION", 2, { date: FROM }),         // on from → excluded (in opening)
      ev("CONTRIBUTION", 4, { date: "2026-02-15" }), // inside → included
      ev("CONTRIBUTION", 8, { date: TO }),           // on to → included
      ev("CONTRIBUTION", 16, { date: "2026-04-01" }),// after → excluded
    ], FROM, TO, CCY);
    check("only (from, to] events included", flows.eventCount === 2 && flows.contributions === 12);
  }

  // ── 7. FX-estimated degradation ───────────────────────────────────────────
  console.log("7. FX estimated");
  {
    const flows = summarizePeriodFlows([ev("CONTRIBUTION", 100, { fxEstimated: true })], FROM, TO, CCY);
    check("fxEstimated surfaced", flows.fxEstimated === true);
    check("degrades to estimated (still valued)", flows.completeness === "estimated");
  }

  // ── 8. unclassified activity ──────────────────────────────────────────────
  console.log("8. unclassified");
  {
    const flows = summarizePeriodFlows([ev("ADJUSTMENT", 25), ev("CONTRIBUTION", 100)], FROM, TO, CCY);
    check("unclassified counted, not external", flows.unclassifiedCount === 1 && flows.netExternalFlows === 100);
    check("degrades to estimated", flows.completeness === "estimated");
  }

  // ── 9. empty period ───────────────────────────────────────────────────────
  console.log("9. empty period");
  {
    const flows = summarizePeriodFlows([], FROM, TO, CCY);
    check("no events → zero net, observed, byCategory empty",
      flows.eventCount === 0 && flows.netExternalFlows === 0 && flows.byCategory.length === 0 && flows.completeness === "observed");
    check("reason states no events", /No investment events/.test(flows.reason));
  }

  // ── 10. byCategory ordering + presence ────────────────────────────────────
  console.log("10. byCategory shaping");
  {
    const flows = summarizePeriodFlows([ev("FEE", -5), ev("CONTRIBUTION", 100), ev("SELL", 50)], FROM, TO, CCY);
    const cats = flows.byCategory.map((c) => c.category);
    check("only present categories, in canonical order", JSON.stringify(cats) === JSON.stringify(["contribution", "sell", "fee"]));
  }

  // ── 11. determinism ───────────────────────────────────────────────────────
  console.log("11. determinism");
  {
    const es: FlowEvent[] = [ev("CONTRIBUTION", 100), ev("BUY", -90, { hasQuantity: true }), ev("DIVIDEND", 3)];
    const a = summarizePeriodFlows(es, FROM, TO, CCY);
    const b = summarizePeriodFlows(es, FROM, TO, CCY);
    check("identical inputs → byte-identical JSON", JSON.stringify(a) === JSON.stringify(b));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll investment-flows-core checks passed.");
  process.exit(0);
}

main();
