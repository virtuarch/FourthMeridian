/**
 * lib/transactions/canonical-spending.ts
 *
 * THE CANONICAL RECENT-SPENDING BASELINE — which months, and what each one counts as.
 *
 * ── The owner's definition (2026-10-04) ─────────────────────────────────────
 *   · the trailing 3 COMPLETE calendar months strictly before the as-of month
 *     (asOf 2026-10-04 → Jul, Aug, Sep; asOf 2026-09-30 → Jun, Jul, Aug);
 *   · the current month is never complete, including on its last day;
 *   · NET of refunds, by the one economic clamp (`clampEconomicSpend`);
 *   · a complete month with no qualifying spending is $0 IN THE AVERAGE;
 *   · fewer months of history ⇒ average what exists and SAY how many; none ⇒ refuse.
 *
 * ⚠️ THE FAILURE THIS EXISTS FOR. `WINDOW_MONTHS = 3` was a CAP over the reliable
 * months of the assembler's 90-day ROLLING read, and a 90-day read starting on any
 * day but the 1st clips its first month. Enumerated over 2026: 356 of 365 days gave
 * TWO months, nine gave three (mostly month-ends, where the in-progress month was
 * counted complete). Every surface — the scenario spine, Net Worth/Assets coverage,
 * the runway grade, the Daily Brief, get_baselines — averaged Aug+Sep while
 * believing it averaged three months. The window was decided by a read length
 * upstream of the authority; here the authority decides it, from the as-of date.
 *
 * ⚠️ NOT A MEASUREMENT. "What did I average over the last 2 / 6 / 12 months" is
 * `measure_flows` / `get_baselines.measuredSpending.byWindow` and is untouched by
 * this module. A measurement never becomes the baseline, and the baseline never
 * becomes a scenario assumption the user did not state.
 *
 * ⚠️ PURE. No clock, no DB. The as-of date and the read are arguments.
 */
import type { MonthlyBreakdownEntry, TransactionsSummaryData } from '@/lib/ai/types';
import { resolvePeriod } from '@/lib/ai/measures/period';
import { meanMonthlyEconomicSpend, type MonthlyEconomicSpend } from './cash-flow';

/** THE one place the baseline's length lives. Change the policy here and nowhere else. */
export const CANONICAL_SPENDING_MONTHS = 3;

export interface CanonicalSpendingWindow {
  /** The as-of date the window was resolved from. */
  asOf: string;
  /** First day of the oldest month. */
  from: string;
  /** Last day of the newest month — always before `asOf`'s month. */
  to: string;
  /** `YYYY-MM`, oldest first, exactly CANONICAL_SPENDING_MONTHS of them. */
  months: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The last day of the month before `asOf`'s month. */
function endOfPreviousMonth(asOfISO: string): string {
  const y = Number(asOfISO.slice(0, 4)), m = Number(asOfISO.slice(5, 7));
  // Day 0 of this month is the last day of the previous one.
  const d = new Date(Date.UTC(y, m - 1, 0));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Every `YYYY-MM` from `from` to `to`, inclusive. */
function monthsBetween(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  let y = Number(fromISO.slice(0, 4)), m = Number(fromISO.slice(5, 7));
  const end = toISO.slice(0, 7);
  for (;;) {
    const ym = `${y}-${pad(m)}`;
    out.push(ym);
    if (ym >= end) break;
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * The canonical window for an as-of date.
 *
 * ⚠️ THROUGH THE PERIOD AUTHORITY, WITH THE CEILING MOVED, NOT REDEFINED.
 * `resolvePeriod({completeMonths})` treats a month-end ceiling as closing its own
 * month — right for a measurement over data that runs THROUGH that day, wrong for
 * "today": on 09-30 September has not finished. Handing it the last day of the
 * PREVIOUS month makes the as-of month incomplete by construction, without
 * touching how any measurement resolves.
 */
export function canonicalSpendingWindow(asOfISO: string): CanonicalSpendingWindow {
  const p = resolvePeriod({ completeMonths: CANONICAL_SPENDING_MONTHS }, endOfPreviousMonth(asOfISO));
  return { asOf: asOfISO, from: p.from, to: p.to, months: monthsBetween(p.from, p.to) };
}

/** Why a canonical month was not averaged. Every exclusion is disclosed, never silent. */
export type CanonicalMonthExclusion =
  /** The month opens before the Space's transaction history begins. */
  | 'BEFORE_HISTORY'
  /** The month opens after the last transaction the Space has on or before as-of. */
  | 'AFTER_HISTORY'
  /** The read did not cover the whole month (a clipped edge). */
  | 'PARTIAL'
  /** The fetch cap dropped some of the month's rows (KD-7). */
  | 'TRUNCATED';

export interface CanonicalSpendingCoverage {
  /** First and last day the read covered. */
  readFrom: string;
  readTo: string;
  /**
   * The Space's transaction history bounds on or before as-of
   * (`transactionCorpusSpan`). `null` ⇒ no history at all ⇒ every month excluded.
   */
  historyFrom: string | null;
  historyTo: string | null;
}

export interface CanonicalSpendingSelection<M extends MonthlyBreakdownEntry = MonthlyBreakdownEntry> {
  window: CanonicalSpendingWindow;
  /** The months averaged, oldest first. A month with no rows is a ZERO entry, flagged. */
  months: M[];
  /** Of `months`, those with no rows at all — counted as $0, by the owner's rule. */
  zeroMonths: string[];
  excluded: { month: string; reason: CanonicalMonthExclusion }[];
}

/** A month in which nothing was recorded: every figure zero, nothing partial. */
export function zeroMonth(month: string): MonthlyBreakdownEntry {
  return {
    month, incomeTotal: 0, expenseTotal: 0, refundTotal: 0, debtPaymentTotal: 0,
    transferTotal: 0, transactionCount: 0, estimated: false, partial: false, truncated: false,
    byCategory: [],
  };
}

const firstDay = (ym: string) => `${ym}-01`;
const lastDay = (ym: string) => {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};

/**
 * Which of the canonical months to average, from any monthly breakdown.
 *
 * ⚠️ A MONTH WITH NO ROWS IS $0 ONLY WHEN WE KNOW IT HAD NONE. That needs both the
 * read to have covered the whole month and the Space's history to span it. Inside
 * history a missing month is a real zero (owner decision: the baseline averages
 * three CALENDAR months, not the months that happened to have transactions);
 * outside it, the month is not available and is excluded — which is the
 * fewer-than-three fallback, disclosed by count.
 *
 * ⚠️ A ROW'S PRESENCE OUTRANKS THE HISTORY BOUNDS. A month the read returned
 * reliable rows for is averaged even if it begins before `historyFrom` — the
 * bounds are only consulted to decide what an ABSENT month means.
 */
export function selectCanonicalSpendingMonths<M extends MonthlyBreakdownEntry>(
  breakdown: readonly M[],
  window: CanonicalSpendingWindow,
  coverage: CanonicalSpendingCoverage,
  zero: (month: string) => M = zeroMonth as (month: string) => M,
): CanonicalSpendingSelection<M> {
  const byMonth = new Map(breakdown.map((m) => [m.month, m]));
  const months: M[] = [];
  const zeroMonths: string[] = [];
  const excluded: CanonicalSpendingSelection['excluded'] = [];
  for (const ym of window.months) {
    const row = byMonth.get(ym);
    if (row) {
      if (row.truncated) { excluded.push({ month: ym, reason: 'TRUNCATED' }); continue; }
      if (row.partial) { excluded.push({ month: ym, reason: 'PARTIAL' }); continue; }
      months.push(row);
      continue;
    }
    if (coverage.historyFrom === null || firstDay(ym) < coverage.historyFrom) {
      excluded.push({ month: ym, reason: 'BEFORE_HISTORY' }); continue;
    }
    if (coverage.historyTo !== null && firstDay(ym) > coverage.historyTo) {
      excluded.push({ month: ym, reason: 'AFTER_HISTORY' }); continue;
    }
    if (coverage.readFrom > firstDay(ym) || coverage.readTo < lastDay(ym)) {
      excluded.push({ month: ym, reason: 'PARTIAL' }); continue;
    }
    months.push(zero(ym));
    zeroMonths.push(ym);
  }
  return { window, months, zeroMonths, excluded };
}

/** The baseline, its months and its basis — the one shape every surface discloses. */
export interface CanonicalSpendingBaseline {
  window: CanonicalSpendingWindow;
  /** Mean NET economic spend per month over `months`; null when no month is available. */
  monthly: number | null;
  /** The net/gross/refund breakdown, per month — `meanMonthlyEconomicSpend` verbatim. */
  economics: MonthlyEconomicSpend | null;
  /** The months averaged, oldest first. */
  months: string[];
  monthCount: number;
  zeroMonths: string[];
  excluded: { month: string; reason: CanonicalMonthExclusion }[];
  basis: 'NET_OF_REFUNDS';
  /** "Jul–Sep 2026 (3 complete months)" — derived, never supplied. */
  label: string;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (ym: string) => `${MONTH_ABBR[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** "Jul–Sep 2026", "Dec 2025–Feb 2026", "Sep 2026". */
export function monthRangeLabel(months: readonly string[]): string {
  if (months.length === 0) return 'no complete months';
  const a = months[0], b = months[months.length - 1];
  if (a === b) return monthName(a);
  return a.slice(0, 4) === b.slice(0, 4)
    ? `${MONTH_ABBR[Number(a.slice(5, 7)) - 1]}–${monthName(b)}`
    : `${monthName(a)}–${monthName(b)}`;
}

/** The baseline over a selection. NET by the one clamp; nothing re-derived. */
export function canonicalSpendingBaseline(selection: CanonicalSpendingSelection): CanonicalSpendingBaseline {
  const economics = meanMonthlyEconomicSpend(selection.months);
  const months = selection.months.map((m) => m.month);
  const n = months.length;
  return {
    window: selection.window,
    monthly: economics?.net ?? null,
    economics,
    months,
    monthCount: n,
    zeroMonths: selection.zeroMonths,
    excluded: selection.excluded,
    basis: 'NET_OF_REFUNDS',
    label: n === 0 ? 'no complete month of spending is available'
      : `${monthRangeLabel(months)} (${n} complete month${n === 1 ? '' : 's'})`,
  };
}

// ── The read ────────────────────────────────────────────────────────────────

/** What a canonical read produced: the baseline, and the months behind it. */
export interface CanonicalSpendingRead {
  baseline: CanonicalSpendingBaseline;
  /**
   * The averaged months as the monthly fold produced them (zero entries for months
   * with no rows). Income and debt payments printed beside the baseline average
   * over THESE months, so every "monthly" figure on a surface shares one population.
   */
  months: MonthlyBreakdownEntry[];
}

/** The coverage a summary's own bounds imply, for a read over `window`. */
export function coverageOfRead(
  summary: Pick<TransactionsSummaryData, 'startDate' | 'truncated' | 'coverageStartDate'> | null,
  window: Pick<CanonicalSpendingWindow, 'from' | 'to'>,
  history: { from: string | null; to: string | null },
): CanonicalSpendingCoverage {
  // ⚠️ A TRUNCATED READ COVERS ONLY FROM ITS OLDEST KEPT ROW. A month older than
  // that has no bucket because its rows were DROPPED, not because it had none;
  // zero-filling it would be the cap pretending to be a fact.
  const floor = summary
    ? (summary.truncated && summary.coverageStartDate ? summary.coverageStartDate : summary.startDate)
    : window.from;
  return {
    readFrom: floor > window.from ? floor : window.from,
    readTo: window.to,
    historyFrom: history.from,
    historyTo: history.to,
  };
}

/**
 * Read the canonical months for an as-of date and resolve the baseline.
 *
 * ⚠️ AN EXPLICIT CALENDAR WINDOW, NEVER THE ASSESSMENT WINDOW. The read is exactly
 * [first day of the oldest month, last day of the newest], so the fold marks no
 * month partial unless the fetch cap bit. The 90-day assessment window, the
 * activity frame and every measurement window are untouched.
 *
 * The two reads are the caller's, under the caller's database authority.
 */
export async function readCanonicalSpending(args: {
  asOf: string;
  readWindow: (w: { startDate: string; endDate: string; label: string }) => Promise<TransactionsSummaryData | null>;
  readHistory: (asOf: string) => Promise<{ from: string | null; to: string | null }>;
}): Promise<CanonicalSpendingRead> {
  const window = canonicalSpendingWindow(args.asOf);
  // ⚠️ SEQUENTIAL, NOT Promise.all: both reads may run on ONE interactive
  // transaction (a tenant phase), which does not take concurrent queries.
  const summary = await args.readWindow({ startDate: window.from, endDate: window.to,
    label: `canonical spending baseline as of ${args.asOf}` });
  const history = await args.readHistory(args.asOf);
  const selection = selectCanonicalSpendingMonths(summary?.monthlyBreakdown ?? [], window,
    coverageOfRead(summary, window, history));
  return { baseline: canonicalSpendingBaseline(selection), months: selection.months };
}
