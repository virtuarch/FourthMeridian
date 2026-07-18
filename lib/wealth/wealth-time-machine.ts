/**
 * lib/wealth/wealth-time-machine.ts
 *
 * Wealth Perspective read model (A6 completion). PURE, deterministic, no I/O:
 * it derives the historical Wealth answer from the already-fetched SpaceSnapshot
 * series plus the shell-owned shared context (as-of date, optional comparison
 * date, shared range). The presentation components render this result; nothing
 * here touches Prisma, the network, or the clock beyond the injected `today`.
 *
 * Doctrine: shared shell state → THIS read model → Wealth presentation. It
 * introduces no new snapshot regeneration, no valuation, no pricing, no
 * reconstruction — every number is a field already present on SpaceSnapshot (the
 * repository's earned historical record). Point-in-time answers resolve at the
 * nearest snapshot ≤ the as-of date (the getSnapshotAsOf semantics, applied
 * client-side over the same series the charts read). The shared range only
 * windows the historical chart; it never redefines the point-in-time cards.
 *
 * Honesty rules enforced here:
 *  - a date before coverage returns a shaped incomplete state, never zeros
 *    dressed as an observation;
 *  - `isEstimated` snapshots surface as "Reconstructed", never "Observed";
 *  - fx-missed points (mixed-unit) are dropped from the series, matching the
 *    existing hero/chart reads;
 *  - deltas and the change story appear only when BOTH endpoints are real;
 *  - drivers are real snapshot component deltas — never invented attribution.
 */

import { formatCurrency } from "@/lib/format";
import { nearestOnOrBefore } from "@/lib/data/nearest-on-or-before";
import { wealthBasisDisclosure, type WealthBasisDisclosure } from "@/lib/wealth/basis-disclosure";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import type { Snapshot } from "@/types";

// ── Result shapes ─────────────────────────────────────────────────────────────

export interface WealthMetrics {
  netWorth:         number;
  totalAssets:      number;
  totalLiabilities: number;
  liquidNetWorth:   number;
}

export interface WealthComposition {
  cash:        number;
  investments: number;
  crypto:      number;
  real:        number;
  liabilities: number;
}

/** Sub-dollar noise floor — a value at/below this never renders as a category. */
export const WEALTH_EPSILON = 0.5;

/**
 * User-facing category labels — the single source of copy for composition slices,
 * legend rows, driver rows, and story text. Presentation only (never persisted);
 * backend enums/columns are unchanged.
 */
export const WEALTH_CATEGORY_LABELS: Record<keyof WealthComposition, string> = {
  cash:        "Cash",
  investments: "Investments",
  crypto:      "Crypto",
  real:        "Real World Assets",
  liabilities: "Liabilities",
};

export interface WealthCompositionItem {
  id:    keyof WealthComposition;
  label: string;
  value: number;
}

/**
 * Asset-class composition items for the doughnut/legend — Cash, Investments,
 * Crypto, Real World Assets — with every category whose value is at/below the
 * monetary epsilon omitted (no zero slices, no zero legend rows, no reserved
 * colors). Liabilities are intentionally excluded here (assets-only doughnut).
 */
export function wealthCompositionItems(c: WealthComposition): WealthCompositionItem[] {
  return (["cash", "investments", "crypto", "real"] as const)
    .map((id) => ({ id, label: WEALTH_CATEGORY_LABELS[id], value: c[id] }))
    .filter((i) => i.value > WEALTH_EPSILON);
}

export interface WealthState extends WealthMetrics {
  /** True when a snapshot on or before the requested date exists. */
  found:       boolean;
  /** The resolved snapshot's date (YYYY-MM-DD), or null when none ≤ requested. */
  date:        string | null;
  isEstimated: boolean;
  composition: WealthComposition;
}

export interface WealthDelta {
  abs: number;
  /** Percent vs the comparison value; null when the denominator is 0/invalid. */
  pct: number | null;
}

export interface WealthChartPoint extends WealthMetrics {
  date:        string;
  isEstimated: boolean;
}

export interface WealthDriver {
  id:    string;
  label: string;
  /** Signed change (as-of − comparison) for this composition component. */
  delta: number;
}

export interface WealthDeltas {
  netWorth:         WealthDelta;
  totalAssets:      WealthDelta;
  totalLiabilities: WealthDelta;
  liquidNetWorth:   WealthDelta;
  composition:      WealthComposition; // signed component deltas (as-of − comparison)
}

export interface WealthResult {
  asOf:         string;
  compareTo:    string | null;
  hasHistory:   boolean;
  coverageFrom: string | null;
  asOfState:    WealthState;
  compareState: WealthState | null;
  deltas:       WealthDeltas | null;
  drivers:      WealthDriver[] | null;
  chart: {
    points:      WealthChartPoint[];
    /**
     * The comparison overlay: the equal-length window ENDING at compareTo
     * ([compareTo − (asOf − compareTo), compareTo]), so the chart can superimpose
     * the prior period's shape onto the primary window. Empty when there is no
     * comparison, no points in the window, or the window precedes coverage — never
     * padded or interpolated.
     */
    compareSeries: WealthChartPoint[];
    asOfDate:    string | null;
    compareDate: string | null;
  };
  completeness: { tier: CompletenessTier; label: string; tone: "neutral" | "positive" | "warning" };
  evidence:     { label: string } | null;
  /** Deterministic, template-based Wealth Explanation (Amendment 10). No LLM. */
  explanation:  string | null;
  /**
   * HIST-2E — today/history valuation-basis disclosure. Present ONLY when the
   * visible chart mixes an observed (live today) point with reconstructed history,
   * i.e. where the two bases can legitimately differ. Surfaces the WHY; changes no
   * number. Null otherwise.
   */
  basis:        WealthBasisDisclosure | null;
}

export interface WealthTimeMachineInput {
  snapshots: Snapshot[];
  asOf:      string;                 // YYYY-MM-DD — the point-in-time state date
  compareTo: string | null;         // YYYY-MM-DD — the comparison / chart range start
  currency:  string;                 // display currency for composed copy
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

const EPS = WEALTH_EPSILON; // sub-dollar noise floor for driver/story inclusion

/** A snapshot's Wealth metrics + composition (all fields already on the row). */
function toState(s: Snapshot): Omit<WealthState, "found"> {
  const cash        = s.totalCash + s.totalSavings;
  const investments = s.totalInvestments;
  const crypto      = s.totalCrypto;
  const real        = Math.max(0, s.totalAssets - cash - investments - crypto);
  const liabilities = s.totalDebt;
  return {
    date:           s.date,
    isEstimated:    s.isEstimated ?? false,
    netWorth:       s.netWorth,
    totalAssets:    s.totalAssets,
    totalLiabilities: liabilities,
    liquidNetWorth: s.totalCash + s.totalSavings - s.totalDebt,
    composition:    { cash, investments, crypto, real, liabilities },
  };
}

const EMPTY_STATE: WealthState = {
  found: false, date: null, isEstimated: false,
  netWorth: 0, totalAssets: 0, totalLiabilities: 0, liquidNetWorth: 0,
  composition: { cash: 0, investments: 0, crypto: 0, real: 0, liabilities: 0 },
};

/** A snapshot → chart point (all four metric series + the estimated flag). */
function toChartPoint(s: Snapshot): WealthChartPoint {
  const st = toState(s);
  return {
    date: s.date, isEstimated: st.isEstimated,
    netWorth: st.netWorth, totalAssets: st.totalAssets,
    totalLiabilities: st.totalLiabilities, liquidNetWorth: st.liquidNetWorth,
  };
}

const MS_PER_DAY = 86_400_000;
function daysBetweenIso(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / MS_PER_DAY);
}
function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Nearest snapshot on or before `date` (getSnapshotAsOf semantics, client-side)
 * via the shared HIST-1B primitive. `sorted` is ascending with unique dates
 * (one SpaceSnapshot per date), so the greatest-date-≤ pick equals the original
 * last-match-wins scan; `preferOnTie: always-replace` reproduces that exactly
 * even were two rows to share a date.
 */
function resolveState(sorted: Snapshot[], date: string): WealthState {
  const picked = nearestOnOrBefore(sorted, date, (s) => s.date, { preferOnTie: () => true });
  return picked ? { ...toState(picked), found: true } : EMPTY_STATE;
}

function delta(asOf: number, compare: number): WealthDelta {
  const abs = asOf - compare;
  const pct = compare !== 0 ? (abs / Math.abs(compare)) * 100 : null;
  return { abs, pct };
}

/** "Jan 1, 2025" — UTC-stable (the date is date-only). */
export function formatWealthDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function computeWealthTimeMachine(input: WealthTimeMachineInput): WealthResult {
  const { asOf, compareTo, currency } = input;
  const fmt = (n: number) => formatCurrency(n, currency);

  // Drop mixed-unit fx-miss points (the hero/chart reads drop these too), then
  // sort ascending so "nearest ≤ date" is a single linear pass.
  const series = input.snapshots
    .filter((s) => !s.fxMiss)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  const hasHistory   = series.length > 0;
  const coverageFrom = hasHistory ? series[0].date : null;

  const asOfState    = resolveState(series, asOf);
  const compareState = compareTo ? resolveState(series, compareTo) : null;

  // Deltas + drivers only when BOTH endpoints are real observations/derivations.
  let deltas: WealthDeltas | null = null;
  let drivers: WealthDriver[] | null = null;
  if (asOfState.found && compareState?.found) {
    const c = compareState;
    deltas = {
      netWorth:         delta(asOfState.netWorth, c.netWorth),
      totalAssets:      delta(asOfState.totalAssets, c.totalAssets),
      totalLiabilities: delta(asOfState.totalLiabilities, c.totalLiabilities),
      liquidNetWorth:   delta(asOfState.liquidNetWorth, c.liquidNetWorth),
      composition: {
        cash:        asOfState.composition.cash        - c.composition.cash,
        investments: asOfState.composition.investments - c.composition.investments,
        crypto:      asOfState.composition.crypto      - c.composition.crypto,
        real:        asOfState.composition.real        - c.composition.real,
        liabilities: asOfState.composition.liabilities - c.composition.liabilities,
      },
    };
    drivers = (Object.keys(WEALTH_CATEGORY_LABELS) as (keyof WealthComposition)[])
      .map((id) => ({ id, label: WEALTH_CATEGORY_LABELS[id], delta: deltas!.composition[id] }))
      .filter((d) => Math.abs(d.delta) > EPS)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

  // Chart series is the Compare To → As Of window (shell §8). With no comparison
  // (or ALL without a coverage date) it falls back to full history up to As Of.
  // Point-in-time cards ignore this window — they always use As Of.
  const startBound = compareTo ?? coverageFrom ?? "0000-01-01";
  const points: WealthChartPoint[] = series
    .filter((s) => s.date >= startBound && s.date <= asOf)
    .map(toChartPoint);

  // Compare overlay: the equal-length window ending at Compare To, so the two
  // period shapes superimpose. Empty unless the full window is real + within
  // coverage — never a truncated or padded overlay (S5 honesty rule).
  let compareSeries: WealthChartPoint[] = [];
  if (compareTo) {
    const windowDays = daysBetweenIso(compareTo, asOf);
    const compareStart = addDaysIso(compareTo, -windowDays);
    if (!coverageFrom || compareStart >= coverageFrom) {
      compareSeries = series.filter((s) => s.date >= compareStart && s.date <= compareTo).map(toChartPoint);
    }
  }

  // Completeness — canonical tier + friendly, shell-ready copy.
  const completeness: WealthResult["completeness"] = !asOfState.found
    ? { tier: "incomplete", label: coverageFrom ? `No history before ${formatWealthDate(coverageFrom)}` : "No history yet", tone: "warning" }
    : asOfState.isEstimated
      ? { tier: "derived", label: "Reconstructed", tone: "neutral" }
      : { tier: "observed", label: "Observed", tone: "positive" };

  // Evidence — real provenance only (snapshot count); omit when there is none.
  const evidence = hasHistory
    ? { label: `${series.length} snapshot${series.length === 1 ? "" : "s"}` }
    : null;

  // Explanation — deterministic, template-driven, only supported facts (§4.5).
  let explanation: string | null = null;
  if (deltas && compareState?.date) {
    const nw = deltas.netWorth.abs;
    const nwDir = nw >= 0 ? "increased" : "decreased";
    const parts = [`Your net worth ${nwDir} by ${fmt(Math.abs(nw))} since ${formatWealthDate(compareState.date)}.`];
    const aAbs = deltas.totalAssets.abs;
    const lAbs = deltas.totalLiabilities.abs;
    if (Math.abs(aAbs) > EPS || Math.abs(lAbs) > EPS) {
      const aClause = `Assets ${aAbs >= 0 ? "increased" : "decreased"} by ${fmt(Math.abs(aAbs))}`;
      const lClause = `liabilities ${lAbs <= 0 ? "decreased" : "increased"} by ${fmt(Math.abs(lAbs))}`;
      parts.push(`${aClause} and ${lClause}.`);
    }
    explanation = parts.join(" ");
  }

  // HIST-2E — basis disclosure, from the VISIBLE chart window: shown only when an
  // observed (live today) point and a reconstructed point are both plotted, i.e.
  // where the two valuation bases can legitimately differ.
  const basis = wealthBasisDisclosure({
    hasObserved:      points.some((p) => !p.isEstimated),
    hasReconstructed: points.some((p) => p.isEstimated),
  });

  return {
    asOf, compareTo, hasHistory, coverageFrom,
    asOfState, compareState, deltas, drivers,
    chart: { points, compareSeries, asOfDate: asOfState.date, compareDate: compareState?.date ?? null },
    completeness, evidence, explanation, basis,
  };
}
