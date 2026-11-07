/**
 * components/space/widgets/wealth/wealth-change-gate.ts  (PB-8b)
 *
 * Whether each Net Worth / Assets series' change vs Compare To may be STATED,
 * given the Space's balance-history floors (PB-8). Pure; presentation-side —
 * WealthResult itself (deltas, drivers, AI / Brief) is untouched.
 *
 * The rule is balance-coverage.core `changeComparability`: a change whose
 * comparison (or closing) day lies before the coverage floor of the accounts the
 * series is composed from is WITHHELD and said ("Change unavailable: history is
 * partial before …"), never shown as a $ / % figure; an endpoint that includes
 * a held-flat liability is comparable but labelled estimated. A series composed
 * of neither cash nor debt (invested) is never gated here — its own coverage
 * disclosures already apply.
 */

import type { WealthResult } from "@/lib/wealth/wealth-time-machine";
import type { WealthMetricKey } from "@/lib/wealth/wealth-mode";
import type { WealthComponentId } from "./wealth-metric-facets";
import {
  balanceCoverageSidesFor, changeComparability, ESTIMATED_CHANGE_SUFFIX,
  type ClientBalanceCoverage, type ChangeComparability,
} from "@/lib/connections/balance-coverage.core";

export type WealthChangeGate = Record<WealthMetricKey, ChangeComparability>;

const METRICS: readonly WealthMetricKey[] = ["netWorth", "totalAssets", "totalLiabilities", "liquidNetWorth", "cash", "invested"];
const COMPARABLE: ChangeComparability = { state: "comparable" };

/**
 * One verdict per series, or null when there is nothing to gate (no comparison,
 * or nothing to cover — every change renders exactly as before). S2 2026-11-03:
 * while coverage is LOADING every governed series is PENDING ("—") and the
 * ungoverned one (invested) is comparable — no change is shown, then retracted.
 */
export function wealthChangeGate(result: WealthResult, cov: ClientBalanceCoverage): WealthChangeGate | null {
  const { asOfState, compareState } = result;
  if (!cov || !result.deltas || !compareState?.found || !compareState.date || !asOfState.date) return null;
  const endpoints = {
    fromISO: compareState.date, toISO: asOfState.date,
    fromEstimated: compareState.isEstimated, toEstimated: asOfState.isEstimated,
  };
  const out = {} as WealthChangeGate;
  for (const m of METRICS) out[m] = changeComparability(cov, balanceCoverageSidesFor(m), endpoints);
  return out;
}

/** The verdict for one series (comparable when there is no gate). */
export function gateFor(gate: WealthChangeGate | null | undefined, metric: WealthMetricKey): ChangeComparability {
  return gate?.[metric] ?? COMPARABLE;
}

/** The series a composition DRIVER's change belongs to (cash / debt are gated; the rest never). */
const DRIVER_SERIES: Record<WealthComponentId, WealthMetricKey> = {
  cash:        "cash",
  liabilities: "totalLiabilities",
  investments: "invested",
  crypto:      "invested",
  real:        "invested",
};

/** A driver id outside the composition classes is never gated. */
export function gateForDriver(gate: WealthChangeGate | null | undefined, id: string): ChangeComparability {
  const series = (DRIVER_SERIES as Record<string, WealthMetricKey | undefined>)[id];
  return series ? gateFor(gate, series) : COMPARABLE;
}

/** "Jun 17, 2026" → "Jun 17, 2026 · estimated" when the change is estimated. */
export function gatedCompareLabel(label: string | undefined, g: ChangeComparability): string | undefined {
  return label && g.state === "estimated" ? `${label}${ESTIMATED_CHANGE_SUFFIX}` : label;
}
