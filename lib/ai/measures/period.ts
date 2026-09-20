/**
 * lib/ai/measures/period.ts   (M1 — measures & comparison)
 *
 * WHICH DAYS a measure covers, resolved against an information ceiling.
 *
 * ⚠️ OVER THE ONE PARSER, NEVER A SECOND. Every relative preset start comes from
 * `compareToForPreset` (lib/perspectives/time-range) — the same function the
 * Cash Flow workspace and the window authority ask. This module adds the shapes
 * the parser does not model (an explicit calendar month, quarter or year, the
 * last N whole months, an explicit pair) and the rule for what "the previous
 * period" means; it never derives a preset start of its own.
 *
 * ⚠️ "PREVIOUS" OF A PERIOD TO DATE IS THE SAME ELAPSED DAYS, NOT THE WHOLE UNIT.
 * September 1–16 against August 1–16 — never September 1–16 against all of
 * August, which compares half a month with a whole one and calls the shortfall
 * a saving. The kind `ELAPSED_EQUIVALENT` names the substitution so a reader
 * can see it was made.
 *
 * ⚠️ ROLLING PRESETS ARE EXCLUSIVE OF THE ANCHOR DAY. The parser returns
 * `subMonths(asOf, 1)` as a FLOW-closed start; PAST_MONTH on 09-16 is therefore
 * 08-17..09-16 (31 days), never 08-16..09-16 — a 32-day "month" was the shape
 * the model probe compared by hand.
 *
 * Pure. No clock (the ceiling is an argument), no data, no rounding of money.
 */

import {
  compareToForPreset, startOfMonth, subMonths, subYears, addDaysISO, type TimePreset,
} from '@/lib/perspectives/time-range';

export type RelativePreset =
  | 'MTD' | 'QTD' | 'YTD' | 'PAST_WEEK' | 'PAST_MONTH' | 'PAST_QUARTER' | 'PAST_6_MONTHS' | 'PAST_YEAR';
export const RELATIVE_PRESETS: readonly RelativePreset[] =
  ['MTD', 'QTD', 'YTD', 'PAST_WEEK', 'PAST_MONTH', 'PAST_QUARTER', 'PAST_6_MONTHS', 'PAST_YEAR'];

export type PeriodSpec =
  | { preset: RelativePreset }
  /** `YYYY-MM`. */
  | { month: string }
  /** `YYYY-Q1`..`YYYY-Q4`. */
  | { quarter: string }
  | { year: number }
  /** The last N whole calendar months before the ceiling's month. */
  | { completeMonths: number }
  | { from: string; to: string };

export type CompareToSpec = 'PREVIOUS' | 'SAME_PERIOD_LAST_YEAR' | PeriodSpec;

export type PeriodKind =
  | 'CALENDAR_MONTH' | 'CALENDAR_QUARTER' | 'CALENDAR_YEAR'
  | 'TO_DATE' | 'ROLLING' | 'COMPLETE_MONTHS' | 'EXPLICIT'
  /** The same number of elapsed days of the previous unit — the previous of a period to date. */
  | 'ELAPSED_EQUIVALENT';

export interface ResolvedPeriod {
  from: string;
  to: string;
  /** Inclusive day count. */
  days: number;
  kind: PeriodKind;
  label: string;
  /** Opens on a month start and closes on a month end at or before the ceiling. */
  calendarComplete: boolean;
  /** The requested end fell past the ceiling and was cut at it. */
  clampedToCeiling: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const endOfMonth = (iso: string): string => {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return `${iso.slice(0, 7)}-${pad(daysInMonth(y, m))}`;
};
export const isMonthStart = (iso: string) => iso.slice(8, 10) === '01';
export const isMonthEnd = (iso: string) => iso === endOfMonth(iso);
export const inclusiveDays = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
const dayBefore = (iso: string) => addDaysISO(iso, -1);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
const ISO_QUARTER = /^\d{4}-Q[1-4]$/;

/** Why a spec could not be resolved. Refused by name, never defaulted. */
export interface PeriodRefusal { unavailable: string }

function finish(
  from: string, toRequested: string, kind: PeriodKind, label: string, ceiling: string,
): ResolvedPeriod {
  const clamped = toRequested > ceiling;
  const to = clamped ? ceiling : toRequested;
  return {
    from, to, days: inclusiveDays(from, to), kind, label,
    calendarComplete: isMonthStart(from) && isMonthEnd(to) && to <= ceiling,
    clampedToCeiling: clamped,
  };
}

/**
 * Validate an untrusted spec. Exactly one shape must be present and well-formed.
 * The model chooses the shape; this only refuses what it cannot read.
 */
export function parsePeriodSpec(raw: unknown): PeriodSpec | PeriodRefusal {
  if (!raw || typeof raw !== 'object') return { unavailable: 'a period is required' };
  const r = raw as Record<string, unknown>;
  const keys = ['preset', 'month', 'quarter', 'year', 'completeMonths', 'from', 'to']
    .filter((k) => r[k] !== undefined && r[k] !== null && r[k] !== '');
  const shape = keys.filter((k) => k !== 'to');
  if (shape.length !== 1) {
    return { unavailable: 'a period is exactly one of: `preset`, `month`, `quarter`, `year`, '
      + `\`completeMonths\`, or \`from\` + \`to\` (got ${keys.length ? keys.join(', ') : 'nothing'})` };
  }
  const k = shape[0];
  if (k === 'preset') {
    const p = String(r.preset).toUpperCase();
    return (RELATIVE_PRESETS as readonly string[]).includes(p)
      ? { preset: p as RelativePreset }
      : { unavailable: `unknown preset "${r.preset}"; one of ${RELATIVE_PRESETS.join(', ')}` };
  }
  if (k === 'month') {
    const m = String(r.month);
    return ISO_MONTH.test(m) && +m.slice(5, 7) >= 1 && +m.slice(5, 7) <= 12
      ? { month: m } : { unavailable: `\`month\` must be "YYYY-MM" (got "${m}")` };
  }
  if (k === 'quarter') {
    const q = String(r.quarter).toUpperCase();
    return ISO_QUARTER.test(q) ? { quarter: q } : { unavailable: `\`quarter\` must be "YYYY-Q1".."YYYY-Q4" (got "${r.quarter}")` };
  }
  if (k === 'year') {
    const y = Number(r.year);
    return Number.isInteger(y) && y >= 1970 && y <= 2200
      ? { year: y } : { unavailable: `\`year\` must be a calendar year (got "${r.year}")` };
  }
  if (k === 'completeMonths') {
    const n = Number(r.completeMonths);
    return Number.isInteger(n) && n >= 1 && n <= 120
      ? { completeMonths: n } : { unavailable: `\`completeMonths\` must be a whole number from 1 to 120 (got "${r.completeMonths}")` };
  }
  // from (+ to)
  const from = String(r.from);
  const to = r.to === undefined || r.to === null || r.to === '' ? null : String(r.to);
  if (!ISO_DAY.test(from) || (to !== null && !ISO_DAY.test(to))) {
    return { unavailable: '`from` and `to` must be YYYY-MM-DD' };
  }
  if (to === null) return { unavailable: '`from` needs a `to`' };
  if (to < from) return { unavailable: `\`to\` (${to}) is before \`from\` (${from})` };
  return { from, to };
}

export function parseCompareToSpec(raw: unknown): CompareToSpec | PeriodRefusal {
  if (typeof raw === 'string') {
    const s = raw.toUpperCase();
    if (s === 'PREVIOUS' || s === 'SAME_PERIOD_LAST_YEAR') return s;
    return { unavailable: `\`compareTo\` is "PREVIOUS", "SAME_PERIOD_LAST_YEAR" or a period object (got "${raw}")` };
  }
  return parsePeriodSpec(raw);
}

/** Resolve a spec against the information ceiling. Every date after `ceiling` is unreadable. */
export function resolvePeriod(spec: PeriodSpec, ceiling: string): ResolvedPeriod {
  if ('preset' in spec) {
    const start = compareToForPreset(spec.preset as TimePreset, ceiling, null)!;
    const toDate = spec.preset === 'MTD' || spec.preset === 'QTD' || spec.preset === 'YTD';
    const from = toDate ? start : addDaysISO(start, 1);
    return finish(from, ceiling, toDate ? 'TO_DATE' : 'ROLLING', spec.preset, ceiling);
  }
  if ('month' in spec) {
    return finish(`${spec.month}-01`, endOfMonth(`${spec.month}-01`), 'CALENDAR_MONTH', spec.month, ceiling);
  }
  if ('quarter' in spec) {
    const y = +spec.quarter.slice(0, 4), q = +spec.quarter.slice(6, 7);
    const m0 = (q - 1) * 3 + 1;
    return finish(`${y}-${pad(m0)}-01`, endOfMonth(`${y}-${pad(m0 + 2)}-01`), 'CALENDAR_QUARTER', spec.quarter, ceiling);
  }
  if ('year' in spec) {
    return finish(`${spec.year}-01-01`, `${spec.year}-12-31`, 'CALENDAR_YEAR', String(spec.year), ceiling);
  }
  if ('completeMonths' in spec) {
    const n = Math.max(1, Math.floor(spec.completeMonths));
    const lastComplete = isMonthEnd(ceiling) ? ceiling : dayBefore(startOfMonth(ceiling));
    const from = startOfMonth(subMonths(startOfMonth(lastComplete), n - 1));
    return finish(from, lastComplete, 'COMPLETE_MONTHS',
      `last ${n} complete month${n === 1 ? '' : 's'}`, ceiling);
  }
  return finish(spec.from, spec.to, 'EXPLICIT', `${spec.from}..${spec.to}`, ceiling);
}

const unitOf = (kind: PeriodKind, spec: PeriodSpec): 'month' | 'quarter' | 'year' => {
  if (kind === 'CALENDAR_MONTH') return 'month';
  if (kind === 'CALENDAR_QUARTER') return 'quarter';
  if (kind === 'CALENDAR_YEAR') return 'year';
  const p = 'preset' in spec ? spec.preset : 'MTD';
  return p === 'QTD' ? 'quarter' : p === 'YTD' ? 'year' : 'month';
};
const backOneUnit = (iso: string, unit: 'month' | 'quarter' | 'year') =>
  unit === 'month' ? subMonths(iso, 1) : unit === 'quarter' ? subMonths(iso, 3) : subYears(iso, 1);

/** The comparison window a spec implies, given the primary it is compared with. */
export function resolveCompareTo(
  primary: ResolvedPeriod, spec: PeriodSpec, compareTo: CompareToSpec, ceiling: string,
): ResolvedPeriod {
  // ⚠️ `completeMonths` INSIDE `compareTo` COUNTS BACK FROM THE PRIMARY, NOT FROM
  // TODAY. Asked to "compare the last three complete months with the three before
  // that", the model wrote `period: {completeMonths: 3}, compareTo: {completeMonths:
  // 3}` — and resolved against the ceiling, both sides were the SAME three months:
  // a comparison of a window with itself, FLAT at 0%, which the model itself called
  // meaningless. Relative to the primary is the only reading under which the
  // argument can mean anything, so it is the reading.
  if (typeof compareTo === 'object' && 'completeMonths' in compareTo) {
    const n = Math.max(1, Math.floor(compareTo.completeMonths));
    const before = dayBefore(primary.from);
    const to = isMonthEnd(before) ? before : dayBefore(startOfMonth(primary.from));
    const from = startOfMonth(subMonths(startOfMonth(to), n - 1));
    return finish(from, to, 'COMPLETE_MONTHS',
      `the ${n} complete month${n === 1 ? '' : 's'} before ${primary.label}`, ceiling);
  }
  if (typeof compareTo === 'object') return resolvePeriod(compareTo, ceiling);
  if (compareTo === 'SAME_PERIOD_LAST_YEAR') {
    return finish(subYears(primary.from, 1), subYears(primary.to, 1), primary.kind,
      `${primary.label} a year earlier`, ceiling);
  }
  // PREVIOUS.
  // A calendar period cut at the ceiling is a period TO DATE, and so is a to-date
  // preset: the previous is the same elapsed slice of the unit before.
  const toDate = primary.kind === 'TO_DATE'
    || (primary.clampedToCeiling && (primary.kind === 'CALENDAR_MONTH'
      || primary.kind === 'CALENDAR_QUARTER' || primary.kind === 'CALENDAR_YEAR'));
  if (toDate) {
    const unit = unitOf(primary.kind, spec);
    const prevStart = backOneUnit(primary.from, unit);
    return finish(prevStart, addDaysISO(prevStart, primary.days - 1), 'ELAPSED_EQUIVALENT',
      `the same ${primary.days} days of the previous ${unit}`, ceiling);
  }
  switch (primary.kind) {
    case 'CALENDAR_MONTH': {
      const p = subMonths(primary.from, 1);
      return finish(startOfMonth(p), endOfMonth(p), 'CALENDAR_MONTH', p.slice(0, 7), ceiling);
    }
    case 'CALENDAR_QUARTER': {
      const p = subMonths(primary.from, 3);
      return finish(startOfMonth(p), endOfMonth(subMonths(primary.to, 3)), 'CALENDAR_QUARTER',
        `the quarter before ${primary.label}`, ceiling);
    }
    case 'CALENDAR_YEAR': {
      const y = +primary.from.slice(0, 4) - 1;
      return finish(`${y}-01-01`, `${y}-12-31`, 'CALENDAR_YEAR', String(y), ceiling);
    }
    case 'COMPLETE_MONTHS': {
      const n = 'completeMonths' in spec ? Math.max(1, Math.floor(spec.completeMonths)) : 1;
      const to = dayBefore(primary.from);
      const from = startOfMonth(subMonths(startOfMonth(to), n - 1));
      return finish(from, to, 'COMPLETE_MONTHS',
        `the ${n} complete month${n === 1 ? '' : 's'} before that`, ceiling);
    }
    default: {
      // ROLLING / EXPLICIT: the same number of days, ending the day before.
      const to = dayBefore(primary.from);
      const from = addDaysISO(to, -(primary.days - 1));
      return finish(from, to, primary.kind === 'ROLLING' ? 'ROLLING' : 'EXPLICIT',
        `the ${primary.days} days before that`, ceiling);
    }
  }
}

/**
 * A run of whole calendar months named by their first and last `YYYY-MM` — for a
 * caller that already knows WHICH months it averaged (the cash projection's own
 * reliable months) and needs them stated as a period.
 */
export function completeMonthsPeriod(
  firstMonth: string, lastMonth: string, label: string, ceiling: string,
): ResolvedPeriod {
  return finish(`${firstMonth}-01`, endOfMonth(`${lastMonth}-01`), 'COMPLETE_MONTHS', label, ceiling);
}

/** Every `YYYY-MM` from the period's first month to its last, in order. */
export function monthsSpanned(period: Pick<ResolvedPeriod, 'from' | 'to'>): string[] {
  const out: string[] = [];
  let cur = startOfMonth(period.from);
  const last = period.to.slice(0, 7);
  while (cur.slice(0, 7) <= last) {
    out.push(cur.slice(0, 7));
    const y = +cur.slice(0, 4), m = +cur.slice(5, 7);
    cur = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  }
  return out;
}

/** Whether a calendar month is clipped by the period's edges. */
export function isPartialMonth(month: string, period: Pick<ResolvedPeriod, 'from' | 'to'>): boolean {
  return (month === period.from.slice(0, 7) && !isMonthStart(period.from))
    || (month === period.to.slice(0, 7) && !isMonthEnd(period.to));
}
