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

import { COMPUTED_TOLERANCE } from "@/lib/perspective-engine/reconciliation.core";

/**
 * Tolerance for a SINGLE WALKED STEP against its own ledger movement — and only
 * that. Deliberately tighter than the one-cent stored-column tolerance below: a
 * step is one subtraction, so anything above half a cent is a real defect, and
 * a looser bound would let sub-cent drift accumulate across hundreds of steps
 * into a visible phantom before any step individually failed.
 *
 * REVIEW-3 (matrix row 15): this constant is NOT the stored-row identity
 * tolerance. Row identities (netWorth = totalAssets − debt, …) are governed by
 * COMPUTED_TOLERANCE — owned by lib/perspective-engine/reconciliation.core.ts
 * and shared with aggregate-authorisation.core.ts — so the probe and the
 * authorisation authority can never disagree about whether one row is
 * self-consistent.
 */
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
  // ONE-ROW identities use the SHARED stored-column tolerance (see the
  // SERIES_IDENTITY_TOLERANCE header): the same one-cent bound
  // aggregate-authorisation.core.ts applies, imported from the one owner.
  const near = (a: number, b: number) => Math.abs(a - b) <= COMPUTED_TOLERANCE;
  if (!near(row.total, row.stocks + row.crypto)) out.push("total !== stocks + crypto");
  if (!near(row.netWorth, row.totalAssets - row.debt)) out.push("netWorth !== totalAssets - debt");
  if (!near(row.netLiquid, row.cash + row.savings - row.debt)) out.push("netLiquid !== cash + savings - debt");
  if (row.totalAssets < row.stocks + row.crypto + row.cash + row.savings - COMPUTED_TOLERANCE) {
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

// ── PB-8 — the debt replay, with an UNVERIFIABLE state ───────────────────────
//
// The write-time probe used to replay every debt account through the as-of
// resolver and demand `stored debt === Σ amountOwed(replayed balance ?? 0)`.
// That is only a test for a liability the canonical ladder WALKS (a
// reconstructable revolving card). A liability the ladder cannot walk — an
// installment loan, a mortgage, a card Plaid sent without a credit limit — has
// no replay at all: the writer HOLDS IT FLAT at its current balance (REG-2, and
// the flat fallback for non-walkable debt), while the resolver reports it as
// `before-coverage` (0) before its connection floor. Comparing the two flagged
// the more accurate side as broken (Production 2026-11-01: a held-flat mortgage
// and a held-flat card, "stored X != replay Y" on every day between the
// writer's floor and the connection floor).
//
// So the probe now distinguishes, per account:
//
//   WALKED        replayed through the ledger; the stored series must agree.
//   UNVERIFIABLE  held flat / no walk. Nothing can confirm or refute its value
//                 on a past day, so it is never compared against 0. On a given
//                 day the writer either held it flat at its current owed or the
//                 account was not yet in the series — so the stored residual over
//                 the walked replay must equal SOME subset of the unverifiable
//                 accounts' held owed. Anything else is a genuine mismatch.
//
// The aggregate identities (aggregateIdentityViolations) are unaffected.

/** One debt account as the probe sees it. Ids only — no names. */
export interface DebtReplayAccount {
  id: string;
  /** True ⇔ the canonical ladder walks this liability (isReconstructableCard). */
  walked: boolean;
  /** amountOwed(current balance): what a held-flat writer holds it at. Ignored when walked. */
  heldFlatOwed: number;
}

export interface DebtReplayRow {
  dateISO: string;
  debt: number;
  isEstimated: boolean;
}

export interface DebtReplayReport {
  /** Estimated rows compared (observations were never walked). */
  checked: number;
  /** Genuine mismatches only — unbounded here; the caller bounds what it logs. */
  violations: string[];
  walkedAccountIds: string[];
  unverifiableAccountIds: string[];
  /** Estimated rows whose stored debt rests in part on an unverifiable account. */
  rowsRestingOnUnverifiable: number;
  /**
   * Of those, rows that matched only as SOME held-flat subset, not the writer's
   * own floors — a row an earlier run wrote before an account was linked. Never
   * a violation (the account is unverifiable either way); counted so it shows.
   */
  rowsOffWriterFloor: number;
}

/**
 * Above this many unverifiable accounts the exact subset test (2^n sums) gives
 * way to its bound: 0 ≤ residual ≤ Σ held owed. No real Space comes close.
 */
const MAX_EXACT_UNVERIFIABLE = 12;

/** Every achievable Σ of a subset of `values` (round2), including the empty subset's 0. */
function subsetSums(values: readonly number[]): number[] {
  let sums = [0];
  for (const v of values) sums = [...sums, ...sums.map((s) => round2(s + v))];
  return sums;
}

/**
 * Audit stored debt against the walked replay. `walkedOwedOn(dateISO, id)` is
 * Σ-ready: amountOwed of the replayed balance for a WALKED account on that day
 * (0 before its floor). It is never asked about an unverifiable account.
 */
export function auditDebtReplay(
  rows: readonly DebtReplayRow[],
  accounts: readonly DebtReplayAccount[],
  walkedOwedOn: (dateISO: string, accountId: string) => number,
  /**
   * PB-8 — THE WRITER'S floors (computeAccountFloors), accountId → YYYY-MM-DD.
   * When given, an account contributes nothing before its writer floor (walked:
   * 0; unverifiable: absent) and its held owed from it — the probe and the
   * writer agree on WHEN an account is in the series. Absent (the operator
   * audit, which has no writer run) ⇒ the subset rule alone.
   */
  writerFloorISOById?: ReadonlyMap<string, string>,
): DebtReplayReport {
  const walked = accounts.filter((a) => a.walked);
  const unverifiable = accounts.filter((a) => !a.walked);
  const held = unverifiable.map((a) => Math.max(0, a.heldFlatOwed));
  const exact = held.length <= MAX_EXACT_UNVERIFIABLE ? subsetSums(held) : null;
  const heldTotal = held.reduce((n, v) => n + v, 0);

  const violations: string[] = [];
  let checked = 0;
  let resting = 0;
  let offFloor = 0;
  const present = (id: string, dateISO: string) => {
    const f = writerFloorISOById?.get(id);
    return f === undefined || dateISO >= f;
  };
  for (const r of rows) {
    if (!r.isEstimated) continue; // an observation was never walked
    checked++;
    const replay = walked.reduce((n, a) => n + (present(a.id, r.dateISO) ? walkedOwedOn(r.dateISO, a.id) : 0), 0);
    const residual = r.debt - replay;
    if (Math.abs(residual) <= SERIES_IDENTITY_TOLERANCE) continue;
    // The writer's own expectation for the unverifiable part, when its floors are known.
    if (writerFloorISOById) {
      const expectedHeld = unverifiable.reduce((n, a, i) => n + (present(a.id, r.dateISO) ? held[i] : 0), 0);
      if (Math.abs(residual - expectedHeld) <= SERIES_IDENTITY_TOLERANCE) { if (expectedHeld > 0) resting++; continue; }
    }
    const explained = unverifiable.length > 0 && (exact
      ? exact.some((s) => Math.abs(residual - s) <= SERIES_IDENTITY_TOLERANCE)
      : residual >= -SERIES_IDENTITY_TOLERANCE && residual <= heldTotal + SERIES_IDENTITY_TOLERANCE);
    if (explained) { resting++; if (writerFloorISOById) offFloor++; continue; }
    violations.push(unverifiable.length === 0
      ? `${r.dateISO} debt: stored ${r.debt.toFixed(2)} != replay ${replay.toFixed(2)}`
      : `${r.dateISO} debt: stored ${r.debt.toFixed(2)} != walked replay ${replay.toFixed(2)} ` +
        `(no held-flat subset of ${unverifiable.length} unverifiable account(s) explains ${round2(residual).toFixed(2)})`);
  }

  return {
    checked,
    violations,
    walkedAccountIds: walked.map((a) => a.id),
    unverifiableAccountIds: unverifiable.map((a) => a.id),
    rowsRestingOnUnverifiable: resting,
    rowsOffWriterFloor: offFloor,
  };
}
