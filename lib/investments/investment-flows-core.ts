/**
 * lib/investments/investment-flows-core.ts
 *
 * A10-1 — PURE investment flow classification and period-flow aggregation. No
 * DB, no clock, no network: the mapping from a canonical InvestmentEvent type to
 * a flow category, and the reduction of a set of period events into signed
 * reporting-currency subtotals. Fixture-tested with no `prisma generate` (the
 * event type is imported type-only).
 *
 * Two honesty rules encoded here:
 *   1. Only money that crosses the portfolio boundary — CONTRIBUTION, WITHDRAWAL,
 *      TRANSFER_IN, TRANSFER_OUT — sums into `netExternalFlows`. Buys, sells,
 *      income, fees, reinvestments and corporate actions are INTERNAL: their net
 *      value effect already shows up in (closing − opening), so folding them into
 *      "external flows" would double-count. A cash transfer is never equated with
 *      investment performance (A10 §change-attribution).
 *   2. A flow with no usable cash amount is never fabricated to zero-value:
 *      in-kind transfers (a TRANSFER carrying security units but no cash leg) and
 *      external events missing an amount are COUNTED and degrade flow
 *      completeness, so their value effect is not silently misattributed to the
 *      residual as "market movement".
 *
 * `amount` is FM-signed: + cash into the account / − cash out (schema.prisma
 * InvestmentEvent.amount; plaid-investment-events.ts amount_fm = −plaid amount).
 * The binding converts each amount into the reporting currency at the event date
 * before calling here — this core sums already-converted, FM-signed reporting
 * amounts.
 */

import type { InvestmentEventType } from "@prisma/client";
import { worstTier } from "@/lib/perspective-engine/completeness";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

/**
 * Canonical flow categories. Finer than "external vs internal" so the UI can
 * itemise contributions/withdrawals/transfers/income/fees separately, but never
 * so fine that trivial provider synonyms diverge. `unclassified` is a valid,
 * surfaced outcome — silence is not (mirrors the classifier's UNKNOWN doctrine).
 */
export type FlowCategory =
  | "contribution"     // CONTRIBUTION
  | "withdrawal"       // WITHDRAWAL
  | "transfer_in"      // TRANSFER_IN
  | "transfer_out"     // TRANSFER_OUT
  | "buy"              // BUY
  | "sell"             // SELL
  | "income"           // DIVIDEND, INTEREST, CAPITAL_GAIN
  | "reinvestment"     // REINVESTMENT
  | "fee"              // FEE, TAX
  | "corporate_action" // SPLIT, MERGER, SPIN_OFF, SYMBOL_CHANGE
  | "opening"          // OPENING_BALANCE
  | "unclassified";    // CANCEL, ADJUSTMENT, OTHER, UNKNOWN

/**
 * The four categories whose FM-signed amount crosses the portfolio boundary and
 * therefore sums into `netExternalFlows`. Contributions / transfers-in carry a
 * positive amount, withdrawals / transfers-out a negative one — so a plain signed
 * sum over these four IS the net external movement.
 */
export const EXTERNAL_BOUNDARY_CATEGORIES: ReadonlySet<FlowCategory> = new Set<FlowCategory>([
  "contribution",
  "withdrawal",
  "transfer_in",
  "transfer_out",
]);

/** Total, exhaustive map from canonical event type → flow category. */
const CATEGORY_BY_TYPE: Record<InvestmentEventType, FlowCategory> = {
  CONTRIBUTION: "contribution",
  WITHDRAWAL: "withdrawal",
  TRANSFER_IN: "transfer_in",
  TRANSFER_OUT: "transfer_out",
  BUY: "buy",
  SELL: "sell",
  DIVIDEND: "income",
  INTEREST: "income",
  CAPITAL_GAIN: "income",
  REINVESTMENT: "reinvestment",
  FEE: "fee",
  TAX: "fee",
  SPLIT: "corporate_action",
  MERGER: "corporate_action",
  SPIN_OFF: "corporate_action",
  SYMBOL_CHANGE: "corporate_action",
  OPENING_BALANCE: "opening",
  CANCEL: "unclassified",
  ADJUSTMENT: "unclassified",
  OTHER: "unclassified",
  UNKNOWN: "unclassified",
};

/** Classify a canonical InvestmentEvent type into its flow category. Total. */
export function classifyEventFlow(type: InvestmentEventType): FlowCategory {
  return CATEGORY_BY_TYPE[type];
}

/**
 * One period event, already converted into the reporting currency by the binding.
 * `amount` is FM-signed (+ in / − out); null ⇒ no valuable cash leg (e.g. an
 * in-kind transfer, or a provider row that omitted the amount).
 */
export interface FlowEvent {
  type:        InvestmentEventType;
  date:        string;          // YYYY-MM-DD
  amount:      number | null;   // reporting-currency, FM-signed; null = no cash leg
  fxEstimated: boolean;         // conversion rate walked back / missing
  hasQuantity: boolean;         // carries security units (in-kind detection)
}

/** Per-category subtotal within the period. Serialisable. */
export interface FlowCategorySummary {
  category: FlowCategory;
  count:    number;
  /** Σ FM-signed reporting amount for this category (0 when every amount was null). */
  amount:   number;
}

/**
 * A period flow summary between two dates, in the reporting currency. The
 * per-category subtotals are informational; `netExternalFlows` is the only figure
 * that feeds the reconciliation identity (opening + netExternalFlows + residual =
 * closing).
 */
export interface PeriodFlows {
  from: string;   // exclusive lower bound (the opening/compareTo date)
  to:   string;   // inclusive upper bound (the closing/asOf date)
  reportingCurrency: string;

  eventCount: number;

  // Signed reporting-currency subtotals (informational breakdown).
  contributions: number;
  withdrawals:   number;
  transfersIn:   number;
  transfersOut:  number;
  buys:          number;
  sells:         number;
  income:        number;
  fees:          number;

  /** contributions + withdrawals + transfersIn + transfersOut (all already signed). */
  netExternalFlows: number;

  byCategory: FlowCategorySummary[];

  /** Transfers carrying units but no valuable cash leg — value effect not captured here. */
  inKindTransferCount: number;
  /** CANCEL / ADJUSTMENT / OTHER / UNKNOWN events (may still move cash into the residual). */
  unclassifiedCount: number;
  /** External-boundary events with no usable amount — their external value is unmeasured. */
  externalAmountMissingCount: number;
  /** True when any summed amount used an estimated FX rate. */
  fxEstimated: boolean;

  /** Trust tier for the flow picture as a whole. */
  completeness: CompletenessTier;
  /** Deterministic, name-free explanation. */
  reason: string;
}

const CATEGORY_ORDER: readonly FlowCategory[] = [
  "contribution", "withdrawal", "transfer_in", "transfer_out",
  "buy", "sell", "income", "reinvestment", "fee",
  "corporate_action", "opening", "unclassified",
];

/**
 * Reduce the events falling in (from, to] into signed reporting-currency period
 * flows. The interval is half-open at the bottom: events on or before `from` are
 * already reflected in the opening value; an event exactly on `to` is included in
 * the period (endpoint-diff semantics). Pure and deterministic.
 */
export function summarizePeriodFlows(
  events: readonly FlowEvent[],
  from: string,
  to: string,
  reportingCurrency: string,
): PeriodFlows {
  const inWindow = events.filter((e) => e.date > from && e.date <= to);

  const catAmount = new Map<FlowCategory, number>();
  const catCount = new Map<FlowCategory, number>();
  let inKindTransferCount = 0;
  let unclassifiedCount = 0;
  let externalAmountMissingCount = 0;
  let fxEstimated = false;

  for (const e of inWindow) {
    const category = classifyEventFlow(e.type);
    const amount = e.amount ?? 0;
    catAmount.set(category, (catAmount.get(category) ?? 0) + amount);
    catCount.set(category, (catCount.get(category) ?? 0) + 1);

    if (e.amount != null && e.fxEstimated) fxEstimated = true;

    const isExternal = EXTERNAL_BOUNDARY_CATEGORIES.has(category);
    const isTransfer = category === "transfer_in" || category === "transfer_out";

    // An in-kind transfer (units, no valuable cash leg) moves value we cannot
    // measure as a flow — count it so the residual isn't read as pure market move.
    if (isTransfer && e.hasQuantity && (e.amount == null || e.amount === 0)) {
      inKindTransferCount++;
    } else if (isExternal && e.amount == null) {
      externalAmountMissingCount++;
    }

    if (category === "unclassified") unclassifiedCount++;
  }

  const amt = (c: FlowCategory): number => catAmount.get(c) ?? 0;
  const contributions = amt("contribution");
  const withdrawals = amt("withdrawal");
  const transfersIn = amt("transfer_in");
  const transfersOut = amt("transfer_out");
  const buys = amt("buy");
  const sells = amt("sell");
  const income = amt("income");
  const fees = amt("fee");
  const netExternalFlows = contributions + withdrawals + transfersIn + transfersOut;

  const byCategory: FlowCategorySummary[] = CATEGORY_ORDER
    .filter((c) => (catCount.get(c) ?? 0) > 0)
    .map((c) => ({ category: c, count: catCount.get(c) ?? 0, amount: amt(c) }));

  // Trust: estimated FX or unclassified activity degrades to estimated; an
  // unmeasured external / in-kind flow degrades to incomplete (a genuine gap).
  let tier: CompletenessTier = "observed";
  if (fxEstimated) tier = worstTier([tier, "estimated"]);
  if (unclassifiedCount > 0) tier = worstTier([tier, "estimated"]);
  if (externalAmountMissingCount > 0 || inKindTransferCount > 0) tier = worstTier([tier, "incomplete"]);

  const reason = inWindow.length === 0
    ? `No investment events between ${from} and ${to}.`
    : buildReason(inWindow.length, {
        externalAmountMissingCount, inKindTransferCount, unclassifiedCount, fxEstimated,
      });

  return {
    from, to, reportingCurrency,
    eventCount: inWindow.length,
    contributions, withdrawals, transfersIn, transfersOut, buys, sells, income, fees,
    netExternalFlows,
    byCategory,
    inKindTransferCount, unclassifiedCount, externalAmountMissingCount, fxEstimated,
    completeness: tier,
    reason,
  };
}

function buildReason(
  n: number,
  flags: {
    externalAmountMissingCount: number;
    inKindTransferCount: number;
    unclassifiedCount: number;
    fxEstimated: boolean;
  },
): string {
  const caveats: string[] = [];
  if (flags.inKindTransferCount > 0) {
    caveats.push(`${flags.inKindTransferCount} in-kind transfer${flags.inKindTransferCount === 1 ? "" : "s"} moved holdings without a cash value`);
  }
  if (flags.externalAmountMissingCount > 0) {
    caveats.push(`${flags.externalAmountMissingCount} external movement${flags.externalAmountMissingCount === 1 ? "" : "s"} had no amount`);
  }
  if (flags.unclassifiedCount > 0) {
    caveats.push(`${flags.unclassifiedCount} event${flags.unclassifiedCount === 1 ? "" : "s"} could not be categorised`);
  }
  if (flags.fxEstimated) {
    caveats.push("some amounts were converted at an estimated rate");
  }
  const base = `${n} event${n === 1 ? "" : "s"} in the period.`;
  return caveats.length === 0 ? base : `${base} ${caveats.join("; ")}.`;
}
