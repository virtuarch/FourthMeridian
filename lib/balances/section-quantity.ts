/**
 * lib/balances/section-quantity.ts   (V27-L2 — BALANCE AUTHORITY)
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
 * ⚠️ Today every current-balance widget below shows OBSERVED_LEDGER or
 * AMOUNT_OWED — the two quantities the product has ever actually rendered. The
 * liquidity family is marked OBSERVED_LEDGER because that is what it shows
 * TODAY, and labelling it honestly is the point: "Accessible cash" computed from
 * ledger balances is not reachable cash. Moving that family onto a reachable /
 * predicted quantity is the reconciliation slice's job, and this map is where
 * that change becomes visible.
 */
export const SECTION_QUANTITY: Record<string, SectionQuantity> = {
  // ── Net worth / wealth — observed ledger balances ─────────────────────────
  net_worth:                "OBSERVED_LEDGER",
  net_worth_section:        "OBSERVED_LEDGER", // deprecated alias, same renderer
  allocation:               "OBSERVED_LEDGER",
  wealth_by_account:        "OBSERVED_LEDGER",
  institution_allocation:   "OBSERVED_LEDGER",
  asset_allocation:         "OBSERVED_LEDGER",
  wealth_concentration:     "OBSERVED_LEDGER",
  business_accounts:        "OBSERVED_LEDGER",
  accounts_overview:        "OBSERVED_LEDGER",
  investment_summary:       "OBSERVED_LEDGER",
  investment_allocation:    "OBSERVED_LEDGER",
  retirement_accounts:      "OBSERVED_LEDGER",

  // ── Liquidity — see the note above: OBSERVED_LEDGER is what these show ────
  liquidity_ladder:         "OBSERVED_LEDGER",
  accessible_cash:          "OBSERVED_LEDGER",
  emergency_fund_readiness: "OBSERVED_LEDGER",
  liquidity_concentration:  "OBSERVED_LEDGER",

  // ── Debt — amount OWED, through lib/debt/balance-semantics ────────────────
  debt_by_account:          "AMOUNT_OWED",
  debt_cost:                "AMOUNT_OWED",
  credit_utilization:       "AMOUNT_OWED",
  debt_complete_info:       "AMOUNT_OWED",
  debt_summary:             "AMOUNT_OWED",
  debt_payoff_tracker:      "AMOUNT_OWED",
  mortgage_tracker:         "AMOUNT_OWED",
  auto_loan_tracker:        "AMOUNT_OWED",
  debt_breakdown_chart:     "AMOUNT_OWED",
  debt_payoff_calculator:   "AMOUNT_OWED",

  // ── Config-driven asset/target widgets — current balances against a target ─
  property_value:           "OBSERVED_LEDGER",
  vehicle_value:            "OBSERVED_LEDGER",
  equipment_value:          "OBSERVED_LEDGER",
  trip_savings:             "OBSERVED_LEDGER",
  emergency_fund_progress:  "OBSERVED_LEDGER",
  retirement_progress:      "OBSERVED_LEDGER",

  // ── Snapshot-backed: already carries its own as-of ────────────────────────
  net_worth_chart:          "HISTORICAL",
  debt_history:             "HISTORICAL",

  // ── Transaction-derived: accounts scope or filter, never sum as balances ──
  cash_flow_summary:        "FLOW",
  cash_flow_history:        "FLOW",
  income_vs_spending:       "FLOW",
  cash_flow_by_category:    "FLOW",
  income_by_source:         "FLOW",
  debt_payments:            "FLOW",
  trip_budget:              "FLOW",

  // ── Not a balance claim ───────────────────────────────────────────────────
  credit_score:             "NON_FINANCIAL",
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
