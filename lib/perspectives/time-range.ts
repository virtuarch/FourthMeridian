/**
 * lib/perspectives/time-range.ts
 *
 * The shared Perspective shell's ONE pure date-range resolver. It maps between a
 * time-slice preset and the (As Of, Compare To) date pair so the shell keeps a
 * single coherent state: the active slice, the point-in-time As Of, and the
 * comparison/range-start Compare To always agree. No React, no I/O, no ambient
 * clock — every date is passed in (YYYY-MM-DD), so SpaceDashboard owns state and
 * this module owns the arithmetic (tested).
 *
 * Presets reuse the existing relative CashFlowPeriod ids (so Cash Flow and the
 * shell speak the same vocabulary), plus a shell-only "CUSTOM" for a manual date
 * pair that matches no preset. Note the repo's rolling set is 1W/1M/1Q/1Y
 * (PAST_WEEK/PAST_MONTH/PAST_QUARTER/PAST_YEAR) — there is no separate 3M/6M
 * slice; PAST_QUARTER is the 3-month rolling window.
 *
 * Semantics:
 *   To-date presets — Compare To = start of the week/month/quarter/year that
 *     CONTAINS As Of; As Of stays the endpoint.
 *   Rolling presets — Compare To = As Of minus 1 week / 1 / 3 / 12 calendar
 *     months (calendar-aware, end-of-month clamped — never fixed day counts).
 *   ALL            — Compare To = the earliest defensible date (coverageFrom)
 *     when known, else null (the perspective falls back to its full-history
 *     behavior; no coverage date is ever fabricated).
 *
 * All dates are treated as timezone-naive calendar dates (UTC construction used
 * only to derive weekday and to add/clamp days), matching how SpaceSnapshot dates
 * are compared elsewhere as plain YYYY-MM-DD strings.
 */

import type { RelativeCashFlowPeriod } from "@/lib/transactions/cash-flow";

/** The shell's active slice: a relative period, or a manual/unmatched pair. */
export type TimePreset = RelativeCashFlowPeriod | "CUSTOM";

/** Presets checked (in this order) when inferring a preset from a date pair. */
const INFERENCE_ORDER: RelativeCashFlowPeriod[] = [
  "WTD", "MTD", "QTD", "YTD",
  "PAST_WEEK", "PAST_MONTH", "PAST_QUARTER", "PAST_YEAR",
];

// ── Calendar helpers (pure, UTC-naive) ────────────────────────────────────────

interface Ymd { y: number; m: number; d: number } // m is 1-based

function parse(iso: string): Ymd {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}
function fmt(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Days in month `m` (1-based) of year `y`. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Weekday of `iso` (0 = Sunday), timezone-independent. */
function weekday(iso: string): number {
  const { y, m, d } = parse(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function addDays(iso: string, n: number): string {
  const { y, m, d } = parse(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function startOfWeek(iso: string): string {
  return addDays(iso, -weekday(iso)); // Sunday start (matches periodRange WTD)
}
export function startOfMonth(iso: string): string {
  const { y, m } = parse(iso);
  return fmt(y, m, 1);
}
export function startOfQuarter(iso: string): string {
  const { y, m } = parse(iso);
  return fmt(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
}
export function startOfYear(iso: string): string {
  return fmt(parse(iso).y, 1, 1);
}
/** As Of minus `n` calendar months, clamping to the last valid day of the target month. */
export function subMonths(iso: string, n: number): string {
  const { y, m, d } = parse(iso);
  let ty = y;
  let tm = m - n;
  while (tm <= 0) { tm += 12; ty -= 1; }
  return fmt(ty, tm, Math.min(d, daysInMonth(ty, tm)));
}
/** As Of minus `n` calendar years, clamping (e.g. Feb 29 → Feb 28 in a non-leap year). */
export function subYears(iso: string, n: number): string {
  const { y, m, d } = parse(iso);
  const ty = y - n;
  return fmt(ty, m, Math.min(d, daysInMonth(ty, m)));
}

// ── Preset → date pair ────────────────────────────────────────────────────────

/** The Compare To a preset implies for a given As Of (null when it has none). */
export function compareToForPreset(
  preset: TimePreset,
  asOf: string,
  coverageFrom: string | null,
): string | null {
  switch (preset) {
    case "WTD": return startOfWeek(asOf);
    case "MTD": return startOfMonth(asOf);
    case "QTD": return startOfQuarter(asOf);
    case "YTD": return startOfYear(asOf);
    case "PAST_WEEK":    return addDays(asOf, -7);
    case "PAST_MONTH":   return subMonths(asOf, 1);
    case "PAST_QUARTER": return subMonths(asOf, 3);
    case "PAST_YEAR":    return subYears(asOf, 1);
    case "ALL":    return coverageFrom ?? null; // never fabricate a start
    case "CUSTOM": return null;                 // caller keeps the manual pair
  }
}

export interface PerspectiveTimeState {
  preset:    TimePreset;
  asOf:      string;
  compareTo: string | null;
}

/**
 * Resolve the coherent (As Of, Compare To) pair for a preset + As Of. As Of is
 * the endpoint and never moves here; Compare To is recomputed from the preset.
 */
export function resolvePerspectiveTimeRange(args: {
  preset:       TimePreset;
  asOf:         string;
  coverageFrom: string | null;
}): PerspectiveTimeState {
  return {
    preset: args.preset,
    asOf: args.asOf,
    compareTo: compareToForPreset(args.preset, args.asOf, args.coverageFrom),
  };
}

/**
 * Infer which preset a manual (As Of, Compare To) pair represents — exact match
 * only (no fuzzy matching), checked in a deterministic order. Returns "CUSTOM"
 * when the pair matches no preset (or there is no comparison).
 */
export function inferPerspectiveTimePreset(args: {
  asOf:         string;
  compareTo:    string | null;
  coverageFrom: string | null;
}): TimePreset {
  const { asOf, compareTo, coverageFrom } = args;
  if (compareTo == null) return "CUSTOM";
  for (const p of INFERENCE_ORDER) {
    if (compareToForPreset(p, asOf, coverageFrom) === compareTo) return p;
  }
  if (coverageFrom != null && compareTo === coverageFrom) return "ALL";
  return "CUSTOM";
}

/** The shell's initial state: MTD, As Of = today, Compare To = first of the month. */
export function defaultPerspectiveTimeState(today: string): PerspectiveTimeState {
  return resolvePerspectiveTimeRange({ preset: "MTD", asOf: today, coverageFrom: null });
}
