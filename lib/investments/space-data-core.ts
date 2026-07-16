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
import { buildInvestmentsTrustSummary, type InvestmentsTrustSummary } from "./investments-trust";
import type { PeriodFlows } from "./investment-flows-core";
import type { ScopeDivergenceDisclosure } from "./scope-divergence";

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
 * THE canonical Investments workspace contract (PCS-1D) — the single boundary
 * every Investments consumer reads through before SpaceDashboard decomposition.
 * FOUR slices, each owned by ONE canonical authority and NEVER cross-derived:
 *
 *   - `current`    — the current-portfolio view, sourced EXCLUSIVELY from
 *     getCurrentPositions() (PCS-1A).
 *   - `historical` — the A10 Time Machine view (as-of / compare / period flows /
 *     reconciliation), sourced EXCLUSIVELY from getInvestmentsTimeMachine (PCS-1B).
 *   - `activity`   — the canonical `PeriodFlows` (PCS-1C); it IS `historical.flows`
 *     re-surfaced at the top level, never a second flow read. Present only when the
 *     historical view defines a comparison window (else flows is null → absent).
 *   - `trust`      — the canonical `InvestmentsTrustSummary` (PCS-1C), the ONE
 *     reduction `buildInvestmentsTrustSummary(historical)` produces. Present with
 *     `historical`.
 *
 * `historical`, `activity`, and `trust` are all OPTIONAL and travel together: a
 * current-only workspace read populates just `current`; asking for the historical
 * view additionally yields `activity` (when there is a window) and `trust`. The
 * slices are never back-filled from each other — `historical` is not derived from
 * `current`, `current` is not derived from the Time Machine, and `activity`/`trust`
 * are pure re-surfacings of the historical result, computing no new arithmetic.
 */
export interface InvestmentsSpaceData {
  current:     CurrentPortfolio;
  historical?: HistoricalPortfolio;
  /** `historical.flows` re-surfaced — the canonical PeriodFlows. Absent when no window. */
  activity?:   PeriodFlows;
  /** `buildInvestmentsTrustSummary(historical)` — present whenever `historical` is. */
  trust?:      InvestmentsTrustSummary;
  /**
   * HIST-1D — shared-Space scope disclosure: why this member-facing investments
   * figure (detailEligible scope) can legitimately differ from whole-Space wealth
   * (all-accounts scope) on the same date. Present ONLY on a shared Space that has
   * a reduced-visibility investment account; absent otherwise. Currency-agnostic
   * (like `trust`), so it is attached from the raw contract, not the converted one.
   */
  scopeDivergence?: ScopeDivergenceDisclosure;
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

/**
 * Compose the full Investments workspace contract from the already-loaded slices.
 * PURE ORCHESTRATION — it performs NO valuation, FX, flow, allocation, or trust
 * arithmetic of its own: `activity` is `historical.flows` re-surfaced, and `trust`
 * is the ONE canonical `buildInvestmentsTrustSummary` reduction. When `historical`
 * is absent (a current-only read) it returns just `current`; the historical,
 * activity, and trust slices are populated together, off the SAME A10 result, so
 * they can never disagree.
 */
export function assembleInvestmentsSpaceData(args: {
  current:     CurrentPortfolio;
  historical?: HistoricalPortfolio | null;
}): InvestmentsSpaceData {
  const { current, historical } = args;
  if (!historical) return { current };
  return {
    current,
    historical,
    // `flows` is null when there is no comparison window — omit rather than carry null.
    ...(historical.flows ? { activity: historical.flows } : {}),
    trust: buildInvestmentsTrustSummary(historical),
  };
}
