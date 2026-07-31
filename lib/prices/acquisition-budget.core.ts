/**
 * lib/prices/acquisition-budget.core.ts
 *
 * V26-PRICE-4 — the PURE cost estimate for a set of acquisition plans. No
 * Prisma, no network, no clock, no registry access.
 *
 * PRICE-4 is the first slice permitted to spend provider credits, so the run
 * must be costable BEFORE it happens. This module turns plans plus ownership
 * segments into a report an operator can approve or refuse: how many requests,
 * how many credits, how many observations are expected back, and — the part that
 * makes it an honest estimate rather than a number — how much of that spend buys
 * EVIDENCED history versus INFERRED history.
 *
 * `checkpointId` is deterministic from (provider, instrument, requested window,
 * chunk) and never from execution order, so the same plan produces the same
 * checkpoint identifiers on every run, in any order, across processes. A
 * truncated run is therefore resumable by identity rather than by position.
 */

import type { AcquisitionPlan, AcquisitionWindow } from "./acquisition-plan.core";
import { attributeRange, type OwnershipSegment } from "./ownership-window.core";

/**
 * Checkpoint identity for one provider request.
 *
 * Deterministic from what the request IS, not when it happened. Position-based
 * identity ("chunk 3 of 7") breaks the moment a plan changes shape — which it
 * does on every run, because coverage shrinks as rows arrive — and would resume
 * a truncated run at the wrong window.
 */
export function acquisitionCheckpointId(
  source:           string,
  instrumentId:     string,
  requestedFromISO: string,
  requestedToISO:   string,
  chunk:            { fromISO: string; toISO: string },
): string {
  return `${source}|${instrumentId}|${requestedFromISO}..${requestedToISO}|${chunk.fromISO}..${chunk.toISO}`;
}

export interface InstrumentBudget {
  instrumentId:      string;
  /** The provider that would be asked, or null when routing found none. */
  source:            string | null;
  requests:          number;
  /** Inclusive calendar days requested — the vendor-cost unit. */
  requestDays:       number;
  /** Expected new PriceObservation rows: the missing EXPECTED dates, not request days. */
  expectedNewRows:   number;
  /** Requested days falling inside a KNOWN ownership segment. */
  knownDays:         number;
  /** Requested days falling inside a POSSIBLE (inferred) ownership segment. */
  possibleDays:      number;
  /**
   * Days that would be requested despite lying outside every ownership segment.
   * MUST be zero — a non-zero value means something planned prehistory.
   */
  unattributedDays:  number;
  /** Days of UNKNOWN prehistory deliberately NOT requested. */
  unknownSkippedDays: number;
  checkpointIds:     string[];
}

export interface AcquisitionBudget {
  instruments:        InstrumentBudget[];
  totalRequests:      number;
  totalRequestDays:   number;
  totalExpectedRows:  number;
  totalKnownDays:     number;
  totalPossibleDays:  number;
  totalUnattributed:  number;
  totalUnknownSkipped: number;
  /** requests × creditsPerRequest — an estimate under the stated assumption. */
  estimatedCredits:   number;
  /**
   * Worst case if every request needed the full retry allowance. Stated because
   * a budget that ignores retries under-reports the ceiling that actually matters.
   */
  worstCaseRequests:  number;
  worstCaseCredits:   number;
}

export interface BudgetInput {
  plan:     AcquisitionPlan;
  /** Ownership segments the plan was built from; [] when none resolved. */
  segments: readonly OwnershipSegment[];
  /** Provider that would serve this instrument, or null. */
  source:   string | null;
  /**
   * Days of evidence-free prehistory NOT requested — the span between an
   * operator's horizon of interest and where ownership evidence begins.
   */
  unknownSkippedDays: number;
}

export interface BudgetOptions {
  /** Vendor credits consumed per request. Default 1. */
  creditsPerRequest?: number;
  /** Retry allowance per request used for the worst case. Default 2. */
  maxRetriesPerRequest?: number;
}

function windowsOf(plan: AcquisitionPlan): readonly AcquisitionWindow[] {
  return plan.kind === "planned" ? plan.windows : [];
}

/**
 * Build the budget. Deterministic: instruments are sorted by id, checkpoint ids
 * follow the plan's already-ascending window order, and every figure is an
 * integer count (no floats, no formatted ratios).
 */
export function estimateAcquisitionBudget(
  inputs: readonly BudgetInput[],
  opts:   BudgetOptions = {},
): AcquisitionBudget {
  const creditsPerRequest    = opts.creditsPerRequest ?? 1;
  const maxRetriesPerRequest = opts.maxRetriesPerRequest ?? 2;

  const instruments: InstrumentBudget[] = [...inputs]
    .sort((a, b) => a.plan.instrumentId.localeCompare(b.plan.instrumentId))
    .map((input) => {
      const windows = windowsOf(input.plan);
      let knownDays = 0, possibleDays = 0, unattributedDays = 0;
      const checkpointIds: string[] = [];

      for (const w of windows) {
        const a = attributeRange(w.fromISO, w.toISO, input.segments);
        knownDays        += a.knownDays;
        possibleDays     += a.possibleDays;
        unattributedDays += a.unattributedDays;
        checkpointIds.push(acquisitionCheckpointId(
          input.source ?? "unrouted",
          input.plan.instrumentId,
          input.plan.kind === "calendar-unavailable" ? "n/a" : input.plan.requestedFromISO,
          input.plan.kind === "calendar-unavailable" ? "n/a" : input.plan.requestedToISO,
          w,
        ));
      }

      return {
        instrumentId:       input.plan.instrumentId,
        source:             input.source,
        requests:           windows.length,
        requestDays:        windows.reduce((n, w) => n + w.requestDays, 0),
        expectedNewRows:    input.plan.kind === "planned" ? input.plan.missingExpectedCount : 0,
        knownDays,
        possibleDays,
        unattributedDays,
        unknownSkippedDays: input.unknownSkippedDays,
        checkpointIds,
      };
    });

  const sum = (pick: (b: InstrumentBudget) => number): number =>
    instruments.reduce((n, b) => n + pick(b), 0);

  const totalRequests     = sum((b) => b.requests);
  const worstCaseRequests = totalRequests * (1 + maxRetriesPerRequest);

  return {
    instruments,
    totalRequests,
    totalRequestDays:    sum((b) => b.requestDays),
    totalExpectedRows:   sum((b) => b.expectedNewRows),
    totalKnownDays:      sum((b) => b.knownDays),
    totalPossibleDays:   sum((b) => b.possibleDays),
    totalUnattributed:   sum((b) => b.unattributedDays),
    totalUnknownSkipped: sum((b) => b.unknownSkippedDays),
    estimatedCredits:    totalRequests * creditsPerRequest,
    worstCaseRequests,
    worstCaseCredits:    worstCaseRequests * creditsPerRequest,
  };
}
