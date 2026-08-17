/**
 * lib/balances/section-quantity.ts   (v2.6-L2 — BALANCE AUTHORITY)
 *
 * What quantity does each Space section widget actually show?
 *
 * Every widget in SectionRegistry is classified here — none may be left out.
 * `lib/balances/balance-boundary.test.ts` reads the registry's key list and
 * fails if a key is missing from this map, so adding a widget without saying
 * what it shows is a build failure rather than an unlabelled figure on the
 * dashboard. The V26 matrix flagged ~18 widgets rendering current balances with
 * no disclosure at all; this is the map that ends that, and keeps it ended.
 *
 * Three classifications, and the distinction matters:
 *
 *   a BalanceQuantity   the widget renders CURRENT account balances, and the
 *                       card discloses which quantity
 *   "HISTORICAL"        snapshot- or event-backed (a point in the past, already
 *                       carrying its own as-of) — a current-balance label would
 *                       be wrong, not merely redundant
 *   "FLOW"              transaction-derived movement over a window; accounts are
 *                       read only to scope or filter, never summed as balances
 *   "NON_FINANCIAL"     goals, activity, credit score, empty states
 *
 * Pure data + pure helpers. No React, no DB.
 */

import { QUANTITY_PLURAL_LABEL, type BalanceQuantity } from "./quantities";

export type SectionQuantity = BalanceQuantity | "HISTORICAL" | "FLOW" | "NON_FINANCIAL";

/**
 * The classification for every SectionRegistry key.
 *
 * ⚠️ v2.6-L3 moved the liquidity family from OBSERVED_LEDGER to REACHABLE_CASH.
 * That flip IS the migration: those four widgets now consume the reconciliation
 * authority instead of summing ledger balances under copy that says "reachable".
 * Everything else still shows OBSERVED_LEDGER or AMOUNT_OWED, which is correct
 * for what those widgets render — a net-worth donut is a statement about
 * observed balances, not about reachable money.
 */
export const SECTION_QUANTITY: Record<string, SectionQuantity> = {
  // REVIEW-3 (slice F): trimmed with the registry — the Overview lede family
  // (net_worth / net_worth_chart / allocation) and the WORKSPACE_RENDERERS-
  // backed perspective widget keys (wealth_* / liquidity_* / cash_flow_* /
  // debt-perspective keys) lost their renderers, so their classifications went
  // with them. The perspective WORKSPACES never rendered through SectionCard;
  // the v2.6-L3 liquidity REACHABLE_CASH migration lives on in the
  // LiquidityWorkspace path, not here.

  // ── Observed ledger balances ──────────────────────────────────────────────
  accounts_overview:        "OBSERVED_LEDGER",
  investment_summary:       "OBSERVED_LEDGER",
  investment_allocation:    "OBSERVED_LEDGER",
  retirement_accounts:      "OBSERVED_LEDGER",

  // ── Debt — amount OWED, through lib/debt/balance-semantics ────────────────
  debt_breakdown_chart:     "AMOUNT_OWED",
  debt_payoff_calculator:   "AMOUNT_OWED",

  // ── Config-driven asset/target widgets — current balances against a target ─
  property_value:           "OBSERVED_LEDGER",
  vehicle_value:            "OBSERVED_LEDGER",
  equipment_value:          "OBSERVED_LEDGER",
  trip_savings:             "OBSERVED_LEDGER",
  emergency_fund_progress:  "OBSERVED_LEDGER",
  retirement_progress:      "OBSERVED_LEDGER",

  // ── Transaction-derived: accounts scope or filter, never sum as balances ──
  trip_budget:              "FLOW",

  // ── Not a balance claim ───────────────────────────────────────────────────
  goal_progress:            "NON_FINANCIAL",
  goal_on_track:            "NON_FINANCIAL",
  goal_required_pace:       "NON_FINANCIAL",
  goal_funding_gap:         "NON_FINANCIAL",
  goals_progress:           "NON_FINANCIAL",
  recent_activity:          "NON_FINANCIAL",
};

/** True when this section renders CURRENT account balances and must disclose it. */
export function isCurrentBalanceSection(key: string): boolean {
  const q = SECTION_QUANTITY[key];
  return q !== undefined && q !== "HISTORICAL" && q !== "FLOW" && q !== "NON_FINANCIAL";
}

/**
 * The disclosure line for a section card, or null when the section shows no
 * current-balance quantity. Deterministic; no clock, no formatting of times —
 * freshness is disclosed once, at the Space header and on each account.
 */
export function sectionQuantityNote(key: string): string | null {
  const q = SECTION_QUANTITY[key];
  if (q === undefined || !isCurrentBalanceSection(key)) return null;
  return QUANTITY_PLURAL_LABEL[q as BalanceQuantity];
}
