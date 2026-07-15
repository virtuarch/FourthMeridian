/**
 * lib/investments/space-data-core.ts  (PCS-1A)
 *
 * PURE assembly of the canonical CURRENT-PORTFOLIO contract — the `current`
 * portion of InvestmentsSpaceData. No DB, no clock, no network: it composes an
 * ALREADY-READ `CurrentPositions` (from getCurrentPositions) plus an accountId→name
 * map into one coherent, serialisable shape. Fixture-tested with no `prisma
 * generate` (space-data-core.test.ts).
 *
 * ── The one current-truth source ─────────────────────────────────────────────
 * Current truth comes EXCLUSIVELY from `getCurrentPositions()` — the A10-at-today
 * seam (visibility enforced inside it: FULL links only). This contract is NOT the
 * A10 Time Machine (it does no As-Of / compare / period-flow) and it never reads
 * the legacy `Holding` model. Historical / compare reads stay with the Time
 * Machine; they join InvestmentsSpaceData in a later PCS step, never here.
 *
 * ── No second portfolio DTO ──────────────────────────────────────────────────
 * `holdings` and `portfolio` are the canonical `CurrentPositions` fields VERBATIM
 * (rows re-surfaced under the field name `holdings` — the name the UI and the
 * Time Machine already use for the same rows; getCurrentPositions calls them
 * `rows`). No value, price, FX, share, or completeness math is created here.
 *
 * ── Allocation is IN CONTRACT ────────────────────────────────────────────────
 * `allocation` (asset-class · sector · account · currency + concentration) is the
 * SAME pure `computeAllocation` the Investments Allocation panel and the AI
 * concentration read already share — computed ONCE, here, over the canonical rows,
 * so "current portfolio statistics" live in the contract instead of being an
 * orphaned client-side derive. Only VALUED rows contribute; concentration excludes
 * cash — exactly the panel's existing semantics.
 */

import { computeAllocation, type AllocationResult } from "./investments-allocation-core";
import type { CurrentPositions, CurrentPositionRow } from "./current-positions-core";
import type { InvestmentsPortfolio, InvestmentsTimeMachineResult } from "./investments-time-machine-core";

/**
 * THE canonical current-portfolio contract. Every field is either passed through
 * from `getCurrentPositions()` verbatim (`asOf`, `reportingCurrency`, `holdings`,
 * `portfolio`) or a pure reduce of its rows (`allocation`). Serialisable.
 */
export interface CurrentPortfolio {
  /** The resolved "today" the positions were valued at (YYYY-MM-DD). */
  asOf:              string;
  reportingCurrency: string;
  /** Canonical valued rows (getCurrentPositions().rows verbatim — carries costBasis). */
  holdings:          CurrentPositionRow[];
  /** Valued subtotal + explicit unvalued remainder + trust envelope (A10 shape). */
  portfolio:         InvestmentsPortfolio;
  /** Asset-class · sector · account · currency breakdowns + concentration. */
  allocation:        AllocationResult;
}

/**
 * THE canonical Investments *historical* view — PCS-1B. It is the A10 Investments
 * Time Machine result (`InvestmentsTimeMachineResult`) VERBATIM, under its contract
 * name: as-of holdings, valued portfolio, period flows, and the change
 * reconciliation over (compareTo, asOf]. Historical truth belongs EXCLUSIVELY to
 * A10 — this alias re-surfaces that result, it does not re-derive or re-shape it,
 * and it deliberately reuses NONE of the current-position DTOs (`CurrentPortfolio`
 * / `CurrentPositionRow`). The current↔historical boundary is time, not data.
 */
export type HistoricalPortfolio = InvestmentsTimeMachineResult;

/**
 * The Investments Space data contract. Two independently-loadable slices, split by
 * TIME and never cross-derived:
 *   - `current`    — the canonical current-portfolio view, sourced EXCLUSIVELY from
 *     getCurrentPositions() (PCS-1A; loaded by loadInvestmentsSpaceData).
 *   - `historical` — the A10 Time Machine view (as-of / compare / period flows /
 *     reconciliation), sourced EXCLUSIVELY from getInvestmentsTimeMachine (PCS-1B;
 *     loaded by loadInvestmentsHistory). Optional: a surface that needs only the
 *     current view (or only historical) populates just its slice.
 *
 * The two are NEVER back-filled from each other — `historical` is not derived from
 * `current`, and `current` is not derived from the Time Machine. A caller that
 * wants as-of / compare / flows is a `historical` (A10) caller, full stop.
 */
export interface InvestmentsSpaceData {
  current:     CurrentPortfolio;
  historical?: HistoricalPortfolio;
}

/**
 * Compose the canonical current-portfolio contract from an already-read
 * `CurrentPositions` and an accountId→name map (for the by-account allocation
 * axis; a missing name buckets as "Unknown account", matching computeAllocation).
 * PURE — the only computation is the shared `computeAllocation` reduce.
 */
export function assembleCurrentPortfolio(
  positions:    CurrentPositions,
  accountNames: Record<string, string> = {},
): CurrentPortfolio {
  return {
    asOf:              positions.asOf,
    reportingCurrency: positions.reportingCurrency,
    holdings:          positions.rows,
    portfolio:         positions.portfolio,
    allocation:        computeAllocation(positions.rows, accountNames),
  };
}
