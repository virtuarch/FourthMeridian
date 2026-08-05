/**
 * lib/balances/reachable.ts   (v2.6-L3 — RECONCILIATION)
 *
 * How a liquidity surface totals reachable cash. Pure: no DB, no React, no clock.
 *
 * This exists so the RULE — which accounts count, and what an unknown does —
 * lives in the authority rather than being re-decided by each widget. Callers
 * convert amounts into the display currency first (FX is a separate layer) and
 * hand the converted figures here.
 *
 * ── The rule, and why an unknown is not a zero ──────────────────────────────
 *
 * A cash account with no reachable figure is EXCLUDED from the total and
 * COUNTED, so the surface can say "of 4 accounts, 1 could not be established"
 * instead of quietly summing it as zero. Silently contributing 0 would understate
 * reachable cash; silently contributing its ledger balance would overstate it by
 * exactly the amount this slice exists to stop overstating.
 */

/** One cash account's already-converted reachable figure. */
export interface ReachableInput {
  accountId: string;
  /** Reachable cash in the DISPLAY currency, or null when it could not be established. */
  reachable: number | null;
  /** The positive unexplained hold on this account, or null. */
  unexplained: number | null;
}

export interface ReachableTotal {
  /** Σ over accounts that HAVE a reachable figure. Never includes an unknown. */
  total: number;
  /** How many cash accounts contributed. */
  coveredCount: number;
  /** How many cash accounts could not be established. */
  unknownCount: number;
  /** Σ of POSITIVE unexplained holds — money held back that nothing explains. */
  unexplainedTotal: number;
  /** True when every cash account contributed a figure. */
  complete: boolean;
}

export function totalReachableCash(rows: ReachableInput[]): ReachableTotal {
  let total = 0, coveredCount = 0, unknownCount = 0, unexplainedTotal = 0;
  for (const r of rows) {
    if (r.reachable === null) unknownCount++;
    else { total += r.reachable; coveredCount++; }
    // Only POSITIVE residuals are "held back". A negative residual is the
    // provider claiming more than our evidence supports — a contradiction, which
    // is reported per-account and must not be netted against real holds here.
    if (r.unexplained !== null && r.unexplained > 0) unexplainedTotal += r.unexplained;
  }
  return { total, coveredCount, unknownCount, unexplainedTotal, complete: unknownCount === 0 };
}

/**
 * The sentence a surface shows when reachable cash is not the whole story.
 * Null when there is nothing to disclose. Amounts are formatted by the caller —
 * this owns the WORDING, which is the part that makes the claim.
 */
export function reachableDisclosure(
  t: ReachableTotal,
  formatMoney: (n: number) => string,
): string | null {
  const parts: string[] = [];
  if (t.unexplainedTotal > 0) {
    parts.push(`${formatMoney(t.unexplainedTotal)} unavailable but not yet explained by transactions`);
  }
  if (t.unknownCount > 0) {
    parts.push(
      `${t.unknownCount} account${t.unknownCount === 1 ? "" : "s"} with no reachable figure — excluded`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
