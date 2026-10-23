/**
 * components/platform/widgets/product-analytics-view.ts  (BETA V3 · Workstream W4)
 *
 * THE PURE PRESENTATION MODEL behind the Growth & Revenue "Product analytics"
 * surface. It turns ONE `ProductAnalyticsResponse` (the frozen W3→W4 contract,
 * lib/platform/growth/product-analytics-types.ts) into words, cells and bar
 * points. No React, no DOM, no fetch, no clock — every function is a plain
 * assertion target (house pattern: npx tsx product-analytics.test.ts).
 *
 * ── THIS MODULE AUTHORS NO METRIC ─────────────────────────────────────────────
 * Every count and every rate is READ from a named field on the payload and
 * carried through unchanged. The reader (W3) owns the arithmetic; this file
 * decides order, labels and which field each figure came from. There is no
 * function here whose name ends in `Rate` and no division over a count — the
 * guard asserts both. The ONE presentational division (bar width as a share of
 * the first funnel stage) is IMPORTED from growth-funnel-view.ts so the two
 * funnels in the Growth area draw with one rule.
 *
 * ── THREE STRATA, NEVER FOLDED ────────────────────────────────────────────────
 * registration · presence · engagement are different facts about different
 * ledgers. The surface renders "present", "engaged" and "sign-ins" as three
 * words that are ALWAYS all visible; there is deliberately no single "active"
 * figure anywhere in this model, and the test refuses one.
 *
 * ── THE THREE STATES OF A RATE ────────────────────────────────────────────────
 *   undefined  not measured (a cohort too young; a stage with nothing before it)
 *   null       measured, no denominator
 *   number     an authority-provided share
 * Collapsing them would turn "too young to say" into 0 %, which is the lie the
 * design (§4) names: a cohort younger than the horizon renders "not yet
 * measurable", never 0 %.
 */

import type { MiniBarPoint } from "../platform-surface";
import type {
  ActiveUsers,
  CostPerEngagedUser,
  FeatureAdoption,
  FunnelStage,
  ProductAnalyticsResponse,
  RetentionCohort,
} from "@/lib/platform/growth/product-analytics-types";
import { RATE_UNAVAILABLE, barFraction, formatRate, type StageRate } from "./growth-funnel-view";

export const PRODUCT_ANALYTICS_URL = "/api/platform/growth-revenue/product-analytics";

export const ESTIMATE_CAPTION = "estimate, not a bill";
export const NOT_YET_MEASURABLE = "not yet measurable";
export const NOT_MEASURED = "not measured";
export const NO_DENOMINATOR = "no denominator";
export const CS_NOTE = "Per-user detail lives in Customer Success; nothing here names a person, a Space or an id.";
export const LOADING_TEXT = "Loading…";

const DAY_MS = 86_400_000;

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

/** One decimal for a per-user frequency ("1.4"); whole when integral. */
export function fmtFrequency(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// ── Registrations ─────────────────────────────────────────────────────────────

export interface RegistrationStat { label: string; value: number; qualifier: string }

export function registrationStats(r: ProductAnalyticsResponse["registrations"]): RegistrationStat[] {
  return [
    { label: "Accounts", value: r.total, qualifier: `${fmtCount(r.deactivated)} deactivated · User rows, counted now` },
    { label: "Registered · last 7 d", value: r.last7d, qualifier: "User.createdAt in the last 7 UTC days" },
    { label: "Registered · last 30 d", value: r.last30d, qualifier: "User.createdAt in the last 30 UTC days" },
  ];
}

/** The window's UTC day keys ending on the UTC day of `checkedAt`, oldest first. */
export function windowDayKeys(checkedAt: string, days: number): string[] {
  const d = new Date(checkedAt);
  const anchor = Number.isNaN(d.getTime()) ? Date.UTC(1970, 0, 1) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(anchor - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

/**
 * A per-day series over the whole window. A day the reader did not list is
 * ZERO here, not a gap: these series are projections over COMPLETE row ledgers
 * (User rows, product-event rows) inside their retention window, where absence
 * of a row is absence of the fact — unlike a usage counter, which writes
 * nothing on a quiet day. The caption on the surface states this rule.
 */
export function daySeries(
  checkedAt: string,
  days: number,
  rows: readonly { day: string; value: number }[],
  unit: string,
): MiniBarPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r.value] as const));
  return windowDayKeys(checkedAt, days).map((key) => {
    const value = byDay.get(key) ?? 0;
    return { key, value, title: `${key}: ${fmtCount(value)} ${unit}` };
  });
}

export const DAY_SERIES_CAPTION = "UTC days · a day without a row is zero (complete ledgers inside the retention window), not a gap";

// ── Presence · engagement · sign-ins ──────────────────────────────────────────

export type Stratum = keyof ActiveUsers;
export type ActiveWindow = "daily" | "weekly" | "monthly";

export const STRATUM_WORD: Record<Stratum, string> = { present: "present", engaged: "engaged", signIns: "sign-ins" };

export const STRATUM_BASIS: Record<Stratum, string> = {
  present: "distinct users with a SESSION_ACTIVE_DAY in the window",
  engaged: "distinct users with ≥1 engagement fact: a product event, a chat or Brief invocation with a user, or a connection added",
  signIns: "distinct users with a credential sign-in (AuditLog LOGIN) — not an activity metric",
};

export const WINDOW_LABEL: Record<ActiveWindow, string> = {
  daily: "Daily · today UTC",
  weekly: "Weekly · last 7 d",
  monthly: "Monthly · last 30 d",
};

export const STRATA_ORDER: readonly Stratum[] = ["present", "engaged", "signIns"];
export const WINDOWS_ORDER: readonly ActiveWindow[] = ["daily", "weekly", "monthly"];

export interface StratumTile { key: Stratum; word: string; count: number; basis: string }
export interface WindowTiles { window: ActiveWindow; label: string; tiles: StratumTile[] }

/** Three windows × three strata — every word present in every window, always. */
export function activeTiles(active: ProductAnalyticsResponse["active"]): WindowTiles[] {
  return WINDOWS_ORDER.map((window) => ({
    window,
    label: WINDOW_LABEL[window],
    tiles: STRATA_ORDER.map((key) => ({ key, word: STRATUM_WORD[key], count: active[window][key], basis: STRATUM_BASIS[key] })),
  }));
}

export function presentPerDay(a: ProductAnalyticsResponse["active"], checkedAt: string, days: number): MiniBarPoint[] {
  return daySeries(checkedAt, days, a.perDay.map((d) => ({ day: d.day, value: d.present })), "present");
}

export function engagedPerDay(a: ProductAnalyticsResponse["active"], checkedAt: string, days: number): MiniBarPoint[] {
  return daySeries(checkedAt, days, a.perDay.map((d) => ({ day: d.day, value: d.engaged })), "engaged");
}

// ── Retention ─────────────────────────────────────────────────────────────────

export interface RetentionCell { text: string; qualifier: string | null }

/** The three-state rate, rendered for a retention cohort cell. */
export function retentionCell(rate: StageRate): RetentionCell {
  if (rate === undefined) return { text: NOT_YET_MEASURABLE, qualifier: null };
  if (rate === null) return { text: RATE_UNAVAILABLE, qualifier: NO_DENOMINATOR };
  return { text: formatRate(rate) ?? RATE_UNAVAILABLE, qualifier: null };
}

export interface RetentionRow {
  key: string;
  week: string;
  cohortSize: number;
  d1: RetentionCell;
  d7Window: RetentionCell;
  d7Strict: RetentionCell;
}

export const RETENTION_HEADINGS = ["First-visit week", "Cohort", "D1", "D7 window", "D7 strict"] as const;

/** Order is the reader's; this never re-sorts. */
export function retentionRows(cohorts: readonly RetentionCohort[]): RetentionRow[] {
  return cohorts.map((c) => ({
    key: c.weekStart,
    week: `week of ${c.weekStart}`,
    cohortSize: c.cohortSize,
    d1: retentionCell(c.d1),
    d7Window: retentionCell(c.d7Window),
    d7Strict: retentionCell(c.d7Strict),
  }));
}

export function returningEverText(r: ProductAnalyticsResponse["retention"]["returningEver"]): string {
  const rate = formatRate(r.rate);
  return rate ? `${rate} of users engaged on a day after their first visit` : `${NOT_MEASURED} as a share · users engaged on a day after their first visit`;
}

export const RETENTION_BASIS = "weekly cohorts by first-visit week · D1 = engaged on first-visit day + 1 · D7 window = engaged at least once in days 1–7 (primary) · D7 strict = engaged on day 7 exactly";

// ── Onboarding funnel ─────────────────────────────────────────────────────────

export interface FunnelRow {
  key: FunnelStage["key"];
  label: string;
  count: number;
  /** null ⇒ render nothing (not measured); the em-dash means "no denominator". */
  rateText: string | null;
  /** null ⇒ no bar (the first stage has no count to be a share of). */
  fraction: number | null;
  /** null ⇒ the reader recorded no abandonment figure for this stage. */
  abandonedText: string | null;
}

export function funnelRows(stages: readonly FunnelStage[], horizonDays: number): FunnelRow[] {
  const first = stages[0]?.count ?? null;
  return stages.map((s) => ({
    key: s.key,
    label: s.label,
    count: s.count,
    rateText: formatRate(s.rate),
    fraction: barFraction(s.count, first),
    abandonedText: s.abandoned === undefined ? null : `${fmtCount(s.abandoned)} abandoned · no next step within ${horizonDays} d`,
  }));
}

// ── Feature adoption ──────────────────────────────────────────────────────────

export interface FeatureRow {
  key: FeatureAdoption["key"];
  label: string;
  adopters: number;
  adoptionText: string;
  frequencyText: string;
  basis: string;
}

export const FEATURE_HEADINGS = ["Feature", "Adopters", "Adoption", "Frequency"] as const;

export function featureRows(features: readonly FeatureAdoption[]): FeatureRow[] {
  return features.map((f) => ({
    key: f.key,
    label: f.label,
    adopters: f.adopters,
    adoptionText: f.adoption === undefined ? NOT_MEASURED : f.adoption === null ? `${RATE_UNAVAILABLE} ${NO_DENOMINATOR}` : (formatRate(f.adoption) ?? RATE_UNAVAILABLE),
    frequencyText:
      f.frequencyPerEngagedUserPerWeek === undefined ? NOT_MEASURED
      : f.frequencyPerEngagedUserPerWeek === null ? `${RATE_UNAVAILABLE} ${NO_DENOMINATOR}`
      : `${fmtFrequency(f.frequencyPerEngagedUserPerWeek)} per engaged user per week`,
    basis: f.basis,
  }));
}

export const ADOPTION_BASIS = "adoption = adopters ÷ registered (not ÷ engaged) · frequency = uses ÷ engaged users in the window, per week";

// ── Cost per engaged user ─────────────────────────────────────────────────────

export type CostReading =
  | { kind: "figure"; value: string; qualifier: string; derivation: string }
  | { kind: "unavailable"; reason: string; derivation: string };

export function costReading(c: CostPerEngagedUser): CostReading {
  const ai = c.aiUsd === null ? "AI unpriced" : `AI ${fmtUsd(c.aiUsd)}`;
  const plaid = c.plaidUsd === null ? "Plaid unpriced" : `Plaid ${fmtUsd(c.plaidUsd)}`;
  const derivation = `${ai} + ${plaid} ÷ ${fmtCount(c.engagedUsers)} engaged user${c.engagedUsers === 1 ? "" : "s"} · ${c.tier}`;
  if (c.perEngagedUserUsd !== null) {
    return { kind: "figure", value: fmtUsd(c.perEngagedUserUsd), qualifier: `${ESTIMATE_CAPTION} · per engaged user · 30 d`, derivation };
  }
  const reasons: string[] = [];
  if (c.aiUsd === null) reasons.push("AI spend could not be priced (a model had no rate in force)");
  if (c.plaidUsd === null) reasons.push("Plaid Item-months could not be priced");
  if (c.engagedUsers === 0) reasons.push("no engaged users in the window (no denominator)");
  if (reasons.length === 0) reasons.push("the reader returned no figure");
  return { kind: "unavailable", reason: reasons.join("; "), derivation };
}

// ── Footnote ──────────────────────────────────────────────────────────────────

export function footnoteText(exclusions: readonly string[]): string {
  const ex = exclusions.length > 0 ? `Excluded by the projection: ${exclusions.join(" · ")}. ` : "";
  return `${ex}${CS_NOTE}`;
}

export function checkedAtText(checkedAt: string): string {
  const t = Date.parse(checkedAt);
  if (Number.isNaN(t)) return "computed at an unreadable time";
  return `computed ${checkedAt.slice(0, 16).replace("T", " ")} UTC`;
}
