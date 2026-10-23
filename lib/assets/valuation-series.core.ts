/**
 * lib/assets/valuation-series.core.ts   (RWA-2A — ASSET VALUATION HISTORY)
 *
 * THE valuation policy for a manual real-world asset — one pure rule that every
 * reader uses (the asset's history chart, the AI tools, and any history rebuild),
 * so no two surfaces can describe the same asset's past differently.
 *
 * Pure: no DB, no React, no ambient clock — `today` is an argument.
 *
 * ── The inputs, and what each one is allowed to mean ──────────────────────────
 *   RECORDED valuations   AssetValuation rows — dated values the USER entered.
 *                         The only stored history. Never edited, never deleted.
 *   PURCHASE PRICE        a fact on ManualAssetProfile. It becomes an anchor ONLY
 *                         when the user opted in (`purchasePriceIsStartingValue`).
 *                         It is resolved here at read time and never copied into
 *                         the valuation ledger. Without the opt-in it is shown as
 *                         a fact and never treated as a market value.
 *   LEGACY balance        an asset created before RWA-2 has no valuation rows; its
 *                         balance at `lastUpdated` is then its one recorded anchor.
 *
 * ── The rule, per day d (YYYY-MM-DD, UTC calendar dates) ──────────────────────
 *   before the start date             → null  NOT_HELD   (acquisition date, else
 *                                              the first anchor — ownership is
 *                                              never fabricated before either)
 *   after acquisition, before the
 *   first anchor                      → null  NOT_VALUED (no value is invented)
 *   on an anchor date                 → that anchor          basis "recorded"
 *   strictly between two anchors      → linear interpolation basis "modeled"
 *   after the last anchor             → the last anchor      basis "carried"
 *                                       (owner D-H4: never extrapolated)
 *
 * Same-day correction rule: for one effective date the valuation with the latest
 * `recordedAt` is the anchor; earlier rows for that date are `superseded` (kept,
 * reported, never used).
 *
 * Modeled values are rounded to whole currency units — interpolation between two
 * estimates carries no cent-level information, and printing cents would imply a
 * precision the data does not have.
 */

export type AnchorKind =
  /** A dated value the user entered (AssetValuation). */
  | "USER_VALUATION"
  /** The purchase price, used as a starting value because the user opted in. */
  | "PURCHASE_PRICE"
  /** A pre-RWA-2 asset's balance at its last update (no ledger rows exist). */
  | "LEGACY_BALANCE";

export type ValuationBasis = "recorded" | "modeled" | "carried";

export interface ValuationRow {
  id:            string;
  /** YYYY-MM-DD. */
  effectiveDate: string;
  value:         number;
  currency:      string;
  /** ISO-8601 instant the row was entered. */
  recordedAt:    string;
}

export interface ProfileFacts {
  /** YYYY-MM-DD or null. */
  acquisitionDate:              string | null;
  purchasePrice:                number | null;
  purchaseCurrency:             string | null;
  purchasePriceIsStartingValue: boolean;
}

export interface LegacyBalance {
  balance:     number;
  currency:    string;
  /** ISO-8601 instant (FinancialAccount.lastUpdated). */
  lastUpdated: string;
}

export interface Anchor {
  date:     string;
  value:    number;
  currency: string;
  kind:     AnchorKind;
  /** For USER_VALUATION: the row that won its date. */
  valuationId?: string;
  recordedAt?:  string;
}

export interface ResolvedAnchors {
  /** The asset's currency (every anchor is in it). */
  currency: string;
  /** Ascending by date, one per date. */
  anchors:  Anchor[];
  /** Same-day rows that a later entry for the same date replaced. */
  superseded: ValuationRow[];
  /** First day the asset is held (acquisition date, else the first anchor), or null. */
  startDate: string | null;
  /**
   * Inputs that could not be used, named — never silently dropped:
   *   PURCHASE_CURRENCY_MISMATCH  opted-in purchase price in another currency
   *   PURCHASE_AFTER_FIRST_VALUATION  acquisition date later than a recorded valuation
   *   VALUATION_CURRENCY_MISMATCH a ledger row not in the asset's currency
   */
  excluded: { reason: string; detail: string }[];
}

export interface ValuationPoint {
  date:  string;
  value: number;
  basis: ValuationBasis;
}

export type ValueOnResult =
  | { held: true;  valued: true;  value: number; basis: ValuationBasis }
  | { held: true;  valued: false; reason: "NOT_VALUED" }
  | { held: false; reason: "NOT_HELD" };

// ── Calendar helpers (UTC, YYYY-MM-DD) ───────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function dayNumber(iso: string): number {
  return Math.round(new Date(`${iso}T00:00:00Z`).getTime() / MS_PER_DAY);
}

export function isoFromDayNumber(n: number): string {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The UTC calendar date of an instant. */
export function isoDateOf(instant: string | Date): string {
  return (instant instanceof Date ? instant : new Date(instant)).toISOString().slice(0, 10);
}

/**
 * The instant that dates an estimate on FinancialAccount.lastUpdated — the clock
 * the freshness authority ages a manual asset by. A value dated today is "now";
 * a value dated in the past is that day (noon UTC), so recording last spring's
 * appraisal today never makes the estimate look fresh.
 */
export function estimateInstant(effectiveDate: string, now: Date): Date {
  return effectiveDate === isoDateOf(now) ? now : new Date(`${effectiveDate}T12:00:00Z`);
}

// ── Validation (the write routes' rules, shared so the UI and server agree) ───

export type DateCheck = { ok: true } | { ok: false; error: string };

/** An acquisition date: a real date, not in the future. */
export function checkAcquisitionDate(date: string, today: string): DateCheck {
  if (!isIsoDate(date)) return { ok: false, error: "Acquisition date must be a valid date (YYYY-MM-DD)." };
  if (date > today) return { ok: false, error: "Acquisition date can't be in the future." };
  return { ok: true };
}

/** A valuation's effective date: a real date, not in the future, not before acquisition. */
export function checkEffectiveDate(date: string, today: string, acquisitionDate: string | null): DateCheck {
  if (!isIsoDate(date)) return { ok: false, error: "The valuation date must be a valid date (YYYY-MM-DD)." };
  if (date > today) return { ok: false, error: "A valuation can't be dated in the future." };
  if (acquisitionDate && date < acquisitionDate) {
    return { ok: false, error: "A valuation can't be dated before the acquisition date." };
  }
  return { ok: true };
}

// ── Anchors ───────────────────────────────────────────────────────────────────

/**
 * Collapse the inputs into one anchor per date, applying the same-day rule and
 * the purchase-price opt-in. `currency` is the asset's currency.
 */
export function resolveAnchors(args: {
  currency:   string;
  valuations: ValuationRow[];
  profile:    ProfileFacts | null;
  legacy:     LegacyBalance | null;
}): ResolvedAnchors {
  const { currency } = args;
  const excluded: ResolvedAnchors["excluded"] = [];

  // Same-day rule: latest recordedAt wins; ties keep the later row in input order.
  const byDate = new Map<string, ValuationRow>();
  const superseded: ValuationRow[] = [];
  for (const v of args.valuations) {
    if (v.currency !== currency) {
      excluded.push({ reason: "VALUATION_CURRENCY_MISMATCH", detail: `${v.effectiveDate} in ${v.currency}` });
      continue;
    }
    const prev = byDate.get(v.effectiveDate);
    if (!prev) { byDate.set(v.effectiveDate, v); continue; }
    if (v.recordedAt >= prev.recordedAt) { superseded.push(prev); byDate.set(v.effectiveDate, v); }
    else superseded.push(v);
  }

  const anchors: Anchor[] = [...byDate.values()].map((v) => ({
    date: v.effectiveDate, value: v.value, currency: v.currency,
    kind: "USER_VALUATION" as const, valuationId: v.id, recordedAt: v.recordedAt,
  }));

  // A pre-RWA-2 asset: its balance is its one recorded anchor.
  if (anchors.length === 0 && args.legacy) {
    anchors.push({
      date: isoDateOf(args.legacy.lastUpdated), value: args.legacy.balance,
      currency: args.legacy.currency, kind: "LEGACY_BALANCE",
    });
  }

  const p = args.profile;
  const acquisitionDate = p?.acquisitionDate && isIsoDate(p.acquisitionDate) ? p.acquisitionDate : null;
  const firstRecorded = anchors.reduce<string | null>((m, a) => (m === null || a.date < m ? a.date : m), null);
  if (acquisitionDate && firstRecorded && acquisitionDate > firstRecorded) {
    excluded.push({ reason: "PURCHASE_AFTER_FIRST_VALUATION", detail: `${acquisitionDate} > ${firstRecorded}` });
  }

  // The purchase price becomes an anchor ONLY by opt-in, in the asset's currency,
  // on the acquisition date, and never displacing a recorded valuation of that date.
  if (p?.purchasePriceIsStartingValue && acquisitionDate && p.purchasePrice !== null && Number.isFinite(p.purchasePrice) && p.purchasePrice >= 0) {
    const pc = p.purchaseCurrency ?? currency;
    if (pc !== currency) {
      excluded.push({ reason: "PURCHASE_CURRENCY_MISMATCH", detail: `${pc} ≠ ${currency}` });
    } else if (!anchors.some((a) => a.date === acquisitionDate) && !(firstRecorded && acquisitionDate > firstRecorded)) {
      anchors.push({ date: acquisitionDate, value: p.purchasePrice, currency, kind: "PURCHASE_PRICE" });
    }
  }

  anchors.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const firstAnchor = anchors[0]?.date ?? null;
  const startDate =
    acquisitionDate && (firstAnchor === null || acquisitionDate <= firstAnchor) ? acquisitionDate : firstAnchor;

  return { currency, anchors, superseded, startDate, excluded };
}

/** The anchor that today's value must equal: the latest-dated one. */
export function latestAnchor(r: ResolvedAnchors): Anchor | null {
  return r.anchors.length ? r.anchors[r.anchors.length - 1] : null;
}

// ── Per-day value ─────────────────────────────────────────────────────────────

/** THE per-day rule (see the header). */
export function valueOn(r: ResolvedAnchors, day: string): ValueOnResult {
  if (r.startDate === null || day < r.startDate) return { held: false, reason: "NOT_HELD" };
  const a = r.anchors;
  if (a.length === 0 || day < a[0].date) return { held: true, valued: false, reason: "NOT_VALUED" };

  // Binary search for the last anchor on or before `day`.
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid].date <= day) lo = mid; else hi = mid - 1;
  }
  const left = a[lo];
  if (left.date === day) return { held: true, valued: true, value: left.value, basis: "recorded" };
  const right = a[lo + 1];
  if (!right) return { held: true, valued: true, value: left.value, basis: "carried" };

  const span = dayNumber(right.date) - dayNumber(left.date);
  const t = (dayNumber(day) - dayNumber(left.date)) / span;
  const value = Math.round(left.value + (right.value - left.value) * t);
  return { held: true, valued: true, value, basis: "modeled" };
}

/**
 * A chart series from the start date to `today`, sampled so the point count stays
 * bounded (≤ ~maxPoints): every anchor date is always included (so recorded
 * values are never lost to sampling), plus evenly spaced days between them.
 */
export function buildValuationSeries(
  r: ResolvedAnchors, today: string, maxPoints = 120,
): ValuationPoint[] {
  if (r.startDate === null || r.anchors.length === 0) return [];
  const from = r.anchors[0].date;              // nothing is drawn before the first anchor
  if (from > today) return [];
  const first = dayNumber(from), last = dayNumber(today);
  const step = Math.max(1, Math.ceil((last - first + 1) / maxPoints));
  const days = new Set<number>();
  for (let n = first; n <= last; n += step) days.add(n);
  days.add(last);
  for (const an of r.anchors) if (an.date <= today) days.add(dayNumber(an.date));
  return [...days].sort((x, y) => x - y).flatMap((n) => {
    const iso = isoFromDayNumber(n);
    const v = valueOn(r, iso);
    return v.held && v.valued ? [{ date: iso, value: v.value, basis: v.basis }] : [];
  });
}

/**
 * The plain-language descriptor of what is modeled — for the AI and the chart
 * legend. Null when nothing is modeled (fewer than two anchors).
 */
export const MODELED_HISTORY_MEANING =
  "Values between two of the user's dated estimates are a straight-line model, not observed market prices; " +
  "after the latest estimate the value is carried forward unchanged, never projected.";

export function describeModeledHistory(r: ResolvedAnchors, today: string): {
  basis: "MODELED"; method: "LINEAR_BETWEEN_ANCHORS";
  from: string; to: string; anchorCount: number; carriedForwardFrom: string | null; meaning: string;
} | null {
  if (r.anchors.length < 2) return null;
  const last = r.anchors[r.anchors.length - 1];
  return {
    basis: "MODELED",
    method: "LINEAR_BETWEEN_ANCHORS",
    from: r.anchors[0].date,
    to: last.date,
    anchorCount: r.anchors.length,
    carriedForwardFrom: last.date < today ? last.date : null,
    meaning: MODELED_HISTORY_MEANING,
  };
}
