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
 * shell speak ONE vocabulary — this is the canonical time model of the amended
 * plan §3; we deliberately keep the CashFlowPeriod ids rather than a parallel
 * "P1W…P6M" set so `mapPresetToCashFlowPeriod` is an identity), plus a shell-only
 * "CUSTOM" for a manual date pair that matches no preset. Rolling group labels
 * are 1W · 1M · 3M · 6M · 1Y · ALL (ids PAST_WEEK/PAST_MONTH/PAST_QUARTER/
 * PAST_6_MONTHS/PAST_YEAR/ALL) — see lib/transactions/cash-flow.ts.
 *
 * This module also owns the shell time REDUCER (shellTimeReducer) implementing
 * the §3.3 transition table (select preset, set As Of, set/clear Compare To,
 * swap) with the invariant `preset ≠ CUSTOM ⟺ compareTo === deriveCompareTo`,
 * plus URL serialize/hydrate. The React binding lives in
 * components/space/shell/usePerspectiveShellState.ts.
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

import type { CashFlowPeriod, RelativeCashFlowPeriod } from "@/lib/transactions/cash-flow";

/** The shell's active slice: a relative period, or a manual/unmatched pair. */
export type TimePreset = RelativeCashFlowPeriod | "CUSTOM";

/** Presets checked (in this order) when inferring a preset from a date pair. */
const INFERENCE_ORDER: RelativeCashFlowPeriod[] = [
  "WTD", "MTD", "QTD", "YTD",
  "PAST_WEEK", "PAST_MONTH", "PAST_QUARTER", "PAST_6_MONTHS", "PAST_YEAR",
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
    case "PAST_WEEK":     return addDays(asOf, -7);
    case "PAST_MONTH":    return subMonths(asOf, 1);
    case "PAST_QUARTER":  return subMonths(asOf, 3);
    case "PAST_6_MONTHS": return subMonths(asOf, 6);
    case "PAST_YEAR":     return subYears(asOf, 1);
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
  asOf:          string;
  compareTo:     string | null;
  coverageFrom:  string | null;
  /** Amended §3.3 ambiguity rule: when several presets match, prefer this one if it still matches. */
  currentPreset?: TimePreset;
}): TimePreset {
  const { asOf, compareTo, coverageFrom, currentPreset } = args;
  if (compareTo == null) return "CUSTOM";
  // Prefer the currently-active preset when it still explains the pair (e.g. on
  // Mar 31 both MTD and QTD give Mar 1 — keep whichever the user had selected).
  if (
    currentPreset && currentPreset !== "CUSTOM" &&
    compareToForPreset(currentPreset, asOf, coverageFrom) === compareTo
  ) return currentPreset;
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

// ── Validation + derived values ────────────────────────────────────────────────

/** Strict YYYY-MM-DD calendar-validity check (rejects e.g. 2026-02-30). */
export function isValidYmd(s: string | null | undefined): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parse(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Clamp As Of to a valid date ≤ today (invalid ⇒ today). */
export function clampAsOf(asOf: string, today: string): string {
  if (!isValidYmd(asOf)) return today;
  return asOf > today ? today : asOf;
}

/**
 * The canonical `compareTo`, exposed ONLY when it is a strictly-earlier baseline
 * than `asOf` — otherwise null. A pure derivation of canonical time (NOT a reducer
 * invariant): the raw pair is kept as-is (Wealth compares to any date, including
 * one ≥ asOf), while the window-constrained lenses (Debt / Investments / Liquidity,
 * whose historical routes 400 on `compareTo >= asOf`) consume this strict value.
 *
 *   compareTo <  asOf → compareTo
 *   compareTo == asOf → null
 *   compareTo >  asOf → null
 *   compareTo == null → null
 */
export function historicalCompareTo(asOf: string, compareTo: string | null): string | null {
  return compareTo && compareTo < asOf ? compareTo : null;
}

const DERIVABLE_PRESETS: readonly TimePreset[] = [...INFERENCE_ORDER, "ALL"];

/** Every non-CUSTOM preset carries a real CashFlowPeriod id; CUSTOM has none, so
 *  Cash Flow holds its last preset-derived period (documented §3.5 limitation). */
export function mapPresetToCashFlowPeriod(preset: TimePreset, lastPeriod: CashFlowPeriod): CashFlowPeriod {
  return preset === "CUSTOM" ? lastPeriod : preset;
}

// ── Reducer (the §3.3 transition table — one source of truth) ──────────────────

export type ShellTimeAction =
  | { type: "selectPreset"; preset: Exclude<TimePreset, "CUSTOM"> }
  | { type: "setAsOf"; asOf: string }
  | { type: "setCompareTo"; compareTo: string | null }
  | { type: "clearCompareTo" }
  | { type: "swap" };

export interface ShellTimeContext {
  today:        string;
  coverageFrom: string | null;
}

/**
 * Apply a shell time action, always preserving the invariant
 * `preset ≠ CUSTOM ⟺ compareTo === deriveCompareTo(preset, asOf)`. Pure and
 * fully tested; the React hook is a thin wrapper over this.
 */
export function shellTimeReducer(
  state: PerspectiveTimeState,
  action: ShellTimeAction,
  ctx: ShellTimeContext,
): PerspectiveTimeState {
  const { today, coverageFrom } = ctx;
  switch (action.type) {
    case "selectPreset": {
      const asOf = clampAsOf(state.asOf, today);
      return { preset: action.preset, asOf, compareTo: compareToForPreset(action.preset, asOf, coverageFrom) };
    }
    case "setAsOf": {
      const asOf = clampAsOf(action.asOf, today);
      if (state.preset !== "CUSTOM") {
        // A preset moves the whole range: recompute Compare To from the new As Of.
        return { preset: state.preset, asOf, compareTo: compareToForPreset(state.preset, asOf, coverageFrom) };
      }
      // Custom: keep Compare To, but the new pair may now snap onto a preset.
      const preset = inferPerspectiveTimePreset({ asOf, compareTo: state.compareTo, coverageFrom, currentPreset: state.preset });
      return { preset, asOf, compareTo: state.compareTo };
    }
    case "setCompareTo": {
      const preset = inferPerspectiveTimePreset({ asOf: state.asOf, compareTo: action.compareTo, coverageFrom, currentPreset: state.preset });
      return { preset, asOf: state.asOf, compareTo: action.compareTo };
    }
    case "clearCompareTo":
      return { preset: "CUSTOM", asOf: state.asOf, compareTo: null };
    case "swap": {
      if (state.compareTo == null) return state; // nothing to swap
      const asOf = clampAsOf(state.compareTo, today);
      const compareTo = state.asOf;
      const preset = inferPerspectiveTimePreset({ asOf, compareTo, coverageFrom, currentPreset: state.preset });
      return { preset, asOf, compareTo };
    }
  }
}

// ── URL serialization ──────────────────────────────────────────────────────────

export interface SerializedShellTime {
  asOf:      string;
  compareTo: string | null;
  preset:    string; // preset id, or "custom"
}

export function serializeShellTimeState(state: PerspectiveTimeState): SerializedShellTime {
  return { asOf: state.asOf, compareTo: state.compareTo, preset: state.preset === "CUSTOM" ? "custom" : state.preset };
}

/**
 * Rebuild shell state from URL params. A concrete preset id re-derives the pair
 * (canonical + self-consistent); "custom"/missing keeps the manual Compare To and
 * re-infers; anything invalid or future falls back to the default MTD state. The
 * round-trip serialize → hydrate is identity (tested).
 */
export function hydrateShellTimeState(
  raw: { asOf?: string | null; preset?: string | null; compareTo?: string | null },
  ctx: ShellTimeContext,
): PerspectiveTimeState {
  const { today, coverageFrom } = ctx;
  const asOf = isValidYmd(raw.asOf) && raw.asOf <= today ? raw.asOf : today;
  const compareTo = isValidYmd(raw.compareTo) ? raw.compareTo : null;
  const presetRaw = raw.preset ?? "";

  if (presetRaw && presetRaw !== "custom" && (DERIVABLE_PRESETS as string[]).includes(presetRaw)) {
    const preset = presetRaw as Exclude<TimePreset, "CUSTOM">;
    return { preset, asOf, compareTo: compareToForPreset(preset, asOf, coverageFrom) };
  }
  if (compareTo != null || presetRaw === "custom") {
    const preset = inferPerspectiveTimePreset({ asOf, compareTo, coverageFrom });
    return { preset, asOf, compareTo };
  }
  return resolvePerspectiveTimeRange({ preset: "MTD", asOf, coverageFrom });
}
