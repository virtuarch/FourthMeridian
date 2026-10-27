/**
 * lib/space/perspective-time-groups.ts  (v2.7 — per-perspective-group time)
 *
 * The Space's reporting period is no longer ONE shared slice. Owner decision
 * (v2.7 final perspective UX pass, 2026-10-27): Cash Flow and Spending keep
 * their own period, independent of Net Worth / Assets / Debt — changing one
 * group's period must never move the other's. The two flow perspectives may
 * share a period between themselves.
 *
 *   GROUP      perspectives                                URL params
 *   position   Net Worth (Total · Assets · Debt) + every    asof · compareto · preset
 *              non-Overview tab (the historical names —
 *              every existing link keeps meaning the same)
 *   flow       Cash Flow · Spending                         fasof · fcompareto · fpreset
 *                                                          + fperiod (an explicit calendar
 *                                                            Month / Quarter / Year)
 *
 * BOTH groups are serialized into the URL at all times, so the URL stays the
 * one authority on traversal: a reload restores both groups, Back/Forward
 * restores both, and a shared link carries both (its explicit dates win). No
 * hidden memory and no browser storage: there is nothing to leak between
 * groups because each reads and writes only its own params.
 *
 * Rolling vs pinned (PR #57) applies per group: a rolling As Of (= today) is
 * omitted from the URL and advances at UTC midnight; an explicit past date — and
 * an explicit calendar period (`fperiod`) — stays pinned.
 *
 * LEGACY LINKS — before v2.7 a Cash Flow link carried its period in the shared
 * `preset/asof/compareto`. When a URL opens a flow perspective and carries NO
 * flow params at all, those legacy params are read as the FLOW group's (the
 * link was describing the page it opens), and the position group starts at its
 * default; the next write canonicalizes the URL (REPLACE). A URL written by this
 * module always carries `fpreset`, so the fallback can never fire on it.
 *
 * Pure — no React, no clock, no window. The React binding is
 * components/space/shell/usePerspectiveShellState.ts.
 */

import {
  DEFAULT_TIME_PRESET,
  hydrateShellTimeState,
  resolvePerspectiveTimeRange,
  rollShellTimeStateToToday,
  serializeShellTimeState,
  shellTimeReducer,
  type PerspectiveTimeState,
  type ShellTimeAction,
  type ShellTimeContext,
} from "@/lib/perspectives/time-range";
import type { CashFlowPeriod, ExplicitCashFlowPeriod, RelativeCashFlowPeriod } from "@/lib/transactions/cash-flow";
import { readSpaceParam } from "@/lib/space/space-url";

// ── Groups ────────────────────────────────────────────────────────────────────

export type TimeGroup = "position" | "flow";

/** The perspectives whose period is the FLOW group's. */
export const FLOW_PERSPECTIVE_IDS: readonly string[] = ["cashFlow", "spending"];
/** Their URL slugs (?perspective=…), for the legacy-link reading below. */
const FLOW_PERSPECTIVE_SLUGS = new Set(["cash-flow", "spending"]);

/** Which time group the rendered destination reads. Only an engaged flow lens on
 *  Overview is "flow"; Net Worth and every other tab is "position". */
export function timeGroupFor(activeTab: string, activePerspectiveId: string | null): TimeGroup {
  return activeTab === "OVERVIEW" && activePerspectiveId != null && FLOW_PERSPECTIVE_IDS.includes(activePerspectiveId)
    ? "flow"
    : "position";
}

/** Each group's URL params. Position keeps the historical names. */
export const TIME_GROUP_PARAMS: Record<TimeGroup, { asOf: string; compareTo: string; preset: string }> = {
  position: { asOf: "asof", compareTo: "compareto", preset: "preset" },
  flow:     { asOf: "fasof", compareTo: "fcompareto", preset: "fpreset" },
};
/** The flow group's explicit calendar period (periodKey form: month:2026-10 · quarter:2026-Q4 · year:2026). */
export const FLOW_PERIOD_PARAM = "fperiod";

// ── Explicit calendar periods (the heatmap's Month · Quarter · Year) ──────────

export type CalendarScale = "month" | "quarter" | "year";

/** Inverse of periodKey() for explicit periods; null for anything else. */
export function parseExplicitPeriodKey(raw: string | null | undefined): ExplicitCashFlowPeriod | null {
  if (!raw) return null;
  let m = /^month:(\d{4})-(\d{2})$/.exec(raw);
  if (m) {
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? { kind: "month", year: Number(m[1]), month } : null;
  }
  m = /^quarter:(\d{4})-Q([1-4])$/.exec(raw);
  if (m) return { kind: "quarter", year: Number(m[1]), quarter: Number(m[2]) };
  m = /^year:(\d{4})$/.exec(raw);
  if (m) return { kind: "year", year: Number(m[1]) };
  return null;
}

/** periodKey() for an explicit period (kept local so this module needs no runtime import from the fold module). */
export function explicitPeriodKey(p: ExplicitCashFlowPeriod): string {
  switch (p.kind) {
    case "month":   return `month:${p.year}-${String(p.month).padStart(2, "0")}`;
    case "quarter": return `quarter:${p.year}-Q${p.quarter}`;
    case "year":    return `year:${p.year}`;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Inclusive calendar bounds of an explicit period (same span as periodRange). */
export function explicitPeriodBounds(p: ExplicitCashFlowPeriod): { start: string; end: string } {
  switch (p.kind) {
    case "month":
      return { start: `${p.year}-${pad(p.month)}-01`, end: `${p.year}-${pad(p.month)}-${pad(lastDay(p.year, p.month))}` };
    case "quarter": {
      const m0 = (p.quarter - 1) * 3 + 1;
      return { start: `${p.year}-${pad(m0)}-01`, end: `${p.year}-${pad(m0 + 2)}-${pad(lastDay(p.year, m0 + 2))}` };
    }
    case "year":
      return { start: `${p.year}-01-01`, end: `${p.year}-12-31` };
  }
}

/** The calendar period of `scale` that contains the ISO date. */
export function explicitPeriodContaining(scale: CalendarScale, iso: string): ExplicitCashFlowPeriod {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (scale === "month") return { kind: "month", year: y, month: m };
  if (scale === "quarter") return { kind: "quarter", year: y, quarter: Math.floor((m - 1) / 3) + 1 };
  return { kind: "year", year: y };
}

/** The adjacent calendar period of the same kind (delta −1 = older, +1 = newer). */
export function stepExplicitPeriod(p: ExplicitCashFlowPeriod, delta: -1 | 1): ExplicitCashFlowPeriod {
  switch (p.kind) {
    case "month": {
      const idx = p.year * 12 + (p.month - 1) + delta;
      return { kind: "month", year: Math.floor(idx / 12), month: (idx % 12) + 1 };
    }
    case "quarter": {
      const idx = p.year * 4 + (p.quarter - 1) + delta;
      return { kind: "quarter", year: Math.floor(idx / 4), quarter: (idx % 4) + 1 };
    }
    case "year":
      return { kind: "year", year: p.year + delta };
  }
}

/**
 * The heatmap's period navigation, derived from the ONE period the header owns.
 *
 *   scale    — the active calendar unit (null while the header holds a relative
 *              preset such as 1M: the heatmap then paints that preset's range and
 *              no unit is active);
 *   choose   — what each of Month · Quarter · Year selects: the calendar unit that
 *              CONTAINS the current window's end (so pressing "Quarter" on Oct 2026
 *              reports Q4 2026 — a real, distinct window per unit);
 *   prev/next — the adjacent unit, or null at the edges (never past today; never
 *              before the first data-bearing date when it is known).
 */
export function calendarNavigation(args: {
  period: CashFlowPeriod;
  /** The current window's end (the flow group's As Of for a relative preset). */
  windowEnd: string;
  today: string;
  /** Earliest data-bearing ISO date, or null when unknown (no lower bound). */
  earliest: string | null;
}): {
  scale: CalendarScale | null;
  choose: Record<CalendarScale, ExplicitCashFlowPeriod>;
  prev: ExplicitCashFlowPeriod | null;
  next: ExplicitCashFlowPeriod | null;
} {
  const { period, today, earliest } = args;
  const explicit = typeof period === "object" ? period : null;
  const end = explicit ? minIso(explicitPeriodBounds(explicit).end, today) : minIso(args.windowEnd, today);
  const choose = {
    month: explicitPeriodContaining("month", end),
    quarter: explicitPeriodContaining("quarter", end),
    year: explicitPeriodContaining("year", end),
  };
  if (!explicit) return { scale: null, choose, prev: null, next: null };
  const older = stepExplicitPeriod(explicit, -1);
  const newer = stepExplicitPeriod(explicit, 1);
  const range = { earliest, today };
  return {
    scale: explicit.kind,
    choose,
    prev: isSelectablePeriod(older, range) ? older : null,
    next: isSelectablePeriod(newer, range) ? newer : null,
  };
}

// ── The supported range (ONE bound for the arrows AND the direct picker) ──────

/**
 * The supported date range for an explicit calendar period: never a unit that
 * starts after today, never one that ends before the earliest data-bearing date
 * (`earliest` null ⇒ no lower bound). The heatmap's ◀ / ▶ and its direct
 * period picker both read this one predicate, so they can never disagree.
 */
export function isSelectablePeriod(p: ExplicitCashFlowPeriod, range: { earliest: string | null; today: string }): boolean {
  const b = explicitPeriodBounds(p);
  return b.start <= range.today && (range.earliest == null || b.end >= range.earliest);
}

/**
 * The years the direct picker lists, oldest first: from the earliest data-bearing
 * year (or, with no known data, the current selection's year — a pinned period is
 * always listed) through today's year.
 */
export function selectablePickerYears(args: { earliest: string | null; today: string; current: ExplicitCashFlowPeriod | null }): number[] {
  const last = Number(args.today.slice(0, 4));
  const fromData = args.earliest != null ? Number(args.earliest.slice(0, 4)) : last;
  const fromCurrent = args.current ? args.current.year : last;
  const first = Math.min(fromData, fromCurrent, last);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

export interface PeriodPickerOption {
  period: ExplicitCashFlowPeriod;
  /** Key form (month:2026-10 …) — stable React key / test handle. */
  key: string;
  /** The grid cell's short text (Oct · Q4 · 2026). */
  short: string;
  /** False outside the supported range (rendered disabled, never selectable). */
  selectable: boolean;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The direct picker's options for one unit: the 12 months / 4 quarters of `year`,
 * or (year unit) every listed year. Out-of-range cells stay in the grid (a stable
 * layout) but are not selectable.
 */
export function periodPickerOptions(
  scale: CalendarScale,
  year: number,
  range: { earliest: string | null; today: string },
  years: number[],
): PeriodPickerOption[] {
  const periods: ExplicitCashFlowPeriod[] =
    scale === "month"   ? Array.from({ length: 12 }, (_, i) => ({ kind: "month" as const, year, month: i + 1 }))
    : scale === "quarter" ? Array.from({ length: 4 }, (_, i) => ({ kind: "quarter" as const, year, quarter: i + 1 }))
    : years.map((y) => ({ kind: "year" as const, year: y }));
  return periods.map((p) => ({
    period: p,
    key: explicitPeriodKey(p),
    short: p.kind === "month" ? MONTH_SHORT[p.month - 1] : p.kind === "quarter" ? `Q${p.quarter}` : String(p.year),
    selectable: isSelectablePeriod(p, range),
  }));
}

function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

// ── One group's time ──────────────────────────────────────────────────────────

export interface GroupTime {
  /** The canonical {preset, asOf, compareTo} for this group. */
  time: PerspectiveTimeState;
  /** The last relative preset this group showed — what Cash Flow holds under CUSTOM (§3.5). */
  lastRelative: RelativeCashFlowPeriod;
  /** An explicit calendar period chosen from the heatmap (flow only), else null. */
  explicit: ExplicitCashFlowPeriod | null;
}

export interface GroupedShellTime {
  position: GroupTime;
  flow: GroupTime;
}

function groupOf(time: PerspectiveTimeState, explicit: ExplicitCashFlowPeriod | null = null): GroupTime {
  return { time, lastRelative: time.preset === "CUSTOM" ? DEFAULT_TIME_PRESET : time.preset, explicit };
}

/** Both groups at the default slice (1M, rolling at today). */
export function defaultGroupedShellTime(today: string): GroupedShellTime {
  const time = resolvePerspectiveTimeRange({ preset: DEFAULT_TIME_PRESET, asOf: today, coverageFrom: null });
  return { position: groupOf(time), flow: groupOf(time) };
}

/**
 * The effective CashFlowPeriod a group implies: the explicit calendar period when
 * one is chosen, else the relative preset, else (CUSTOM) the last relative preset.
 */
export function groupPeriod(g: GroupTime): CashFlowPeriod {
  if (g.explicit) return g.explicit;
  return g.time.preset === "CUSTOM" ? g.lastRelative : g.time.preset;
}

/**
 * Apply a HEADER action to one group. The header is the master of the reporting
 * range: any header action ends an explicit calendar selection (the header and the
 * heatmap can therefore never show two different windows).
 */
export function reduceGroupTime(g: GroupTime, action: ShellTimeAction, ctx: ShellTimeContext): GroupTime {
  const time = shellTimeReducer(g.time, action, ctx);
  const lastRelative = time.preset === "CUSTOM" ? g.lastRelative : time.preset;
  if (time === g.time && g.explicit === null) return g;
  return { time, lastRelative, explicit: null };
}

/**
 * RESET (the heatmap's Reset action): the group back to its default — no explicit
 * calendar unit, the default relative preset (1M) at a ROLLING As Of (today), so
 * the URL omits the flow As Of / Compare To again. Only this group is touched.
 */
export function resetGroupTime(ctx: ShellTimeContext): GroupTime {
  return groupOf(resolvePerspectiveTimeRange({ preset: DEFAULT_TIME_PRESET, asOf: ctx.today, coverageFrom: ctx.coverageFrom }));
}

/** Choose (or clear) an explicit calendar period — the heatmap's Month · Quarter · Year. */
export function setGroupExplicit(g: GroupTime, explicit: ExplicitCashFlowPeriod | null): GroupTime {
  const same = explicit === null ? g.explicit === null : g.explicit !== null && explicitPeriodKey(g.explicit) === explicitPeriodKey(explicit);
  return same ? g : { ...g, explicit };
}

/** True when two group states are the same canonical state. */
export function sameGroupTime(a: GroupTime, b: GroupTime): boolean {
  return a.time.preset === b.time.preset && a.time.asOf === b.time.asOf && a.time.compareTo === b.time.compareTo
    && (a.explicit ? explicitPeriodKey(a.explicit) : null) === (b.explicit ? explicitPeriodKey(b.explicit) : null);
}

// ── URL ───────────────────────────────────────────────────────────────────────

function readGroupRaw(search: string, group: TimeGroup) {
  const p = TIME_GROUP_PARAMS[group];
  return {
    asOf: readSpaceParam(search, p.asOf),
    compareTo: readSpaceParam(search, p.compareTo),
    preset: readSpaceParam(search, p.preset),
  };
}
const hasAny = (raw: { asOf: string | null; compareTo: string | null; preset: string | null }) =>
  raw.asOf != null || raw.compareTo != null || raw.preset != null;

/**
 * Rebuild both groups from a URL. Each group hydrates from its own params through
 * the canonical hydrateShellTimeState (invalid / future ⇒ default; rolling
 * preserved). A legacy flow link (flow perspective, no flow params) reads the
 * shared params as the flow group's — see the module doc.
 */
export function hydrateGroupedShellTime(search: string, ctx: ShellTimeContext): GroupedShellTime {
  let positionRaw = readGroupRaw(search, "position");
  let flowRaw = readGroupRaw(search, "flow");
  const periodRaw = readSpaceParam(search, FLOW_PERIOD_PARAM);
  const opensFlow = FLOW_PERSPECTIVE_SLUGS.has((readSpaceParam(search, "perspective") ?? "").toLowerCase());
  if (opensFlow && !hasAny(flowRaw) && periodRaw == null && hasAny(positionRaw)) {
    flowRaw = positionRaw;
    positionRaw = { asOf: null, compareTo: null, preset: null };
  }
  const explicit = parseExplicitPeriodKey(periodRaw);
  const validExplicit = explicit && explicitPeriodBounds(explicit).start <= ctx.today ? explicit : null;
  return {
    position: groupOf(hydrateShellTimeState(positionRaw, ctx)),
    flow: groupOf(hydrateShellTimeState(flowRaw, ctx), validExplicit),
  };
}

/** Both groups → their URL params (null removes a param). Rolling As Of omitted per #57. */
export function serializeGroupedShellTime(g: GroupedShellTime, today: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const group of ["position", "flow"] as const) {
    const ser = serializeShellTimeState(g[group].time, today);
    const p = TIME_GROUP_PARAMS[group];
    out[p.asOf] = ser.asOf;
    out[p.compareTo] = ser.compareTo;
    out[p.preset] = ser.preset;
  }
  out[FLOW_PERIOD_PARAM] = g.flow.explicit ? explicitPeriodKey(g.flow.explicit) : null;
  return out;
}

// ── System transitions (both groups) ──────────────────────────────────────────

/** UTC midnight passed with the page open: each group's ROLLING state advances;
 *  pinned dates and explicit calendar periods stay. Identity when nothing rolls. */
export function rollGroupedShellTime(g: GroupedShellTime, prevToday: string, ctx: ShellTimeContext): GroupedShellTime {
  const position = rollShellTimeStateToToday(g.position.time, prevToday, ctx);
  const flow = rollShellTimeStateToToday(g.flow.time, prevToday, ctx);
  if (position === g.position.time && flow === g.flow.time) return g;
  return {
    position: position === g.position.time ? g.position : { ...g.position, time: position },
    flow: flow === g.flow.time ? g.flow : { ...g.flow, time: flow },
  };
}

/** Coverage arrived: a group on ALL re-derives its start. Identity otherwise. */
export function rederiveAllPreset(g: GroupedShellTime, ctx: ShellTimeContext): GroupedShellTime {
  const re = (x: GroupTime): GroupTime => {
    if (x.time.preset !== "ALL") return x;
    const time = shellTimeReducer(x.time, { type: "selectPreset", preset: "ALL" }, ctx);
    return time.compareTo === x.time.compareTo && time.asOf === x.time.asOf ? x : { ...x, time };
  };
  const position = re(g.position);
  const flow = re(g.flow);
  return position === g.position && flow === g.flow ? g : { position, flow };
}
