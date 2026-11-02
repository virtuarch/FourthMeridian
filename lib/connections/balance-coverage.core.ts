/**
 * lib/connections/balance-coverage.core.ts  (PB-8 — owner ruling 2026-10-30, valuation coverage)
 *
 * Why a Space's debt / cash history is PARTIAL before a date, when the reason is
 * BALANCES (not prices — that is valuation-coverage.core.ts). Pure: no DB, no
 * clock; dates and counts only — no account id, name or balance leaves.
 *
 * ── The defect ───────────────────────────────────────────────────────────────
 * A stored SpaceSnapshot carries only aggregates. An account contributes to a
 * day only from its history floor; before it, the account is simply ABSENT, so
 * a mortgage connected yesterday reads as $0 owed on every earlier day and net
 * worth "drops" by the mortgage on its floor. The owner ruling: balance
 * completeness ≠ price coverage ≠ valuation coverage; interior gaps are
 * PARTIAL; never silently $0 / omitted.
 *
 * ── The floor ────────────────────────────────────────────────────────────────
 * Per account, THE coverage authority's DISPLAY floor
 * (account-coverage.core `displayFromISO`) — the same floor the historical
 * drill-down (getAccountBalancesOverWindow) already shows the account from. No
 * new floor semantics: a walked account (checking / savings / revolving card)
 * is covered from its posted ledger; an unwalkable one (installment loan,
 * mortgage, a card without a limit) has NO replay, so it is covered only from
 * its connection. Before that the stored series either omits it or holds it
 * flat — an estimate, not history — and both are partial.
 *
 * A held-flat account with a ZERO balance is not counted: its absence and its
 * flat value are the same number, so nothing is misstated.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * Liabilities = debt accounts; balance assets = checking + savings. Investments
 * and crypto already carry their own disclosures (position spine / price floor,
 * ValuationCoverageNote; the Investments slice's per-point coverage), and a
 * manual real asset's floor is its own first valuation anchor — none of them
 * is restated here.
 */

import type { AccountHistoricalCoverage, CoverageClass } from "@/lib/data/account-coverage.core";

export type BalanceCoverageSide = "asset" | "liability";

export interface BalanceCoverageAccountInput {
  side:           BalanceCoverageSide;
  coverageClass:  CoverageClass;
  /**
   * The day the account enters the stored series (YYYY-MM-DD), aligned with the
   * writer's floor (`writerAlignedFloorISO`).
   */
  floorISO:       string;
  /** Current balance — read only to drop a zero-balance held-flat account. Never returned. */
  balance:        number;
}

export interface BalanceCoverage {
  /** One floor per counted debt account, ascending. Dates only. */
  liabilityFloors: string[];
  /** One floor per counted checking / savings account, ascending. */
  assetFloors:     string[];
  /**
   * PB-8 — the floors of the counted debt accounts that are HELD FLAT (no walk:
   * a mortgage, a loan). On a historical day on/after such a floor the debt
   * includes an ESTIMATE (today's balance, no history), not a reconstruction.
   */
  estimatedLiabilityFloors: string[];
}

/**
 * ── The four states, on the existing vocabulary (owner rule 2026-11-02) ──────
 *   VERIFIED       observed            the live row (isEstimated=false)
 *   RECONSTRUCTED  derived             walked from posted tx back from the anchor
 *   ESTIMATED      estimated           held flat at today's balance inside its floor
 *   UNKNOWN        incomplete          before the floor — never $0, said as partial
 * The per-account resolver (accounts-asof.core resolveOne) already speaks these
 * tiers; this module carries the last two to the AGGREGATE chart points, where a
 * stored row has no per-account split: UNKNOWN ⇒ basis `unreliable` + "Partial"
 * line; ESTIMATED ⇒ basis `carried` ("latest estimate, carried forward") +
 * "Estimated" line. VERIFIED / RECONSTRUCTED points are untouched.
 */

/**
 * The day an account enters the stored series, from the coverage authority's
 * facts, aligned with the writer (computeAccountFloors):
 *   · a WALKED account (BALANCE_WALK) — its replay/display floor (posted ledger);
 *   · a HELD-FLAT account — its earliest posted transaction when that precedes
 *     connection, else its connection (PB-8: a held-flat liability is never
 *     floored at the epoch);
 *   · in a SHARED Space, never before the account was linked in.
 */
export function writerAlignedFloorISO(
  cov: AccountHistoricalCoverage, coverageClass: CoverageClass, connectionFloorISO: string, linkISO: string, isShared: boolean,
): string {
  const base = coverageClass === "HELD_FLAT" ? (cov.existenceFromISO ?? connectionFloorISO) : cov.displayFromISO;
  return isShared && linkISO > base ? linkISO : base;
}

/** The account types each side counts. Every other type is out of scope (see header). */
export function balanceCoverageSideOf(type: string): BalanceCoverageSide | null {
  if (type === "debt") return "liability";
  if (type === "checking" || type === "savings") return "asset";
  return null;
}

export function deriveBalanceCoverage(inputs: readonly BalanceCoverageAccountInput[]): BalanceCoverage | null {
  const counted = inputs.filter((i) => !(i.coverageClass === "HELD_FLAT" && i.balance === 0));
  if (!counted.length) return null;
  const floors = (side: BalanceCoverageSide) => counted.filter((i) => i.side === side).map((i) => i.floorISO).sort();
  return {
    liabilityFloors: floors("liability"),
    assetFloors: floors("asset"),
    estimatedLiabilityFloors: counted.filter((i) => i.side === "liability" && i.coverageClass === "HELD_FLAT").map((i) => i.floorISO).sort(),
  };
}

/** The Net Worth page's series (WealthMetricKey) → which sides its value is composed from. */
export function balanceCoverageSidesFor(metric: string): readonly BalanceCoverageSide[] {
  switch (metric) {
    case "netWorth":
    case "liquidNetWorth":   return ["asset", "liability"];
    case "totalAssets":
    case "cash":             return ["asset"];
    case "totalLiabilities": return ["liability"];
    default:                 return []; // invested: neither cash nor debt
  }
}

function floorsFor(cov: BalanceCoverage, sides: readonly BalanceCoverageSide[]): string[] {
  return [
    ...(sides.includes("liability") ? cov.liabilityFloors : []),
    ...(sides.includes("asset") ? cov.assetFloors : []),
  ];
}

/**
 * The first day every counted account on these sides is covered — the LATEST
 * floor — or null when there is nothing to cover.
 */
export function balanceCoveredFromISO(cov: BalanceCoverage | null, sides: readonly BalanceCoverageSide[]): string | null {
  if (!cov) return null;
  const all = floorsFor(cov, sides);
  return all.length ? [...all].sort().at(-1)! : null;
}

function noun(sides: readonly BalanceCoverageSide[], cov: BalanceCoverage, n: number): string {
  const both = sides.includes("liability") && sides.includes("asset") && cov.liabilityFloors.length > 0 && cov.assetFloors.length > 0;
  const word = both ? "account" : sides.includes("liability") && cov.liabilityFloors.length > 0 ? "debt" : "cash account";
  return n === 1 ? word : `${word}s`;
}

/** "Partial: 1 of 3 debts has no balance history this far back" — the tooltip's coverage line for one day. */
export function partialCoverageLabel(cov: BalanceCoverage | null, sides: readonly BalanceCoverageSide[], dateISO: string): string | null {
  if (!cov) return null;
  const all = floorsFor(cov, sides);
  const missing = all.filter((f) => f > dateISO).length;
  if (missing === 0) return null;
  return `Partial: ${missing} of ${all.length} ${noun(sides, cov, all.length)} ${missing === 1 ? "has" : "have"} no balance history this far back`;
}

/** "Estimated: 1 of 4 debts held at today’s balance (no history)" — or null. */
export function estimatedCoverageLabel(cov: BalanceCoverage | null, sides: readonly BalanceCoverageSide[], dateISO: string): string | null {
  if (!cov || !sides.includes("liability")) return null;
  const n = cov.estimatedLiabilityFloors.filter((f) => f <= dateISO).length;
  if (n === 0) return null;
  const total = cov.liabilityFloors.length;
  return `Estimated: ${n} of ${total} ${total === 1 ? "debt" : "debts"} held at today’s balance (no history)`;
}

/**
 * Carry UNKNOWN and ESTIMATED to the aggregate points, with the existing idioms:
 *   · before the coverage floor (some account not yet in the series): basis
 *     `unreliable` (dotted, unfilled, "low confidence") + the "Partial" line —
 *     the same pair the Investments slice uses for "N of M positions valued";
 *   · on/after it, a RECONSTRUCTED point that includes a held-flat liability:
 *     basis `carried` ("latest estimate, carried forward") + the "Estimated" line.
 * The VALUE is never changed: a gap we cannot fill is said, not filled. An
 * observed point (the live row) is the verified balance and is never relabelled
 * estimated; an explicit caller basis (e.g. RWA `modeled`) is kept, its line added.
 */
export function markPartialBalanceCoverage<P extends { date: string; estimated?: boolean; basis?: "unreliable" | "carried" | (string & {}); coverageLabel?: string | null }>(
  points: readonly P[],
  cov: BalanceCoverage | null,
  sides: readonly BalanceCoverageSide[],
): P[] {
  const from = balanceCoveredFromISO(cov, sides);
  if (!from) return points.slice();
  return points.map((p) => {
    if (p.date < from) return { ...p, basis: "unreliable", coverageLabel: partialCoverageLabel(cov, sides, p.date) } as P;
    if (p.estimated !== true) return p;
    const est = estimatedCoverageLabel(cov, sides, p.date);
    if (!est) return p;
    return { ...p, ...(p.basis === undefined || p.basis === "reconstructed" ? { basis: "carried" } : {}), coverageLabel: est } as P;
  });
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The one sentence under the chart, or null. Shown only when the plotted window
 * starts before the coverage floor. Counts only the accounts whose floor falls
 * inside the window — the ones actually missing from its earliest day.
 */
export function balanceCoverageNote(cov: BalanceCoverage | null, sides: readonly BalanceCoverageSide[], chartFromISO: string | null): string | null {
  const from = balanceCoveredFromISO(cov, sides);
  if (!cov || !from || !chartFromISO || chartFromISO >= from) return null;
  const all = floorsFor(cov, sides);
  const missing = all.filter((f) => f > chartFromISO).length;
  const owed = sides.includes("liability") && cov.liabilityFloors.some((f) => f > chartFromISO);
  return `History is partial before ${fmtDay(from)}: ${missing} of ${all.length} ${noun(sides, cov, all.length)} ` +
    `${missing === 1 ? "has" : "have"} no balance history that far back, so earlier days don’t fully include ${missing === 1 ? "it" : "them"}` +
    `; ${owed ? "a missing debt isn’t $0 owed" : "a missing balance isn’t $0"}.`;
}
