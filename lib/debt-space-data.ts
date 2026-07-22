/**
 * lib/debt-space-data.ts  (SD-4 contract priming — Debt)
 *
 * THE canonical composition contract for the Debt workspace. Debt is a TEMPORAL
 * Perspective (consumesShellTime) whose inputs must be composed against the shell
 * (asOf / compareTo) window — and today NOTHING owns that composition (the
 * asOf/compareTo clipping gap: the lens never recomputes as-of on the production
 * path, and the Balance-Over-Time series is never clipped to the window). This
 * contract is that owner, and closing the gap is exactly what it does.
 *
 * Deliberately NARROW — a TIME-COMPOSITION boundary, NOT a KPI DTO. It owns only
 * the DURABLE composition concerns:
 *   • `lens`         — the debt lens computed AT asOf (verdict/headline/metrics/
 *                      provenance authority; carries its own as-of `completeness`).
 *   • `completeness` — that as-of trust envelope, re-surfaced (a POINTER to
 *                      `lens.completeness`, not a second computation).
 *   • `history`      — the Balance-Over-Time snapshot series CLIPPED to
 *                      [compareTo ?? start, asOf], with its explicit snapshot-
 *                      currency basis (distinct from the lens/KPI currency).
 *   • `fico`         — passthrough, never debt math.
 *
 * Everything else stays PRESENTATION-DERIVED inside the Debt workspace, sourced
 * from the visibility-filtered accounts array (the figures of record): the KPI
 * strip, per-account bars, interest cost, utilization rows, payoff scenarios,
 * signals, and the gap list. This is LOAD-BEARING: the lens may see DebtProfile
 * terms the client array lacks, so the two can legitimately disagree; the design
 * keeps the lens PROSE-ONLY in the UI and sources every visible number from the
 * client array. A figure-computing DebtSpaceData would reintroduce that
 * contradiction — so it is refused here (see debt-kpis.ts / DebtPerspective.tsx).
 *
 * PURE assembly — no DB, no clock, no network: it composes an ALREADY-COMPUTED
 * `LensResult` (from the debt lens at the resolved asOf) plus an already-read
 * `Snapshot[]` into one serialisable shape. The runtime BINDING (a client
 * composition hook that fetches the lens at asOf and injects the host snapshots —
 * the Debt analogue of useInvestmentsTimeMachine, NOT a server loader, since the
 * client KPI authority is intentionally client-side) is an extraction-phase step;
 * this is its pure core. Unit-testable under tsx.
 */

import type { Snapshot } from "@/types";
import type { Completeness, LensResult } from "@/lib/perspective-engine/types";

/** One clipped Balance-Over-Time point — the debt-scoped projection of a Snapshot
 *  (only the fields the debt history renders; the other snapshot classes are
 *  irrelevant to "what do I owe over time"). */
export interface DebtHistoryPoint {
  date: string;
  totalDebt: number;
  /** True for a reconstructed/backfilled row (Snapshot.isEstimated). */
  isEstimated: boolean;
}

/** The window-clipped Balance-Over-Time slice. */
export interface DebtHistorySlice {
  /** Points clipped to [compareTo ?? earliest, asOf], fxMiss dropped, ascending. */
  points: DebtHistoryPoint[];
  /** The snapshot currency basis — NOT necessarily the lens/KPI currency (a
   *  display-currency switch reconverts current figures but relabels historical
   *  totals, which are pre-stamped). Kept explicit so no consumer pretends one
   *  currency spans both axes. */
  currency: string;
  /** The applied lower bound (compareTo), or null for "full history up to asOf". */
  windowStart: string | null;
  /** The applied upper bound (asOf). */
  windowAsOf: string;
}

/** THE canonical Debt workspace composition contract. */
export interface DebtSpaceData {
  asOf: string;
  compareTo: string | null;
  /** The debt lens computed AT asOf — the verdict/headline/metrics/provenance
   *  authority. null when no lens was supplied (an empty/error/absent read). */
  lens: LensResult | null;
  /** `lens.completeness` re-surfaced (the as-of trust envelope). null when the lens
   *  is absent or was not computed as-of (byte-identical present-day branch). */
  completeness: Completeness | null;
  /** Window-clipped Balance-Over-Time. null when no usable history exists in-window. */
  history: DebtHistorySlice | null;
  /** FICO passthrough — never drives debt math; Personal host only in practice. */
  fico: { score: number | null; updatedAt: string | null };
}

/**
 * Clip a Snapshot series to the debt history window. PURE: filters to numeric
 * totalDebt with fxMiss dropped (invariant 8 — mixed-magnitude points never
 * plotted), inside [compareTo ?? −∞, asOf], sorted ascending, projected to the
 * debt-scoped point shape. Returns null when nothing survives (the workspace
 * applies its own "not enough history yet" presentation gate on top).
 */
function clipDebtHistory(
  snapshots: Snapshot[],
  asOf: string,
  compareTo: string | null,
  currency: string,
): DebtHistorySlice | null {
  const points: DebtHistoryPoint[] = snapshots
    .filter((s) => typeof s.totalDebt === "number" && s.fxMiss !== true)
    .filter((s) => s.date <= asOf && (compareTo === null || s.date >= compareTo))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((s) => ({ date: s.date, totalDebt: s.totalDebt, isEstimated: s.isEstimated === true }));

  if (points.length === 0) return null;
  return { points, currency, windowStart: compareTo, windowAsOf: asOf };
}

/**
 * Compose the canonical Debt workspace contract from already-loaded inputs. PURE
 * ORCHESTRATION — it computes NO KPI sum, payoff, utilization, blended APR, or
 * verdict: it carries the lens verbatim, re-surfaces its as-of completeness, clips
 * the snapshot history to the shell window, and passes FICO through. `lens` is
 * expected to have been computed AT `asOf` (the debt lens already supports this —
 * getAccountsAsOf + buildDebtCompleteness); wiring that fetch is the extraction
 * step, and providing a present-day lens here simply yields a null `completeness`.
 */
export function assembleDebtSpaceData(args: {
  asOf: string;
  compareTo?: string | null;
  lens?: LensResult | null;
  snapshots?: Snapshot[] | null;
  /** The stamped currency of the snapshot series (the history basis). */
  snapshotCurrency: string;
  fico?: { score: number | null; updatedAt: string | null } | null;
}): DebtSpaceData {
  const compareTo = args.compareTo ?? null;
  const lens = args.lens ?? null;
  return {
    asOf: args.asOf,
    compareTo,
    lens,
    completeness: lens?.completeness ?? null,
    history: clipDebtHistory(args.snapshots ?? [], args.asOf, compareTo, args.snapshotCurrency),
    fico: { score: args.fico?.score ?? null, updatedAt: args.fico?.updatedAt ?? null },
  };
}
