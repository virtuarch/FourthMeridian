/**
 * lib/snapshots/series-integrity.core.ts
 *
 * STANDING INTEGRITY PROBES for reconstructed snapshot series. Pure: no DB, no
 * clock, no prices.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The 2025-07-31 phantom was written by a regeneration run that had no way to
 * notice it. The run applied a delta the ledger did not contain, produced a
 * series that contradicted its own evidence, and reported success. 375 rows
 * carried a constant −145.98 for a year before anything looked.
 *
 * A regeneration stage may now report success only after its resulting series
 * passes these probes. They are the difference between "we wrote rows" and "we
 * wrote rows that agree with the evidence".
 *
 * ── The identity ─────────────────────────────────────────────────────────────
 * A reconstructed liability series is a posted anchor walked backward through a
 * posted ledger, which implies for every adjacent pair of reconstructed days:
 *
 *     debt(d) − debt(d−1) === −Σ(posted liability movements dated d)
 *
 * It is not a convention. It is what "walked from the ledger" MEANS, and it is
 * checkable without trusting either the writer or the reader.
 *
 * ── The three exemptions, and why each is NOT a defect ───────────────────────
 *   OBSERVED BOUNDARY  an isEstimated=false row is an observation of what
 *                      balances said that day. It was never walked, so the
 *                      identity does not apply — neither to it nor to the step
 *                      that lands on it.
 *   NON-NEGATIVE CLAMP a walked owed may dip below zero; a stored row publishes
 *                      max(0, owed). That displaces only the days it covers and
 *                      never propagates, unlike a phantom, which always reaches
 *                      the oldest day.
 *   ROUNDING           float accumulation over hundreds of days.
 *
 * Collapsing any of these into "violation" would cry wolf; collapsing a phantom
 * into any of them would hide the defect that motivated the whole probe.
 */

/** Canonical money tolerance for a single step. */
export const SERIES_IDENTITY_TOLERANCE = 0.005;

/** One day of a stored series, with everything the probes need to judge it. */
export interface SeriesPoint {
  dateISO: string;
  /** The stored component value for the day. */
  value: number;
  /** Σ of POSTED movements dated this day for the accounts behind the component. */
  movement: number;
  /** False ⇒ observed/frozen: never walked, so the identity does not apply. */
  isEstimated: boolean;
}

export type ViolationKind =
  /** Uncompensated, and it reaches the oldest day: the phantom class. */
  | "PHANTOM"
  /** The step is explained by a clamp at zero — displaces only its own run. */
  | "CLAMP"
  /** A step adjacent to an observed row, where the identity does not apply. */
  | "OBSERVED_BOUNDARY";

export interface SeriesViolation {
  dateISO: string;
  kind: ViolationKind;
  /** step + movement — zero when the identity holds. */
  residual: number;
  previousValue: number;
  value: number;
}

export interface SeriesIntegrityReport {
  /** Days examined (steps, so one fewer than points). */
  steps: number;
  violations: SeriesViolation[];
  /** True only when no PHANTOM survived. Clamps and boundaries are not failures. */
  healthy: boolean;
}

/**
 * Audit a component series against its own ledger.
 *
 * `points` must be ascending by date and contiguous. A gap is not an error here
 * — the caller supplies exactly the days it stored — but a missing day's
 * movements must be folded into the next present day by the caller, or the step
 * across the gap will read as a violation. The binding does this.
 */
export function auditLiabilitySeries(
  points: readonly SeriesPoint[],
): SeriesIntegrityReport {
  const violations: SeriesViolation[] = [];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const residual = round2(cur.value - prev.value + cur.movement);
    if (Math.abs(residual) <= SERIES_IDENTITY_TOLERANCE) continue;

    // An observed row was never walked; neither it nor the step onto it is
    // evidence of anything. Checked FIRST — an observation outranks arithmetic.
    if (!cur.isEstimated || !prev.isEstimated) {
      violations.push({ dateISO: cur.dateISO, kind: "OBSERVED_BOUNDARY", residual, previousValue: prev.value, value: cur.value });
      continue;
    }

    // A clamp is visible in the values themselves: one side sits exactly at the
    // floor while the identity would have put it below. No guessing.
    const impliedPrev = round2(cur.value + cur.movement);
    const clamped = (prev.value === 0 && impliedPrev < 0) || (cur.value === 0 && round2(prev.value - cur.movement) < 0);
    violations.push({
      dateISO: cur.dateISO,
      kind: clamped ? "CLAMP" : "PHANTOM",
      residual, previousValue: prev.value, value: cur.value,
    });
  }

  return {
    steps: Math.max(0, points.length - 1),
    violations,
    healthy: !violations.some((v) => v.kind === "PHANTOM"),
  };
}

/** The stored aggregate identities, checked on ONE row. */
export interface AggregateRow {
  stocks: number; crypto: number; total: number;
  cash: number; savings: number; debt: number;
  netWorth: number; totalAssets: number; netLiquid: number;
}

/**
 * Verify a row's stored columns against `computeSnapshotFields`' arithmetic.
 *
 * `cashOnHand` is deliberately excluded: its formula has drifted between the
 * schema comment and both writers, and 483 seeded rows hold a third value.
 * Asserting an identity the data does not satisfy manufactures contradictions
 * out of a naming disagreement.
 *
 * `totalAssets` is NOT checked against its components either — real assets are
 * folded in without a stored column, so the difference is a legitimate residual
 * rather than an error. `netWorth = totalAssets − debt` IS checkable, because
 * both sides are stored.
 */
export function aggregateIdentityViolations(row: AggregateRow): string[] {
  const out: string[] = [];
  const near = (a: number, b: number) => Math.abs(a - b) <= SERIES_IDENTITY_TOLERANCE;
  if (!near(row.total, row.stocks + row.crypto)) out.push("total !== stocks + crypto");
  if (!near(row.netWorth, row.totalAssets - row.debt)) out.push("netWorth !== totalAssets - debt");
  if (!near(row.netLiquid, row.cash + row.savings - row.debt)) out.push("netLiquid !== cash + savings - debt");
  if (row.totalAssets < row.stocks + row.crypto + row.cash + row.savings - SERIES_IDENTITY_TOLERANCE) {
    out.push("totalAssets < its own components");
  }
  return out;
}

/** Per-component health classification for the repository-wide audit. */
export type ComponentHealth =
  | "HEALTHY"
  | "REPAIRABLE"
  | "UNSUPPORTED"
  | "CONTRADICTORY"
  | "FROZEN";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
