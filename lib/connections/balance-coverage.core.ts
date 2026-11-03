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

// ── Fail CLOSED when the coverage read itself fails ──────────────────────────
//
// `null` means "nothing to cover" (no counted account): every change is
// comparable and every point is as-is. A FAILED read used to collapse into that
// same null — so a coverage outage silently re-enabled pre-floor points and
// cross-floor changes as facts. A failed read is now its own value: the points
// stay as they are but are UNVOUCHED, and every change claim is withheld with
// the unreadable reason (`changeComparability`). Client surfaces never receive
// it (they read BalanceCoverage | null), so their paths are unchanged.

/** A coverage read that FAILED — distinct from null ("nothing to cover"). */
export interface BalanceCoverageUnavailable { readonly unavailable: true }
export const BALANCE_COVERAGE_UNAVAILABLE: BalanceCoverageUnavailable = Object.freeze({ unavailable: true as const });
/** What a server-side coverage read yields: the floors, nothing to cover (null), or unavailable. */
export type BalanceCoverageRead = BalanceCoverage | BalanceCoverageUnavailable | null;

export function isBalanceCoverageUnavailable(cov: BalanceCoverageRead | undefined): cov is BalanceCoverageUnavailable {
  return !!cov && (cov as BalanceCoverageUnavailable).unavailable === true;
}

/** The floors when they were read; null for "nothing to cover" AND for unavailable (no floor is known). */
export function knownBalanceCoverage(cov: BalanceCoverageRead | undefined): BalanceCoverage | null {
  return !cov || isBalanceCoverageUnavailable(cov) ? null : cov;
}

/** The note every AI surface carries when the coverage read failed (owner wording, S2 sweep). */
export const BALANCE_COVERAGE_UNREADABLE_NOTE =
  "balance-history completeness could not be read — do not state changes or pre-history values";

/** Under a chart whose coverage could not be read (client BalanceCoverageNote). */
export const BALANCE_COVERAGE_UNREADABLE_CHART_NOTE =
  "Balance-history completeness couldn’t be read, so changes are withheld; earlier days may not include every account.";

/** The withheld-change wording when coverage could not be read (cards render it; the AI reads it). */
export const BALANCE_COVERAGE_UNREADABLE_MESSAGE =
  "Change unavailable: balance-history completeness could not be read";

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
export function balanceCoveredFromISO(covRead: BalanceCoverageRead, sides: readonly BalanceCoverageSide[]): string | null {
  const cov = knownBalanceCoverage(covRead);
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
export function partialCoverageLabel(covRead: BalanceCoverageRead, sides: readonly BalanceCoverageSide[], dateISO: string): string | null {
  const cov = knownBalanceCoverage(covRead);
  if (!cov) return null;
  const all = floorsFor(cov, sides);
  const missing = all.filter((f) => f > dateISO).length;
  if (missing === 0) return null;
  return `Partial: ${missing} of ${all.length} ${noun(sides, cov, all.length)} ${missing === 1 ? "has" : "have"} no balance history this far back`;
}

/** "Estimated: 1 of 4 debts held at today’s balance (no history)" — or null. */
export function estimatedCoverageLabel(covRead: BalanceCoverageRead, sides: readonly BalanceCoverageSide[], dateISO: string): string | null {
  const cov = knownBalanceCoverage(covRead);
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
  cov: BalanceCoverageRead,
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
export function balanceCoverageNote(covRead: BalanceCoverageRead, sides: readonly BalanceCoverageSide[], chartFromISO: string | null): string | null {
  const cov = knownBalanceCoverage(covRead);
  const from = balanceCoveredFromISO(cov, sides);
  if (!cov || !from || !chartFromISO || chartFromISO >= from) return null;
  const all = floorsFor(cov, sides);
  const missing = all.filter((f) => f > chartFromISO).length;
  const owed = sides.includes("liability") && cov.liabilityFloors.some((f) => f > chartFromISO);
  return `History is partial before ${fmtDay(from)}: ${missing} of ${all.length} ${noun(sides, cov, all.length)} ` +
    `${missing === 1 ? "has" : "have"} no balance history that far back, so earlier days don’t fully include ${missing === 1 ? "it" : "them"}` +
    `; ${owed ? "a missing debt isn’t $0 owed" : "a missing balance isn’t $0"}.`;
}

// ── PB-8b — a change is never measured across the coverage floor ─────────────
//
// PB-8 marks the days before the floor UNKNOWN on the chart, but a headline
// "↑ $X · Y% vs <date>" subtracts the opening day from the closing one: when the
// opening day is missing debts (counted as nothing), the difference is the
// missing debt arriving, not a change. The codebase's idiom for a comparison
// whose endpoint is not real is to WITHHOLD it and say why — the Wealth read
// model emits deltas "only when BOTH endpoints are real", the composition card
// says "Historical composition unavailable — no history before <date>", and the
// Debt hero defers its change to the chart when the bases differ. Moving the
// comparison silently to another day would disagree with the window the chart
// and the Compare To selector state, so it is withheld, never re-anchored.
//
// An ESTIMATED endpoint (a held-flat liability inside its floor) is comparable —
// both sides carry the same held value — but the change is labelled estimated.

export type ChangeComparability =
  | { state: "comparable" }
  | { state: "estimated" }
  | { state: "withheld"; coveredFromISO: string; message: string }
  /** The coverage read FAILED: no floor is known, so no change may be stated. */
  | { state: "withheld"; coveredFromISO: null; message: string; unreadable: true };

export interface ChangeEndpoints {
  /** The comparison (opening) day, YYYY-MM-DD. */
  fromISO:        string;
  /** The closing day, YYYY-MM-DD. */
  toISO:          string;
  /** The opening point is reconstructed (isEstimated) — not the live row. */
  fromEstimated?: boolean;
  toEstimated?:   boolean;
}

/** "Change unavailable: history is partial before Nov 2, 2026" — the one wording. */
export function changeUnavailableMessage(coveredFromISO: string): string {
  return `Change unavailable: history is partial before ${fmtDay(coveredFromISO)}`;
}

/** The label suffix an estimated comparison carries ("vs Jun 17, 2026 · estimated"). */
export const ESTIMATED_CHANGE_SUFFIX = " · estimated";

/**
 * Whether a change between two days of a series composed from `sides` may be
 * stated. Withheld when EITHER endpoint lies before the coverage floor (the
 * latest floor on those sides); estimated when an endpoint is a reconstructed
 * day that includes a held-flat liability; otherwise comparable. No coverage
 * (loading, nothing to cover) ⇒ comparable — byte-identical to
 * before PB-8b. A FAILED server read (BALANCE_COVERAGE_UNAVAILABLE) is withheld, never comparable.
 */
export function changeComparability(
  covRead: BalanceCoverageRead, sides: readonly BalanceCoverageSide[], e: ChangeEndpoints,
): ChangeComparability {
  // A FAILED read is never "comparable" for a series coverage governs (fail closed).
  // A series composed of neither cash nor debt (investments, crypto: sides = [])
  // was never gated by balance coverage, so an outage does not withhold it either.
  if (isBalanceCoverageUnavailable(covRead)) {
    if (sides.length === 0) return { state: "comparable" };
    return { state: "withheld", coveredFromISO: null, message: BALANCE_COVERAGE_UNREADABLE_MESSAGE, unreadable: true };
  }
  const cov = covRead;
  const from = balanceCoveredFromISO(cov, sides);
  if (!cov || !from) return { state: "comparable" };
  if (e.fromISO < from || e.toISO < from) {
    return { state: "withheld", coveredFromISO: from, message: changeUnavailableMessage(from) };
  }
  const est = (iso: string, estimated: boolean | undefined) => estimated === true && estimatedCoverageLabel(cov, sides, iso) !== null;
  if (est(e.fromISO, e.fromEstimated) || est(e.toISO, e.toEstimated)) return { state: "estimated" };
  return { state: "comparable" };
}

// ── PB-8c — the SAME rule, carried by the server-side change claims ──────────
//
// PB-8b gated the client heroes; the launcher card's 1M change, the AI
// snapshot changes (`canonicalChange` / `liabilitiesChange`, the AI history
// tool's `change` block) and the Daily Brief's `recentChanges` still subtracted
// across the floor. They now pass through `gateWindowChange`, which is
// `changeComparability` and nothing else: a withheld change becomes null plus a
// typed reason the consumer renders or discloses (the AI receives the reason
// string instead of the number); an estimated one keeps its figure, marked.

/** The typed reason a server-side change claim was withheld. Dates only. */
export interface WithheldChange {
  /** PARTIAL_BALANCE_HISTORY: crossed the floor. BALANCE_HISTORY_UNREADABLE: the coverage read failed. */
  reason:      "PARTIAL_BALANCE_HISTORY" | "BALANCE_HISTORY_UNREADABLE";
  /** YYYY-MM-DD — the coverage floor the comparison crossed; null when the coverage could not be read. */
  coveredFrom: string | null;
  /** The one wording (`changeUnavailableMessage`). */
  message:     string;
}

export function withheldChangeOf(g: ChangeComparability): WithheldChange | null {
  if (g.state !== "withheld") return null;
  return g.coveredFromISO === null
    ? { reason: "BALANCE_HISTORY_UNREADABLE", coveredFrom: null, message: g.message }
    : { reason: "PARTIAL_BALANCE_HISTORY", coveredFrom: g.coveredFromISO, message: g.message };
}

export interface GatedWindowChange<C> {
  /** The change, or null when withheld; `estimated: true` when an endpoint is estimated. */
  change:   (C & { estimated?: true }) | null;
  withheld: WithheldChange | null;
}

/**
 * Gate one already-computed window change. `openingISO` is the date of the
 * observation the change actually opened on (it may precede `fromDate` when the
 * series has a gap) — the earlier of the two is the one compared to the floor.
 * No coverage ⇒ the change unchanged; UNAVAILABLE ⇒ withheld (as `changeComparability`).
 */
export function gateWindowChange<C extends { fromDate: string; toDate: string }>(
  change: C | null,
  cov: BalanceCoverageRead,
  sides: readonly BalanceCoverageSide[],
  e: { openingISO?: string | null; fromEstimated?: boolean; toEstimated?: boolean } = {},
): GatedWindowChange<C> {
  if (!change) return { change: null, withheld: null };
  const fromISO = e.openingISO && e.openingISO < change.fromDate ? e.openingISO : change.fromDate;
  const g = changeComparability(cov, sides, {
    fromISO, toISO: change.toDate, fromEstimated: e.fromEstimated, toEstimated: e.toEstimated,
  });
  if (g.state === "withheld") return { change: null, withheld: withheldChangeOf(g) };
  if (g.state === "estimated") return { change: { ...change, estimated: true as const }, withheld: null };
  return { change, withheld: null };
}

/** Where a coverage read failed — named in the counts-only log line. */
export type BalanceCoverageSurface =
  | "ai-snapshot" | "ai-history-tool" | "space-launcher" | "daily-brief" | "client-data-health" | "data-health-route";

/**
 * The counts-only line logged when a coverage read FAILS and the change claims
 * are withheld (BALANCE_COVERAGE_UNAVAILABLE) (no ids, no amounts, no error text — an error message
 * can carry a query's values). Frequent failures would otherwise be silent.
 */
export function balanceCoverageLoadFailureLine(surface: BalanceCoverageSurface, failed: number, of: number): string {
  return `[balance-coverage] load failed surface=${surface} failed=${failed} of=${of}; coverage unavailable, change claims withheld`;
}
