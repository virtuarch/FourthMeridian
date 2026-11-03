/**
 * lib/platform/ai/fleet-spend-status.ts  (AI COST CONTROLS — the ONE fleet spend status)
 *
 * THE SINGLE AUTHORITY for "how priced is the fleet's rolling-window AI spend,
 * and what share of the fleet alert threshold does it use". Every tile that
 * reads the fleet budget — the AI & Costs hero KPI "Budget used", the AI & Costs
 * "Budget utilisation" card, and the Economics → AI Budget drawer headline and
 * bar — derives its words and numbers from `fleetSpendStatus()` and nothing
 * else, so no two tiles can disagree about the same window.
 *
 * Status vocabulary (the owner's):
 *   MEASURED     billed cost read from a provider invoice. NOT PRODUCED: no
 *                invoice is read anywhere (ESTIMATE_NOT_BILLING) — the word is
 *                part of the vocabulary so a future billed source has a slot.
 *   ESTIMATED    every customer call in the window was priced by the rate card;
 *                utilisation = estimated spend ÷ threshold, an estimate.
 *   PARTIAL      some calls priced, some not: the priced portion is a LOWER
 *                BOUND ("at least $X", "≥ N%"), the unpriced calls counted.
 *   UNAVAILABLE  nothing priced (no calls recorded, or none could be priced):
 *                no dollar figure and no percentage — never $0.
 *
 * A fleet alert threshold of 0 (or unset) is NO threshold: the spend status is
 * unchanged, the utilisation is null and every tile says "No threshold set".
 *
 * Missing telemetry is never $0 (owner rule): an absent figure is UNAVAILABLE
 * with its reason. Pure; no clock, no I/O. Display and derivation only — the
 * alert rule (spend-health.ts) and the allowance are untouched.
 */

import type { AiBudgetUtilization } from "@/lib/platform/ai/cost-controls.types";

export type SpendStatus = "MEASURED" | "ESTIMATED" | "PARTIAL" | "UNAVAILABLE";

export const FLEET_REASON_NO_CALLS = "no customer invocations in the window";
export const FLEET_REASON_NONE_PRICED = "no customer invocation in the window could be priced";
export const NO_THRESHOLD = "No threshold set";

export interface FleetSpendStatus {
  status: Exclude<SpendStatus, "MEASURED">;
  /** Σ priced customer spend in the window; null iff UNAVAILABLE. A lower bound when PARTIAL. */
  pricedUsd: number | null;
  /** Share of the fleet alert threshold the PRICED spend uses; null when UNAVAILABLE or no threshold is set. A lower bound when PARTIAL. */
  utilisationPct: number | null;
  /** True when the figures are a lower bound (PARTIAL). */
  atLeast: boolean;
  /** Customer calls in the window (measured from the ledger). */
  invocations: number;
  /** Customer calls the rate card could not price — counted, never $0. */
  unpricedInvocations: number;
  thresholdUsd: number;
  /** False when the fleet alert threshold is 0 or unset: utilisation is then null ("No threshold set"), never "0% of $0.00". */
  thresholdSet: boolean;
  windowHours: number;
  alertEnabled: boolean;
  /** Why there is no figure (UNAVAILABLE only). */
  reason: string | null;
}

/**
 * Customer-surface unpriced calls: the fleet fold covers customer surfaces only,
 * so the count comes from the customer rows of `bySurface` (the reader seeds a
 * row per surface). A payload without customer rows falls back to the reader's
 * customer-only `unpriced` count.
 */
function customerUnpriced(b: Pick<AiBudgetUtilization, "bySurface" | "unpriced">): number {
  const rows = (b.bySurface ?? []).filter((s) => s.customer);
  return rows.length > 0 ? rows.reduce((a, s) => a + s.unpricedInvocations, 0) : b.unpriced?.invocations ?? 0;
}

export function fleetSpendStatus(b: Pick<AiBudgetUtilization, "fleet" | "windowHours" | "bySurface" | "unpriced">): FleetSpendStatus {
  const f = b.fleet;
  const unpricedInvocations = customerUnpriced(b);
  const thresholdSet = typeof f.thresholdUsd === "number" && Number.isFinite(f.thresholdUsd) && f.thresholdUsd > 0;
  const base = { invocations: f.invocations, unpricedInvocations, thresholdUsd: thresholdSet ? f.thresholdUsd : 0, thresholdSet, windowHours: b.windowHours, alertEnabled: f.alertEnabled };
  if (f.estimatedUsd === null) {
    return { ...base, status: "UNAVAILABLE", pricedUsd: null, utilisationPct: null, atLeast: false, reason: f.invocations === 0 ? FLEET_REASON_NO_CALLS : FLEET_REASON_NONE_PRICED };
  }
  // No threshold ⇒ no share of one. Otherwise the reader's percentage (the same pct() the alert view uses).
  const utilisationPct = !thresholdSet ? null : f.utilizationPct ?? Math.round((f.estimatedUsd / f.thresholdUsd) * 1000) / 10;
  const partial = unpricedInvocations > 0;
  return { ...base, status: partial ? "PARTIAL" : "ESTIMATED", pricedUsd: f.estimatedUsd, utilisationPct, atLeast: partial, reason: null };
}
