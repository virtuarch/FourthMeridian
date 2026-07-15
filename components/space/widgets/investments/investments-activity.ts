/**
 * components/space/widgets/investments/investments-activity.ts
 *
 * PURE presentation model for the Period Activity panel. No DB, no clock, no
 * React — it turns the A10 `PeriodFlows` DTO into intent-grouped rows with
 * deterministic template sentences, so it fixture-tests with a standalone `tsx`
 * script (house pattern) and the card is a thin renderer.
 *
 * Grouping (plan §2 — reconciled against `investment-flows-core.ts` doctrine, so
 * Activity's "money out" agrees with the Bridge exactly):
 *   money in     = contribution + transfer_in          (crosses the boundary, +)
 *   money out    = withdrawal   + transfer_out         (crosses the boundary, −)
 *   inside       = buy / sell / income / reinvestment / fee / corporate_action
 * Fees are INTERNAL by doctrine (EXTERNAL_BOUNDARY_CATEGORIES is exactly the four
 * boundary categories); grouping them as "money out" would double-count against
 * the Bridge residual, so they live under "inside the portfolio".
 *
 * One caveat sentence is built from the four honesty counters + the FX-estimated
 * flag. `compareTo = null` (flows === null) and the zero-event case are honest
 * states, never fabricated windows.
 */

import {
  formatFlowCaveatSentence,
  type PeriodFlows,
  type FlowCategory,
} from "@/lib/investments/investment-flows-core";
import { formatCurrencyExact } from "@/lib/format";

export type ActivityGroupKey = "money_in" | "money_out" | "inside";

export interface ActivityGroup {
  key:   ActivityGroupKey;
  title: string;
  /** Signed net for the group in the reporting currency; null for "inside". */
  amount: number | null;
  /** Deterministic, name-free template sentence. */
  sentence: string;
}

export interface ActivityModel {
  state:   "no-comparison" | "no-events" | "events";
  /** Copy for the no-comparison / no-events states; null when there are groups. */
  message: string | null;
  groups:  ActivityGroup[];
  /** One caveat sentence from the honesty counters; null when nothing is off. */
  caveat:  string | null;
}

/** No-comparison honest copy (compareTo omitted / invalidated). */
const NO_COMPARISON = "Pick a comparison date to see what happened over a period.";

function countMap(flows: PeriodFlows): Record<FlowCategory, number> {
  const m = {} as Record<FlowCategory, number>;
  for (const c of flows.byCategory) m[c.category] = c.count;
  return m;
}

const n = (c: Record<FlowCategory, number>, k: FlowCategory): number => c[k] ?? 0;

/** "2 contributions" / "1 transfer in" — deterministic plural, name-free. */
function part(count: number, singular: string, plural: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Build the Period Activity presentation model. Pure and deterministic.
 * `flows === null` ⇒ no comparison selected (honest, never fabricated).
 */
export function buildActivityGroups(flows: PeriodFlows | null): ActivityModel {
  if (flows === null) {
    return { state: "no-comparison", message: NO_COMPARISON, groups: [], caveat: null };
  }
  if (flows.eventCount === 0) {
    return { state: "no-events", message: flows.reason, groups: [], caveat: null };
  }

  const cur = flows.reportingCurrency;
  const counts = countMap(flows);
  const fmt = (v: number) => formatCurrencyExact(v, cur);
  const groups: ActivityGroup[] = [];

  // ── Money in — contributions + transfers in (crosses the boundary, +). ──────
  const inCount = n(counts, "contribution") + n(counts, "transfer_in");
  if (inCount > 0) {
    const amount = flows.contributions + flows.transfersIn;
    const detail = [part(n(counts, "contribution"), "contribution", "contributions"), part(n(counts, "transfer_in"), "transfer in", "transfers in")]
      .filter(Boolean).join(", ");
    groups.push({ key: "money_in", title: "Money in", amount, sentence: `You added ${fmt(amount)} (${detail}).` });
  }

  // ── Money out — withdrawals + transfers out (crosses the boundary, −). ───────
  const outCount = n(counts, "withdrawal") + n(counts, "transfer_out");
  if (outCount > 0) {
    const amount = flows.withdrawals + flows.transfersOut; // ≤ 0
    const detail = [part(n(counts, "withdrawal"), "withdrawal", "withdrawals"), part(n(counts, "transfer_out"), "transfer out", "transfers out")]
      .filter(Boolean).join(", ");
    groups.push({ key: "money_out", title: "Money out", amount, sentence: `You moved out ${fmt(Math.abs(amount))} (${detail}).` });
  }

  // ── Inside the portfolio — buys/sells/income/reinvestment/fees/corp actions. ─
  const insideCount = n(counts, "buy") + n(counts, "sell") + n(counts, "income")
    + n(counts, "reinvestment") + n(counts, "fee") + n(counts, "corporate_action");
  if (insideCount > 0) {
    const parts = [
      part(n(counts, "buy"), "buy", "buys"),
      part(n(counts, "sell"), "sell", "sells"),
      flows.income !== 0 ? `${fmt(flows.income)} income` : null,
      flows.fees !== 0 ? `${fmt(Math.abs(flows.fees))} fees` : null,
      part(n(counts, "reinvestment"), "reinvestment", "reinvestments"),
      part(n(counts, "corporate_action"), "corporate action", "corporate actions"),
    ].filter(Boolean).join(", ");
    groups.push({ key: "inside", title: "Inside the portfolio", amount: null, sentence: `Inside the portfolio: ${parts}.` });
  }

  // The caveat sentence is single-authored in investment-flows-core
  // (formatFlowCaveatSentence) — PCS-1C removed this panel's private copy so
  // Activity, the flow `reason`, and the Trust summary can never diverge.
  return { state: "events", message: null, groups, caveat: formatFlowCaveatSentence(flows) };
}
